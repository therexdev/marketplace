'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { dataImage, metadataImage, normalizeImage, ipfsRoots, firstAvailable, limitedBody } = require('../lib/media');
const { harness, PAINT, CREW, TOKEN, paint } = require('./fixtures/server-harness');
const delay = ms => new Promise(r => setTimeout(r, ms));
const get = (app, url) => fetch(app.base + url).then(r => r.json());

const DUCKS = '1EpeEKtMaH7nV3ZthEk1Emw4F6y6ZEhQNa';
const DUCK_OWNER = '1JtWgDM3tN2zEFUmhMvSJF43dCGRNsJ83m';
const duckId = n => '0x' + Buffer.from('DUCK' + String(n).padStart(4, '0')).toString('hex');
const orderKey = o => '0x' + Buffer.concat([Buffer.from(require('koilib').utils.decodeBase58(o.collection)), Buffer.from(o.token_id.slice(2), 'hex')]).toString('hex');
const byStorageKey = (a, b) => orderKey(a).length - orderKey(b).length || orderKey(a).localeCompare(orderKey(b));

test('Google, email login, and registration use the canonical bridge without losing credentials', async () => {
  for (const origin of [' https://aurvania.quest/ ', 'https://www.aurvania.quest', 'https://koinoscrusaders.com', 'https://aurvania.com']) {
    const requests = [];
    const app = await harness({ env: { AURVANIA_API: origin }, fetch: async (url, opts) => {
      requests.push({ url, opts });
      return new Response(JSON.stringify({ wif: 'fixture-only', address: DUCK_OWNER }), { status: 200 });
    } });
    try {
      assert.equal((await get(app, '/api/config')).aurvania, 'https://aurvania.com');
      for (const body of [{ action: 'google', idToken: 'fixture-google-token' }, { action: 'login', email: 'fixture@example.test', password: 'fixture-password' }, { action: 'register', email: 'fixture@example.test', password: 'fixture-password' }]) {
        const r = await fetch(app.base + '/api/account', { method: 'POST', body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).address, DUCK_OWNER);
        const call = requests.at(-1);
        assert.equal(call.url, 'https://aurvania.com/api/account');
        assert.equal(call.opts.method, 'POST');
        assert.deepEqual(JSON.parse(call.opts.body), body);
      }
      assert.equal(requests.length, 3);
    } finally { await app.close(); }
  }
});

test('custom account servers remain supported; redirects and invalid credentials never sign in', async () => {
  let requests = 0, redirected = 0, redirect = true;
  const upstream = require('http').createServer((req, res) => {
    if (req.url === '/wrong') { redirected++; res.end('{}'); return; }
    requests++;
    if (redirect) { res.writeHead(301, { Location: '/wrong' }); res.end(); }
    else { res.writeHead(401); res.end(JSON.stringify({ error: 'Google rejected that sign-in — try again' })); }
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const app = await harness({ env: { AURVANIA_API: origin }, fetch });
  try {
    const login = () => fetch(app.base + '/api/account', { method: 'POST', body: JSON.stringify({ action: 'google', idToken: 'invalid-diagnostic-token' }) });
    assert.equal((await get(app, '/api/config')).aurvania, origin);
    const failed = await login();
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).wif, undefined);
    assert.equal(requests, 1, 'account POST must not be retried');
    assert.equal(redirected, 0, 'credentials must not follow an unexpected redirect');
    redirect = false;
    const invalid = await login();
    assert.equal(invalid.status, 401);
    assert.match((await invalid.json()).error, /Google rejected/);
  } finally {
    await app.close();
    upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
  }
});

