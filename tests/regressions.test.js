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
    app.caches.get('orders:' + PAINT).at = 0;
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
