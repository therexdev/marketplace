#!/usr/bin/env node
/* Recover a collection's art from the Internet Archive.

   The usual restoration (tools/seed-art.js) assumes somebody still has
   the original files. Nobody listing OTHER PEOPLE'S collections does.
   But the art was on the public web for years before its host died, and
   the Wayback Machine crawls the public web — so ask IT for the exact
   urls the chain names, and import whatever comes back.

   Nothing here chooses a url. The collection's own metadata names them,
   this server reports them, and a snapshot either exists or it does not.

     node tools/recover-art.js --site https://ouro.lifestyle --key ADMIN_KEY \
          --collection 1EwJUW4BFbA4EGmSyB9bgdhB3gk2f3shRN --survey

   --survey asks only "was any of this ever archived?" and prints the
   answer without downloading a byte. Drop it to actually recover:

     node tools/recover-art.js --site … --key … --collection … [--limit 50]

   --limit caps how many tokens are attempted (a first run of 5 tells you
   whether the rest is worth waiting for). --archive points at a mirror.

   A collection whose METADATA host died names no urls at all — there is
   nothing here to recover, and the tool says so instead of pretending.
*/
'use strict';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const SITE = String(arg('site', '')).replace(/\/$/, '');
const KEY = arg('key', '');
const ADDR = arg('collection', '');
const ARCHIVE = String(arg('archive', 'https://web.archive.org')).replace(/\/$/, '');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const SURVEY = process.argv.includes('--survey');

if (!SITE || !KEY || !ADDR) {
  console.error('usage: node tools/recover-art.js --site https://… --key ADMIN_KEY --collection 1… [--survey] [--limit N]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* archive.org is a charity serving the whole internet: two at a time,
   and back off rather than hammer when it says it is busy. */
const PATIENT = [429, 503, 504, 520];
async function politely(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(2000 * i);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
      if (PATIENT.includes(r.status)) { try { await r.arrayBuffer(); } catch (_) {} continue; }
      return r;
    } catch (_) {}
  }
  return null;
}

/* Scheme, default ports and a trailing slash are noise when matching what
   the archive says it has against what the chain said it wanted. */
