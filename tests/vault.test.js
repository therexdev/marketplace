'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) || null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };
function setup(outcome = 'approved') {
  const calls = [], sessionStorage = storage(), localStorage = storage();
  const context = {
    URL, URLSearchParams, AbortSignal, Event, console, sessionStorage, localStorage,
    location: { origin: 'https://ouro.lifestyle' }, setTimeout: fn => { fn(); },
    window: { dispatchEvent() {} }, Provider: class {},
    utils: { tokenAbi: {} },
    Contract: class { constructor({ id }) { this.id = id; } encodeOperation({ name, args }) { return { call_contract: { contract_id: this.id, entry_point: name, args: JSON.stringify(args) } }; } },
    fetch: async (url, opts = {}) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      const data = url === '/api/config' ? { network: 'mainnet', rpcs: [], market: 'market', koin: 'koin', sponsor: true, sponsorPayer: 'market-sponsor', launchFeeKoin: 100 }
        : url.includes('/request-status?') ? { ok: true, status: outcome, txid: outcome === 'approved' ? 'mined-id' : null, error: outcome === 'failed' ? 'chain refused' : null }
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
  await assert.rejects(c.wallet.launchCollection({}), /Paid collection launches/);
  assert.ok(!c.calls.some(x => x.url === '/api/launch/prepare'));
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
  const code = qr(0, 'M'); code.addData('https://wallet.usekoinos.com/?connect=session&secret=secret'); code.make();
  assert.ok(code.getModuleCount() > 20); assert.match(code.createSvgTag(), /<svg/);
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
