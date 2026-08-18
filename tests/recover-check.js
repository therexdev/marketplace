#!/usr/bin/env node
/* Pulling a collection's art back out of the Internet Archive.

   The case this exists for: the operator lists somebody ELSE'S
   collection, its art host has been deleted for years, and of course
   they do not have the original files — but the art was on the public
   web long enough to be crawled. So the archive is asked for the exact
   urls the chain names, and whatever comes back is imported.

   Both ends are local here: this site, and a stand-in for the archive
   that answers CDX queries and serves snapshots the way web.archive.org
   does. What is being proven is the plumbing — that the tool asks for
   the right urls, refuses anything that is not an image, pins what it
   gets against the right token, and knows a collection with no urls at
   all is not its problem to solve.  */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRATCH = process.env.TEST_TMP || os.tmpdir();
const ROOT = path.join(__dirname, '..');
const PORT = 3983;
const ARCHIVE_PORT = 3984;
const KEY = 'test-admin-key';
let fails = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const ELEMENTUS = '1EwJUW4BFbA4EGmSyB9bgdhB3gk2f3shRN'; // images dead, metadata on chain
const PUNKS = '19g4oTs39Lg3ZCjKs9w9B6NjQzswB69QwU';      // every file on its own share path
const DARK = '1N2AhqGGticZ8hYmwNPWoroEBvTp3YGsLW';      // metadata dead: names nothing
const art = (n) => `https://storage.googleapis.com/kondor-elementus-nft/elementus/${n}.png`;
/* Storj share links gave every single file its own path segment — the
   shape that would otherwise cost one archive query per token. */
const share = (n) => `https://link-that-expired.invalid/raw/j${'abcdefghijklmnopqrstuvwxyz'[n % 26]}${n}x/koinospunks/nfts/${n}.png`;

/* What the archive crawled: two of the three tokens, plus one url that
   answers with a courtesy page instead of the art. */
const SNAPSHOTS = {
  [art(1)]: { ts: '20210417081500', body: PNG },
  [art(20)]: { ts: '20211102113000', body: Buffer.from('<!doctype html><h1>Sorry, this bucket is gone</h1>') },
  [art(79)]: { ts: '20200914040000', body: PNG },
};
const PUNK_IDS = Array.from({ length: 30 }, (_, i) => i + 1);
for (const n of PUNK_IDS) SNAPSHOTS[share(n)] = { ts: '20220301120000', body: PNG };

let srv, archive;
process.on('exit', () => { try { srv && srv.kill(); } catch (_) {} try { archive && archive.close(); } catch (_) {} });

const dataDir = path.join(SCRATCH, 'recover-check-' + process.pid);

