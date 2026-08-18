#!/usr/bin/env node
/* Covers for collections the internet stopped serving.

   Three cards out of the audit, none of which can fetch its own art any
   more, and the three ways one still ends up with a cover:

     * art the operator IMPORTED is proof enough — the hunt has to accept
       what this server can serve, not only what an origin still answers;
     * one dead url at the front of the queue must not end the hunt;
     * a collection whose metadata died names nothing at all, so the
       admin key hands it a cover — and can take it back.

   Entirely local: no chain, no gateway, no clock to wait out. The
   registry, the collection indexes and the pinned art are written into
   DATA_DIR before boot exactly as a live deployment would hold them, and
   every url in here is .invalid — so anything that loads, loaded from
   this server.  */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const SCRATCH = process.env.TEST_TMP || os.tmpdir();
const ROOT = path.join(__dirname, '..');
const PORT = 3982;
const KEY = 'test-admin-key';
let fails = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A real 1x1 PNG — the art cache sniffs magic bytes, not extensions. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

/* The three collections, with the addresses they really have on chain. */
const RESCUED = '1EwJUW4BFbA4EGmSyB9bgdhB3gk2f3shRN'; // art host deleted, art re-imported
const IMPORTED = '19g4oTs39Lg3ZCjKs9w9B6NjQzswB69QwU'; // art host expired, imported in this run
const DARK = '1N2AhqGGticZ8hYmwNPWoroEBvTp3YGsLW'; // metadata host gone: names nothing at all

const PINNED_URL = 'https://storage-that-vanished.invalid/elementus/1.png';
const DEAD_URL = 'https://storage-that-vanished.invalid/elementus/79.png';
const EXPIRED_URL = 'https://link-that-expired.invalid/koinospunks/nfts/3.png';

let srv;
process.on('exit', () => { try { srv && srv.kill(); } catch (_) {} });

const dataDir = path.join(SCRATCH, 'cover-check-' + process.pid);
const idxRow = (n, image) => ({ tokenId: '0x' + n.toString(16).padStart(2, '0'), label: String(n), name: '#' + n, image, traits: {}, owner: null });
const writeIndex = (addr, tokens) => fs.writeFileSync(
  path.join(dataDir, 'index', addr + '.json'),
  JSON.stringify({ at: Date.now(), value: { tokens, facets: [], total: tokens.length, partial: false, scheme: 'legacy' } }));

