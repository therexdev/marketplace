#!/usr/bin/env node
/* Which Koinos NFT collections can OURO actually show today?

   A collection is only worth registering if three layers still answer:
   the CONTRACT (name/supply reads), the METADATA (on chain, or the uri
   host is alive), and the ART (the image URLs inside that metadata).
   Kollection's death took none of the chain state with it, but plenty of
   drops pinned their files to hosts that are gone — nftstorage.link most
   of all — and a collection whose art is unreachable is an empty shelf.

   Discovery walks the two legacy marketplace contracts' full event
   histories: every order ever created or executed names its collection,
   so the union is the complete set of collections that ever traded on
   Koinos. Wallets ride along (seller/buyer fields look identical in the
   raw events); the probe simply drops every address that does not answer
   as an NFT contract.

   The probe mirrors server.js resolution EXACTLY — metadata_of first,
   then the collection uri with both filename conventions (label and hex
   id) across both gateways (ipfs.io, dweb.link), images re-rooted the
   same way — so "works here" means "works on the site".

     node tools/audit-collections.js discover          # -> data/audit/candidates.json
     node tools/audit-collections.js audit             # -> data/audit/results.json + REPORT.md
     node tools/audit-collections.js audit 1Addr [...] # probe specific addresses
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { Contract, Provider, utils } = require('koilib');

const RPC = process.env.KOINOS_RPC || 'https://api.koinos.io';
const OUT_DIR = path.join(__dirname, '..', 'data', 'audit');
const provider = new Provider([RPC]);

/* The two dead marketplaces whose events name every collection that ever
   traded: Kollection's generations — 16tsFkc5… (marketplace.create_order/
   execute_order), 1AyXgogB… (…_event variants). */
const LEGACY_MARKETS = [
  '16tsFkc5RyuwQmXxVABzHHwS513Nu2B9S3',
  '1AyXgogBeFG9XSJjpSBFujNcfXbo8cbrKE',
];

function sanitizeAbi(abi) {
  const k = abi.koilib_types?.nested?.koinos?.nested;
  if (k) { delete k.btype; delete k._btype; }
  return abi;
}
const NFT_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server-abi', 'nft-abi.json'), 'utf8')));

const nftContracts = new Map();
const nftC = (addr) => {
  if (!nftContracts.has(addr)) nftContracts.set(addr, new Contract({ id: addr, provider, abi: NFT_ABI }));
  return nftContracts.get(addr);
};

