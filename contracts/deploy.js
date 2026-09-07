#!/usr/bin/env node
/* Deploy the marketplace contract.

   Usage:
     node deploy.js keygen  --keys keys.env
     node deploy.js deploy  --keys keys.env [--network harbinger|mainnet]
     node deploy.js upgrade --keys keys.env [--network ...]
                            (re-uploads the bytecode over the LIVE contract;
                             orders and config are storage and survive intact)
     node deploy.js config  --keys keys.env [--network ...]
                            [--treasury <addr>] [--fee-bps 0]
     node deploy.js status  --keys keys.env [--network ...]

   keys.env holds two WIFs and is NEVER committed (see .gitignore):
     KOINOS_DEV_WIF     — pays the mana for everything, here and at runtime.
     KOINOS_MARKET_WIF  — the account the contract lives on. On Koinos a
                          contract IS an account: this key's address is the
                          marketplace's address. Cold after deploy+config.

   Everything is idempotent: a re-run skips what already succeeded, so a
   deploy that dies halfway is resumed by running the same command again.

   The rc sizing below was learned on mainnet with the Aurvania contracts,
   in both directions: a fixed 10 KOIN limit reverts an upload with
   "insufficient rc", while 95% of a rich wallet is rejected by the mempool
   as "insufficient pending account resources" (it reserves the LIMIT, not
   the eventual use). So: 95% of live mana, capped at estimated need +25%. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Signer, Provider, Contract } = require('koilib');

const NETWORKS = {
  harbinger: {
    label: 'Koinos Harbinger testnet',
    rpcs: ['https://harbinger-api.koinos.io'],
    // The official tKOIN contract (docs.koinos.io/developers/testnet).
    koinContract: '1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju',
    explorer: 'https://harbinger.koinosblocks.com',
  },
  mainnet: {
    label: 'Koinos mainnet',
    rpcs: ['https://api.koinos.io'],
    // The real KOIN contract — verified on-chain by the Aurvania deploy.
    koinContract: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',
    explorer: 'https://koinosblocks.com',
  },
};

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const cmd = process.argv[2] || 'status';
const network = arg('--network', 'harbinger');
const keysFile = arg('--keys', '');
const net = NETWORKS[network];
if (!net) { console.error(`unknown network "${network}"`); process.exit(1); }

/* ---- keys ---- */
function loadEnv(file) {
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}
if (!keysFile) { console.error('Pass --keys <file>'); process.exit(1); }
const env = loadEnv(keysFile);

if (cmd === 'keygen') {
  // Append only what is missing — existing keys are never overwritten.
  const lines = [];
  for (const name of ['KOINOS_DEV_WIF', 'KOINOS_MARKET_WIF']) {
    if (env[name]) { console.log(`${name}: kept`); continue; }
    const signer = new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
    lines.push(`${name}=${signer.getPrivateKey('wif', true)}`);
    console.log(`${name}: generated -> address ${signer.getAddress()}`);
  }
  if (lines.length) fs.appendFileSync(keysFile, (fs.existsSync(keysFile) && fs.readFileSync(keysFile, 'utf8').endsWith('\n') === false && fs.statSync(keysFile).size ? '\n' : '') + lines.join('\n') + '\n');
  process.exit(0);
}

for (const name of ['KOINOS_DEV_WIF', 'KOINOS_MARKET_WIF']) {
  if (!env[name]) { console.error(`${name} missing — run: node deploy.js keygen --keys ${keysFile}`); process.exit(1); }
}

/* ---- artifacts ---- */
const wasmPath = () => {
  const built = path.join(__dirname, 'market', 'build', 'release', 'contract.wasm');
  if (fs.existsSync(built)) { console.log('wasm:     market from build/release (freshly compiled)'); return built; }
  console.log('wasm:     market from prebuilt/ — run `node build.js market` to compile local source instead');
  return path.join(__dirname, 'prebuilt', 'market', 'contract.wasm');
};
const abiJson = () => {
  const built = path.join(__dirname, 'market', 'build', 'market-abi.json');
  const p = fs.existsSync(built) ? built : path.join(__dirname, 'prebuilt', 'market', 'abi.json');
  return fs.readFileSync(p, 'utf8');
};
/* protobufjs in koilib 9.x rejects the btype extension declaration. */
function sanitizeAbi(json) {
  const abi = JSON.parse(json);
  const k = abi.koilib_types?.nested?.koinos?.nested;
  if (k) { delete k.btype; delete k._btype; }
  return abi;
}

