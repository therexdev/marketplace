#!/usr/bin/env node
/* The marketplace server: API surface, registry rules, and above all the
   SPONSOR — the endpoint that spends the dev wallet's mana on strangers'
   transactions. Every rule that protects that wallet is exercised with a
   crafted transaction that breaks exactly one of them.

   The payer here is a THROWAWAY key with zero KOIN, so even the
   transaction that passes every check cannot land on chain: the mempool
   refuses it for having no mana. "passed validation, died at broadcast"
   is therefore the SUCCESS signal for the happy path.  */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Signer, Provider, Contract, Transaction, utils } = require('koilib');

const os = require('os');
const SCRATCH = process.env.TEST_TMP || os.tmpdir();
const ROOT = path.join(__dirname, '..');
const PORT = 3981;
let fails = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail).slice(0, 200)}`);
  if (!ok) fails++;
};

const newSigner = () => new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv;
process.on('exit', () => { try { srv && srv.kill(); } catch (_) {} });

(async () => {
  const dev = newSigner();                       // zero-mana payer
  const MARKET = newSigner().getAddress();       // pretend contract address
  const RELICS = '1E8hw3NiDPz9gcZ8BiWoTHzFz4H48dpFKq';
  const dataDir = path.join(SCRATCH, 'mk-check-' + process.pid);
  fs.rmSync(dataDir, { recursive: true, force: true });

  srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir,
      KOINOS_NETWORK: 'mainnet',
      MARKET_ADDR: MARKET,
      KOINOS_DEV_WIF: dev.getPrivateKey('wif', true),
      ADMIN_KEY: 'test-admin-key',
      LAUNCH_FEE_KOIN: '0',
    }),
    stdio: process.env.KC_TEST_STDIO ? 'inherit' : ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/config`); if (r.ok) break; } catch (_) {}
    await sleep(250);
  }

  const api = async (p, opts) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, opts);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  /* ---- surface ---- */
  const cfg = (await api('/api/config')).body;
  check('config names the sponsor payer', cfg.sponsor === true && cfg.sponsorPayer === dev.getAddress(), JSON.stringify(cfg).slice(0, 120));
  check('config carries the Google client id from Aurvania', !!cfg.googleClientId, 'missing');

  const diag = (await api('/api/diag')).body;
  check('a diagnostic endpoint reports whether the sign-in bridge is reachable',
    !!diag.bridge && typeof diag.bridge.ok === 'boolean' && !!diag.googleClientId,
    JSON.stringify(diag).slice(0, 200));

  const home = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await home.text();
  check('the site is served', home.status === 200 && html.includes('OURO'), String(home.status));
  const spa = await fetch(`http://127.0.0.1:${PORT}/c/whatever`);
  check('extensionless routes fall back to the app', (await spa.text()).includes('OURO'), String(spa.status));

  /* ---- registry rules ---- */
  /* Registration is open to anyone now — the chain decides what is real.
     What must still hold: a duplicate is refused, garbage is refused, and
     `featured` stays privileged. */
  let r = await api('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: RELICS }) });
  check('adding a collection needs no admin key, but a duplicate is refused',
    r.status === 400 && /Already/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await api('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'test-admin-key', address: 'not-an-address' }) });
  check('…and a real address', r.status === 400, JSON.stringify(r.body));
  r = await api('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: newSigner().getAddress() }) });
  check('…and an address that answers as nothing is refused',
    r.status === 400 && /KCS-2/.test(r.body.error || ''), JSON.stringify(r.body));

  {
    // Anyone may add; only the admin key may promote to the front page.
    const cols = (await api('/api/collections')).body.collections || [];
    check('…while `featured` stays privileged', cols.every(c => c.featured !== true || c.address === RELICS),
      JSON.stringify(cols.map(c => [c.address, c.featured])));
  }

  /* ---- the auth bridge only forwards the stateless actions ---- */
  r = await api('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'link', email: 'x@x.com' }) });
  check('the auth bridge refuses non-login actions', r.status === 400, JSON.stringify(r.body));

  /* ---- sponsor gates, one broken rule per case ---- */
  const user = newSigner();
  const provider = new Provider(['https://api.koinos.io']);
  /* The public RPC flakes in stretches — garbage JSON, timeouts — and
     any single un-retried read voids the whole suite. Retry every call
     the harness makes, in one place. */
  const rawCall = provider.call.bind(provider);
  provider.call = async (method, params) => {
    for (let i = 0; ; i++) {
      try { return await rawCall(method, params); }
      catch (e) {
        if (i >= 5) throw e;
        await sleep(3000 * (i + 1));
      }
    }
  };
  const marketAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-abi', 'market-abi.json'), 'utf8'));
  const nftAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-abi', 'nft-abi.json'), 'utf8'));
  for (const abi of [marketAbi, nftAbi]) {
    const k = abi.koilib_types?.nested?.koinos?.nested;
    if (k) { delete k.btype; delete k._btype; }
  }
  const marketC = new Contract({ id: MARKET, abi: marketAbi, provider });
  const relicsC = new Contract({ id: RELICS, abi: nftAbi, provider });
  const koinC = new Contract({ id: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK', abi: nftAbi, provider });

  const goodOp = await marketC.encodeOperation({
    name: 'create_order',
    args: { collection: RELICS, token_id: '0x01', price: '100000000', expires: '0' },
  });
  const approveOp = await relicsC.encodeOperation({
    name: 'approve',
    args: { approver_address: user.getAddress(), to: MARKET, token_id: '0x01' },
  });
  // The op the wallet must never pay for: a call to a foreign contract.
  const evilOp = await koinC.encodeOperation({
    name: 'transfer',
    args: { from: user.getAddress(), to: dev.getAddress(), token_id: '0x01' },
  });

  async function craft({ ops, payer = dev.getAddress(), payee = user.getAddress(), rcLimit = '200000000', sign = true }) {
    const tx = new Transaction({ signer: user, provider, options: { payer, payee, rcLimit } });
    for (const op of ops) await tx.pushOperation(op);
    // Nonce/chain-id come from mainnet for realism; the tx never lands.
    // The public RPC flakes under load, and one timed-out chain-id read
    // must not void a whole suite — retry the prepare a few times.
    for (let i = 0; ; i++) {
      try { await tx.prepare(); break; }
      catch (e) {
        if (i >= 5) throw e;
        await sleep(3000 * (i + 1));
      }
    }
    if (sign) await tx.sign();
    return tx.transaction;
  }
  const sponsor = async (transaction) => api('/api/sponsor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction }),
  });

  r = await sponsor(await craft({ ops: [goodOp], payer: user.getAddress() }));
  check('a transaction not paid by the dev wallet is refused', r.status === 400 && /payer/.test(r.body.error), JSON.stringify(r.body));

  {
    const tx = new Transaction({ signer: user, provider, options: { payer: dev.getAddress(), rcLimit: '200000000' } });
    await tx.pushOperation(goodOp); await tx.prepare(); await tx.sign();
    r = await sponsor(tx.transaction);
    check('a transaction with no payee is refused', r.status === 400 && /payee/.test(r.body.error), JSON.stringify(r.body));
  }

  r = await sponsor(await craft({ ops: [goodOp], rcLimit: '99900000000' }));
  check('an rc limit above the ceiling is refused', r.status === 400 && /ceiling/.test(r.body.error), JSON.stringify(r.body));

  /* The mana budget that broke listing. A real Koinos contract call burns
     roughly 0.4–1.3 KOIN, so a two-operation listing under a flat 2 KOIN
     ceiling reverted on chain with "insufficient rc". The ceiling now
     follows the operation count. */
  r = await sponsor(await craft({ ops: [approveOp, goodOp], rcLimit: '600000000' }));
  check('a 2-op listing may budget 6 KOIN of mana — the amount it actually needs',
    !/ceiling/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await sponsor(await craft({ ops: [goodOp], rcLimit: '600000000' }));
  check('…but a 1-op transaction may not claim that same budget',
    r.status === 400 && /ceiling/.test(r.body.error || ''), JSON.stringify(r.body));

  r = await sponsor(await craft({ ops: [goodOp, evilOp] }));
  check('an op on a foreign contract is refused even next to a good one', r.status === 400 && /not something/.test(r.body.error), JSON.stringify(r.body));

  r = await sponsor(await craft({ ops: [evilOp] }));
  check('a KOIN-contract call is never sponsored', r.status === 400, JSON.stringify(r.body));

  r = await sponsor(await craft({ ops: [goodOp], sign: false }));
  check('an unsigned payee is refused', r.status === 400 && /not signed/.test(r.body.error), JSON.stringify(r.body));

  {
    // Signed by SOMEBODY — just not the payee it names.
    const other = newSigner();
    const tx = new Transaction({ signer: other, provider, options: { payer: dev.getAddress(), payee: user.getAddress(), rcLimit: '200000000' } });
    await tx.pushOperation(goodOp); await tx.prepare(); await tx.sign();
    r = await sponsor(tx.transaction);
    check('a signature from the wrong account is refused', r.status === 400 && /not signed/.test(r.body.error), JSON.stringify(r.body));
  }

  /* The happy path: market op + approval on a REGISTERED collection,
     payee signed, payer dev. Validation passes; the zero-mana payer then
     dies at the mempool — which is exactly the proof we want offline. */
  r = await sponsor(await craft({ ops: [approveOp, goodOp] }));
  const passed = r.status === 200 || (r.status === 400 && /rc|resource|mana|reverted|failed|account/i.test(r.body.error || ''));
  check('a well-formed listing passes validation (dies only at the mempool, having no mana)',
    passed && !/payer|payee|ceiling|not something|not signed/.test(r.body.error || ''), JSON.stringify(r.body));

  /* ---- rate limit ---- */
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const rr = await sponsor(await craft({ ops: [goodOp] }));
    if (rr.status === 429) { limited = true; break; }
  }
  check('a payee hammering the sponsor gets rate limited', limited, 'never hit 429');

  /* ---- filters read the whole collection, not one page ---- */
  const F = await api(`/api/collections/${RELICS}/facets`);
  const facets = F.body.facets || [];
  const rarity = facets.find(f => f.trait === 'Rarity');
  check('facets are built from every token in the collection',
    !!rarity && rarity.total === F.body.indexed && F.body.indexed > 24, JSON.stringify(F.body).slice(0, 160));
  check('…and each trait value carries a real count',
    !!rarity && rarity.values.every(v => v.count > 0) &&
    rarity.values.reduce((s, v) => s + v.count, 0) === rarity.total, JSON.stringify(rarity).slice(0, 160));

  const all = (await api(`/api/collections/${RELICS}/tokens?limit=1`)).body;
  const rareOnly = (await api(`/api/collections/${RELICS}/tokens?limit=60&t=Rarity:rare`)).body;
  const rareCount = rarity.values.find(v => v.value === 'rare')?.count;
  check('a trait filter narrows the WHOLE collection, matching the sidebar count',
    rareOnly.matched === rareCount && rareOnly.matched < all.matched,
    `matched=${rareOnly.matched} facet=${rareCount} total=${all.matched}`);

  const twoVals = (await api(`/api/collections/${RELICS}/tokens?limit=60&t=Rarity:rare&t=Rarity:epic`)).body;
  const epicCount = rarity.values.find(v => v.value === 'epic')?.count || 0;
  check('…two values of one trait are an OR', twoVals.matched === rareCount + epicCount,
    `${twoVals.matched} vs ${rareCount}+${epicCount}`);

  const crossed = (await api(`/api/collections/${RELICS}/tokens?limit=60&t=Rarity:rare&t=Kind:pet`)).body;
  check('…while different traits are an AND', crossed.matched <= Math.min(rareOnly.matched, all.matched),
    String(crossed.matched));

  const searched = (await api(`/api/collections/${RELICS}/tokens?limit=60&q=blade`)).body;
  check('search matches names across the collection',
    searched.matched > 0 && searched.tokens.every(t => /blade/i.test(t.name + ' ' + t.label)),
    JSON.stringify(searched.tokens.slice(0, 2)));

  const paged = (await api(`/api/collections/${RELICS}/tokens?limit=10&offset=0`)).body;
  const paged2 = (await api(`/api/collections/${RELICS}/tokens?limit=10&offset=10`)).body;
  check('paging walks the filtered set without repeating',
    paged.nextOffset === 10 && paged2.tokens.length > 0 &&
    !paged2.tokens.some(t => paged.tokens.some(p => p.tokenId === t.tokenId)),
    `${paged.tokens.length}/${paged2.tokens.length}`);

  const nobody = (await api(`/api/collections/${RELICS}/tokens?limit=5&owner=${newSigner().getAddress()}`)).body;
  check('an owner filter with no holdings matches nothing', nobody.matched === 0, String(nobody.matched));

  /* ---- history is decoded from the contract's own events ---- */
  const hist = await api(`/api/history?collection=${RELICS}`);
  check('history answers for a collection with no trades yet',
    hist.status === 200 && Array.isArray(hist.body.events), JSON.stringify(hist.body).slice(0, 120));

  /* The walk itself, against the REAL contract on mainnet. "No trades yet"
     and "the indexer never reached the chain" produce the same empty list,
     so the record count is what separates them. */
  {
    const LIVE_PORT = PORT + 1;
    const liveDir = path.join(SCRATCH, 'mk-live-' + process.pid);
    fs.mkdirSync(liveDir, { recursive: true });
    /* Seed the store with the exact corruption that shipped — one real
       event written twenty times — so the repair path is exercised, not
       just the walk that stopped causing it. */
    const dupRow = {
      seq: 2, kind: 'listed', tx: '0xdup', at: 1785883140110,
      collection: RELICS, tokenId: '0xdead', seller: '1Seller', buyer: null,
      price: '1000000000', fee: null, royalty: null, expires: '0',
    };
    // lastSeq -1 so the walk still discovers what is really on chain: this
    // exercises the repair AND the walk, not one at the expense of the other.
    fs.writeFileSync(path.join(liveDir, 'history.json'),
      JSON.stringify({ events: Array.from({ length: 20 }, () => ({ ...dupRow })), lastSeq: -1 }));

    const live = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(LIVE_PORT),
        DATA_DIR: liveDir,
        KOINOS_NETWORK: 'mainnet',
        MARKET_ADDR: '1BsZx4Hc69tWo1q9sXNP9ywvpBW2KdXwc8',
      }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      let body = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        try {
          const rr = await fetch(`http://127.0.0.1:${LIVE_PORT}/api/history?collection=${RELICS}`);
          if (rr.ok) { body = await rr.json(); if (body.scanned > 0) break; }
        } catch (_) {}
      }
      check('the indexer really walks the market contract\'s history on chain',
        !!body && body.scanned > 0, JSON.stringify(body).slice(0, 160));

      /* The walk paged over the same records twenty times, because the
         FIRST record of an account carries no seq_num at all (protobuf
         omits zero) and every comparison against NaN was false. */
      /* The market's history grows with every listing, so the bound is
         relative: a healthy first walk reads each record once (scanned
         tracks records, and one record can hold several decoded events);
         the NaN-cursor bug read everything twentyfold. */
      check('…in one pass, instead of paging over the same records again and again',
        !!body && body.scanned <= (body.known || 0) * 3 + 40, `scanned ${body && body.scanned} known ${body && body.known}`);

      const rows = (body && body.events) || [];
      const keys = rows.map(e => [e.seq, e.idx, e.tx, e.kind, e.tokenId, e.price].join('|'));
      check('…and one event lands as ONE row, however often the walk runs',
        keys.length === new Set(keys).size, `${keys.length} rows, ${new Set(keys).size} distinct`);
      check('…with duplicates already on disk collapsed rather than served forever',
        rows.filter(e => e.tx === '0xdup').length === 1,
        `${rows.filter(e => e.tx === '0xdup').length} copies of the seeded duplicate`);

      const listed = rows.find(e => e.kind === 'listed' && e.tx !== '0xdup');
      check('…and the real listing on chain is decoded with its price',
        !!listed && !!listed.price && !!listed.seller, JSON.stringify(listed || null).slice(0, 160));
    } finally { try { live.kill(); } catch (_) {} }
  }

  /* ---- minting: free, capped, and honest about whose key it needs ---- */
  r = await api('/api/mint', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: RELICS, owner: user.getAddress(), tokenId: '0x01', name: 'Probe', image: 'https://example.com/a.png' }) });
  check('a mint on a collection not launched here is sent back to the wallet',
    r.status === 400 && r.body.external === true && /wallet/i.test(r.body.error || ''), JSON.stringify(r.body));

  r = await api('/api/mint', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: RELICS, owner: user.getAddress(), tokenId: 'not-hex', name: 'Probe', image: 'https://example.com/a.png' }) });
  check('…and a malformed token id never leaves the building', r.status === 400 && /hex/i.test(r.body.error || ''), JSON.stringify(r.body));

  {
    // With mints free, the sponsor must refuse ANY KOIN transfer — a fee op
    // has no business existing when there is no fee.
    const feeOp = await koinC.encodeOperation({ name: 'transfer', args: { from: user.getAddress(), to: dev.getAddress(), token_id: '0x01' } });
    const mintOp = await relicsC.encodeOperation({ name: 'mint', args: { to: user.getAddress(), token_id: '0x01' } });
    r = await sponsor(await craft({ ops: [feeOp, mintOp] }));
    check('with free mints, no KOIN transfer rides the sponsor — even beside a mint',
      r.status === 400 && /not something/.test(r.body.error || ''), JSON.stringify(r.body));
  }

  /* ---- a buy: KOIN allowance to the market + execute_order ----
     KCS-4 KOIN only leaves a wallet on an allowance, so every purchase
     arrives as this exact pair. The sponsor must wave the pair through —
     execute_order weighted as the several calls it makes inside — while
     an allowance for any OTHER spender stays someone else's bill. */
  {
    const tokenAbi = JSON.parse(JSON.stringify(utils.tokenAbi));
    const k4 = tokenAbi.koilib_types?.nested?.koinos?.nested;
    if (k4) { delete k4.btype; delete k4._btype; }
    const koinTokenC = new Contract({ id: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK', abi: tokenAbi, provider });
    const buyOps = [
      await koinTokenC.encodeOperation({ name: 'approve',
        args: { owner: user.getAddress(), spender: MARKET, value: '100000000' } }),
      await marketC.encodeOperation({ name: 'execute_order',
        args: { collection: RELICS, token_id: '0x01', buyer: user.getAddress(), max_price: '100000000' } }),
    ];
    r = await sponsor(await craft({ ops: buyOps, rcLimit: '1500000000' }));
    check('a KOIN allowance for the market rides the sponsor beside its buy',
      !/ceiling|not something|payee|payer/.test(r.body.error || ''), JSON.stringify(r.body).slice(0, 160));

    const strayApprove = await koinTokenC.encodeOperation({ name: 'approve',
      args: { owner: user.getAddress(), spender: dev.getAddress(), value: '100000000' } });
    r = await sponsor(await craft({ ops: [strayApprove] }));
    check('…an allowance for any other spender is refused',
      r.status === 400 && /not something/.test(r.body.error || ''), JSON.stringify(r.body));

    const strayOwner = await koinTokenC.encodeOperation({ name: 'approve',
      args: { owner: dev.getAddress(), spender: MARKET, value: '100000000' } });
    r = await sponsor(await craft({ ops: [strayOwner] }));
    check('…and an allowance from anyone but the payee is refused',
      r.status === 400 && /not something/.test(r.body.error || ''), JSON.stringify(r.body));
  }

  /* ---- mint-and-list: a whole shopfront in one sponsored tx ----
     One blanket approval plus ten orders is eleven ops ≈ 11 KOIN of mana,
     inside the 15 KOIN ceiling — the sponsor must wave it through to the
     mempool rather than refuse it at the gate. */
  {
    const ops = [await relicsC.encodeOperation({
      name: 'set_approval_for_all',
      args: { approver_address: user.getAddress(), operator_address: MARKET, approved: true },
    })];
    for (let i = 0; i < 10; i++) {
      ops.push(await marketC.encodeOperation({
        name: 'create_order',
        args: { collection: RELICS, token_id: '0x0' + i.toString(16), price: '100000000', expires: '0' },
      }));
    }
    r = await sponsor(await craft({ ops, rcLimit: '1500000000' }));
    check('a blanket approval plus ten listings clears the sponsor in one transaction',
      !/ceiling|not something|payee|payer/.test(r.body.error || ''), JSON.stringify(r.body).slice(0, 160));
  }

  /* ---- an oversize upload gets an answer, not a dead socket ----
     The server used to destroy the connection mid-body, which a browser
     reports as a bare "Failed to fetch" — indistinguishable from the
     network dropping. Someone lost a whole bulk drop to that. */
  {
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;   // PNG magic
    const r413 = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: big,
    }).then(async (rr) => ({ status: rr.status, body: await rr.json().catch(() => null) }))
      .catch((e) => ({ status: 0, body: { error: String(e.message) } }));
    check('an image over the size cap is refused with words, never a dead socket',
      r413.status === 413 && /larger than/.test(r413.body?.error || ''), JSON.stringify(r413).slice(0, 160));
  }

  /* ---- Kollection-era collections: The Crew, live on mainnet ----
     No get_tokens (ids are plain decimals probed via owner_of), metadata
     keyed by hex id on IPFS, royalties declared per 100,000 — a real sale
     paid 54.10 KOIN royalty on a 1,082 KOIN price, 5%, and the site must
     say 5%, not 50%. */
  {
    const CREW = '1FB7geE8MN1ViG91rkBE5iu27s2Khuo257';
    const info = await api(`/api/collections/${CREW}`);
    check('a Kollection-era collection reads name, symbol and supply',
      info.body?.info?.name === 'The Crew' && info.body?.info?.totalSupply === '60',
      String(JSON.stringify(info.body)).slice(0, 160));
    check('…and its per-100k royalty shows as the 5% real sales paid',
      info.body?.info?.royaltyBps === 500 && info.body?.info?.legacyRoyalty === true,
      `royaltyBps=${info.body?.info?.royaltyBps} legacy=${info.body?.info?.legacyRoyalty}`);

    const toks = await api(`/api/collections/${CREW}/tokens?limit=5`);
    check('…its tokens enumerate without get_tokens, probed from the supply',
      (toks.body?.matched || 0) >= 55 && (toks.body?.tokens || []).length === 5,
      `matched=${toks.body?.matched} got=${(toks.body?.tokens || []).length}`);

    // Registered without a cover image, a collection borrows one from its
    // own newest art — found in the background, PROVEN to load, stored.
    // The Crew's art is unpinned (every gateway 504s), so the borrowing is
    // demonstrated on Mata NFT, whose images this site hosts itself.
    const add = await api('/api/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: CREW }),
    });
    check('a collection can be added with nothing but its address', add.status === 200, JSON.stringify(add.body).slice(0, 120));
    const MATA = '17zfwC1PXHLrxwPXkx1ppweiP2dupAgxHk';
    await api('/api/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: MATA }),
    });
    let cover = '';
    for (let i = 0; i < 25 && !cover; i++) {
      const list = await api('/api/collections');
      cover = (list.body?.collections || []).find((x) => x.address === MATA)?.image || '';
      if (!cover) await sleep(1500);
    }
    check('…and with no cover chosen, its newest loadable art fronts the collection',
      /^(\/img\/c\/|\/u\/|https:\/\/)/.test(cover), `image=${cover.slice(0, 80)}`);
    if (cover.startsWith('/img/')) {
      /* The page now hands out /img/ paths served from our own art
         cache — prove the path delivers actual image bytes, which is
         more than the old direct-gateway url ever promised. */
      const art = await fetch(`http://127.0.0.1:${PORT}${cover}`);
      check('…and the art cache serves those bytes itself',
        art.ok && /^image\//.test(art.headers.get('content-type') || ''),
        `status=${art.status} type=${art.headers.get('content-type')}`);
      try { await art.arrayBuffer(); } catch (_) {}
    }

    /* Importing art the internet lost: past the admin key only, bytes
       must BE an image, and the filename must be one the collection's
       own metadata names — the caller never chooses a url. */
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('tiny')]);
    let imp = await fetch(`http://127.0.0.1:${PORT}/api/art?collection=${MATA}&file=x.png`,
      { method: 'POST', body: fakePng });
    check('importing lost art demands the admin key', imp.status === 403, `status=${imp.status}`);
    imp = await fetch(`http://127.0.0.1:${PORT}/api/art?key=test-admin-key&collection=${MATA}&file=x.png`,
      { method: 'POST', body: Buffer.from('not an image at all') });
    check('…and refuses bytes that are not an image', imp.status === 400, `status=${imp.status}`);
    imp = await fetch(`http://127.0.0.1:${PORT}/api/art?key=test-admin-key&collection=${MATA}&file=no-such-art.png`,
      { method: 'POST', body: fakePng });
    check('…and refuses a filename no token in the metadata names', imp.status === 404, `status=${imp.status}`);
    /* Naming the token outright skips the index entirely — the server
       resolves that ONE token's metadata and pins against the url it
       names, so a wounded index cannot block a restoration. */
    imp = await fetch(`http://127.0.0.1:${PORT}/api/art?key=test-admin-key&collection=${MATA}&token=0x4d41544130303031`,
      { method: 'POST', body: fakePng });
    const impBody = await imp.json().catch(() => ({}));
    check('naming a token imports even past a wounded index', imp.status === 200 && impBody.pinned === 1,
      `status=${imp.status} ${JSON.stringify(impBody).slice(0, 100)}`);
    if (imp.status === 200) {
      const got = await fetch(`http://127.0.0.1:${PORT}/img/t/${MATA}/0x4d41544130303031`);
      const bytes = Buffer.from(await got.arrayBuffer());
      check('…and the imported bytes are exactly what the site serves back',
        got.ok && bytes.length === fakePng.length, `status=${got.status} len=${bytes.length}`);
    }

    // Registered by mistake? The admin key takes it back out — nobody else.
    let del = await api(`/api/collections/${CREW}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'not-the-key' }),
    });
    check('removing a collection demands the admin key', del.status === 403, JSON.stringify(del.body));
    del = await api(`/api/collections/${CREW}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test-admin-key' }),
    });
    const after = await api('/api/collections');
    check('…and with it, the collection leaves the registry',
      del.status === 200 && !(after.body?.collections || []).some((x) => x.address === CREW),
      JSON.stringify(del.body));
  }

  /* ---- bulk minting: refused whole, or fits whole ---- */
  const twoDucks = [
    { tokenId: '0x4401', name: 'Duck #1', image: 'https://example.com/1.png', attributes: [{ trait_type: 'Rarity', value: 'Common' }] },
    { tokenId: '0x4402', name: 'Duck #2', image: 'https://example.com/2.png', attributes: [] },
  ];
  r = await api('/api/mint-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: RELICS, owner: user.getAddress(), items: twoDucks }) });
  check('a batch on a collection not launched here is sent back to the wallet',
    r.status === 400 && r.body.external === true, JSON.stringify(r.body));

  r = await api('/api/mint-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: RELICS, owner: user.getAddress(), items: [twoDucks[0], twoDucks[0]] }) });
  check('…a token id repeating within a batch is caught before the chain',
    r.status === 400 && /repeats/.test(r.body.error || ''), JSON.stringify(r.body));

  r = await api('/api/mint-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: RELICS, owner: user.getAddress(),
      items: Array.from({ length: 31 }, (_, i) => ({ ...twoDucks[0], tokenId: '0x44' + String(i).padStart(2, '0') })) }) });
  check('…and a batch larger than a whole day\'s budget is refused outright',
    r.status === 400 && /at most/.test(r.body.error || ''), JSON.stringify(r.body));

  /* ---- a launch transaction must PARSE ----
     The contract upload rode on Buffer.toString('base64url'), which never
     pads — and the node's JSON codec requires padded base64url. The first
     binary was divisible by 3 (padded == unpadded) and deployed twice on
     that coincidence; the rebuild broke it and every launch died with
     "parameters could not be parsed". With a zero-mana payer the node
     parses BEFORE it checks resources, so the free path must die at the
     MANA wall — dying at the parser is this exact bug back again. */
  {
    r = await api('/api/launch/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Parse Probe', symbol: 'PROBE', description: '', owner: user.getAddress() }),
    });
    const msg = String((r.body && r.body.error) || '');
    check('a free launch reaches the mempool whole (dies at mana, never at the parser)',
      r.status === 400 && /resource|rc|mana/i.test(msg) && !/parsed|translate/i.test(msg), JSON.stringify(r.body).slice(0, 200));
  }

  /* ---- sign-in must not depend on the game being reachable ----
     Exactly what went wrong live: the bridge stopped answering, and with
     it the client id, so the site announced "Google sign-in is not
     configured" while the OAuth setup was perfectly fine. */
  {
    const OFF_PORT = PORT + 2;
    const off = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(OFF_PORT),
        DATA_DIR: path.join(SCRATCH, 'mk-off-' + process.pid),
        KOINOS_NETWORK: 'mainnet',
        AURVANIA_API: 'http://127.0.0.1:9',        // nothing listens here
        GOOGLE_CLIENT_ID: '893657214159-test.apps.googleusercontent.com',
      }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      let c = null;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        try { const rr = await fetch(`http://127.0.0.1:${OFF_PORT}/api/config`); if (rr.ok) { c = await rr.json(); break; } } catch (_) {}
      }
      check('with the bridge down, the client id still comes from this server\'s env',
        !!c && c.googleClientId === '893657214159-test.apps.googleusercontent.com', JSON.stringify(c).slice(0, 140));

      const acct = await fetch(`http://127.0.0.1:${OFF_PORT}/api/account`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', email: 'a@b.c', password: 'x' }),
      });
      const ab = await acct.json();
      check('…and a failed sign-in says WHAT could not be reached, not just that it failed',
        acct.status === 502 && !!ab.detail && ab.detail.length > 3, JSON.stringify(ab).slice(0, 160));

      const d = await (await fetch(`http://127.0.0.1:${OFF_PORT}/api/diag`)).json();
      check('…and the diagnostic names the unreachable bridge',
        d.bridge && d.bridge.ok === false && !!d.bridge.error && /env/.test(d.googleClientId),
        JSON.stringify(d).slice(0, 200));
    } finally { try { off.kill(); } catch (_) {} }
  }

  /* ---- the bridge must introduce itself ----
     The game's host answers 403 to node's default User-Agent, so the
     request never reached the game's app at all. Stand in for the game
     and read the header we actually send. */
  {
    const http = require('http');
    const seen = [];
    const stand = http.createServer((rq, rs) => {
      seen.push({ url: rq.url, ua: rq.headers['user-agent'] || '', accept: rq.headers.accept || '' });
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ googleClientId: 'stand-in-client-id' }));
    });
    await new Promise((r) => stand.listen(0, '127.0.0.1', r));
    const standPort = stand.address().port;
    const UA_PORT = PORT + 3;
    const uaSrv = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(UA_PORT),
        DATA_DIR: path.join(SCRATCH, 'mk-ua-' + process.pid),
        KOINOS_NETWORK: 'mainnet',
        AURVANIA_API: `http://127.0.0.1:${standPort}`,
        KOINOS_DEV_WIF: newSigner().getPrivateKey('wif', true),
        MINT_PER_DAY_TOTAL: '0',
      }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      for (let i = 0; i < 40 && !seen.length; i++) {
        await sleep(400);
        try { await fetch(`http://127.0.0.1:${UA_PORT}/api/config`); } catch (_) {}
      }
      const hit = seen[0];
      check('the bridge sends a User-Agent rather than node\'s default',
        !!hit && !!hit.ua && !/^node$/i.test(hit.ua), JSON.stringify(hit));
      check('…one on the accepted side of the game host\'s filter, and self-identifying',
        !!hit && /^(curl|Wget)\//.test(hit.ua) && /OURO/i.test(hit.ua), hit && hit.ua);

      const zm = await fetch(`http://127.0.0.1:${UA_PORT}/api/mint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: RELICS, owner: user.getAddress(), tokenId: '0x01', name: 'Probe', image: 'https://example.com/a.png' }),
      });
      const zb = await zm.json();
      check('the site-wide daily mint budget is enforced before anything is spent',
        zm.status === 429 && /budget|per day/i.test(zb.error || ''), JSON.stringify(zb));

      const d = await (await fetch(`http://127.0.0.1:${UA_PORT}/api/diag?ua=Wget/1.21.3%20(probe)`)).json();
      check('…and the diagnostic can try a different identity from the server itself',
        d.userAgent === 'Wget/1.21.3 (probe)' && seen.some(s => s.ua === 'Wget/1.21.3 (probe)'),
        JSON.stringify(d).slice(0, 160));
    } finally { try { uaSrv.kill(); } catch (_) {} stand.close(); }
  }

  /* No trade exists on the new contract yet, so prove the DECODER against
     bytes shaped exactly like the chain's: koilib's Serializer silently
     prefers a default type over the one passed per call, which would have
     decoded every event as whichever type was named first. */
  {
    const { Serializer, utils } = require('koilib');
    const s = new Serializer(marketAbi.koilib_types);
    const sold = {
      buyer: user.getAddress(), seller: dev.getAddress(), collection: RELICS,
      token_id: '0x4352534449544d30303031', price: '2500000000',
      protocol_fee: '62500000', royalties_paid: '25000000',
    };
    const wire = utils.encodeBase64url(await s.serialize(sold, 'market.execute_order_event'));
    const back = await s.deserialize(utils.decodeBase64url(wire), 'market.execute_order_event');
    check('a sale event decodes with buyer, seller, price, fee and royalty intact',
      back.buyer === sold.buyer && back.seller === sold.seller && back.price === sold.price &&
      back.protocol_fee === sold.protocol_fee && back.royalties_paid === sold.royalties_paid,
      JSON.stringify(back));
    const net = BigInt(back.price) - BigInt(back.protocol_fee) - BigInt(back.royalties_paid);
    check('…and the seller\'s take is the price minus both cuts', net === 2412500000n, String(net));

    const listed = await s.deserialize(
      utils.decodeBase64url(utils.encodeBase64url(await s.serialize(
        { seller: dev.getAddress(), collection: RELICS, token_id: '0x01', price: '900', expires: '0' },
        'market.create_order_event'))),
      'market.create_order_event');
    check('a listing event decodes as a LISTING, not as whichever type came first',
      listed.price === '900' && listed.buyer === undefined && listed.seller === dev.getAddress(),
      JSON.stringify(listed));
  }

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