(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const d of ['index', 'imgcache']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });

  /* The registry as the operator left it: three collections, no covers. */
  fs.writeFileSync(path.join(dataDir, 'collections.json'), JSON.stringify({
    collections: [
      { address: RESCUED, name: 'Kondor Elementus', description: '125 pieces from the Kollection era.', image: '', featured: false, addedAt: 1 },
      { address: IMPORTED, name: 'Koinos Punks', description: '200 pieces from the Kollection era.', image: '', featured: false, addedAt: 2 },
      { address: DARK, name: 'OG-REX', description: 'Original metadata host is gone.', image: '', featured: false, addedAt: 3 },
    ],
  }, null, 2));

  /* Indexes as the walks left them. Candidates are taken newest-first,
     so the dead url is the one the hunt meets FIRST. */
  writeIndex(RESCUED, [idxRow(1, PINNED_URL), idxRow(79, DEAD_URL)]);
  writeIndex(IMPORTED, [idxRow(3, EXPIRED_URL)]);
  writeIndex(DARK, [idxRow(1, null), idxRow(2, null)]);  // metadata dead: labels, no art

  /* One artwork already imported, pinned under the url its metadata
     names — the archive a dead host leaves behind. */
  const key = crypto.createHash('sha256').update(PINNED_URL).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'imgcache', key), PNG);
  fs.writeFileSync(path.join(dataDir, 'imgcache', key + '.json'),
    JSON.stringify({ type: 'image/png', src: PINNED_URL, size: PNG.length, at: Date.now(), pinned: true }));

  srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, KOINOS_NETWORK: 'mainnet', ADMIN_KEY: KEY,
    }),
    stdio: process.env.KC_TEST_STDIO ? 'inherit' : ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/config`); if (r.ok) break; } catch (_) {}
    await sleep(250);
  }

  const api = async (p, opts) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, opts);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const rowOf = async (addr) => ((await api('/api/collections')).body.collections || []).find((c) => c.address === addr) || {};
  const until = async (fn, ms = 45000) => {
    const stop = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > stop) return v;
      await sleep(500);
    }
  };
  const bytesAt = async (p) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: 'manual' });
    return { status: r.status, type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) };
  };

  console.log('\ncovers for art the internet lost\n');

  /* ---- 1. the hunt believes the archive, and walks past a dead url ---- */
  const rescued = await until(async () => {
    const row = await rowOf(RESCUED);
    return row.image ? row : null;
  });
  check('a dead url at the head of the queue does not end the cover hunt',
    !!rescued && rescued.image === `/img/c/${RESCUED}`, JSON.stringify(rescued));

  const art = await bytesAt(`/img/c/${RESCUED}`);
  check('…and the cover it settles on serves the imported bytes from here',
    art.status === 200 && /^image\/png/.test(art.type) && art.body.equals(PNG),
    `status=${art.status} type=${art.type} bytes=${art.body.length}`);

  /* ---- 2. nothing is invented for a collection that names nothing ---- */
  check('a collection whose metadata died is given no cover it never had',
    (await rowOf(DARK)).image === '', JSON.stringify(await rowOf(DARK)));

  /* ---- 3. an import fronts a coverless collection with what it brought ---- */
  const imp = await fetch(
    `http://127.0.0.1:${PORT}/api/art?key=${KEY}&collection=${IMPORTED}&file=3.png`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: PNG });
  const impBody = await imp.json().catch(() => ({}));
  check('importing art the host lost is accepted against the url the metadata names',
    imp.status === 200 && impBody.pinned === 1, `${imp.status} ${JSON.stringify(impBody)}`);

  const imported = await until(async () => {
    const row = await rowOf(IMPORTED);
    return row.image ? row : null;
  }, 15000);
  check('…and a collection with no cover is fronted with it at once',
    !!imported && imported.image === `/img/c/${IMPORTED}`, JSON.stringify(imported));
  const impArt = await bytesAt(`/img/c/${IMPORTED}`);
  check('…served from the archive, not from the host that lost it',
    impArt.status === 200 && impArt.body.equals(PNG), `status=${impArt.status} bytes=${impArt.body.length}`);

  /* ---- 4. the admin key can hand a cover to a collection that has none ---- */
  const patch = (addr, body) => api(`/api/collections/${addr}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  let r = await patch(DARK, { image: 'https://example.invalid/cover.png' });
  check('setting a cover demands the admin key', r.status === 403, JSON.stringify(r.body));

  const up = await (await fetch(`http://127.0.0.1:${PORT}/api/upload`,
    { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).json();
  r = await patch(DARK, { key: KEY, image: up.url, description: 'Art restored by hand.' });
  check('…and with it, an already-registered collection takes one',
    r.status === 200 && /^\/u\/[a-f0-9]+\.png$/.test(r.body.collection?.image || ''), JSON.stringify(r.body));

  const dark = await rowOf(DARK);
  check('…which the home page shows without waiting for a rebuild',
    dark.image === r.body.collection.image && dark.description === 'Art restored by hand.', JSON.stringify(dark));
  const darkArt = await bytesAt(dark.image || '/nope');
  check('…and which serves the uploaded bytes',
    darkArt.status === 200 && darkArt.body.equals(PNG), `status=${darkArt.status} bytes=${darkArt.body.length}`);

  r = await patch(DARK, { key: KEY, image: 'javascript:alert(1)' });
  check('a cover cannot be pointed at just anything', r.status === 400, JSON.stringify(r.body));

  r = await patch(DARK, { key: KEY, image: null });
  const cleared = await rowOf(DARK);
  check('clearing a cover hands the collection back to the automatic hunt',
    r.status === 200 && cleared.image === '', JSON.stringify({ patch: r.body, row: cleared }));

  r = await patch('1MDyZtgrmBbH63FuGd7JXT4mSQfgBAUzWk', { key: KEY, image: null });
  check('editing a collection nobody registered is a 404', r.status === 404, JSON.stringify(r.body));

  /* ---- 5. and the card can say why it is still a placeholder ---- */
  r = await api(`/api/collections/${DARK}/cover`);
  check('the cover diagnostic demands the admin key', r.status === 403, JSON.stringify(r.body));

  r = await api(`/api/collections/${DARK}/cover?key=${KEY}`);
  check('…and tells a collection that names no art from one that merely failed',
    r.status === 200 && !r.body.candidates.length && /metadata host is gone/.test(r.body.hint || ''),
    JSON.stringify(r.body));

  r = await api(`/api/collections/${IMPORTED}/cover?key=${KEY}`);
  check('…and reports imported art as the archive it is',
    r.status === 200 && (r.body.candidates || []).some((c) => c.url === EXPIRED_URL && c.state === 'pinned'),
    JSON.stringify(r.body));

  console.log(`\n${fails ? `${fails} failed` : 'all good'}\n`);
  srv.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { srv.kill(); } catch (_) {} process.exit(1); });