(async () => {
  const provider = new Provider(net.rpcs);
  const dev = Signer.fromWif(env.KOINOS_DEV_WIF); dev.provider = provider;
  const marketSigner = Signer.fromWif(env.KOINOS_MARKET_WIF); marketSigner.provider = provider;
  const devAddr = dev.getAddress();
  const marketId = marketSigner.getAddress();

  console.log(`network:  ${net.label}`);
  console.log(`dev:      ${devAddr}`);
  console.log(`market:   ${marketId}`);
  const mana = Number(await provider.getAccountRc(devAddr)) / 1e8;
  console.log(`dev mana: ${mana.toFixed(2)} KOIN`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KOIN_PER_BYTE = 45.94 / 59926;    // measured on the Aurvania mainnet upload

  const paidByDev = async (maxKoin) => {
    await sleep(4000);                    // let the node's rc view settle
    const rc = BigInt(await provider.getAccountRc(devAddr));
    let limit = rc * 95n / 100n;
    if (maxKoin) {
      const cap = BigInt(Math.ceil(maxKoin * 1.25 * 1e8));
      if (limit > cap) limit = cap;
    }
    return { rcLimit: limit.toString(), payer: devAddr, beforeSend: async (tx) => { await dev.signTransaction(tx); } };
  };

  /* The bytecode rides on the Contract itself — koilib's deploy() uploads
     this.bytecode, and without it fails with "bytecode not found" after
     reading the wasm for nothing. */
  const marketC = new Contract({
    id: marketId, provider, signer: marketSigner,
    abi: sanitizeAbi(abiJson()),
    bytecode: fs.readFileSync(wasmPath()),
  });

  async function send(label, fn) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const { transaction } = await fn();
        console.log(`${label}: sent ${transaction.id} — waiting for the block…`);
        await transaction.wait('byBlock', 60000);
        console.log(`${label}: confirmed`);
        return;
      } catch (e) {
        const msg = String(e && e.message || e);
        if (attempt === 4) throw e;
        console.log(`${label}: ${msg.slice(0, 120)} — retry ${attempt}/3`);
        await sleep(4000 * attempt);
      }
    }
  }

  if (cmd === 'deploy') {
    let live = false;
    try { live = !!(await marketC.functions.get_config({})).result; } catch (_) {}
    if (live) {
      console.log('deploy:   contract already answers get_config — skipping upload');
    } else {
      const bytes = marketC.bytecode;
      const need = bytes.length * KOIN_PER_BYTE * 1.08;
      if (mana < need) {
        console.error(`deploy: needs ~${need.toFixed(1)} KOIN of mana in one transaction; the dev wallet has ${mana.toFixed(2)}.`);
        console.error('deploy: mana can never exceed the KOIN balance — top the wallet up and re-run.');
        process.exit(1);
      }
      await send('deploy', async () => marketC.deploy({
        ...(await paidByDev(bytes.length * KOIN_PER_BYTE)),
        abi: abiJson(),
      }));
      console.log(`deploy:   ${net.explorer}/address/${marketId}`);
    }
  }

  if (cmd === 'upgrade') {
    /* Same upload as deploy, WITHOUT the already-live skip: replacing the
       bytecode on the same account is how a Koinos contract upgrades, and
       its storage (orders, config) is untouched by the swap. */
    const bytes = marketC.bytecode;
    const need = bytes.length * KOIN_PER_BYTE * 1.08;
    if (mana < need) {
      console.error(`upgrade: needs ~${need.toFixed(1)} KOIN of mana in one transaction; the dev wallet has ${mana.toFixed(2)}.`);
      process.exit(1);
    }
    await send('upgrade', async () => marketC.deploy({
      ...(await paidByDev(bytes.length * KOIN_PER_BYTE)),
      abi: abiJson(),
    }));
    console.log(`upgrade:  new bytecode live, state untouched — ${net.explorer}/address/${marketId}`);
  }

  if (cmd === 'deploy' || cmd === 'config') {
    // Fee-only changes must preserve the existing treasury and token address.
    const previous = cmd === 'config' ? (await marketC.functions.get_config({})).result : null;
    const treasury = arg('--treasury', previous?.treasury || devAddr);
    const feeBps = Number(arg('--fee-bps', '0'));
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error('--fee-bps must be an integer from 0 to 1000');
    const expectedMarket = arg('--market', '');
    if (expectedMarket && expectedMarket !== marketId) throw new Error('The market key does not match --market');
    await send('config', async () => marketC.functions.set_config({
      treasury, koin: previous?.koin || net.koinContract, fee_bps: feeBps,
    }, await paidByDev(3)));
    console.log(`config:   treasury ${treasury} · fee ${(feeBps / 100).toFixed(2)}% · koin ${net.koinContract}`);
  }

  if (cmd === 'status') {
    try {
      const { result } = await marketC.functions.get_config({});
      console.log('config:  ', JSON.stringify(result));
    } catch (e) {
      console.log('status:   contract not deployed or not configured yet');
    }
  }
})().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