test('Block Ducks shows nine active 5 KOIN orders and only Duck 2 as unlisted', async () => {
  // Public mainnet state observed 2026-09-10: scoped enumeration is empty,
  // but the global book and individual reads contain all nine live orders.
  const book = Array.from({ length: 10 }, (_, i) => i + 1).filter(n => n !== 2).map(n => ({
    collection: DUCKS, seller: DUCK_OWNER, token_id: duckId(n), price: '500000000', expires: '0', created: '1787687486020',
  }));
  const app = await harness({ chain: (id, method, args) => {
    if (method === 'get_orders') return { result: { value: args.collection ? [] : book } };
    if (id === DUCKS && method === 'total_supply') return { result: { value: '10' } };
    if (id === DUCKS && method === 'get_tokens') return { result: { token_ids: Array.from({ length: 10 }, (_, i) => duckId(i + 1)) } };
    if (id === DUCKS && method === 'get_tokens_by_owner') return { result: { token_ids: Array.from({ length: 10 }, (_, i) => duckId(i + 1)) } };
    if (method === 'get_order') return { result: book.find(o => o.token_id === args.token_id) || {} };
  } });
  try {
    fs.writeFileSync(path.join(app.dataDir, 'index', DUCKS + '.json'), JSON.stringify({ at: Date.now(), value: {
      tokens: Array.from({ length: 10 }, (_, i) => ({ tokenId: duckId(i + 1), label: `DUCK${i + 1}`, name: `Duck #${i + 1}`, traits: {}, image: null })), facets: [], total: 10, partial: false,
    } }));
    const detail = await get(app, `/api/collections/${DUCKS}`);
    assert.equal(detail.orders.length, 9);
    assert.ok(detail.orders.every(o => o.price === '500000000'));
    const grid = await get(app, `/api/collections/${DUCKS}/tokens?status=listed`);
    assert.equal(grid.matched, 9);
    assert.ok(grid.tokens.every(t => t.order && t.tokenId !== duckId(2)));
    const mine = await get(app, `/api/collections/${DUCKS}/tokens?owner=${DUCK_OWNER}&status=unlisted`);
    assert.deepEqual(mine.tokens.map(t => t.tokenId), [duckId(2)]);
    assert.equal((await get(app, `/api/collections/${DUCKS}/facets`)).listed, 9);
    const home = await get(app, '/api/collections');
    assert.ok(home.collections.every(c => c.listed === 0), 'other collections must not inherit duck orders');
    assert.equal(app.calls.filter(c => c.method === 'get_orders').length, 1, 'views share one full-book read');
  } finally { await app.close(); }
});

test('global order pagination uses full keys across collections and variable token lengths', async () => {
  const book = Array.from({ length: 205 }, (_, i) => ({
    collection: i % 2 ? CREW : PAINT, seller: DUCK_OWNER,
    token_id: '0x' + Buffer.from('N' + String(i).padStart(i < 202 ? 4 : 7, '0')).toString('hex'),
    price: '100000000', expires: i === 0 ? '1' : '0',
  })).sort(byStorageKey);
  const app = await harness({ chain: (_, method, args) => {
    if (method !== 'get_orders') return;
    assert.equal(args.collection, undefined);
    const start = args.start_after ? book.findIndex(o => orderKey(o) === args.start_after) + 1 : 0;
    if (args.start_after) assert.ok(start > 0, 'cursor includes the address and token bytes');
    return { result: { value: book.slice(start, start + args.limit) } };
  } });
  try {
    const a = await get(app, `/api/collections/${PAINT}`);
    const b = await get(app, `/api/collections/${CREW}`);
    assert.equal(a.orders.length + b.orders.length, 204, 'expired order omitted');
    assert.ok(a.orders.every(o => o.collection === PAINT));
    assert.ok(b.orders.every(o => o.collection === CREW));
    assert.equal(app.calls.filter(c => c.method === 'get_orders').length, 2);
  } finally { await app.close(); }
});

test('failed order refresh never exposes listed NFTs to List all', async () => {
  let failure = false;
  const app = await harness({ chain: (_, method) => { if (failure && method === 'get_orders') throw new Error('RPC down'); } });
  try {
    await app.rebuildIndex(PAINT);
    await get(app, `/api/collections/${PAINT}/tokens`);
    app.caches.get('market-orders').at = Date.now() - 11000;
    failure = true;
    const unlisted = await fetch(app.base + `/api/collections/${PAINT}/tokens?status=unlisted&owner=${CREW}`);
    assert.equal(unlisted.status, 503);
    const body = await unlisted.json();
    assert.match(body.error, /Could not verify listings/);
    assert.equal(body.tokens, undefined);
    app.caches.get('market-orders').at = 0;
    assert.equal((await fetch(app.base + `/api/collections/${PAINT}`)).status, 503);
  } finally { await app.close(); }
});

test('a confirmed individual listing updates the collection grid immediately', async () => {
  let listed = false;
  const app = await harness({ chain: (_, method) => {
    if (method === 'get_order') return { result: listed ? { seller: CREW, price: '500000000', expires: '0' } : {} };
  } });
  try {
    await app.rebuildIndex(PAINT);
    assert.equal((await get(app, `/api/collections/${PAINT}/tokens?status=listed`)).matched, 0);
    listed = true;
    await get(app, `/api/collections/${PAINT}/token/${TOKEN}`);
    assert.equal((await get(app, `/api/collections/${PAINT}/tokens?status=listed`)).matched, 1);
    assert.equal((await get(app, `/api/collections/${PAINT}/tokens?status=unlisted`)).matched, 0);
    listed = false;
    await get(app, `/api/collections/${PAINT}/token/${TOKEN}`);
    assert.equal((await get(app, `/api/collections/${PAINT}/tokens?status=listed`)).matched, 0);
  } finally { await app.close(); }
});

