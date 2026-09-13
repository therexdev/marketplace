'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) || null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };
function setup(outcome = 'approved', pairUri = 'https://koinvault.app/?connect=session&secret=secret') {
  const calls = [], sessionStorage = storage(), localStorage = storage();
  const launchTx = { id: 'launch-id', header: { payer: 'sponsor' }, operations: [{ call_contract: {} }, { upload_contract: {} }] };
  const context = {
    URL, URLSearchParams, AbortSignal, Event, console, sessionStorage, localStorage,
    location: { origin: 'https://ouro.lifestyle' }, setTimeout: fn => { fn(); },
    window: { dispatchEvent() {} }, Provider: class {},
    utils: { tokenAbi: {} },
    Contract: class { constructor({ id }) { this.id = id; } encodeOperation({ name, args }) { return { call_contract: { contract_id: this.id, entry_point: name, args: JSON.stringify(args) } }; } },
    fetch: async (url, opts = {}) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      const data = url === '/api/config' ? { network: 'mainnet', rpcs: [], market: 'market', koin: 'koin', sponsor: true, sponsorPayer: 'market-sponsor', launchFeeKoin: 100 }
        : url.endsWith('/api/dapp/create') ? { ok: true, sessionId: 'session', secret: 'secret', uri: pairUri, expiresAt: Date.now() + 60000 }
        : url === '/api/launch/prepare' ? { transaction: launchTx }
        : url === '/api/launch/submit' ? { ok: true, collection: 'launched', initialized: true }
        : url.includes('/request-status?') ? { ok: true, status: outcome, signedTransaction: outcome === 'signed' ? { ...launchTx, signatures: ['passkey'] } : null, txid: outcome === 'approved' ? 'mined-id' : null, error: outcome === 'failed' ? 'chain refused' : null }
        : url.includes('/status?') ? { ok: true, address: 'account' }
        : { ok: true, requestId: 'request' };
      return { ok: true, json: async () => data };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('public/js/vault.js','utf8') + '\nglobalThis.vault = Vault;', context);
  const wallet = fs.readFileSync('public/js/wallet.js','utf8').replace('init, onChange, connectKondor,', 'send, init, onChange, connectKondor,');
  vm.runInContext(wallet + '\nglobalThis.wallet = Wallet;', context);
  return { ...context, calls };
}
const session = { sessionId: 'session', secret: 'secret', address: 'account' };
test('Vault routes operations directly, returns confirmed id, and never calls marketplace sponsor', async () => {
  const c = setup(); await c.wallet.init(); c.wallet.adoptVault(session);
  const ops = [{ call_contract: { contract_id: 'market', entry_point: 123, args: 'AA==' } }];
  assert.equal((await c.wallet.send(ops)).id, 'mined-id');
  assert.deepEqual(c.calls.find(x => x.url.endsWith('/api/dapp/request')).body.operations, ops);
  assert.ok(!c.calls.some(x => x.url === '/api/sponsor'));
  assert.equal(c.localStorage.getItem('mk_wif'), null);
  assert.equal(c.vault.load().address, 'account');
  c.wallet.disconnect(); assert.equal(c.vault.load(), null);
});
for (const outcome of ['rejected','failed']) test('Vault propagates ' + outcome + ' without rebroadcasting', async () => {
  const c = setup(outcome);
  await assert.rejects(c.vault.send(session, []), outcome === 'rejected' ? /rejected/ : /chain refused/);
  assert.equal(c.calls.filter(x => x.url.endsWith('/api/dapp/request')).length, 1);
});
test('Vault restores only a session whose live address still matches', async () => {
  const c = setup(); c.localStorage.setItem('mk_kind','vault'); c.vault.save(session);
  await c.wallet.init(); assert.equal(c.wallet.account.address, 'account');
  const d = setup(); d.localStorage.setItem('mk_kind','vault'); d.vault.save({ ...session, address: 'different' });
  await d.wallet.init(); assert.equal(d.wallet.account, null); assert.equal(d.vault.load(), null);
});
test('QR generator encodes the connection locally', () => {
  const qr = require('../public/js/vendor/qrcode');
  const code = qr(0, 'M'); code.addData('https://koinvault.app/?connect=session&secret=secret'); code.make();
  assert.ok(code.getModuleCount() > 20); assert.match(code.createSvgTag(), /<svg/);
});
test('paid launch waits for Vault signature and submits the approved transaction to OURO', async () => {
  const c = setup('signed'); await c.wallet.init(); c.wallet.adoptVault(session);
  assert.equal((await c.wallet.launchCollection({ name: 'Example' })).collection, 'launched');
  assert.equal(c.calls.find(x => x.url === '/api/launch/prepare').body.wallet, 'vault');
  assert.equal(c.calls.filter(x => x.url.endsWith('/api/dapp/launch')).length, 1);
  const submission = c.calls.find(x => x.url === '/api/launch/submit').body.transaction;
  assert.equal(submission.id, 'launch-id'); assert.deepEqual(submission.signatures, ['passkey']);
  assert.ok(!c.calls.some(x => x.url === '/api/sponsor'));
});
test('buy, cancel and batch listing use Vault and stay within six operations per approval', async () => {
  const c = setup(); await c.wallet.init(); c.wallet.adoptVault(session);
  await c.wallet.buyToken('collection', 'token', '100');
  await c.wallet.cancelOrder('collection', 'token');
  await c.wallet.listTokens('collection', Array.from({ length: 6 }, (_, i) => ({ tokenId: String(i), priceSats: '100' })));
  const requests = c.calls.filter(x => x.url.endsWith('/api/dapp/request'));
  assert.deepEqual(requests.map(x => x.body.operations.length), [2, 1, 6, 1]);
  assert.equal(requests[0].body.operations[0].call_contract.contract_id, 'koin');
  assert.equal(JSON.parse(requests[0].body.operations[0].call_contract.args).value, '100');
});

test('pairing uses koinvault.app for its API and QR, with matching session parameters', async () => {
  const c = setup(); const pair = await c.vault.create();
  assert.equal(new URL(pair.uri).origin, 'https://koinvault.app');
  assert.equal(c.calls[0].url, 'https://koinvault.app/api/dapp/create');
  assert.equal(c.calls[0].body.name, 'OURO');
  await c.vault.status(pair);
  assert.ok(c.calls.at(-1).url.startsWith('https://koinvault.app/api/dapp/status?'));
});
test('pairing rejects old-domain, hostile and mismatched connection links', async () => {
  for (const uri of [
    'https://wallet.usekoinos.com/?connect=session&secret=secret',
    'https://koinvault.app.evil.example/?connect=session&secret=secret',
    'https://koinvault.app/?connect=different&secret=secret',
    'https://koinvault.app/?connect=session&secret=different',
    'https://koinvault.app/other?connect=session&secret=secret',
  ]) await assert.rejects(setup('approved', uri).vault.create(), /unexpected wallet address/);
});
test('old-domain sessions require a fresh connection after the domain update', async () => {
  const c = setup(); c.localStorage.setItem('mk_kind', 'vault');
  c.sessionStorage.setItem('ouro:vault:v1', JSON.stringify(session));
  await c.wallet.init();
  assert.equal(c.wallet.account, null); assert.equal(c.vault.load(), null);
});