const hexToLabel = (hex) => {
  try {
    const b = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
    const s = b.toString('utf8');
    return /^[\x20-\x7e]+$/.test(s) ? s : hex;
  } catch (_) { return hex; }
};
const asHex = (s) => '0x' + [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');

/* === copied verbatim from server.js — the gateway re-rooting the site uses === */
function ipfsRoots(base) {
  let cid = null, sub = '';
  let m = /^ipfs:\/\/([^/]+)\/?(.*)$/.exec(base);
  if (m) { cid = m[1]; sub = m[2]; }
  if (!cid) {
    m = /^https?:\/\/([a-z0-9]{46,})\.ipfs\.[^/]+\/?(.*)$/i.exec(base);
    if (m) { cid = m[1]; sub = m[2]; }
  }
  if (!cid) {
    m = /^https?:\/\/[^/]+\/ipfs\/([a-zA-Z0-9]{40,})\/?(.*)$/.exec(base);
    if (m) { cid = m[1]; sub = m[2]; }
  }
  if (!cid) return null;
  const inner = /^ipfs\/([a-zA-Z0-9]{40,})\/?(.*)$/.exec(sub);
  if (inner) { cid = inner[1]; sub = inner[2]; }
  const tail = sub ? '/' + sub.replace(/\/$/, '') : '';
  return ['https://ipfs.io/ipfs/' + cid + tail, 'https://dweb.link/ipfs/' + cid + tail];
}

const rewriteImg = (u) => {
  if (typeof u !== 'string') return null;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
  u = u.replace(/^https?:\/\/(www\.)?koinoscrusaders\.com\//, 'https://aurvania.quest/');
  return /^https:\/\//.test(u) ? u : null;
};
/* === end of the server.js mirror === */

async function rpcRetry(method, args, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await provider.call(method, args); }
    catch (e) {
      const msg = String(e && e.message || e);
      /* "contract not found"-class answers are answers, not flakiness */
      if (i >= tries - 1 || !/deadline|timeout|ECONN|fetch failed|50[0-9]/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/* ---------------- discover ---------------- */

function* lenFields(buf) {
  let o = 0;
  while (o < buf.length) {
    let shift = 0, key = 0;
    for (;;) {
      if (o >= buf.length) return;
      const b = buf[o++];
      key |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 35) return;
    }
    const wire = key & 7;
    if (wire === 0) { while (o < buf.length && (buf[o++] & 0x80)); }
    else if (wire === 1) { o += 8; }
    else if (wire === 5) { o += 4; }
    else if (wire === 2) {
      let len = 0; shift = 0;
      for (;;) {
        if (o >= buf.length) return;
        const b = buf[o++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 35) return;
      }
      if (len < 0 || o + len > buf.length) return;
      const v = buf.subarray(o, o + len);
      o += len;
      yield v;
      if (len > 2 && len < 200) { try { yield* lenFields(v); } catch (_) {} }
    } else { return; }
  }
}

async function discover() {
  const found = new Map(); // address -> occurrences in marketplace events
  for (const market of LEGACY_MARKETS) {
    let seq = null, pages = 0, events = 0;
    for (;;) {
      if (++pages > 1000) break;
      const args = { address: market, limit: 100, ascending: false, irreversible: true };
      if (seq != null) args.seq_num = String(seq);
      let res;
      try { res = await rpcRetry('account_history.get_account_history', args); }
      catch (e) { console.error(`\n${market} page ${pages}: ${String(e.message).slice(0, 120)}`); break; }
      const values = res.values || [];
      if (!values.length) break;
      for (const v of values) {
        for (const ev of (v.trx?.receipt?.events || [])) {
          if (ev.source !== market || !/^marketplace\./.test(ev.name)) continue;
          events++;
          let data;
          try { data = Buffer.from(utils.decodeBase64url(ev.data)); } catch (_) { continue; }
          for (const f of lenFields(data)) {
            if (f.length !== 25 || f[0] !== 0x00) continue;
            try {
              const a = utils.encodeBase58(f);
              if (/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) found.set(a, (found.get(a) || 0) + 1);
            } catch (_) {}
          }
        }
      }
      const lastSeq = Number(values[values.length - 1].seq_num || 0);
      process.stderr.write(`\r${market} page ${pages} seq ${lastSeq}   `);
      if (lastSeq === 0) break;
      seq = lastSeq - 1;
    }
    console.error(`\n${market}: ${events} marketplace events`);
  }
  const rows = [...found.entries()]
    .map(([address, occurrences]) => ({ address, occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'candidates.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(`${rows.length} distinct addresses -> data/audit/candidates.json`);
}

/* ---------------- probe one collection ---------------- */

async function info(addr) {
  const c = nftC(addr);
  const out = { address: addr };
  try {
    const { result } = await c.functions.get_info({});
    if (result) { out.name = result.name; out.symbol = result.symbol; out.uri = result.uri; out.description = result.description; }
  } catch (_) {
    try { out.name = (await c.functions.name({})).result?.value; } catch (_) {}
    try { out.symbol = (await c.functions.symbol({})).result?.value; } catch (_) {}
    try { out.uri = (await c.functions.uri({})).result?.value; } catch (_) {}
  }
  try { out.totalSupply = (await c.functions.total_supply({})).result?.value || '0'; } catch (_) {}
  try {
    const { result } = await c.functions.royalties({});
    out.royaltyBps = (result?.value || []).reduce((s, r) => s + Number(r.percentage || 0), 0);
  } catch (_) { out.royaltyBps = 0; }
  return out;
}

/* Sample token ids the way the indexer enumerates: get_tokens when the
   contract has it (KCS-2), otherwise the decimal probe every
   Kollection-era drop answers. */
async function sampleIds(addr, supply, want) {
  const c = nftC(addr);
  try {
    const ids = (await c.functions.get_tokens({ limit: 100, descending: false })).result?.token_ids || [];
    const picked = [];
    if (ids.length <= want) picked.push(...ids);
    else for (let i = 0; i < want; i++) picked.push(ids[Math.floor(i * (ids.length - 1) / (want - 1))]);
    return { scheme: 'kcs2', ids: picked };
  } catch (_) { /* no get_tokens — legacy */ }
  const owned = async (label) => {
    try { return !!(await c.functions.owner_of({ token_id: asHex(label) })).result?.value; }
    catch (_) { return null; } // entry point missing → not an NFT at all
  };
  if (await owned('1') === null) return { scheme: 'none', ids: [] };
  /* Sparse drops (Koinos Astronauts: supply 180, serials scattered up to
     ~1000) mint out of order — "1" and "0" missing proves nothing. Walk
     the range and keep the hits, giving up only after a bounded number
     of all-miss probes. */
  const ids = [];
  const cap = Math.min(Math.max(Number(supply || 0) * 6, 60), 1200);
  for (let i = 0; i <= cap && ids.length < want; i++) {
    if (await owned(String(i))) ids.push(asHex(String(i)));
    else if (i >= 240 && !ids.length) break; // nothing in 240 serials — ids are not decimal
  }
  return { scheme: 'legacy', ids };
}

/* Metadata, exactly as server.js tokenMeta: chain first, then the uri
   with both filename conventions across both gateways, remembering per
   collection which combination answered. */
const metaPathHints = new Map();

/* Kuku Playing Cards wrote its on-chain metadata JSON.stringify'd twice:
   one parse yields a string and the token reads as artless. Unwrap at
   most once, and only keep objects — same treatment as server.js. */
function parseMeta(text) {
  let m = JSON.parse(text);
  if (typeof m === 'string') m = JSON.parse(m);
  return m && typeof m === 'object' ? m : null;
}

async function tokenMeta(addr, tokenIdHex, uriBase, giveUpUri) {
  const c = nftC(addr);
  try {
    const { result } = await c.functions.metadata_of({ token_id: tokenIdHex });
    if (result?.value) {
      try { const m = parseMeta(result.value); if (m) return { meta: m, source: 'chain' }; } catch (_) {}
    }
  } catch (_) {}
  const base = String(uriBase || '').trim();
  if (!base || !/^(https?|ipfs):\/\//.test(base) || giveUpUri()) return null;
  const roots = ipfsRoots(base) || [base];
  const names = [encodeURIComponent(hexToLabel(tokenIdHex)), tokenIdHex.toLowerCase()];
  const combos = [];
  for (const root of roots) for (const name of names) combos.push({ root, name, idx: combos.length });
  const hint = metaPathHints.get(addr);
  if (hint != null && hint > 0 && hint < combos.length) combos.unshift(combos.splice(hint, 1)[0]);
  for (const cb of combos) {
    try {
      const r = await fetch(`${cb.root.replace(/\/$/, '')}/${cb.name}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const text = (await r.text()).slice(0, 262144);
      const parsed = parseMeta(text);
      if (!parsed) continue;
      metaPathHints.set(addr, cb.idx);
      return { meta: parsed, source: 'uri ' + new URL(cb.root).host };
    } catch (_) {}
  }
  return null;
}

const IMG_MAGIC = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png'],
  [Buffer.from([0xff, 0xd8, 0xff]), 'jpeg'],
  [Buffer.from('GIF8'), 'gif'],
  [Buffer.from('RIFF'), 'webp'],
  [Buffer.from('<svg'), 'svg'],
  [Buffer.from('<?xml'), 'svg'],
];
async function imageAlive(url, timeoutMs = 10000) {
  /* the site's <img> loads rewriteImg(url) and falls back across
     gateways when the url carries a CID — try the same sequence */
  const primary = rewriteImg(url);
  if (!primary) return { ok: false, note: 'not https (site will not render it)' };
  const tries = [...new Set([primary, ...(ipfsRoots(primary) || [])])];
  for (const u of tries) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs), headers: { Range: 'bytes=0-4095' } });
      if (!r.ok) continue;
      const type = r.headers.get('content-type') || '';
      let head = Buffer.alloc(0);
      const reader = r.body?.getReader();
      if (reader) {
        while (head.length < 8) {
          const { value, done } = await reader.read();
          if (done) break;
          head = Buffer.concat([head, Buffer.from(value)]);
          if (head.length >= 4096) break;
        }
        await reader.cancel().catch(() => {});
      }
      const sniffed = IMG_MAGIC.find(([m]) => head.subarray(0, m.length).equals(m));
      if (/^image\//.test(type) || sniffed) {
        return { ok: true, url: u, type: type || `sniffed ${sniffed?.[1]}` };
      }
    } catch (_) {}
  }
  return { ok: false, note: 'no gateway serves it' };
}

async function probe(addr, occurrences) {
  const row = { address: addr, trades: occurrences || 0 };
  let inf;
  try { inf = await info(addr); }
  catch (e) { return { ...row, verdict: 'not-collection', note: String(e.message).slice(0, 80) }; }
  row.name = inf.name || null;
  row.symbol = inf.symbol || null;
  row.description = inf.description || null;
  row.uri = inf.uri || null;
  row.supply = Number(inf.totalSupply || 0);
  row.royaltyBps = inf.royaltyBps;
  if (!row.name && !row.supply) return { ...row, verdict: 'not-collection' };

  const { scheme, ids } = await sampleIds(addr, row.supply, 6);
  row.scheme = scheme;
  if (scheme === 'none') return { ...row, verdict: 'not-collection' };
  if (scheme === 'legacy' && row.royaltyBps > 0) row.royaltyBps = Math.round(row.royaltyBps / 10);
  if (!ids.length) return { ...row, verdict: row.supply ? 'no-tokens-found' : 'empty' };

  /* metadata for each sample; stop paying uri timeouts once two whole
     tokens missed with no working path ever found (server gives up the
     same way after eight misses) */
  let uriMisses = 0;
  const giveUpUri = () => uriMisses >= 2 && !metaPathHints.has(addr);
  const metas = [];
  for (const tid of ids) {
    const m = await tokenMeta(addr, tid, inf.uri, giveUpUri);
    if (!m && !metaPathHints.has(addr)) uriMisses++;
    metas.push({ tokenId: tid, label: hexToLabel(tid), ...(m || {}) });
  }
  row.sampled = ids.length;
  row.metaResolved = metas.filter((m) => m.meta).length;
  row.metaSources = [...new Set(metas.filter((m) => m.meta).map((m) => m.source))];

  const imgs = [...new Set(metas.map((m) => m.meta?.image).filter(Boolean))].slice(0, 4);
  row.imgChecked = imgs.length;
  row.imgLive = 0;
  row.images = [];
  for (const u of imgs) {
    const a = await imageAlive(u);
    row.images.push({ image: u, ...a });
    if (a.ok) row.imgLive++;
  }
  /* IPFS gateways time out on content they demonstrably hold (a cold CID
     can 504 once and serve the next minute), so one miss is not a death
     certificate. Anything that failed gets one patient retry — all of
     them when some sibling loaded (a flip changes the verdict), just the
     first when nothing did (dead hosts answer 404/401 fast anyway). */
  if (row.imgLive < row.imgChecked) {
    const failed = row.images.filter((i) => !i.ok);
    const retry = row.imgLive > 0 ? failed : failed.slice(0, 1);
    for (const im of retry) {
      const again = await imageAlive(im.image, 25000);
      if (again.ok) {
        Object.assign(im, again, { retried: true });
        row.imgLive++;
      }
    }
  }
  row.sampleTokens = metas.map((m) => ({
    label: m.label, hasMeta: !!m.meta, source: m.source || null,
    name: m.meta?.name || null, image: m.meta?.image || null,
  }));

  row.verdict =
    !row.metaResolved ? 'metadata-dead'
    : !row.imgChecked ? 'no-images-in-metadata'
    : !row.imgLive ? 'images-dead'
    : (row.metaResolved === row.sampled && row.imgLive === row.imgChecked) ? 'healthy'
    : 'degraded';
  return row;
}

/* ---------------- audit ---------------- */

const VERDICT_ORDER = ['healthy', 'degraded', 'images-dead', 'no-images-in-metadata', 'metadata-dead', 'no-tokens-found', 'empty'];

async function audit(addrs) {
  let candidates;
  if (addrs.length) {
    candidates = addrs.map((address) => ({ address, occurrences: 0 }));
  } else {
    const file = path.join(OUT_DIR, 'candidates.json');
    if (!fs.existsSync(file)) { console.error('no data/audit/candidates.json — run `discover` first'); process.exit(1); }
    candidates = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  console.error(`probing ${candidates.length} addresses against ${RPC} ...`);
  let done = 0;
  const rows = await mapPool(candidates, 6, async (c) => {
    const r = await probe(c.address, c.occurrences).catch((e) => ({
      address: c.address, trades: c.occurrences, verdict: 'error', note: String(e.message).slice(0, 100),
    }));
    process.stderr.write(`\r${++done}/${candidates.length} ${r.verdict === 'not-collection' ? '' : `${r.address} ${r.verdict} `}      `);
    return r;
  });
  console.error('');

  const collections = rows
    .filter((r) => r.verdict !== 'not-collection')
    .sort((a, b) => {
      const va = VERDICT_ORDER.indexOf(a.verdict), vb = VERDICT_ORDER.indexOf(b.verdict);
      if (va !== vb) return (va < 0 ? 99 : va) - (vb < 0 ? 99 : vb);
      return (b.trades || 0) - (a.trades || 0);
    });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({
    auditedAt: new Date().toISOString(), rpc: RPC,
    candidates: candidates.length, collections: collections.length, rows: collections,
  }, null, 2) + '\n');

  const md = [];
  md.push('# Koinos NFT collections — metadata & image liveness');
  md.push('');
  md.push(`Audited ${new Date().toISOString().slice(0, 10)} · ${candidates.length} addresses from legacy marketplace events · ${collections.length} answered as NFT collections.`);
  md.push('');
  md.push('| Collection | Address | Supply | Trades | Metadata | Images | Verdict |');
  md.push('|---|---|---:|---:|---|---|---|');
  for (const r of collections) {
    const meta = r.metaResolved != null ? `${r.metaResolved}/${r.sampled} (${(r.metaSources || []).join(', ') || '—'})` : '—';
    const img = r.imgChecked != null ? `${r.imgLive}/${r.imgChecked}` : '—';
    md.push(`| ${r.name || '?'} ${r.symbol ? `(${r.symbol})` : ''} | \`${r.address}\` | ${r.supply ?? '—'} | ${r.trades || 0} | ${meta} | ${img} | **${r.verdict}** |`);
  }
  md.push('');
  md.push('Verdicts: **healthy** — every sampled token resolved metadata and every image answered from a gateway the site uses; **degraded** — partial; **images-dead** — metadata resolves but no image URL answers; **metadata-dead** — neither chain metadata nor the uri host answers; **no-tokens-found** — supply says tokens exist but neither KCS-2 enumeration nor the legacy decimal probe finds them.');
  md.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), md.join('\n'));
  console.log(`-> data/audit/results.json, data/audit/REPORT.md`);
  for (const v of VERDICT_ORDER) {
    const n = collections.filter((r) => r.verdict === v).length;
    if (n) console.log(`   ${v}: ${n}`);
  }
}

(async () => {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'discover') return discover();
  if (mode === 'audit') return audit(rest.filter((a) => /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)));
  console.error('usage: node tools/audit-collections.js discover | audit [address ...]');
  process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