test('a stuck pagination cursor fails without caching an incomplete order book', async () => {
  const book = Array.from({ length: 200 }, (_, i) => ({ collection: PAINT, seller: CREW, token_id: '0x' + i.toString(16).padStart(4, '0'), price: '1' }));
  const app = await harness({ chain: (_, method) => method === 'get_orders' ? { result: { value: book } } : undefined });
  try {
    const response = await fetch(app.base + `/api/collections/${PAINT}`);
    assert.equal(response.status, 503);
    assert.equal(app.caches.has('market-orders'), false);
    assert.equal(app.calls.filter(c => c.method === 'get_orders').length, 2);
  } finally { await app.close(); }
});

test('real Discover Paint metadata retains embedded SVG and supports image_data', () => {
  const art = dataImage(metadataImage(paint));
  assert.equal(art.type, 'image/svg+xml');
  assert.match(art.bytes.toString(), /^<svg/);
  assert.equal(dataImage(metadataImage({ image_data: '<svg xmlns="http://www.w3.org/2000/svg"/>' })).type, 'image/svg+xml');
  assert.equal(normalizeImage('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(normalizeImage('data:image/png;base64,???'), null);
  assert.equal(normalizeImage('javascript:alert(1)'), null);
  assert.equal(dataImage('data:image/svg+xml,%ZZ'), null);
});

test('IPFS URI formats retain the CID, path, and encoded spaces', () => {
  const cid = 'bafybeidssqmc2cjlpmy3rnxq6ehbvvwb3pqewtndhfcqlznx6bw2jsig3y';
  const expected = `https://ipfs.io/ipfs/${cid}/The%20Crew.png`;
  for (const url of [`ipfs://${cid}/The%20Crew.png`, `ipfs://ipfs/${cid}/The%20Crew.png`, `https://${cid}.ipfs.nftstorage.link/The%20Crew.png`, `https://gateway.example/ipfs/${cid}/The%20Crew.png`]) assert.equal(ipfsRoots(url)[0], expected);
});

test('gateway racing ignores quick failures and aborts the stalled loser', async () => {
  let aborted = false;
  const result = await firstAvailable(['bad', 'healthy', 'stalled'], async (url, signal) => {
    if (url === 'bad') throw new Error('404');
    if (url === 'healthy') { await delay(20); return 'image bytes'; }
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }));
  }, 200);
  assert.equal(result, 'image bytes');
  assert.equal(aborted, true);
});

test('streaming metadata and artwork limits reject an oversized body', async () => {
  await assert.rejects(limitedBody(new Response(Buffer.alloc(1025)), 1024), /too large/);
  await assert.rejects(limitedBody(new Response('missing', { status: 404 }), 1024), /404/);
});

test('FREE comes from a zero on-chain fee; configured nonzero fees remain truthful', async () => {
  for (const feeBps of [0, 250]) {
    const app = await harness({ feeBps });
    try { assert.equal((await get(app, '/api/config')).feeBps, feeBps); }
    finally { await app.close(); }
  }
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const label = vm.runInNewContext(source.match(/const feeLabel = (.*);/)[1]);
  assert.equal(label(0), 'FREE');
  assert.equal(label(250), '2.5%');
  assert.equal(label(null), 'Unavailable');
  assert.doesNotMatch(source, /feeBps\s*\|\|\s*250/);
});

test('failed on-chain configuration is unavailable, never silently FREE', async () => {
  const app = await harness({ chain: (_, method) => { if (method === 'get_config') throw new Error('offline'); } });
  try { assert.equal((await get(app, '/api/config')).feeBps, null); }
  finally { await app.close(); }
});

test('home cover, collection grid and single NFT serve the exact on-chain SVG', async () => {
  const app = await harness();
  try {
    await app.rebuildIndex(PAINT);
    const grid = await get(app, `/api/collections/${PAINT}/tokens`);
    assert.equal(grid.tokens[0].image, `/img/t/${PAINT}/${TOKEN}`);
    const single = await get(app, `/api/collections/${PAINT}/token/${TOKEN}`);
    assert.equal(single.meta.image, grid.tokens[0].image);
    const home = await get(app, '/api/collections');
    const cover = home.collections.find(c => c.address === PAINT).image;
    assert.equal(cover, `/img/c/${PAINT}`);
    for (const url of [cover + '?w=480', grid.tokens[0].image + '?w=480', single.meta.image]) {
      const r = await fetch(app.base + url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers.get('content-type'), 'image/svg+xml');
      assert.match(r.headers.get('content-security-policy'), /sandbox/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await r.text(), dataImage(paint.image).bytes.toString());
    }
    assert.equal(app.imgBusy.size, 0);
  } finally { await app.close(); }
});

