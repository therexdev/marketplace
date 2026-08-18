#!/usr/bin/env node
/* Give a collection the cover it cannot find for itself.

   When a collection's metadata host is gone outright, nothing it names
   still answers — there is no url to import art against and nothing for
   the automatic hunt to prove, so its card wears a placeholder forever.
   This hands it a cover: a local file (uploaded here, then served from
   the site itself) or any https:// / ipfs:// link.

     node tools/set-cover.js --site https://ouro.lifestyle --key ADMIN_KEY \
          --collection 1N2AhqGGticZ8hYmwNPWoroEBvTp3YGsLW --file ./og-rex.png

     node tools/set-cover.js … --url https://example.com/cover.png
     node tools/set-cover.js … --clear     # back to the automatic hunt

   --description and --name ride along, since the same edit usually wants
   them. A cover set here always wins: nothing derived ever overwrites a
   field an operator filled in.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const SITE = String(arg('site', '')).replace(/\/$/, '');
const KEY = arg('key', '');
const ADDR = arg('collection', '');
const FILE = arg('file', '');
const URL_IN = arg('url', '');
const CLEAR = process.argv.includes('--clear');
const DESCRIPTION = arg('description', null);
const NAME = arg('name', null);

if (!SITE || !KEY || !ADDR || (!FILE && !URL_IN && !CLEAR && DESCRIPTION === null && NAME === null)) {
  console.error('usage: node tools/set-cover.js --site https://… --key ADMIN_KEY --collection 1… (--file cover.png | --url https://… | --clear) [--description "…"] [--name "…"]');
  process.exit(1);
}
if ([FILE, URL_IN, CLEAR ? '--clear' : ''].filter(Boolean).length > 1) {
  console.error('Pick one of --file, --url or --clear.');
  process.exit(1);
}
if (FILE && !fs.existsSync(FILE)) {
  console.error(`--file points at nothing: ${FILE}`);
  process.exit(1);
}

(async () => {
  const patch = { key: KEY };

  if (FILE) {
    /* Upload first: the site keeps the bytes content-addressed under
       /u/…, so the cover survives whatever happened to the original
       host — and cannot go dark a second time. */
    const body = fs.readFileSync(FILE);
    const r = await fetch(`${SITE}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(120000),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.url) {
      console.error(`upload failed: ${r.status} ${out.error || ''}`);
      process.exit(1);
    }
    console.log(`uploaded ${path.basename(FILE)} (${body.length} bytes) -> ${out.path}`);
    patch.image = out.url;
  } else if (URL_IN) {
    patch.image = URL_IN;
  } else if (CLEAR) {
    patch.image = null;
  }
  if (DESCRIPTION !== null) patch.description = DESCRIPTION;
  if (NAME !== null) patch.name = NAME;

  const r = await fetch(`${SITE}/api/collections/${ADDR}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(120000),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`${r.status} ${out.error || 'could not update that collection'}`);
    process.exit(1);
  }
  /* A site running an older build has no PATCH: the request falls
     through to the plain GET of that collection and comes back 200 with
     the row it did NOT change. Silence there would read as success and
     send someone hunting a cover that was never set — so insist on the
     answer only the editor gives. */
  if (!out.ok || !out.collection) {
    console.error('That site answered, but not as the registry editor — it is running a build');
    console.error('without PATCH /api/collections/:address. Nothing was changed. Deploy the');
    console.error('current server.js and run this again.');
    process.exit(1);
  }
  const c = out.collection;
  console.log(`${c.name || ADDR}: cover ${c.image ? `${SITE}${c.image}` : '(cleared — the site will hunt for one)'}`);
  if (DESCRIPTION !== null) console.log(`  description: ${c.description}`);
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
