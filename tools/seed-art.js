#!/usr/bin/env node
/* Restore a collection's art from local files, through the site's own
   admin import endpoint. Each image is matched BY FILENAME against the
   image urls in the collection's on-chain-derived metadata — the server
   does the matching, so this tool needs to know nothing but where the
   files are.

     node tools/seed-art.js --site https://ouro.lifestyle --key ADMIN_KEY \
          --collection 1FB7geE8MN1ViG91rkBE5iu27s2Khuo257 --dir ./crew-art \
          [--register]

   --register additionally adds the collection to the site's registry
   once the art is in (harmless if it is already registered). The first
   upload can take a while: the server may be building the collection's
   index, patiently resolving metadata from whatever host still answers.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SITE = String(arg('site', '')).replace(/\/$/, '');
const KEY = arg('key', '');
const ADDR = arg('collection', '');
const DIR = arg('dir', '');
const REGISTER = process.argv.includes('--register');

if (!SITE || !KEY || !ADDR || !DIR) {
  console.error('usage: node tools/seed-art.js --site https://… --key ADMIN_KEY --collection 1… --dir ./art [--register]');
  process.exit(1);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) walk(path.join(d, f.name));
    else if (IMAGE_EXT.test(f.name)) files.push(path.join(d, f.name));
  }
})(DIR);

(async () => {
  console.log(`${files.length} image file(s) under ${DIR}`);
  let pinned = 0, missed = 0, failed = 0;
  for (const f of files) {
    const name = path.basename(f);
    const body = fs.readFileSync(f);
    let out;
    try {
      const r = await fetch(
        `${SITE}/api/art?key=${encodeURIComponent(KEY)}&collection=${ADDR}&file=${encodeURIComponent(name)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(600000) },
      );
      out = await r.json().catch(() => ({}));
      if (r.ok) { pinned++; console.log(`  pinned ${name} -> ${(out.tokens || []).map((t) => t.name || t.label).join(', ')}`); }
      else if (r.status === 404) { missed++; console.log(`  no token names ${name} — skipped`); }
      else { failed++; console.log(`  FAILED ${name}: ${r.status} ${out.error || ''}`); }
    } catch (e) { failed++; console.log(`  FAILED ${name}: ${String(e.message).slice(0, 80)}`); }
  }
  console.log(`\npinned ${pinned}, unmatched ${missed}, failed ${failed}`);
  if (REGISTER && pinned && !failed) {
    const r = await fetch(`${SITE}/api/collections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, address: ADDR }),
    });
    const out = await r.json().catch(() => ({}));
    if (r.ok) console.log(`registered ${out.collection?.name || ADDR} on ${SITE}`);
    else console.log(`registration: ${r.status} ${out.error || ''} (already registered is fine)`);
  }
  process.exit(failed ? 1 : 0);
})();