test('resolved metadata survives a process restart with its source offline', async () => {
  const first = await harness();
  await first.tokenMeta(PAINT, TOKEN);
  await first.close();
  const second = await harness({ dataDir: first.dataDir, chain: (_, method) => { if (method === 'metadata_of') throw new Error('offline'); } });
  try {
    assert.equal((await second.tokenMeta(PAINT, TOKEN)).image, paint.image);
    assert.equal(second.calls.filter(c => c.method === 'metadata_of').length, 0);
  } finally { await second.close(); }
});

test('Crew recovery repairs audited tokens without inventing unsampled mappings', async () => {
  const app = await harness();
  try {
    const meta = await app.tokenMeta(CREW, '0x31');
    assert.equal(meta.name, 'The Mastermind');
    assert.match(meta.image, /\/Mastermind\.png$/);
    assert.equal(await app.tokenMeta(CREW, '0x393939'), null);
    fs.writeFileSync(path.join(app.dataDir, 'index', CREW + '.json'), JSON.stringify({ at: Date.now(), value: { tokens: [{ tokenId: '0x31', name: '1', image: null, traits: {} }], facets: [], total: 1 } }));
    const recovered = app.indexPeek(CREW).value.tokens[0];
    assert.equal(recovered.name, 'The Mastermind');
    assert.match(recovered.image, /\/Mastermind\.png$/);
  } finally { await app.close(); }
});

test('cold browse responds while indexing is stalled, then becomes complete', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const app = await harness({ chain: async (id, method) => { if (id === PAINT && method === 'get_tokens') await gate; } });
  try {
    const before = performance.now();
    const pending = await get(app, `/api/collections/${PAINT}/tokens`);
    assert.equal(pending.loading, true);
    assert.equal(pending.partial, true);
    assert.ok(performance.now() - before < 500, 'browse waited for index');
    release();
    await app.rebuildIndex(PAINT);
    const complete = await get(app, `/api/collections/${PAINT}/tokens`);
    assert.equal(complete.loading, false);
    assert.equal(complete.tokens.length, 1);
  } finally { release(); await app.close(); }
});

test('concurrent cache misses and token metadata calls share their upstream read', async () => {
  const app = await harness();
  try {
    let reads = 0;
    const results = await Promise.all(Array.from({ length: 20 }, () => app.cached('same', 1000, async () => { reads++; await delay(20); return 7; })));
    assert.equal(reads, 1);
    assert.ok(results.every(x => x === 7));
    await Promise.all(Array.from({ length: 20 }, () => app.tokenMeta(PAINT, TOKEN)));
    assert.equal(app.calls.filter(c => c.method === 'metadata_of').length, 1);
  } finally { await app.close(); }
});

test('stored Google settings do not block config while the bridge refreshes', async () => {
  const app = await harness();
  await app.close();
  fs.writeFileSync(path.join(app.dataDir, 'gameinfo.json'), JSON.stringify({ googleClientId: 'remembered-client' }));
  const restored = await harness({ dataDir: app.dataDir, env: { GOOGLE_CLIENT_ID: '' }, fetch: async () => { await delay(200); throw new Error('bridge offline'); } });
  try {
    const before = performance.now();
    const cfg = await get(restored, '/api/config');
    assert.equal(cfg.googleClientId, 'remembered-client');
    assert.ok(performance.now() - before < 150, 'waited for bridge');
  } finally { await delay(220); await restored.close(); }
});