(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'index'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'collections.json'), JSON.stringify({
    collections: [
      { address: ELEMENTUS, name: 'Kondor Elementus', description: '', image: '', featured: false, addedAt: 1 },
      { address: PUNKS, name: 'Koinos Punks', description: '', image: '', featured: false, addedAt: 2 },
      { address: DARK, name: 'OG-REX', description: '', image: '', featured: false, addedAt: 3 },
    ],
  }));
  const row = (n) => ({ tokenId: '0x' + n.toString(16).padStart(4, '0'), label: String(n), name: `Kondor Elementus #${n}`, image: art(n), traits: {} });
  const tokens = [row(1), row(20), row(79), row(105)];  // 105 was never crawled
  fs.writeFileSync(path.join(dataDir, 'index', ELEMENTUS + '.json'),
    JSON.stringify({ at: Date.now(), value: { tokens, facets: [], total: tokens.length, partial: false, scheme: 'kcs2' } }));
  const punkTokens = PUNK_IDS.map((n) => ({ tokenId: '0x' + (0x1000 + n).toString(16), label: String(n), name: `Koinos Punks #${n}`, image: share(n), traits: {} }));
  fs.writeFileSync(path.join(dataDir, 'index', PUNKS + '.json'),
    JSON.stringify({ at: Date.now(), value: { tokens: punkTokens, facets: [], total: punkTokens.length, partial: false, scheme: 'legacy' } }));
  fs.writeFileSync(path.join(dataDir, 'index', DARK + '.json'),
    JSON.stringify({ at: Date.now(), value: { tokens: [{ tokenId: '0x01', label: '1', name: '1', image: null, traits: {} }], facets: [], total: 1, partial: false, scheme: 'legacy' } }));

  /* A stand-in for web.archive.org: the two endpoints the tool uses. */
  let cdxCalls = 0;
  archive = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/cdx/search/cdx') {
      cdxCalls++;
      const q = u.searchParams.get('url') || '';
      const pattern = q.endsWith('*') ? q.slice(0, -1) : null;
      const rows = Object.entries(SNAPSHOTS)
        .filter(([orig]) => (pattern ? orig.startsWith(pattern) : orig === q))
        .map(([orig, s]) => [orig, s.ts]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rows.length ? [['original', 'timestamp'], ...rows] : []));
    }
    const m = /^\/web\/(\d+)id_\/(.+)$/.exec(decodeURIComponent(u.pathname + u.search));
    const snap = m && SNAPSHOTS[m[2]];
    if (!snap || snap.ts !== m[1]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(snap.body);
  });
  await new Promise((r) => archive.listen(ARCHIVE_PORT, r));

  srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, ADMIN_KEY: KEY }),
    stdio: process.env.KC_TEST_STDIO ? 'inherit' : ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/config`); if (r.ok) break; } catch (_) {}
    await sleep(250);
  }

  const api = async (p) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const run = (args) => new Promise((resolve) => {
    const p = spawn('node', ['tools/recover-art.js', '--site', `http://127.0.0.1:${PORT}`, '--key', KEY,
      '--archive', `http://127.0.0.1:${ARCHIVE_PORT}`, ...args], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
  });

  console.log('\nrecovering art from the archive\n');

  /* ---- the manifest a rescue works from ---- */
  let r = await api(`/api/collections/${ELEMENTUS}/art`);
  check('the art manifest demands the admin key', r.status === 403, JSON.stringify(r.body));

  r = await api(`/api/collections/${ELEMENTUS}/art?key=${KEY}&missing=1`);
  check('…and reports the source urls nothing else can see, with what is missing',
    r.status === 200 && r.body.missing === 4 && r.body.held === 0 &&
    r.body.tokens.every((t) => /^https:\/\/storage\.googleapis\.com\//.test(t.source)),
    JSON.stringify(r.body).slice(0, 200));

  /* ---- survey first: is any of it there at all? ---- */
  let got = await run(['--collection', ELEMENTUS, '--survey']);
  check('a survey counts the snapshots without importing a byte',
    got.code === 0 && /3 of 4 missing token\(s\) have a snapshot/.test(got.out) &&
    (await api(`/api/collections/${ELEMENTUS}/art?key=${KEY}`)).body.held === 0,
    got.out.slice(-300));
  check('…in one archive query per directory, not one per token',
    cdxCalls <= 2, `cdx calls=${cdxCalls}`);

  /* ---- then the recovery itself ---- */
  got = await run(['--collection', ELEMENTUS]);
  check('recovery imports what the archive really holds',
    got.code === 0 && /recovered 2, not an image 1, failed 0/.test(got.out), got.out.slice(-400));

  const after = (await api(`/api/collections/${ELEMENTUS}/art?key=${KEY}`)).body;
  check('…pinned against the tokens whose metadata names those urls',
    after.held === 2 && after.tokens.filter((t) => t.state === 'pinned').map((t) => t.label).join(',') === '1,79',
    JSON.stringify(after.tokens));

  const tok = await fetch(`http://127.0.0.1:${PORT}/img/t/${ELEMENTUS}/0x0001`);
  const bytes = Buffer.from(await tok.arrayBuffer());
  check('…and the site serves those bytes back as the token\'s art',
    tok.ok && bytes.equals(PNG), `status=${tok.status} len=${bytes.length}`);

  const cover = ((await api('/api/collections')).body.collections || []).find((c) => c.address === ELEMENTUS);
  check('…and the collection that had no cover is fronted with the rescue',
    cover && cover.image === `/img/c/${ELEMENTUS}`, JSON.stringify(cover));

  /* ---- a courtesy page is not art, and never becomes art ---- */
  check('a page the host returned instead of the art is refused',
    after.tokens.find((t) => t.label === '20')?.state === 'missing' && /not an image/.test(got.out),
    JSON.stringify(after.tokens.find((t) => t.label === '20')));

  /* ---- a drop that gave every file its own path is still ONE ask ---- */
  const before = cdxCalls;
  got = await run(['--collection', PUNKS]);
  check('thirty files on thirty paths cost the archive one query, not thirty',
    got.code === 0 && /recovered 30, not an image 0, failed 0/.test(got.out) && cdxCalls - before === 1,
    `cdx calls=${cdxCalls - before} :: ${got.out.slice(-300)}`);

  /* ---- and a collection that names nothing is told the truth ---- */
  got = await run(['--collection', DARK]);
  check('a collection whose metadata died is sent to set-cover, not on a hunt',
    got.code === 0 && /names no art at all/.test(got.out) && /set-cover/.test(got.out), got.out.slice(-300));

  console.log(`\n${fails ? `${fails} failed` : 'all good'}\n`);
  srv.kill(); archive.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { srv && srv.kill(); archive && archive.close(); } catch (_) {} process.exit(1); });