const norm = (u) => String(u || '')
  .replace(/^https?:\/\//i, '')
  .replace(/^([^/]+?):(80|443)(\/|$)/, '$1$3')
  .replace(/^([^/]+)/, (h) => h.toLowerCase());

/** Every snapshot the archive holds under one directory, in one ask. */
async function cdx(pattern) {
  const url = `${ARCHIVE}/cdx/search/cdx?url=${encodeURIComponent(pattern)}` +
    '&output=json&fl=original,timestamp&filter=statuscode:200&collapse=urlkey&limit=20000';
  const r = await politely(url);
  if (!r || !r.ok) return [];
  const rows = await r.json().catch(() => []);
  return (Array.isArray(rows) ? rows.slice(1) : []) // row 0 is the header
    .map(([original, timestamp]) => ({ original, timestamp }));
}

(async () => {
  const manifest = await fetch(`${SITE}/api/collections/${ADDR}/art?key=${encodeURIComponent(KEY)}&missing=1`,
    { signal: AbortSignal.timeout(120000) });
  const body = await manifest.json().catch(() => ({}));
  if (manifest.status === 503 && body.building) {
    console.error('The server is indexing this collection — give it a few minutes and run this again.');
    process.exit(1);
  }
  if (!manifest.ok) {
    console.error(`${manifest.status} ${body.error || 'could not read that collection'}`);
    if (manifest.status === 404) console.error('(a 404 here means the site is running a build without GET /api/collections/:address/art)');
    process.exit(1);
  }

  console.log(`${body.indexed} token(s) indexed · ${body.held} already here · ${body.missing} missing · ${body.unnamed} naming no art`);
  if (!body.missing) {
    console.log(body.unnamed === body.indexed
      ? '\nThis collection names no art at all — its METADATA host is gone, not just its images.\nThere is nothing to recover by url. Give the card a cover instead:\n  node tools/set-cover.js --site … --key … --collection ' + ADDR + ' --file cover.png'
      : '\nNothing missing — every url this collection names is already held here.');
    process.exit(0);
  }

  const wanted = LIMIT ? body.tokens.slice(0, LIMIT) : body.tokens;
  if (LIMIT && body.tokens.length > LIMIT) console.log(`(attempting the first ${LIMIT} of them)`);

  /* One CDX query per directory usually covers a whole collection —
     350 tokens, one ask. But some drops gave every file its own path
     (Storj share links carry a per-file token), and one query per token
     is not a favour to anybody's servers: past a couple of dozen
     directories, ask once for the longest prefix they all share. */
  const dirOf = (u) => u.replace(/[^/]*$/, '');
  let dirs = [...new Set(wanted.map((t) => dirOf(t.source)))];
  if (dirs.length > 25) {
    const [first] = dirs;
    let common = first;
    for (const d of dirs) { while (!d.startsWith(common)) common = common.slice(0, -1); }
    if (common.length > 12) {
      console.log(`${dirs.length} separate paths — asking once for what they share: ${common}`);
      dirs = [common];
    }
  }
  const found = new Map(); // normalised original -> timestamp
  for (const d of dirs) {
    for (const row of await cdx(d + '*')) {
      if (!found.has(norm(row.original))) found.set(norm(row.original), row.timestamp);
    }
  }
  console.log(`the archive holds ${found.size} snapshot(s) under ${dirs.length} path(s) this collection uses`);

  /* Whatever the bulk sweep missed is worth one exact ask each — up to a
     point, since these are serial and archive.org is somebody's charity.
     Past that the run says what it did not ask about rather than
     reporting a smaller "gone" than it actually measured. */
  const MOP_UP = 60;
  const misses = wanted.filter((t) => !found.has(norm(t.source)));
  if (misses.length) {
    const ask = misses.slice(0, MOP_UP);
    process.stdout.write(`asking url by url for ${ask.length} of the other ${misses.length}… `);
    for (const t of ask) {
      const rows = await cdx(t.source);
      if (rows.length) found.set(norm(t.source), rows[0].timestamp);
    }
    console.log('done');
    if (misses.length > ask.length) {
      console.log(`  (${misses.length - ask.length} url(s) were not asked about individually — rerun with --limit to work through them)`);
    }
  }

  const recoverable = wanted.filter((t) => found.has(norm(t.source)));
  console.log(`\n${recoverable.length} of ${wanted.length} missing token(s) have a snapshot`);
  if (SURVEY || !recoverable.length) {
    if (!recoverable.length) {
      console.log('\nNothing of this collection was ever crawled at those urls. The art is gone.');
      console.log('Give the card a cover so it stops reading as broken:');
      console.log(`  node tools/set-cover.js --site ${SITE} --key … --collection ${ADDR} --file cover.png`);
    } else if (SURVEY) {
      console.log('\nRun again without --survey to pull them in.');
    }
    process.exit(0);
  }

  const IMG_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46]];
  const looksImage = (b) => IMG_MAGIC.some((m) => m.every((v, i) => b[i] === v)) ||
    /^\s*<(\?xml|svg)/i.test(b.subarray(0, 64).toString('utf8'));

  let pinned = 0, notImage = 0, failed = 0;
  for (const t of recoverable) {
    const ts = found.get(norm(t.source));
    /* id_ asks for the ORIGINAL bytes: no toolbar, no rewritten links. */
    const r = await politely(`${ARCHIVE}/web/${ts}id_/${t.source}`);
    if (!r || !r.ok) { failed++; console.log(`  ✗ ${t.label}: archive would not serve ${ts}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (!buf.length || !looksImage(buf)) { notImage++; console.log(`  ✗ ${t.label}: what came back is not an image`); continue; }
    const imp = await fetch(
      `${SITE}/api/art?key=${encodeURIComponent(KEY)}&collection=${ADDR}&token=${t.tokenId}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf, signal: AbortSignal.timeout(120000) });
    const out = await imp.json().catch(() => ({}));
    if (imp.status === 200) { pinned++; console.log(`  ✓ ${t.name || t.label} (${buf.length} bytes, archived ${ts.slice(0, 8)})`); }
    else { failed++; console.log(`  ✗ ${t.label}: ${imp.status} ${out.error || ''}`); }
  }

  console.log(`\nrecovered ${pinned}, not an image ${notImage}, failed ${failed}`);
  if (pinned) console.log('The collection is fronted with the first one that landed; the rest are pinned to their tokens.');
  process.exit(failed && !pinned ? 1 : 0);
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