test('thumbnails preserve alpha, remain bounded, and keep HTTP responsive during encoding', async () => {
  const app = await harness();
  try {
    const { Jimp } = require('jimp');
    const img = new Jimp({ width: 1200, height: 1800, color: 0xff0000ff });
    // Noise creates an original large enough to need a derivative.
    for (let i = 0; i < img.bitmap.data.length; i += 4) {
      img.bitmap.data[i] = (i * 7 + (i >> 9)) % 256;
      img.bitmap.data[i + 1] = (i >> 4) % 256;
      img.bitmap.data[i + 3] = i % 64 === 4 ? 0 : 255;
    }
    const file = path.join(app.dataDir, 'test.png');
    fs.writeFileSync(file, await img.getBuffer('image/png'));
    assert.ok(fs.statSync(file).size > 96 * 1024);
    const thumb = app.thumbOf(file, 'image/png');
    const before = performance.now();
    assert.equal((await fetch(app.base + '/')).status, 200);
    assert.ok(performance.now() - before < 500, 'thumbnail blocked HTTP');
    const result = await thumb;
    assert.equal(result.type, 'image/png');
    const resized = await Jimp.read(result.file);
    assert.ok(resized.width <= 480 && resized.height <= 480);
    assert.ok(resized.bitmap.data.some((b, i) => i % 4 === 3 && b < 255));
    assert.equal(await app.thumbOf(file, 'image/gif'), null);
    assert.equal(await app.thumbOf(file, 'image/webp'), null);
  } finally { await app.close(); }
});

test('config command sets zero and preserves the deployed treasury/KOIN; rejects wrong market or invalid fee', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../contracts/deploy.js'), 'utf8');
  const realRequire = require('module').createRequire(path.join(__dirname, '../contracts/deploy.js'));
  for (const variant of ['zero', 'invalid', 'wrong-market']) {
    const calls = [], errors = [];
    const previous = { treasury: CREW, koin: PAINT, fee_bps: 250 };
    class Provider { async getAccountRc() { return '100000000000'; } }
    const Signer = { fromWif: key => ({ getAddress: () => key === 'market-key' ? CREW : PAINT }) };
    class Contract {
      constructor() { this.functions = {
        get_config: async () => ({ result: previous }),
        set_config: async args => { calls.push(args); return { transaction: { id: 'test', wait: async () => {} } }; },
      }; }
    }
    const keyfile = '/virtual/keys.env';
    const fakeFs = { ...fs,
      existsSync: file => file === keyfile || fs.existsSync(file),
      readFileSync: (file, ...args) => file === keyfile ? 'KOINOS_DEV_WIF=dev-key\nKOINOS_MARKET_WIF=market-key\n' : fs.readFileSync(file, ...args),
    };
    const argv = ['node', 'deploy.js', 'config', '--keys', keyfile, '--network', 'mainnet', '--market', variant === 'wrong-market' ? PAINT : CREW, '--fee-bps', variant === 'invalid' ? '2.5' : '0'];
    await vm.runInNewContext(source, {
      require: name => name === 'koilib' ? { Provider, Signer, Contract } : name === 'fs' ? fakeFs : realRequire(name),
      __dirname: path.join(__dirname, '../contracts'), process: { argv, exit: () => {} },
      console: { log() {}, error: e => errors.push(e) }, Buffer,
      setTimeout: fn => { queueMicrotask(fn); },
    });
    if (variant === 'zero') {
      assert.equal(errors.length, 0);
      assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ treasury: CREW, koin: PAINT, fee_bps: 0 }]);
    } else { assert.equal(calls.length, 0); assert.equal(errors.length, 1); }
  }
});

test('warm grids keep browsing while an order-book refresh is stalled', async () => {
  let block = false, release;
  const gate = new Promise(r => { release = r; });
  const app = await harness({ chain: async (_, method) => { if (block && method === 'get_orders') await gate; } });
  try {
    await app.rebuildIndex(PAINT);
    await get(app, `/api/collections/${PAINT}/tokens`);
    app.caches.get('market-orders').at = Date.now() - 11000;
    block = true;
    const start = performance.now();
    assert.equal((await get(app, `/api/collections/${PAINT}/tokens`)).tokens.length, 1);
    assert.ok(performance.now() - start < 500);
  } finally { release(); await app.close(); }
});


test('an old index with blank art still exposes the live token image endpoint', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const app = await harness({ chain: async (_, method) => { if (method === 'get_tokens') await gate; } });
  try {
    fs.writeFileSync(path.join(app.dataDir, 'index', PAINT + '.json'), JSON.stringify({
      at: Date.now(), value: { tokens: [{ tokenId: TOKEN, label: 'DK00001', name: 'Purple Dot', image: null, traits: {} }], facets: [], total: 1, partial: false },
    }));
    const grid = await get(app, `/api/collections/${PAINT}/tokens`);
    assert.equal(grid.tokens[0].image, `/img/t/${PAINT}/${TOKEN}`);
    const art = await fetch(app.base + grid.tokens[0].image);
    assert.equal(art.status, 200);
    assert.equal(await art.text(), dataImage(paint.image).bytes.toString());
  } finally { release(); await app.rebuildIndex(PAINT); await app.close(); }
});
