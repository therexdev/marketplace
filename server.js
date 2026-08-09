#!/usr/bin/env node
/* ============================================================
   The marketplace server — every KCS-2 collection on Koinos.

   Deliberately thin. The order book lives ON CHAIN (the contract's
   get_orders is a plain paginated read), ownership lives on chain, and
   accounts are keys the user holds in their browser — so this server
   keeps no user state at all. What it actually does:

     * serves the site;
     * keeps the COLLECTION REGISTRY — the one curated thing here: which
       collections appear on the home page (anything else is reachable by
       address, listed or not);
     * caches chain reads so browsing does not hammer the RPC;
     * proxies metadata fetches (never an open proxy — only URLs derived
       from a collection's own on-chain uri are fetched);
     * bridges SIGN-IN to the Aurvania game server, so the same Google or
       email account resolves to the SAME Koinos wallet there and here;
     * SPONSORS MANA: users sign as payee, this server co-signs as payer
       with the dev wallet, so nobody needs KOIN mana to trade. The
       validation below is what keeps that wallet from being drained.

   Env:
     PORT               (default 3100)
     DATA_DIR           runtime state dir (default ./data-live)
     KOINOS_NETWORK     mainnet | harbinger   (default mainnet)
     KOINOS_RPC         override RPC url(s), comma separated
     MARKET_ADDR        the deployed marketplace contract address
     KOINOS_DEV_WIF     the mana payer (sponsorship off without it)
     SPONSOR_RC_PER_OP  mana ceiling per operation in satoshis (default 3 KOIN)
     SPONSOR_RC_MAX     absolute per-tx mana ceiling (default 15 KOIN)
     INDEX_MAX_TOKENS   how deep a collection is indexed for filters (default 1500)
     AURVANIA_API       game server for shared sign-in (default aurvania.quest)
     ADMIN_KEY          enables POST /api/collections (registry writes)
   ============================================================ */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Signer, Provider, Contract, Transaction, Serializer, utils } = require('koilib');

/* A background chain walk, a stray rejection, a bad response shape — none
   of it should ever take the site down. A logged error serves everyone
   better than a process that exits and leaves the host answering 503. */
process.on('unhandledRejection', (e) => {
  console.error('[unhandled rejection]', (e && e.stack) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaught exception]', (e && e.stack) || e);
});

const NETWORKS = {
  harbinger: {
    label: 'Koinos Harbinger testnet',
    rpcs: ['https://harbinger-api.koinos.io'],
    koinContract: '1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju',
    explorer: 'https://harbinger.koinosblocks.com',
  },
  mainnet: {
    label: 'Koinos',
    rpcs: ['https://api.koinos.io'],
    koinContract: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',
    explorer: 'https://koinosblocks.com',
  },
};

/* Env numbers, parsed so a typo cannot kill the process. BigInt('5e8')
   throws, and a throw out here happens at module load — before anything
   is listening and before any log line, which from outside is an
   unexplained 503. A bad value falls back and says so. */
function bigEnv(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return BigInt(Math.round(fallback));
  try {
    const n = /^[0-9]+$/.test(raw) ? BigInt(raw) : BigInt(Math.round(Number(raw)));
    if (n > 0n) return n;
    throw new Error('must be positive');
  } catch (_) {
    console.error(`[config] ${name}="${raw}" is not a whole number of satoshis — using ${fallback}`);
    return BigInt(Math.round(fallback));
  }
}

/* Which port the host wants us on. Platforms inject this under different
   names, and getting it wrong is invisible from inside the process: the
   app starts, binds, logs happily — and every request still 503s because
   the proxy is pointed somewhere else, so the supervisor restarts it in a
   loop. Take the first one offered, and say at boot where it came from. */
const PORT_VARS = ['PORT', 'APP_PORT', 'SERVER_PORT', 'NODE_PORT', 'HTTP_PORT', 'LISTEN_PORT'];
function choosePort() {
  for (const name of PORT_VARS) {
    const v = parseInt(process.env[name] || '', 10);
    if (v > 0 && v < 65536) return { port: v, from: name };
  }
  return { port: 3100, from: null };
}
const PORT_CHOICE = choosePort();

const CFG = {
  PORT: PORT_CHOICE.port,
  DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data-live')),
  NETWORK: (process.env.KOINOS_NETWORK || 'mainnet').trim(),
  MARKET_ADDR: (process.env.MARKET_ADDR || '').trim(),
  DEV_WIF: (process.env.KOINOS_DEV_WIF || '').trim(),
  /* Mana ceilings. A Koinos contract call really costs ~0.4–1.3 KOIN of
     mana, so a ceiling is per-OPERATION with a hard absolute cap; a flat
     5 KOIN cap rejected nothing but did let the old 2-op listing squeak
     under a limit too small to actually execute. rc_limit is a ceiling,
     not a charge — only rc_used leaves the payer. */
  SPONSOR_RC_PER_OP: bigEnv('SPONSOR_RC_PER_OP', 3e8),
  SPONSOR_RC_MAX: bigEnv('SPONSOR_RC_MAX', 15e8),
  AURVANIA_API: (process.env.AURVANIA_API || 'https://aurvania.quest').replace(/\/$/, ''),
  /* Optional: the same Google OAuth client the game uses. Set it here and
     sign-in no longer waits on the game server being reachable. */
  GOOGLE_CLIENT_ID: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  /* How this server introduces itself to the game. The host in front of
     aurvania.quest answers 403 to almost every User-Agent — a browser
     string, an empty one, node's own, a plain product token — and passes
     `curl/*` and `Wget/*`. Measured, not guessed. The prefix clears that
     filter while the rest keeps the caller identifiable in the game's
     logs; override it if the rule ever changes. */
  BRIDGE_UA: (process.env.BRIDGE_UA || 'curl/8.5.0 (OURO-marketplace; +https://ouro.lifestyle)').trim(),
  ADMIN_KEY: (process.env.ADMIN_KEY || '').trim(),

  /* Launching a collection uploads a contract, and an upload costs about
     59 KOIN of mana against roughly 1 for an ordinary call — measured on
     this very marketplace's own deployment. Around 28 of them would take
     the sponsor wallet to zero and freeze listings and purchases for
     everyone until it recharges, so a launch is paid for AND rationed.
     Set LAUNCH_FEE_KOIN=0 to make launching free; the limits still apply. */
  LAUNCH_FEE_KOIN: Math.max(0, Number(process.env.LAUNCH_FEE_KOIN ?? 100)),
  LAUNCH_PER_DAY_PER_ACCOUNT: parseInt(process.env.LAUNCH_PER_DAY_PER_ACCOUNT || '3', 10),
  LAUNCH_PER_DAY_TOTAL: parseInt(process.env.LAUNCH_PER_DAY_TOTAL || '12', 10),
  /* Minting, same shape as launching: a configurable fee (0 = free), and
     a GLOBAL daily budget across every collection — a mint is ~2 KOIN of
     sponsored mana, so the budget bounds the worst day at ~60 KOIN. */
  MINT_FEE_KOIN: Math.max(0, Number(process.env.MINT_FEE_KOIN ?? 0)),
  MINT_PER_DAY_TOTAL: parseInt(process.env.MINT_PER_DAY_TOTAL || '30', 10),
  UPLOAD_MAX_BYTES: parseInt(process.env.UPLOAD_MAX_BYTES || String(4 * 1024 * 1024), 10),
};
const NET = NETWORKS[CFG.NETWORK] || NETWORKS.mainnet;
const RPCS = (process.env.KOINOS_RPC || '').split(',').map(s => s.trim()).filter(Boolean);
if (!RPCS.length) RPCS.push(...NET.rpcs);

fs.mkdirSync(CFG.DATA_DIR, { recursive: true });

/* ---------------- tiny persistent store ---------------- */

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function saveJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/* The registry: seeded from the repo's data/collections.json on first
   boot, then owned by DATA_DIR. The seed ships with Aurvania; everything
   else arrives through the admin endpoint. */
const REGISTRY_FILE = path.join(CFG.DATA_DIR, 'collections.json');
let registry = loadJson(REGISTRY_FILE, null);
if (!registry) {
  registry = loadJson(path.join(__dirname, 'data', 'collections.json'), { collections: [] });
  saveJson(REGISTRY_FILE, registry);
}

/* ---------------- chain ---------------- */

const provider = new Provider(RPCS);
/* No chain read may hang forever. koilib's fetch carries no timeout, so
   one silently dead TCP connection wedged the snapshot rebuild AND the
   index worker for good — the home page froze at whatever the last
   completed build knew (zeros, as it happened, for every listing).
   A hung call now REJECTS after 25s and every caller already handles
   rejection; the workers keep working. */
const rawProviderCall = provider.call.bind(provider);
const timedCall = (method, params) => Promise.race([
  rawProviderCall(method, params),
  new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 25000);
    if (t.unref) t.unref();
  }),
]);
/* READS also retry: the node intermittently answers with a Cloudflare
   HTML page or times out, and a single dropped read was becoming a
   wrong answer somewhere ("0 listed", a token without traits).
   Transaction submission stays single-shot — a retried submit could
   double-broadcast, and no error message is worth that. */
provider.call = async (method, params) => {
  const retries = /submit/.test(method) ? 0 : 2;
  for (let i = 0; ; i++) {
    try { return await timedCall(method, params); }
    catch (e) {
      const transient = /timeout|invalid json|deadline|ECONN|fetch failed/i.test(String(e && e.message || e));
      if (i >= retries || !transient) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
};
const dev = CFG.DEV_WIF ? Signer.fromWif(CFG.DEV_WIF) : null;
if (dev) dev.provider = provider;

function sanitizeAbi(abi) {
  const k = abi.koilib_types?.nested?.koinos?.nested;
  if (k) { delete k.btype; delete k._btype; }
  return abi;
}
const NFT_ABI = sanitizeAbi(loadJson(path.join(__dirname, 'server-abi', 'nft-abi.json'), {}));
/* koilib ships a token ABI that protobufjs refuses to load — the same
   btype extension every other ABI here has to have stripped. Constructing
   it threw inside a catch, so KOIN balances quietly read zero for
   everyone. Sanitize a copy once and use that. */
const TOKEN_ABI = sanitizeAbi(JSON.parse(JSON.stringify(utils.tokenAbi)));
const MARKET_ABI = sanitizeAbi(loadJson(path.join(__dirname, 'server-abi', 'market-abi.json'), {}));

const marketC = CFG.MARKET_ADDR
  ? new Contract({ id: CFG.MARKET_ADDR, provider, abi: MARKET_ABI })
  : null;

const nftContracts = new Map();
function nftC(addr) {
  if (!nftContracts.has(addr)) {
    nftContracts.set(addr, new Contract({ id: addr, provider, abi: NFT_ABI }));
  }
  return nftContracts.get(addr);
}

/* ---------------- caches ---------------- */

const caches = new Map();
async function cached(key, ttlMs, fn) {
  const hit = caches.get(key);
  const t = Date.now();
  if (hit && t - hit.at < ttlMs) return hit.value;
  const value = await fn();
  caches.set(key, { at: t, value });
  if (caches.size > 5000) {
    // drop the oldest half rather than tracking LRU precisely
    const entries = [...caches.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < entries.length / 2; i++) caches.delete(entries[i][0]);
  }
  return value;
}

const isAddr = (s) => typeof s === 'string' && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);

/** Token ids travel as 0x-hex. Shown to people as utf8 when printable. */
const hexToLabel = (hex) => {
  try {
    const b = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
    const s = b.toString('utf8');
    return /^[\x20-\x7e]+$/.test(s) ? s : hex;
  } catch (_) { return hex; }
};

/* ---------------- collection reads ---------------- */

async function collectionInfo(addr) {
  return cached('info:' + addr, 300000, async () => {
    const c = nftC(addr);
    const out = { address: addr };
    try {
      const { result } = await c.functions.get_info({});
      if (result) { out.name = result.name; out.symbol = result.symbol; out.uri = result.uri; out.description = result.description; }
    } catch (_) {
      // KCS-2 without get_info: fall back to the individual getters.
      try { out.name = (await c.functions.name({})).result?.value; } catch (_) {}
      try { out.symbol = (await c.functions.symbol({})).result?.value; } catch (_) {}
      try { out.uri = (await c.functions.uri({})).result?.value; } catch (_) {}
    }
    try { out.totalSupply = (await c.functions.total_supply({})).result?.value || '0'; } catch (_) {}
    // Who may mint into it — the answer the Create page needs.
    try { out.owner = (await c.functions.owner({})).result?.value || null; } catch (_) { out.owner = null; }
    try {
      const { result } = await c.functions.royalties({});
      out.royaltyBps = (result?.value || []).reduce((s, r) => s + Number(r.percentage || 0), 0);
    } catch (_) { out.royaltyBps = 0; }
    /* Kollection-era contracts (no get_tokens) declared royalties per
       100,000 — The Crew's "5000" paid 5% on real Kollection sales, not
       50%. Normalize to basis points so every display and fee breakdown
       says what a buyer will actually be charged. The market contract
       makes the same call with the same probe. */
    if (out.royaltyBps > 0) {
      try { await c.functions.get_tokens({ limit: 1 }); }
      catch (_) { out.legacyRoyalty = true; out.royaltyBps = Math.round(out.royaltyBps / 10); }
    }
    return out;
  });
}

async function collectionOrders(addr) {
  if (!marketC) return [];
  return cached('orders:' + addr, 10000, async () => {
    const rows = [];
    let startAfter = '';
    for (let page = 0; page < 20; page++) {
      const args = { collection: addr, limit: 100 };
      if (startAfter) args.start_after = startAfter;
      const { result } = await marketC.functions.get_orders(args);
      const batch = result?.value || [];
      rows.push(...batch);
      if (batch.length < 100) break;
      startAfter = batch[batch.length - 1].token_id;
    }
    const now = Date.now();
    return rows
      .filter(o => !Number(o.expires) || Number(o.expires) > now)
      .map(o => ({
        seller: o.seller, collection: o.collection, tokenId: o.token_id,
        label: hexToLabel(o.token_id),
        price: o.price, expires: o.expires || '0', created: o.created || '0',
      }));
  });
}

/* Kuku Playing Cards wrote its on-chain metadata JSON.stringify'd twice:
   the first parse yields a STRING, reading .image off it yields nothing,
   and the whole collection rendered artless with its metadata sitting
   right there on chain. Unwrap at most once, and only keep objects. */
function parseMeta(text) {
  let m = JSON.parse(text);
  if (typeof m === 'string') m = JSON.parse(m);
  return m && typeof m === 'object' ? m : null;
}

/** On-chain metadata first, uri fetch second — never an open proxy.
    Successes keep for an hour; a MISS keeps for two minutes — one bad
    gateway moment cached as "no metadata" for an hour was starving
    every retry of the art importer and every index rebuild. */
async function tokenMeta(addr, tokenIdHex) {
  const key = `meta:${addr}:${tokenIdHex}`;
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < (hit.value === null ? 120000 : 3600000)) return hit.value;
  const value = await tokenMetaFetch(addr, tokenIdHex);
  caches.set(key, { at: Date.now(), value });
  return value;
}
async function tokenMetaFetch(addr, tokenIdHex) {
  const c = nftC(addr);
  try {
    const { result } = await c.functions.metadata_of({ token_id: tokenIdHex });
    if (result?.value) { try { const m = parseMeta(result.value); if (m) return m; } catch (_) {} }
  } catch (_) {}
  const info = await collectionInfo(addr);
  const base = String(info.uri || '').trim();
  if (!base) return null;
  if (!/^(https?|ipfs):\/\//.test(base)) return null;
  /* Two file-name conventions exist in the wild — our own launches use
     the human label, Kollection-era drops keyed files by the HEX id
     (…/0x31). And ipfs.io routinely fails content that dweb.link still
     serves, so anything with a CID in it gets both gateways before
     giving up. The combination that answers first is remembered per
     collection, so an index walk pays the discovery timeouts once, not
     sixty times. */
  const roots = ipfsRoots(base) || [base];
  const names = [encodeURIComponent(hexToLabel(tokenIdHex)), tokenIdHex.toLowerCase()];
  const combos = [];
  for (const root of roots) for (const name of names) combos.push({ root, name, idx: combos.length });
  const hint = metaPathHints.get(addr);
  if (hint != null && hint > 0 && hint < combos.length) {
    combos.unshift(combos.splice(hint, 1)[0]);
  }
  for (const c of combos) {
    try {
      const r = await fetch(`${c.root.replace(/\/$/, '')}/${c.name}`, { signal: AbortSignal.timeout(8000), size: 1048576 });
      if (!r.ok) continue;
      const text = (await r.text()).slice(0, 262144);
      const parsed = parseMeta(text);
      if (!parsed) continue;
      metaPathHints.set(addr, c.idx);
      return parsed;
    } catch (_) {}
  }
  return null;

}
const metaPathHints = new Map(); // collection -> canonical index of the combo that answered

/** Anything carrying a CID — ipfs:// uris, subdomain-gateway urls like
    …cid.ipfs.nftstorage.link (that host is dead, its CIDs sometimes are
    not) — re-rooted onto gateways that still answer. Returns null when
    the url carries no CID and should be fetched as-is. */
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
  // Some uris embed a second, path-style /ipfs/<cid>/ — re-root there.
  const inner = /^ipfs\/([a-zA-Z0-9]{40,})\/?(.*)$/.exec(sub);
  if (inner) { cid = inner[1]; sub = inner[2]; }
  const tail = sub ? '/' + sub.replace(/\/$/, '') : '';
  return ['https://ipfs.io/ipfs/' + cid + tail, 'https://dweb.link/ipfs/' + cid + tail];
}

const rewriteImg = (u) => {
  if (typeof u !== 'string') return null;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
  /* Aurvania relics minted before the domain move carry the RETIRED domain
     in their on-chain metadata — immutable history. Rewriting here keeps
     the art loading directly (no redirect hop) and keeps working on the
     day koinoscrusaders.com finally lapses. */
  u = u.replace(/^https?:\/\/(www\.)?koinoscrusaders\.com\//, 'https://aurvania.quest/');
  return /^https:\/\//.test(u) ? u : null;
};

/* ---------------- the art cache ----------------

   Art was the slow half of every page. The browser used to pull each
   image straight from an IPFS gateway, so a grid of 24 tokens was 24
   separate gambles on ipfs.io's mood — some covers never arrived at all,
   which reads as "this marketplace is broken", not "a gateway is moody".

   So the pages now hand the browser /img/... urls served from HERE.
   The server resolves what to fetch from data it already trusts — the
   registry's cover field, a token's own metadata — never from anything
   client-supplied, so this stays shut as ever (the same rule the
   metadata proxy has always had). The fetch gets the gateway fallbacks
   and the patience one browser <img> tag cannot have, and the bytes are
   kept on disk. Every load after the first is a same-origin file.  */

const IMG_DIR = path.join(CFG.DATA_DIR, 'imgcache');
fs.mkdirSync(IMG_DIR, { recursive: true });
const IMG_FILE_MAX = 12 * 1048576;   // one artwork; beyond this it stays a placeholder
const IMG_DIR_MAX = 2048 * 1048576;  // the whole cache; swept oldest-first past this

const IMG_MAGIC = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from('GIF8'), 'image/gif'],
  [Buffer.from('RIFF'), 'image/webp'],
  [Buffer.from('<svg'), 'image/svg+xml'],
  [Buffer.from('<?xml'), 'image/svg+xml'],
];

/* Art uploaded through this site is already a local immutable file —
   hand back its own path rather than proxying ourselves. Only when the
   file really is HERE, though: metadata minted through ANOTHER
   deployment of this code carries that deployment's /u/ url, and
   claiming it locally would 404 a perfectly good remote image. */
const localUpload = (u) => {
  const m = /^(?:https?:\/\/[^/]+)?\/u\/([a-f0-9]{8,64}\.(?:png|jpg|gif|webp))$/.exec(String(u || ''));
  if (!m) return null;
  try { return fs.existsSync(path.join(UPLOAD_DIR, m[1])) ? '/u/' + m[1] : null; }
  catch (_) { return null; }
};
const artUrl = (addr, tokenId, image) =>
  !image ? null : localUpload(image) || `/img/t/${addr}/${tokenId}`;
const coverUrl = (row) =>
  !row || !row.image ? '' : localUpload(row.image) || `/img/c/${row.address}`;

const imgKey = (src) => crypto.createHash('sha256').update(src).digest('hex');
const imgDead = new Map();     // key -> when the last hunt failed (retried after 10 min)
const imgBusy = new Map();     // key -> in-flight fetch, so a grid asks once
let imgFetching = 0;           // upstream fetches in flight, across all keys

/** Fetch one artwork into the disk cache. Returns {file, type} or null. */
async function fetchArt(src) {
  const key = imgKey(src);
  const file = path.join(IMG_DIR, key);
  if (fs.existsSync(file + '.json')) {
    const meta = loadJson(file + '.json', null);
    if (meta && fs.existsSync(file)) return { file, type: meta.type };
  }
  const failedAt = imgDead.get(key);
  if (failedAt && Date.now() - failedAt < 120000) return null;
  if (imgBusy.has(key)) return imgBusy.get(key);
  const run = (async () => {
    /* A cold grid must not open one upstream connection per tile. */
    while (imgFetching >= 6) await new Promise((r) => setTimeout(r, 150));
    imgFetching++;
    try {
      const tries = [...new Set([src, ...(ipfsRoots(src) || [])])];
      for (const u of tries) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
          if (!r.ok) continue;
          const chunks = [];
          let size = 0, over = false;
          for await (const chunk of r.body) {
            size += chunk.length;
            if (size > IMG_FILE_MAX) { over = true; break; }
            chunks.push(chunk);
          }
          if (over) break; // the same bytes wait on every gateway — give up whole
          const buf = Buffer.concat(chunks);
          const claimed = r.headers.get('content-type') || '';
          const sniffed = IMG_MAGIC.find(([m]) => buf.subarray(0, m.length).equals(m));
          if (!/^image\//.test(claimed) && !sniffed) continue;
          const type = sniffed ? sniffed[1] : claimed.split(';')[0];
          fs.writeFileSync(file, buf);
          saveJson(file + '.json', { type, src, size: buf.length, at: Date.now() });
          imgDead.delete(key);
          return { file, type };
        } catch (_) {}
      }
      imgDead.set(key, Date.now());
      return null;
    } finally { imgFetching--; imgBusy.delete(key); }
  })();
  imgBusy.set(key, run);
  return run;
}

/* ---------------- thumbnails ----------------

   A grid tile does not need the 1.6MB original — it needs 50KB that
   look identical at 300px. Derivatives are cut once with jimp (pure
   JS, vendored like everything else — a deploy cannot lose it), kept
   beside the original in the cache, and regenerating after a sweep is
   automatic. If jimp ever fails to load, originals serve as before —
   slower, never broken. */
let Jimp = null;
try { ({ Jimp } = require('jimp')); }
catch (_) { console.warn('[art] jimp unavailable — grids will serve full-size originals'); }

const THUMB_W = 480;
const thumbBusy = new Map();
let thumbsCutting = 0;
async function thumbOf(file, type) {
  if (!Jimp || type === 'image/svg+xml') return null;
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }
  if (stat.size < 96 * 1024) return null; // already lighter than a thumb would be
  const tf = `${file}.w${THUMB_W}`;
  if (fs.existsSync(tf + '.json')) {
    const m = loadJson(tf + '.json', null);
    if (m && fs.existsSync(tf)) return m.skip ? null : { file: tf, type: m.type };
  }
  if (thumbBusy.has(file)) return thumbBusy.get(file);
  const run = (async () => {
    try {
      while (thumbsCutting >= 2) await new Promise((r) => setTimeout(r, 100));
      thumbsCutting++;
      const img = await Jimp.fromBuffer(fs.readFileSync(file));
      if (img.width > THUMB_W) img.resize({ w: THUMB_W });
      /* JPEG unless transparency is actually IN USE — art on a dark
         page with a quietly blackened backdrop looks broken. */
      let alpha = false;
      const px = img.bitmap.data;
      for (let i = 3; i < px.length && !alpha; i += 64) alpha = px[i] < 250;
      const outType = alpha ? 'image/png' : 'image/jpeg';
      const out = await img.getBuffer(outType, { quality: 80 });
      if (out.length >= stat.size) {
        saveJson(tf + '.json', { skip: true, at: Date.now() });
        return null;
      }
      fs.writeFileSync(tf, out);
      saveJson(tf + '.json', { type: outType, at: Date.now() });
      return { file: tf, type: outType };
    } catch (_) { return null; }
    finally { thumbsCutting--; thumbBusy.delete(file); }
  })();
  thumbBusy.set(file, run);
  return run;
}

async function serveArt(req, res, src, cacheSeconds, wantThumb) {
  if (!src) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
  /* The etag IS the source url's hash (plus the variant): same source,
     same art. A cover an admin re-points gets a new etag by construction. */
  const tag = `"${imgKey(src)}${wantThumb ? '-w' + THUMB_W : ''}"`;
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, { 'ETag': tag }); return res.end(); }
  const got = await fetchArt(src).catch(() => null);
  if (!got) {
    /* We could not produce the bytes — a gateway flaking, or this url
       resting in the negative cache after a failed burst. Hand the
       browser the SOURCE url instead of a broken tile: a different
       network path that often succeeds, and at worst exactly the
       direct load every page did before the cache existed. */
    res.writeHead(302, { 'Location': src, 'Cache-Control': 'no-store' });
    return res.end();
  }
  const variant = (wantThumb && await thumbOf(got.file, got.type).catch(() => null)) || got;
  res.writeHead(200, {
    'Content-Type': variant.type || 'application/octet-stream',
    'Cache-Control': `public, max-age=${cacheSeconds}`,
    'ETag': tag,
  });
  fs.createReadStream(variant.file).pipe(res);
}

async function serveTokenArt(req, res, addr, tokenId, wantThumb) {
  /* The persisted index already resolved this token's art url — no
     chain round-trip. Metadata is only consulted for tokens the index
     has never met. */
  const peek = indexPeek(addr);
  const known = peek && (peek.value.tokens || []).find((t) => t.tokenId === tokenId);
  if (known && known.image) return serveArt(req, res, known.image, 86400, wantThumb);
  // Unknown to the index, or indexed while its metadata was missing —
  // ask the metadata directly rather than 404ing on a stale blank.
  const meta = await tokenMeta(addr, tokenId).catch(() => null);
  return serveArt(req, res, rewriteImg(meta?.image), 86400, wantThumb);
}

async function serveCoverArt(req, res, addr, wantThumb) {
  const row = registry.collections.find((c) => c.address === addr);
  return serveArt(req, res, rewriteImg(row?.image), 3600, wantThumb);
}

/* Art whose ONLY living copy is this cache — imported by the operator
   after the original host died — is not cache at all, it is the archive.
   Pinned entries are written by /api/art and never swept. */
function pinArt(src, buf, type) {
  const key = imgKey(src);
  const file = path.join(IMG_DIR, key);
  fs.writeFileSync(file, buf);
  saveJson(file + '.json', { type, src, size: buf.length, at: Date.now(), pinned: true });
  imgDead.delete(key);
  return key;
}

/* The cache is append-only in the happy path; keep it from appending
   forever. Oldest art goes first — pinned archive entries never —
   and anything still wanted comes back on its next view. */
function sweepImgCache() {
  try {
    const entries = fs.readdirSync(IMG_DIR)
      .filter((f) => !f.endsWith('.json'))
      .map((f) => { const s = fs.statSync(path.join(IMG_DIR, f)); return { f, size: s.size, at: s.mtimeMs }; });
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= IMG_DIR_MAX) return;
    for (const e of entries.sort((a, b) => a.at - b.at)) {
      if (loadJson(path.join(IMG_DIR, e.f + '.json'), {}).pinned) continue;
      try { fs.unlinkSync(path.join(IMG_DIR, e.f)); fs.unlinkSync(path.join(IMG_DIR, e.f + '.json')); } catch (_) {}
      total -= e.size;
      if (total <= IMG_DIR_MAX * 0.8) break;
    }
  } catch (_) {}
}
sweepImgCache();
setInterval(sweepImgCache, 6 * 3600000).unref();

/* ---------------- the collection index ----------------

   Filtering has to see the WHOLE collection: a sidebar built from the 24
   tokens that happen to be on screen would give wrong counts and hide
   matches further down. So each collection gets walked once — ids from
   get_tokens, traits from each token's metadata — and the result is held
   for a while. Metadata reads are individually cached too, so refreshes
   are cheap after the first walk.

   Big collections are capped rather than allowed to stall a request; the
   response says so instead of quietly pretending the index is complete. */

const INDEX_MAX_TOKENS = parseInt(process.env.INDEX_MAX_TOKENS || '1500', 10);
const INDEX_TTL_MS = 600000;
const META_CONCURRENCY = 8;

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (_) { out[i] = null; }
    }
  }));
  return out;
}

/** Traits, flattened to strings so they can be compared and counted.
    Numbers stay printable ("Level 3"), everything else is trimmed. */
function traitsOf(meta) {
  const t = {};
  for (const a of (meta && Array.isArray(meta.attributes) ? meta.attributes : [])) {
    const key = String(a.trait_type ?? a.name ?? '').trim();
    if (!key) continue;
    const val = a.value;
    if (val === null || val === undefined || val === '') continue;
    t[key] = String(val).trim().slice(0, 60);
  }
  return t;
}

/* Indexes answer from memory or disk INSTANTLY, however old, and a
   stale one quietly rebuilds in the background — a visitor never waits
   out a 1500-token walk that some earlier visitor already paid for.
   Disk persistence means a restart begins warm too; the only cold walk
   left is the very first sight of a collection, and boot pre-warms the
   registry so even that is usually already done. */
const IDX_DIR = path.join(CFG.DATA_DIR, 'index');
fs.mkdirSync(IDX_DIR, { recursive: true });
const idxMem = new Map();      // addr -> {at, value}
const idxBuilding = new Map(); // addr -> in-flight build

/** The index we already have — memory, then disk — or null. Never builds. */
function indexPeek(addr) {
  let hit = idxMem.get(addr);
  if (!hit) {
    const disk = loadJson(path.join(IDX_DIR, addr + '.json'), null);
    if (disk && disk.value) { hit = disk; idxMem.set(addr, hit); }
  }
  return hit || null;
}

async function collectionIndex(addr) {
  const hit = indexPeek(addr);
  if (hit) {
    if (Date.now() - hit.at > INDEX_TTL_MS) queueRebuild(addr);
    return hit.value;
  }
  return rebuildIndex(addr);
}

/* Background rebuilds go through ONE worker: nineteen collections going
   stale together (every restart) must refresh one at a time, not as
   nineteen simultaneous 1500-token walks against the same RPC. */
const idxQueue = [];
let idxWorkers = 0;
function queueRebuild(addr) {
  if (idxBuilding.has(addr) || idxQueue.includes(addr)) return;
  idxQueue.push(addr);
  /* Two workers: one storm-recovery pass over twenty collections took
     the better part of an hour single-file, which reads as "broken"
     from outside. Two is still gentle on the RPC. */
  while (idxWorkers < 2 && idxQueue.length > idxWorkers) {
    idxWorkers++;
    (async () => {
      try {
        while (idxQueue.length) {
          const a = idxQueue.shift();
          try { await rebuildIndex(a); } catch (_) {}
        }
      } finally { idxWorkers--; }
    })();
  }
}

function rebuildIndex(addr) {
  if (idxBuilding.has(addr)) return idxBuilding.get(addr);
  const run = (async () => {
    try {
      const value = await buildCollectionIndex(addr);
      const rec = { at: Date.now(), value };
      idxMem.set(addr, rec);
      if (idxMem.size > 200) {
        const oldest = [...idxMem.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) idxMem.delete(oldest[0]);
      }
      saveJson(path.join(IDX_DIR, addr + '.json'), rec);
      return value;
    } finally { idxBuilding.delete(addr); }
  })();
  idxBuilding.set(addr, run);
  return run;
}

async function buildCollectionIndex(addr) {
  const c = nftC(addr);
  const ids = [];
  let start = '';
  let partial = false;
  /* An RPC having a bad minute must not masquerade as an empty
     collection: Koinos Puppies once cached "0 tokens" for real because
     its build ran during a timeout storm, and the site served that
     nothing as truth. Errors are counted apart from genuine emptiness,
     and a build that only erred THROWS instead of caching. */
  let enumErrors = 0;
  const transientErr = (e) => /timeout|invalid json|deadline|ECONN|fetch failed/i.test(String((e && e.message) || e));
  /* Which dialect is this contract? The question is only ambiguous
     while the answer has never been learned: a page-zero read that
     fails with TRANSPORT garbage looks the same for a flaky KCS-2 and
     a Kollection-era contract behind a flaky edge — and one storm
     froze every legacy collection in a retry loop re-asking it. So the
     index REMEMBERS the dialect once learned, rebuilds skip the
     ambiguous test entirely, and only a never-before-seen collection
     has to learn it — with a few patient attempts before giving up. */
  let scheme = indexPeek(addr)?.value?.scheme || null;
  if (scheme !== 'legacy') {
    pages:
    for (let page = 0; page < 200; page++) {
      const args = { limit: 100, descending: false };
      if (start) args.start = start;
      let batch = null;
      for (let attempt = 0; batch === null; attempt++) {
        try { batch = (await c.functions.get_tokens(args)).result?.token_ids || []; }
        catch (e) {
          if (page === 0 && transientErr(e) && scheme !== 'kcs2' && attempt < 2) {
            await new Promise((r) => setTimeout(r, 2500)); // ambiguity is worth a little patience
            continue;
          }
          if (page === 0 && transientErr(e)) throw new Error('get_tokens unreachable — retry, do not misdiagnose');
          if (page === 0) { scheme = 'legacy'; break pages; } // clean "no such entry point"
          enumErrors++;
          break pages;
        }
      }
      scheme = 'kcs2';
      ids.push(...batch);
      if (batch.length < 100) break;
      start = batch[batch.length - 1];
      if (ids.length >= INDEX_MAX_TOKENS) { partial = true; break; }
    }
  }
  /* Kollection-era contracts have no get_tokens at all — their only
     enumeration is per-owner. Every one of them numbers its tokens with
     plain decimal strings, so when the walk finds nothing but the
     supply says otherwise, probe serials against owner_of and keep
     whichever ids exist. Sparse drops (Koinos Astronauts: 180 minted,
     serials scattered up to ~1000) mint out of order, so "1" and "0"
     both missing proves nothing — walk in chunks until the supply is
     accounted for, and only give up on decimal ids after 240 straight
     misses from the start, which is what "ids are names, not numbers"
     (KAP domains) looks like. */
  if (!ids.length) {
    const info = await collectionInfo(addr).catch(() => ({}));
    const supply = Math.min(Number(info.totalSupply || 0), INDEX_MAX_TOKENS);
    if (supply > 0) {
      const asHex = (s) => '0x' + [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      const cap = Math.min(Math.max(supply * 6, 60), 4 * INDEX_MAX_TOKENS);
      for (let at = 0; at <= cap && ids.length < supply; at += 64) {
        const chunk = Array.from({ length: Math.min(64, cap - at + 1) }, (_, i) => asHex(String(at + i)));
        const hits = await mapPool(chunk, META_CONCURRENCY, async (tid) => {
          try { return (await c.functions.owner_of({ token_id: tid })).result?.value ? tid : null; }
          catch (_) { enumErrors++; return null; }
        });
        ids.push(...hits.filter(Boolean));
        if (at + 64 > 240 && !ids.length) break;
      }
      if (ids.length) { partial = partial || Number(info.totalSupply || 0) > INDEX_MAX_TOKENS; scheme = 'legacy'; }
    }
  }

  /* A rebuild on a day the metadata host sulks must never know LESS
     than the index it replaces — pinned art, names and traits all ride
     on these rows. A miss falls back to the previous index's row, and
     ids an ERRORED walk failed to see again are carried over whole. */
  const prev = new Map((indexPeek(addr)?.value?.tokens || []).map((t) => [t.tokenId, t]));
  if (enumErrors > 0 && prev.size) {
    const seen = new Set(ids);
    for (const tid of prev.keys()) if (!seen.has(tid)) ids.push(tid);
  }
  if (!ids.length && enumErrors > 8) {
    throw new Error(`enumeration of ${addr} failed under RPC stress — not caching emptiness`);
  }
  const capped = ids.slice(0, INDEX_MAX_TOKENS);

  /* A collection whose metadata host died (nftstorage.link took whole
     drops with it) would otherwise spend half an hour timing out once
     per token. After eight straight misses with no working path ever
     found, the rest of the walk renders from labels alone — and gets
     another chance on the next rebuild. */
  let metaMisses = 0;
  const flaked = [];
  const tokens = (await mapPool(capped, META_CONCURRENCY, async (tid) => {
    const giveUp = metaMisses >= 8 && !metaPathHints.has(addr);
    const meta = giveUp ? null : await tokenMeta(addr, tid).catch(() => null);
    if (meta) metaMisses = 0; else metaMisses += 1;
    if (!meta && prev.has(tid)) return prev.get(tid);
    if (!meta) flaked.push(tid);
    return {
      tokenId: tid, label: hexToLabel(tid),
      name: meta?.name || hexToLabel(tid),
      image: rewriteImg(meta?.image),
      traits: traitsOf(meta),
    };
  })).filter(Boolean);

  /* If ANY metadata resolved, the path works and the misses were
     weather — an RPC dropping a third of its calls, a giveUp streak
     that condemned the rest of the walk. Retry the stragglers in
     rounds while rounds still help, so an index built in a storm still
     comes out whole. A collection where NOTHING resolved is genuinely
     dark and skips this (dead hosts pay the timeouts once, not four
     times). */
  const anyLife = tokens.some((t) => t.image || Object.keys(t.traits).length) || metaPathHints.has(addr);
  if (anyLife) {
    let remaining = flaked.slice(0, 400);
    for (let round = 0; round < 3 && remaining.length; round++) {
      const next = [];
      for (const tid of remaining) {
        caches.delete(`meta:${addr}:${tid}`); // the miss just cached — retry for real
        const meta = await tokenMeta(addr, tid).catch(() => null);
        if (!meta) { next.push(tid); continue; }
        const at = tokens.findIndex((t) => t.tokenId === tid);
        if (at >= 0) {
          tokens[at] = {
            tokenId: tid, label: hexToLabel(tid),
            name: meta.name || hexToLabel(tid),
            image: rewriteImg(meta.image),
            traits: traitsOf(meta),
          };
        }
      }
      if (next.length === remaining.length) break; // no progress — stop paying
      remaining = next;
    }
  }

  // Facets, ordered by how often the trait appears then alphabetically,
  // so the sidebar leads with the traits that actually divide the set.
  const byTrait = new Map();
  for (const t of tokens) {
    for (const [k, v] of Object.entries(t.traits)) {
      if (!byTrait.has(k)) byTrait.set(k, new Map());
      const vals = byTrait.get(k);
      vals.set(v, (vals.get(v) || 0) + 1);
    }
  }
  const facets = [...byTrait.entries()]
    .map(([trait, vals]) => ({
      trait,
      total: [...vals.values()].reduce((a, b) => a + b, 0),
      values: [...vals.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value), undefined, { numeric: true })),
    }))
    .filter(f => f.values.length > 1 || f.total < tokens.length)
    .sort((a, b) => b.values.length - a.values.length || a.trait.localeCompare(b.trait));

  return { tokens, facets, total: tokens.length, partial: partial || ids.length > capped.length, scheme };
}

/* ---------------- trade history ----------------

   Every listing, cancellation and sale is already recorded: the contract
   emits an event for each, and Koinos indexes a contract's own events
   under its address. So history is READ FROM THE CHAIN rather than kept
   here — a trade done straight against the contract, bypassing this site
   entirely, still shows up.

   The walk is incremental. Records arrive newest-first with a sequence
   number, so once a sequence has been seen it is never fetched again, and
   what has been decoded is written to DATA_DIR to survive a restart.
   Block timestamps cost two extra reads per transaction, so they are
   resolved once and stored with the event. */

const HISTORY_FILE = path.join(CFG.DATA_DIR, 'history.json');
const EVENT_TYPES = {
  'market.create_order': 'market.create_order_event',
  'market.execute_order': 'market.execute_order_event',
  'market.cancel_order': 'market.cancel_order_event',
};
const EVENT_KIND = {
  'market.create_order': 'listed',
  'market.execute_order': 'sold',
  'market.cancel_order': 'cancelled',
};
/* No defaultTypeName: koilib's Serializer lets a default SILENTLY win over
   the type passed per call, which would decode every event as whichever
   type was named first.

   Built defensively because this runs at MODULE LOAD: a throw here would
   kill the process before it ever listened, taking the whole site down for
   the sake of the history panel. Losing history is the right failure. */
let marketSerializer = null;
try {
  if (MARKET_ABI.koilib_types) marketSerializer = new Serializer(MARKET_ABI.koilib_types);
} catch (e) {
  console.error('[history] event decoding unavailable —', String((e && e.message) || e));
}

/* One event, one row. The key has to survive a restart and a re-walk, so
   it is built from what the chain says rather than from insertion order:
   the record's sequence plus the event's index within that receipt (a
   single transaction can emit more than one). */
const eventKey = (e) => [e.seq, e.idx ?? '', e.tx, e.kind, e.tokenId, e.price].join('|');
function dedupeEvents(list) {
  const out = [], seen = new Set();
  for (const e of list) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

let history = loadJson(HISTORY_FILE, null) || { events: [], lastSeq: -1 };
// Repair anything an earlier walk duplicated rather than serving it forever.
if (Array.isArray(history.events)) {
  const before = history.events.length;
  history.events = dedupeEvents(history.events);
  if (history.events.length !== before) {
    console.log(`[history] collapsed ${before - history.events.length} duplicate row(s)`);
    try { saveJson(HISTORY_FILE, history); } catch (_) {}
  }
}
/* How many account-history records the last walk actually read. Without
   it, "no trades yet" and "the walk never reached the chain" look
   identical from the outside — including to the tests. */
let historyScanned = 0;
let historyAt = 0;
let historyRun = null;

async function blockTimeOf(txId) {
  return cached('txtime:' + txId, 86400000, async () => {
    try {
      const t = await provider.call('transaction_store.get_transactions_by_id', { transaction_ids: [txId] });
      const blockId = ((t.transactions || [])[0] || {}).containing_blocks?.[0];
      if (!blockId) return null;
      const b = await provider.call('block_store.get_blocks_by_id', {
        block_ids: [blockId], return_block: true, return_receipt: false,
      });
      const hdr = ((b.block_items || [])[0] || {}).block?.header || {};
      return hdr.timestamp ? Number(hdr.timestamp) : null;
    } catch (_) { return null; }
  });
}

async function refreshHistory({ force = false } = {}) {
  if (!marketC || !marketSerializer) return history;
  if (!force && Date.now() - historyAt < 20000) return history;
  if (historyRun) return historyRun;          // one walk at a time
  historyRun = (async () => {
    const seen = new Set(history.events.map(eventKey));
    const fresh = [];
    let seq = null;
    let scanned = 0;
    let lowestSeen = Infinity;
    for (let page = 0; page < 20; page++) {
      const args = { address: CFG.MARKET_ADDR, limit: 100, ascending: false, irreversible: false };
      if (seq !== null) args.seq_num = seq;
      let res;
      try { res = await provider.call('account_history.get_account_history', args); }
      catch (_) { break; }
      const values = res.values || [];
      if (!values.length) break;
      scanned += values.length;
      let reachedKnown = false;
      let pageMin = Infinity;
      for (const v of values) {
        /* Protobuf omits zero, so the very first record of an account
           arrives with NO seq_num at all. Reading it as a number gave NaN,
           every comparison against it was false, and the walk paged over
           the same records twenty times re-adding what it already had. */
        const n = Number(v.seq_num || 0);
        if (n < pageMin) pageMin = n;
        if (n <= history.lastSeq) { reachedKnown = true; continue; }
        const txId = v.trx?.transaction?.id || null;
        const evs = v.trx?.receipt?.events || [];
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          const type = EVENT_TYPES[ev.name];
          if (!type) continue;
          let data = null;
          try { data = await marketSerializer.deserialize(utils.decodeBase64url(ev.data), type); }
          catch (_) { continue; }
          const row = {
            seq: n, idx: Number(ev.sequence ?? i), kind: EVENT_KIND[ev.name], tx: txId,
            at: await blockTimeOf(txId),
            collection: data.collection, tokenId: data.token_id,
            seller: data.seller || null, buyer: data.buyer || null,
            price: data.price || null,
            fee: data.protocol_fee || null, royalty: data.royalties_paid || null,
            expires: data.expires || null,
          };
          const key = eventKey(row);
          if (seen.has(key)) { reachedKnown = true; continue; }
          seen.add(key);            // within this walk too, not just against what was stored
          fresh.push(row);
        }
      }
      if (reachedKnown || pageMin <= 0) break;
      const next = pageMin - 1;
      // Never re-ask for ground already covered — that is how this looped.
      if (!Number.isFinite(next) || next < 0 || next >= lowestSeen) break;
      lowestSeen = next;
      seq = next;
    }
    if (fresh.length) {
      history.events = dedupeEvents([...fresh, ...history.events])
        .sort((a, b) => b.seq - a.seq || b.idx - a.idx)
        .slice(0, 20000);
      history.lastSeq = Math.max(history.lastSeq, ...fresh.map(e => e.seq));
      try { saveJson(HISTORY_FILE, history); } catch (_) {}
    }
    historyScanned = scanned;
    historyAt = Date.now();
    return history;
  })().finally(() => { historyRun = null; });
  return historyRun;
}

/* ---------------- launching a collection ----------------

   A launch is three things happening in order:

     1. the creator pays the launch fee and the contract is uploaded, in
        ONE transaction so the fee cannot land without the collection;
     2. the collection is initialized — named, given its royalty, and
        handed to the creator, who owns it from that moment;
     3. it is registered here so it appears on the site.

   The contract is deployed to its own fresh account. That account's key
   is the collection's upgrade authority and OURO keeps it: creators own
   their collections (mint, metadata, royalties) without having to keep a
   key alive that would break their collection if they lost it. The key is
   written with owner-only permissions, is never returned by any endpoint,
   and never reaches a log line. */

const pendingLaunches = new Map();      // prepared-but-unsigned launches
const UPLOAD_DIR = path.join(CFG.DATA_DIR, 'uploads');
/* Losing uploads is survivable; losing the site is not. A read-only or
   full disk here would otherwise throw at module load, before anything is
   listening and before a single log line — which from outside is a bare
   503 with nothing to read. */
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
catch (e) { console.error('[uploads] directory unavailable —', String((e && e.message) || e)); }

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const publicOrigin = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers.host || '').trim();
  return process.env.PUBLIC_ORIGIN || (host ? `${proto}://${host}` : '');
};

/** Only links we would be willing to render; never a javascript: or data: url. */
const safeImage = (u) => {
  const s = String(u || '').trim();
  if (!s) return null;
  if (s.startsWith('/u/')) return s;                        // our own upload
  if (/^https:\/\//.test(s) || /^ipfs:\/\//.test(s)) return s.slice(0, 500);
  return null;
};

/** Magic bytes, not the filename: the extension is whatever a caller typed. */
function imageKind(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.slice(0, 6).toString('latin1') === 'GIF89a' || b.slice(0, 6).toString('latin1') === 'GIF87a') return 'gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function readRaw(req, max) {
  /* Never destroy the socket on an oversize body: from the browser a
     killed connection is a bare "Failed to fetch", indistinguishable from
     a network drop. Resolve 'OVERSIZE' and keep draining, so the caller
     can answer 413 with words in it. Bodies that announce their size in
     Content-Length are refused before a byte is read. */
  return new Promise((resolve) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > max) { req.resume(); return resolve('OVERSIZE'); }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; req.resume(); return resolve('OVERSIZE'); }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', () => resolve(null));
  });
}

/** A collection's read caches, after something changed on chain. The
    browse grid is served from a ten-minute index; without this, a fresh
    mint shows on its own token page (a direct read) while the collection
    page insists it does not exist — exactly the bug that shipped. */
function forgetCollection(addr) {
  idxMem.delete(addr);
  try { fs.unlinkSync(path.join(IDX_DIR, addr + '.json')); } catch (_) {}
  caches.delete('info:' + addr);
  for (const k of [...caches.keys()]) {
    if (k.startsWith('owned:' + addr + ':')) caches.delete(k);
  }
}

/* ---------------- the home snapshot ----------------

   The home page used to interrogate the chain about every collection —
   serially — while the visitor watched a spinner. Now a snapshot of
   that answer lives in memory and on disk, every request is served from
   it at memory speed, and a stale snapshot refreshes BEHIND the
   response it just gave. Floors lag live trading by a refresh, which is
   the right trade: browsing is constant, buying re-checks on chain. */
const HOME_FILE = path.join(CFG.DATA_DIR, 'home.json');
let homeSnap = loadJson(HOME_FILE, null); // { at, collections }
let homeBuilding = null;

async function buildHome() {
  return mapPool(registry.collections.slice(), 6, async (c) => {
    const info = await collectionInfo(c.address).catch(() => ({ address: c.address }));
    /* A FAILED order read is not an empty order book. Zeros written
       during one bad minute made every collection say "0 listed" until
       someone asked why — reuse the previous snapshot's numbers when
       the read errs, real zeros only when the chain really says so. */
    const orders = await collectionOrders(c.address).catch(() => null);
    const prevRow = orders === null && homeSnap
      ? homeSnap.collections.find((r) => r.address === c.address) : null;
    const floor = orders && orders.length
      ? orders.reduce((m, o) => BigInt(o.price) < m ? BigInt(o.price) : m, BigInt(orders[0].price)) : null;
    // No cover chosen? Borrow one from the collection itself — in the
    // background, so an index build never holds up this listing.
    if (!c.image) deriveCover(c.address).catch(() => {});
    return {
      ...c, ...info,
      listed: orders === null ? (prevRow?.listed ?? 0) : orders.length,
      floor: orders === null ? (prevRow?.floor ?? null) : (floor === null ? null : floor.toString()),
    };
  });
}

let homeBuildingAt = 0;
function refreshHome({ maxAgeMs = 15000 } = {}) {
  if (homeSnap && Date.now() - homeSnap.at < maxAgeMs) return Promise.resolve(homeSnap);
  /* A build stuck past any sane RPC budget is abandoned, not awaited —
     the provider timeout should make this unreachable, but a frozen
     home page must have no second way to happen. */
  if (homeBuilding && Date.now() - homeBuildingAt > 90000) homeBuilding = null;
  if (homeBuilding) {
    /* A FORCED refresh must not coalesce into a build that started
       before the thing it was forced for (a collection added mid-build
       would stay invisible until the next interval). Chain behind it. */
    return maxAgeMs === 0
      ? homeBuilding.then(() => refreshHome({ maxAgeMs: 1 }), () => refreshHome({ maxAgeMs: 1 }))
      : homeBuilding;
  }
  homeBuildingAt = Date.now();
  const run = (async () => {
    try {
      const collections = await buildHome();
      homeSnap = { at: Date.now(), collections };
      saveJson(HOME_FILE, homeSnap);
      return homeSnap;
    } finally { if (homeBuilding === run) homeBuilding = null; }
  })();
  homeBuilding = run;
  return run;
}
setInterval(() => refreshHome({ maxAgeMs: 45000 }).catch(() => {}), 60000).unref();

/* Covers resolve against the LIVE registry row at serve time, so a
   cover derived a moment ago shows without waiting for the next
   snapshot build. */
function homeRow(snapRow) {
  const reg = registry.collections.find((r) => r.address === snapRow.address);
  return { ...snapRow, image: coverUrl(reg || snapRow) };
}

const marketCfg = async () => {
  if (!marketC) return {};
  try { return await cached('marketcfg', 300000, async () => (await marketC.functions.get_config({})).result) || {}; }
  catch (_) { return {}; }
};

const COLLECTION_WASM = path.join(__dirname, 'contracts', 'prebuilt', 'collection', 'contract.wasm');
const COLLECTION_ABI = sanitizeAbi(loadJson(path.join(__dirname, 'server-abi', 'collection-abi.json'), {}));
const KEYS_FILE = path.join(CFG.DATA_DIR, 'collection-keys.json');
const LAUNCH_LOG = path.join(CFG.DATA_DIR, 'launches.json');
let launches = loadJson(LAUNCH_LOG, null) || { items: [] };
const MINT_LOG = path.join(CFG.DATA_DIR, 'mints.json');
let mints = loadJson(MINT_LOG, null) || { items: [] };
function mintsSince(ms) {
  const t = Date.now();
  return mints.items.filter(m => t - m.at < ms).length;
}

/** Upgrade keys, at rest. Written 0600 and read by nothing but this. */
function rememberCollectionKey(address, wif, owner) {
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (_) {}
  keys[address] = { wif, owner, at: Date.now() };
  const tmp = `${KEYS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, KEYS_FILE);
  try { fs.chmodSync(KEYS_FILE, 0o600); } catch (_) {}
}

const DAY = 86400000;
function launchesSince(ms, who) {
  const t = Date.now();
  return launches.items.filter(l => t - l.at < ms && (!who || l.owner === who)).length;
}

const KOIN_SATS = (koin) => BigInt(Math.round(Number(koin) * 1e8));

/** Everything a launch needs checked before any mana is spent on it. */
function validateLaunch(body) {
  const name = String(body.name || '').trim();
  const symbol = String(body.symbol || '').trim().toUpperCase();
  const description = String(body.description || '').trim();
  const image = String(body.image || '').trim();
  const uri = String(body.uri || '').trim();
  const owner = String(body.owner || '').trim();
  const royaltyBps = Math.round(Number(body.royaltyBps || 0));

  if (!isAddr(owner)) return { error: 'A connected wallet is required to own the collection' };
  if (name.length < 1 || name.length > 64) return { error: 'Name must be 1-64 characters' };
  if (!/^[A-Z0-9]{1,16}$/.test(symbol)) return { error: 'Symbol must be 1-16 letters or digits' };
  if (description.length > 1000) return { error: 'Description must be 1000 characters or fewer' };
  if (uri && !/^https:\/\/|^ipfs:\/\//.test(uri)) return { error: 'Base URI must be https:// or ipfs://' };
  if (uri.length > 300) return { error: 'Base URI must be 300 characters or fewer' };
  if (image && !/^https:\/\/|^ipfs:\/\//.test(image)) return { error: 'Image must be an https:// or ipfs:// link' };
  if (!(royaltyBps >= 0 && royaltyBps <= 1000)) return { error: 'Royalty must be between 0% and 10%' };
  return { name, symbol, description, image, uri, owner, royaltyBps };
}


/** Name a deployed collection and hand it to its creator.

    The payee is the COLLECTION's own account, never the dev wallet. Dev
    pays the mana, but a transaction's payee is whose NONCE it spends —
    and the dev wallet is also the game's, signing constantly. Borrowing
    its nonce here put this transaction in a race it kept losing, which
    is how a paid-for collection ended up deployed but unnamed. A freshly
    created account has a nonce nobody else is touching. */
async function initializeCollection(address, key, spec) {
  const c = new Contract({ id: address, provider, abi: COLLECTION_ABI, signer: key });
  const { transaction } = await c.functions.initialize({
    name: spec.name, symbol: spec.symbol, uri: spec.uri || '', description: spec.description || '',
    owner: spec.owner, royalty_bps: String(spec.royaltyBps || 0), royalty_address: spec.owner,
  }, {
    payer: dev.getAddress(), payee: address, rcLimit: String(5e8),
    beforeSend: async (t) => { await dev.signTransaction(t); },
  });
  await transaction.wait('byTransactionId', 60000);
  return transaction.id;
}


/** Everything after the contract is on chain: name it, hand it over,
    keep its key, and put it on the site. Shared by both launch paths. */
async function completeLaunch(address, key, spec) {
  let initialized = false;
  let lastError = null;
  for (let attempt = 0; attempt < 3 && !initialized; attempt++) {
    try { await initializeCollection(address, key, spec); initialized = true; }
    catch (e) {
      lastError = String((e && e.message) || e).slice(0, 300);
      console.error('[launch] initialize attempt failed —', lastError);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  rememberCollectionKey(address, key.getPrivateKey('wif', true), spec.owner);
  launches.items.push({ address, owner: spec.owner, at: Date.now(), initialized });
  try { saveJson(LAUNCH_LOG, launches); } catch (_) {}
  if (!registry.collections.some(c => c.address === address)) {
    registry.collections.push({
      address, name: spec.name, description: spec.description,
      image: spec.image || '', featured: false, addedBy: spec.owner,
      addedAt: Date.now(), launched: true,
    });
    saveJson(REGISTRY_FILE, registry);
  }
  caches.delete('info:' + address);
  return { initialized, error: initialized ? null : lastError };
}

/** The collection's own signer, when this launchpad holds its key. */
function collectionKeyFor(collection) {
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (_) {}
  const held = keys[collection];
  if (!held || !held.wif) return null;
  const key = Signer.fromWif(held.wif);
  key.provider = provider;
  return key;
}

/** Sign ops as the collection, pay as dev, broadcast, wait. */
async function sendAsCollection(collection, key, ops, rcKoin) {
  const tx = new Transaction({
    signer: key, provider,
    options: { payer: dev.getAddress(), payee: collection, rcLimit: String(Math.round(rcKoin * 1e8)) },
  });
  for (const op of ops) await tx.pushOperation(op);
  await tx.prepare();
  await tx.sign();
  await dev.signTransaction(tx.transaction);
  const send = new Transaction({ provider });
  send.transaction = tx.transaction;
  await send.send();
  await send.wait('byTransactionId', 60000);
  return send.transaction.id;
}

/** Collections launched before the mint-authority change refuse their own
    account. We hold the upgrade key: upload the current binary in place. */
async function healMintAuthority(collection, key) {
  await sendAsCollection(collection, key, [{
    upload_contract: {
      contract_id: collection,
      bytecode: utils.encodeBase64url(fs.readFileSync(COLLECTION_WASM)),
    },
  }], 80);
}

/** One mint item, checked. Returns {error} or the cleaned item. */
function cleanMintItem(raw, i) {
  const tokenId = String(raw.tokenId || '').trim().toLowerCase();
  const name = String(raw.name || '').trim();
  const description = String(raw.description || '').trim().slice(0, 1000);
  const image = safeImage(raw.image);
  if (!/^0x[0-9a-f]{2,64}$/.test(tokenId)) return { error: `item ${i + 1}: token id must be hex` };
  if (name.length < 1 || name.length > 80) return { error: `item ${i + 1}: name must be 1-80 characters` };
  if (!image) return { error: `item ${i + 1}: artwork is required` };
  const attributes = (Array.isArray(raw.attributes) ? raw.attributes : [])
    .slice(0, 24)
    .map(a => ({ trait_type: String(a.trait_type || '').slice(0, 60), value: String(a.value ?? '').slice(0, 60) }))
    .filter(a => a.trait_type && a.value);
  return { tokenId, name, description, image, attributes };
}

/* ---------------- mana sponsorship ---------------- */

/* The rules that keep the dev wallet safe while it pays for strangers:

     1. payer must be the dev address — we never co-sign someone else's bill;
     2. payee must be set, must not be dev, and MUST have signed — the
        chain also enforces the payee signature (the payee's nonce is
        consumed), this check just fails fast and keeps garbage off chain;
     3. every operation must target the marketplace, or be an approval on
        a REGISTERED collection (the op that precedes a listing) — the dev
        wallet does not fund arbitrary computation;
     4. the rc ceiling is capped, and each payee and IP is rate limited. */

const entryIds = (abi) => {
  const ids = {};
  for (const [name, m] of Object.entries(abi.methods || {})) {
    ids[name] = typeof m['entry-point'] === 'string' ? parseInt(m['entry-point'], 16) : m['entry-point'];
  }
  return ids;
};
const NFT_ENTRIES = entryIds(loadJson(path.join(__dirname, 'server-abi', 'nft-abi.json'), {}));
const APPROVAL_ENTRIES = new Set([NFT_ENTRIES.approve, NFT_ENTRIES.set_approval_for_all].filter(Boolean));
/* What a creator does to their own collection. Paying the mana for these
   is safe because the COLLECTION decides who may run them — the contract
   checks the caller is its owner — so this only ever funds work the chain
   was going to accept anyway. */
const CREATOR_ENTRIES = new Set([
  NFT_ENTRIES.mint, NFT_ENTRIES.set_metadata,
  NFT_ENTRIES.set_royalties, NFT_ENTRIES.transfer_ownership,
].filter(Boolean));
/* KOIN is KCS-4: a contract spends someone's KOIN only through an
   allowance, a signature alone stopped being enough chain-wide. So a buy
   arrives as approve(market, price) + execute_order, and the approve is
   safe to pay for — it moves nothing, and only the market can consume it,
   which it only does inside an execute_order the same owner signed. */
const KOIN_APPROVE_ENTRY = Number((utils.tokenAbi.methods.approve || {}).entry_point || 0);
const MARKET_EXEC_ENTRY = entryIds(MARKET_ABI).execute_order;

const sponsorHits = new Map();
function rateLimited(key, max, windowMs) {
  const t = Date.now();
  const arr = (sponsorHits.get(key) || []).filter(x => t - x < windowMs);
  arr.push(t);
  sponsorHits.set(key, arr);
  return arr.length > max;
}

async function sponsor(txJson, ip) {
  if (!dev) return { status: 503, body: { error: 'Sponsorship is not configured on this server' } };
  if (!marketC) return { status: 503, body: { error: 'Marketplace contract is not configured' } };
  const tx = txJson;
  const h = tx && tx.header;
  if (!h || !Array.isArray(tx.operations) || !tx.operations.length) {
    return { status: 400, body: { error: 'A prepared transaction is required' } };
  }
  const devAddr = dev.getAddress();
  if (h.payer !== devAddr) return { status: 400, body: { error: 'payer must be the marketplace mana wallet' } };
  if (!h.payee || h.payee === devAddr) return { status: 400, body: { error: 'payee must be the acting account' } };
  let rc;
  try { rc = BigInt(h.rc_limit); } catch (_) { return { status: 400, body: { error: 'bad rc_limit' } }; }
  /* Budget the ceiling against the work actually being authorized, so a
     bigger transaction gets the mana it needs without handing every
     transaction the maximum. An execute_order counts as several plain
     calls: inside it are three KOIN transfers, an NFT transfer and the
     royalty reads. */
  let opWeight = 0n;
  for (const op of tx.operations) {
    const c = op.call_contract;
    opWeight += (c && c.contract_id === CFG.MARKET_ADDR && Number(c.entry_point) === MARKET_EXEC_ENTRY) ? 4n : 1n;
  }
  const opBudget = CFG.SPONSOR_RC_PER_OP * opWeight;
  const ceiling = opBudget < CFG.SPONSOR_RC_MAX ? opBudget : CFG.SPONSOR_RC_MAX;
  if (rc <= 0n || rc > ceiling) {
    return { status: 400, body: { error: 'rc_limit above the sponsorship ceiling' } };
  }

  const registered = new Set(registry.collections.map(c => c.address));
  let sawMint = false;
  const feeOps = [];
  const allowanceOps = [];
  const touched = [];
  for (const op of tx.operations) {
    const call = op.call_contract;
    if (!call) return { status: 400, body: { error: 'only contract calls are sponsored' } };
    const target = call.contract_id;
    const entry = Number(call.entry_point);
    const isMarket = target === CFG.MARKET_ADDR;
    const isApproval = registered.has(target) && APPROVAL_ENTRIES.has(entry);
    const isCreatorOp = registered.has(target) && CREATOR_ENTRIES.has(entry);
    if (isCreatorOp) touched.push(target);
    if (entry === NFT_ENTRIES.mint && registered.has(target)) sawMint = true;
    if (target === NET.koinContract) {
      /* Two KOIN operations ride the sponsor and nothing else: the
         allowance that lets the market collect a purchase, and — while a
         mint fee is set — the fee transfer. Both are decoded and checked
         below before anything is signed. */
      if (KOIN_APPROVE_ENTRY && entry === KOIN_APPROVE_ENTRY) { allowanceOps.push(op); continue; }
      if (CFG.MINT_FEE_KOIN > 0) { feeOps.push(op); continue; }
      return { status: 400, body: { error: 'that operation is not something this wallet pays for' } };
    }
    if (!isMarket && !isApproval && !isCreatorOp) {
      return { status: 400, body: { error: 'that operation is not something this wallet pays for' } };
    }
  }
  for (const op of allowanceOps) {
    /* An allowance the payee grants THE MARKET, from their own account —
       it moves no funds, and only an execute_order the owner signs can
       ever consume it. Any other owner or spender is someone else's bill. */
    try {
      const koinC = new Contract({ id: NET.koinContract, provider, abi: TOKEN_ABI });
      const dec = await koinC.decodeOperation(op);
      if (dec.name !== 'approve' || dec.args.owner !== h.payee || dec.args.spender !== CFG.MARKET_ADDR) {
        return { status: 400, body: { error: 'that operation is not something this wallet pays for' } };
      }
    } catch (_) {
      return { status: 400, body: { error: 'that operation is not something this wallet pays for' } };
    }
  }
  if (feeOps.length) {
    const treasury = (await marketCfg()).treasury;
    if (feeOps.length > 1 || !sawMint || !isAddr(treasury)) {
      return { status: 400, body: { error: 'that operation is not something this wallet pays for' } };
    }
    try {
      const koinC = new Contract({ id: NET.koinContract, provider, abi: TOKEN_ABI });
      const dec = await koinC.decodeOperation(feeOps[0]);
      const want = KOIN_SATS(CFG.MINT_FEE_KOIN).toString();
      if (dec.name !== 'transfer' || dec.args.to !== treasury ||
          String(dec.args.value) !== want || dec.args.from !== h.payee) {
        return { status: 400, body: { error: `The mint fee must be exactly ${CFG.MINT_FEE_KOIN} KOIN to the treasury` } };
      }
    } catch (_) {
      return { status: 400, body: { error: 'that operation is not something this wallet pays for' } };
    }
  }

  if (rateLimited('payee:' + h.payee, 30, 3600000) || rateLimited('ip:' + ip, 90, 3600000)) {
    return { status: 429, body: { error: 'Too many sponsored transactions — slow down' } };
  }

  // The payee must already have signed what we are about to pay for.
  let signers = [];
  try { signers = await Signer.recoverAddresses(tx); } catch (_) {}
  if (!signers.includes(h.payee)) {
    return { status: 400, body: { error: 'the payee has not signed this transaction' } };
  }

  await dev.signTransaction(tx);
  try {
    const receipt = await provider.sendTransaction(tx);
    // A creator just changed their collection; stop serving the old view.
    for (const addr of new Set(touched)) forgetCollection(addr);
    return { status: 200, body: { ok: true, id: tx.id, receipt: receipt && receipt.receipt } };
  } catch (e) {
    /* Keep the chain's own words in the log — that is where a rejection
       gets diagnosed — while the caller gets something a person can act on. */
    const raw = String(e && e.message || e);
    console.error('[sponsor] rejected', raw.slice(0, 300));
    return { status: 400, body: { error: raw.slice(0, 300) } };
  }
}

/* A collection nobody gave a cover image: front it with its most recent
   active listing's art, or failing that the newest token that has any.
   Found once, stored in the registry exactly like a hand-picked image —
   so the cost is paid once, and an owner's later choice still wins by
   simply replacing the field. */
const coverBusy = new Set();
const coverTried = new Map(); // addr -> when the last hunt came up empty
async function deriveCover(addr) {
  if (coverBusy.has(addr)) return;
  const tried = coverTried.get(addr);
  if (tried && Date.now() - tried < 600000) return;
  coverBusy.add(addr);
  try {
    let img = null;
    const orders = await collectionOrders(addr).catch(() => []);
    if (orders.length) {
      const newest = orders.reduce((a, b) => (Number(b.created || 0) > Number(a.created || 0) ? b : a));
      img = rewriteImg(((await tokenMeta(addr, newest.tokenId).catch(() => null)) || {}).image);
    }
    if (!img) {
      const idx = await collectionIndex(addr).catch(() => null);
      const toks = (idx && idx.tokens) || [];
      for (let i = toks.length - 1; i >= 0 && !img; i--) img = toks[i].image;
    }
    /* Unpinned art produces a URL that answers 504 on every gateway — a
       broken cover reads worse than the placeholder. Persist only a url
       that demonstrably serves an image, from whichever gateway does. */
    let proven = null;
    for (const u of (img ? (ipfsRoots(img) || [img]) : [])) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(7000), size: 4194304 });
        if (r.ok && /^image\//.test(r.headers.get('content-type') || '')) { proven = u; }
        try { await r.arrayBuffer(); } catch (_) {}
        if (proven) break;
      } catch (_) {}
    }
    const row = registry.collections.find((x) => x.address === addr);
    if (proven && row && !row.image) { row.image = proven; saveJson(REGISTRY_FILE, registry); }
    else coverTried.set(addr, Date.now());
  } finally { coverBusy.delete(addr); }
}

/* ---------------- http plumbing ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
/* Compress what compresses. res.req is the paired request (node has
   carried it since v12), so no signature has to change. */
const wantsGzip = (res) => /\bgzip\b/.test((res.req && res.req.headers['accept-encoding']) || '');
function json(res, status, body) {
  let data = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (data.length > 2048 && wantsGzip(res)) {
    data = zlib.gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 262144) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
  });
}
/* Uploaded art. The name IS the content hash, so it can never change and
   is cached hard; the route pattern is the only path that reaches here,
   which keeps a filename from walking out of the directory. */
async function serveUpload(res, name, wantThumb) {
  const file = path.join(UPLOAD_DIR, name);
  if (!file.startsWith(UPLOAD_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(file);
  const full = { file, type: MIME[ext] || 'application/octet-stream' };
  const variant = (wantThumb && await thumbOf(file, full.type).catch(() => null)) || full;
  res.writeHead(200, {
    'Content-Type': variant.type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(variant.file).pipe(res);
}

const GZIPPABLE = new Set(['.html', '.js', '.css', '.json', '.svg']);
const gzipCache = new Map(); // file:mtime -> gzipped buffer (koilib compresses once, not per visitor)
function serveStatic(res, urlPath) {
  const clean = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(__dirname, 'public', clean);
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // hash-routed SPA: any extensionless miss is the app
    if (!path.extname(clean)) file = path.join(__dirname, 'public', 'index.html');
    else { res.writeHead(404); return res.end('not found'); }
  }
  const ext = path.extname(file);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  };
  const stat = fs.statSync(file);
  if (GZIPPABLE.has(ext) && stat.size > 2048 && wantsGzip(res)) {
    const key = `${file}:${stat.mtimeMs}`;
    if (!gzipCache.has(key)) {
      gzipCache.set(key, zlib.gzipSync(fs.readFileSync(file)));
      if (gzipCache.size > 100) gzipCache.delete(gzipCache.keys().next().value);
    }
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    return res.end(gzipCache.get(key));
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/* ---------------- api ---------------- */

/* The game's public settings, chiefly the Google client id. This used to be
   a live cross-site fetch with no fallback, which made a value that never
   changes depend on one host being reachable from this one — and when that
   call started failing, sign-in silently advertised itself as "not
   configured". Now: this server's own env wins, the last good answer is
   remembered on disk, and the reason for a failure is kept for /api/diag. */
const GAMEINFO_FILE = path.join(CFG.DATA_DIR, 'gameinfo.json');
let aurvaniaInfo = loadJson(GAMEINFO_FILE, null);
let aurvaniaError = null;
let aurvaniaAt = 0;

async function fetchJson(url, opts = {}, tries = 2) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        ...opts,
        headers: {
          // Without this the game's host answers 403 before our request
          // ever reaches its app — node's default UA is on the wrong side
          // of its filter.
          'User-Agent': opts.ua || CFG.BRIDGE_UA,
          Accept: 'application/json',
          ...(opts.headers || {}),
        },
        signal: AbortSignal.timeout(opts.timeoutMs || 12000),
      });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) {}
      return { ok: r.ok, status: r.status, body, text };
    } catch (e) {
      last = e;
      if (i + 1 < tries) await new Promise((r) => setTimeout(r, 400));
    }
  }
  const err = new Error(`${last && last.name === 'TimeoutError' ? 'timed out' : String((last && last.message) || last)}`);
  err.cause = last;
  throw err;
}

async function gameInfo() {
  // Refresh at most every ten minutes; serve the remembered copy meanwhile.
  if (aurvaniaInfo && Date.now() - aurvaniaAt < 600000) return aurvaniaInfo;
  try {
    const r = await fetchJson(CFG.AURVANIA_API + '/api/chain-info');
    if (r.ok && r.body) {
      aurvaniaInfo = r.body;
      aurvaniaError = null;
      aurvaniaAt = Date.now();
      try { saveJson(GAMEINFO_FILE, aurvaniaInfo); } catch (_) {}
    } else {
      aurvaniaError = `HTTP ${r.status}`;
    }
  } catch (e) {
    aurvaniaError = String((e && e.message) || e).slice(0, 200);
    if (!aurvaniaInfo) console.error(`[bridge] ${CFG.AURVANIA_API} unreachable — ${aurvaniaError}`);
  }
  return aurvaniaInfo || {};
}

const api = {
  async config(req, res) {
    const gi = await gameInfo();
    let feeBps = 250, treasury = null;
    if (marketC) {
      try {
        const cfg = await cached('marketcfg', 300000, async () => (await marketC.functions.get_config({})).result);
        if (cfg) { feeBps = Number(cfg.fee_bps || 0); treasury = cfg.treasury || null; }
      } catch (_) {}
    }
    json(res, 200, {
      network: CFG.NETWORK, networkLabel: NET.label, rpc: RPCS[0], rpcs: RPCS,
      explorer: NET.explorer, koin: NET.koinContract,
      market: CFG.MARKET_ADDR || null, feeBps, treasury,
      sponsor: !!dev, sponsorPayer: dev ? dev.getAddress() : null,
      // Our own env first: the bridge is a convenience, not a dependency.
      mintFeeKoin: CFG.MINT_FEE_KOIN,
      googleClientId: CFG.GOOGLE_CLIENT_ID || gi.googleClientId || null,
      aurvania: CFG.AURVANIA_API,
    });
  },

  /** Adding a collection is open to anyone: the chain already decides what
      is real, so this only checks that the address answers as KCS-2 and
      rate-limits the obvious abuse. Only `featured` stays privileged. */
  async collections(req, res) {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const admin = !!CFG.ADMIN_KEY && body.key === CFG.ADMIN_KEY;
      const ip = clientIp(req);
      if (!admin && rateLimited('addcol:' + ip, 10, DAY)) {
        return json(res, 429, { error: 'That is a lot of collections for one day — try again tomorrow' });
      }
      const addr = String(body.address || '').trim();
      if (!isAddr(addr)) return json(res, 400, { error: 'A Koinos address is required' });
      if (registry.collections.some(c => c.address === addr)) return json(res, 400, { error: 'Already registered' });
      const info = await collectionInfo(addr);
      if (!info.name && !info.symbol) return json(res, 400, { error: 'That address does not answer as a KCS-2 collection' });
      const row = {
        address: addr, name: String(body.name || info.name || addr),
        description: String(body.description || info.description || '').slice(0, 1000),
        image: safeImage(body.image) || '', featured: admin && !!body.featured,
        addedBy: isAddr(body.by) ? body.by : null, addedAt: Date.now(),
      };
      registry.collections.push(row);
      saveJson(REGISTRY_FILE, registry);
      // Visible on the home page immediately, exact numbers a refresh later.
      if (homeSnap) homeSnap.collections.push({ ...row, ...info, listed: 0, floor: null });
      refreshHome({ maxAgeMs: 0 }).catch(() => {});
      queueRebuild(addr);
      return json(res, 200, { ok: true, collection: info });
    }
    /* Answer from the snapshot at memory speed, however old it is; a
       stale one refreshes behind this response, not in front of it. */
    if (!homeSnap) await refreshHome().catch(() => {});
    else refreshHome().catch(() => {});
    json(res, 200, { collections: (homeSnap ? homeSnap.collections : []).map(homeRow) });
  },

  async collection(req, res, addr) {
    if (!isAddr(addr)) return json(res, 400, { error: 'bad address' });
    if (req.method === 'DELETE') {
      /* Registration's undo, behind the same admin key that curates the
         registry. Removal only unlists from THIS site — tokens, owners
         and any on-chain orders are untouched, so a removal with live
         listings is refused unless forced, to keep the book honest. */
      const body = await readBody(req).catch(() => ({}));
      const key = String(body.key || new URL(req.url, 'http://localhost').searchParams.get('key') || '');
      if (!CFG.ADMIN_KEY || key !== CFG.ADMIN_KEY) return json(res, 403, { error: 'the admin key opens this door' });
      const at = registry.collections.findIndex((c) => c.address === addr);
      if (at < 0) return json(res, 404, { error: 'not registered' });
      const live = await collectionOrders(addr).catch(() => []);
      if (live.length && !body.force) {
        return json(res, 400, { error: `${live.length} live listing(s) — cancel them first, or pass force:true to unlist the collection anyway (the orders stay on chain)` });
      }
      registry.collections.splice(at, 1);
      saveJson(REGISTRY_FILE, registry);
      forgetCollection(addr);
      if (homeSnap) homeSnap.collections = homeSnap.collections.filter((c) => c.address !== addr);
      return json(res, 200, { ok: true, removed: addr });
    }
    const reg = registry.collections.find(c => c.address === addr) || null;
    const info = await collectionInfo(addr);
    // A blinked RPC read of the order book must not take the page down.
    const orders = await collectionOrders(addr).catch(() => []);
    json(res, 200, { registered: !!reg, meta: reg ? { ...reg, image: coverUrl(reg) } : null, info, orders });
  },

  /** The browse grid, filtered and sorted across the WHOLE collection.
      Filters arrive as repeated t=Trait:Value; several values of the SAME
      trait are an OR (rare or epic), different traits are an AND. */
  async tokens(req, res, addr, q) {
    if (!isAddr(addr)) return json(res, 400, { error: 'bad address' });
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10));
    const limit = Math.min(60, Math.max(1, parseInt(q.get('limit') || '24', 10)));
    const status = String(q.get('status') || 'all');
    const sort = String(q.get('sort') || 'default');
    const search = String(q.get('q') || '').trim().toLowerCase();

    const wanted = new Map();
    for (const raw of q.getAll('t')) {
      const i = String(raw).indexOf(':');
      if (i < 1) continue;
      const trait = raw.slice(0, i), value = raw.slice(i + 1);
      if (!wanted.has(trait)) wanted.set(trait, new Set());
      wanted.get(trait).add(value);
    }

    const idx = await collectionIndex(addr);
    const orders = await collectionOrders(addr).catch(() => []);
    const listed = new Map(orders.map(o => [o.tokenId, o]));

    /* "Mine" is just another filter, so it composes with the traits
       instead of being a separate view with its own half of the rules. */
    const owner = String(q.get('owner') || '');
    let ownedIds = null;
    if (isAddr(owner)) {
      let viaStandard = true;
      try {
        const { result } = await cached(`owned:${addr}:${owner}`, 20000,
          async () => nftC(addr).functions.get_tokens_by_owner({ owner, limit: 500 }));
        ownedIds = new Set(result?.token_ids || []);
      } catch (_) { viaStandard = false; ownedIds = new Set(); }
      if (!viaStandard && idx.tokens.length && idx.tokens.length <= 200) {
        /* Kollection-era contracts only enumerate per owner-and-index;
           for a small collection it is cheaper to ask owner_of across
           the whole index than to page that. */
        const owners = await cached(`owners:${addr}`, 60000, async () =>
          mapPool(idx.tokens, META_CONCURRENCY, async (t) => ({
            id: t.tokenId,
            owner: (await nftC(addr).functions.owner_of({ token_id: t.tokenId })).result?.value || null,
          })));
        ownedIds = new Set(owners.filter((o) => o && o.owner === owner).map((o) => o.id));
      }
    }

    let rows = idx.tokens.filter((t) => {
      for (const [trait, values] of wanted) {
        if (!values.has(t.traits[trait])) return false;
      }
      if (ownedIds && !ownedIds.has(t.tokenId)) return false;
      if (status === 'listed' && !listed.has(t.tokenId)) return false;
      if (status === 'unlisted' && listed.has(t.tokenId)) return false;
      if (search && !(`${t.name} ${t.label}`.toLowerCase().includes(search))) return false;
      return true;
    }).map(t => ({ ...t, order: listed.get(t.tokenId) || null }));

    const priceOf = (t) => (t.order ? BigInt(t.order.price) : null);
    if (sort === 'price_asc' || sort === 'price_desc') {
      rows.sort((a, b) => {
        const pa = priceOf(a), pb = priceOf(b);
        // Unlisted tokens have no price; they sort after everything priced.
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        if (pa === pb) return 0;
        const cmp = pa < pb ? -1 : 1;
        return sort === 'price_asc' ? cmp : -cmp;
      });
    } else if (sort === 'name') {
      rows.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    }

    json(res, 200, {
      tokens: rows.slice(offset, offset + limit).map(t => ({
        tokenId: t.tokenId, label: t.label, name: t.name, image: artUrl(addr, t.tokenId, t.image), order: t.order,
      })),
      matched: rows.length,
      indexed: idx.total,
      partial: idx.partial,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    });
  },

  /** The sidebar: every trait in the collection with real counts. */
  async facets(req, res, addr) {
    if (!isAddr(addr)) return json(res, 400, { error: 'bad address' });
    const idx = await collectionIndex(addr);
    const orders = await collectionOrders(addr).catch(() => []);
    json(res, 200, {
      facets: idx.facets, indexed: idx.total, partial: idx.partial, listed: orders.length,
    });
  },

  /** What has happened to a token: listed, cancelled, sold — from chain
      events, so trades made outside this site are included. */
  async history(req, res, q) {
    const addr = String(q.get('collection') || '');
    const tokenId = String(q.get('token_id') || '');
    if (!isAddr(addr)) return json(res, 400, { error: 'bad address' });
    const h = await refreshHistory().catch(() => history);
    const rows = h.events
      .filter(e => e.collection === addr && (!tokenId || e.tokenId === tokenId))
      .sort((a, b) => (b.at || 0) - (a.at || 0) || b.seq - a.seq)
      .slice(0, 100);
    json(res, 200, { events: rows, scanned: historyScanned, known: h.events.length });
  },

  async token(req, res, addr, tokenId) {
    if (!isAddr(addr)) return json(res, 400, { error: 'bad address' });
    const c = nftC(addr);
    /* Four independent reads, one round-trip of wall clock — this is
       the page a buyer sits on, and it reads live state on purpose. */
    const [owner, meta, order] = await Promise.all([
      c.functions.owner_of({ token_id: tokenId }).then((r) => r.result?.value || null, () => null),
      tokenMeta(addr, tokenId).catch(() => null),
      (async () => {
        if (!marketC) return null;
        try {
          const { result } = await marketC.functions.get_order({ collection: addr, token_id: tokenId });
          if (!result?.seller) return null;
          return {
            seller: result.seller, price: result.price,
            expires: result.expires || '0',
            dead: Number(result.expires) !== 0 && Number(result.expires) < Date.now(),
          };
        } catch (_) { return null; }
      })(),
    ]);
    let approved = false;
    if (CFG.MARKET_ADDR && owner) {
      try {
        const a1 = (await c.functions.get_approved({ token_id: tokenId })).result?.value;
        if (a1 === CFG.MARKET_ADDR) approved = true;
        if (!approved) {
          const a2 = (await c.functions.is_approved_for_all({ owner, operator: CFG.MARKET_ADDR })).result?.value;
          approved = !!a2;
        }
      } catch (_) {}
    }
    const info = await collectionInfo(addr);
    json(res, 200, {
      collection: info, tokenId, label: hexToLabel(tokenId), owner,
      meta: meta ? { name: meta.name, description: meta.description, image: artUrl(addr, tokenId, rewriteImg(meta.image)), attributes: meta.attributes || [] } : null,
      order, approved,
    });
  },

  async owned(req, res, q) {
    const addr = String(q.get('address') || '');
    if (!isAddr(addr)) return json(res, 400, { error: 'bad address' });
    const out = [];
    for (const c of registry.collections) {
      try {
        const { result } = await cached(`owned:${c.address}:${addr}`, 20000,
          async () => nftC(c.address).functions.get_tokens_by_owner({ owner: addr, limit: 100 }));
        const ids = result?.token_ids || [];
        if (!ids.length) continue;
        const orders = await collectionOrders(c.address).catch(() => []);
        const listed = new Map(orders.map(o => [o.tokenId, o]));
        const info = await collectionInfo(c.address);
        out.push({
          collection: { address: c.address, name: info.name || c.name },
          tokens: await Promise.all(ids.map(async (tid) => {
            const meta = await tokenMeta(c.address, tid).catch(() => null);
            return { tokenId: tid, label: hexToLabel(tid), name: meta?.name || hexToLabel(tid), image: artUrl(c.address, tid, rewriteImg(meta?.image)), order: listed.get(tid) || null };
          })),
        });
      } catch (_) {}
    }
    json(res, 200, { collections: out });
  },

  /** The auth bridge: the SAME Google/email account resolves to the SAME
      Koinos wallet as in Aurvania, because Aurvania answers the question.
      Only the three stateless actions are bridged. */
  async account(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const body = await readBody(req);
    const action = String(body.action || '');
    if (!['register', 'login', 'google'].includes(action)) {
      return json(res, 400, { error: 'Unsupported action' });
    }
    try {
      const r = await fetchJson(CFG.AURVANIA_API + '/api/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), timeoutMs: 15000,
      });
      return json(res, r.status, r.body || { error: 'The account server sent an unreadable reply' });
    } catch (e) {
      /* Say WHAT failed. A bare "could not reach" sent us hunting the
         browser and the OAuth console when the real answer was that this
         server cannot open a connection to the game at all. */
      const detail = String((e && e.message) || e).slice(0, 200);
      console.error('[bridge] account call failed —', detail);
      return json(res, 502, {
        error: 'Could not reach the account server — try again shortly',
        detail,
      });
    }
  },

  /** Is the sign-in bridge actually working? Answers without a key because
      it exposes nothing but reachability — and being able to ask from
      outside is the whole point when the site is misbehaving. */
  async diag(req, res, q) {
    const started = Date.now();
    /* ?ua=… tries a different identity from THIS server. When the game's
       host started refusing us, the only way to find a string it accepts
       was to try them from the machine actually being refused. */
    const ua = String((q && q.get('ua')) || '').slice(0, 200) || undefined;
    let reach = null;
    try {
      const r = await fetchJson(CFG.AURVANIA_API + '/api/chain-info', { timeoutMs: 12000, ua }, 1);
      reach = { ok: r.ok, status: r.status, ms: Date.now() - started, hasClientId: !!(r.body && r.body.googleClientId) };
    } catch (e) {
      reach = { ok: false, error: String((e && e.message) || e).slice(0, 200), ms: Date.now() - started };
    }
    json(res, 200, {
      aurvania: CFG.AURVANIA_API,
      userAgent: ua || CFG.BRIDGE_UA,
      bridge: reach,
      lastBridgeError: aurvaniaError,
      googleClientId: CFG.GOOGLE_CLIENT_ID ? 'from this server\'s env' :
        (aurvaniaInfo && aurvaniaInfo.googleClientId ? 'inherited from the game' : 'MISSING'),
      remembered: !!aurvaniaInfo,
      market: CFG.MARKET_ADDR || null,
      sponsor: !!dev,
    });
  },

  async sponsor(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const body = await readBody(req);
    const r = await sponsor(body.transaction, clientIp(req));
    json(res, r.status, r.body);
  },

  /** What launching costs and whether you may right now. */
  async launchInfo(req, res, q) {
    const who = String(q.get('owner') || '');
    json(res, 200, {
      feeKoin: CFG.LAUNCH_FEE_KOIN,
      feeSats: KOIN_SATS(CFG.LAUNCH_FEE_KOIN).toString(),
      treasury: CFG.MARKET_ADDR ? (await marketCfg()).treasury : null,
      perAccountPerDay: CFG.LAUNCH_PER_DAY_PER_ACCOUNT,
      usedToday: isAddr(who) ? launchesSince(DAY, who) : 0,
      globalRemaining: Math.max(0, CFG.LAUNCH_PER_DAY_TOTAL - launchesSince(DAY, null)),
      mintFeeKoin: CFG.MINT_FEE_KOIN,
      mintsRemaining: Math.max(0, CFG.MINT_PER_DAY_TOTAL - mintsSince(DAY)),
      ready: !!dev && fs.existsSync(COLLECTION_WASM),
    });
  },

  /** Step one: we build the transaction, the creator signs it.
      Fee and contract upload ride together, so the fee cannot be taken
      without the collection actually being created. */
  async launchPrepare(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!dev) return json(res, 503, { error: 'Launching is not configured on this server' });
    if (!fs.existsSync(COLLECTION_WASM)) return json(res, 503, { error: 'The collection contract is not built on this server' });

    const body = await readBody(req);
    const v = validateLaunch(body);
    if (v.error) return json(res, 400, { error: v.error });

    if (launchesSince(DAY, v.owner) >= CFG.LAUNCH_PER_DAY_PER_ACCOUNT) {
      return json(res, 429, { error: `Only ${CFG.LAUNCH_PER_DAY_PER_ACCOUNT} collections per wallet per day — try again tomorrow` });
    }
    if (launchesSince(DAY, null) >= CFG.LAUNCH_PER_DAY_TOTAL) {
      return json(res, 429, { error: 'The launch queue is full for today — try again tomorrow' });
    }
    if (rateLimited('launch-ip:' + clientIp(req), 6, DAY)) {
      return json(res, 429, { error: 'Too many launches from here today' });
    }

    const treasury = (await marketCfg()).treasury;
    if (CFG.LAUNCH_FEE_KOIN > 0 && !isAddr(treasury)) {
      return json(res, 503, { error: 'No treasury is configured to receive the launch fee' });
    }

    // The collection's own account: fresh key, used to authorize its
    // upload and setup, then kept as the upgrade key.
    const key = new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
    key.provider = provider;
    const address = key.getAddress();

    const ops = [];
    if (CFG.LAUNCH_FEE_KOIN > 0) {
      const koinC = new Contract({ id: NET.koinContract, provider, abi: TOKEN_ABI });
      ops.push(await koinC.encodeOperation({
        name: 'transfer',
        args: { from: v.owner, to: treasury, value: KOIN_SATS(CFG.LAUNCH_FEE_KOIN).toString() },
      }));
    }
    ops.push({
      upload_contract: {
        contract_id: address,
        /* koilib's own encoder, NOT Buffer.toString('base64url'): the node's
           JSON codec wants PADDED base64url, and Node never pads. The first
           contract binary was 75,936 bytes — divisible by 3, so unpadded and
           padded are the same string — and deployed twice on that pure
           coincidence. The rebuild changed the length by 31 bytes and every
           launch since died with "parameters could not be parsed". */
        bytecode: utils.encodeBase64url(fs.readFileSync(COLLECTION_WASM)),
      },
    });

    /* PAYEE is the collection's own account, not the creator's wallet.
       The payee is whose nonce a transaction spends, and the chain makes
       the payee sign — which is the only reason a free launch was ever
       asking anyone to approve anything. A brand new account signs for
       itself here, so the creator's wallet is involved when, and only
       when, it is being asked to part with money. */
    const tx = new Transaction({
      signer: key, provider,
      options: { payer: dev.getAddress(), payee: address, rcLimit: String(80e8) },
    });
    for (const op of ops) await tx.pushOperation(op);
    await tx.prepare();
    await tx.sign();                     // the collection account authorizes its own upload

    if (CFG.LAUNCH_FEE_KOIN <= 0) {
      // Nothing here belongs to the creator, so nothing needs their key.
      try {
        await dev.signTransaction(tx.transaction);
        const send = new Transaction({ provider });
        send.transaction = tx.transaction;
        await send.send();
        await send.wait('byTransactionId', 60000);
      } catch (e) {
        const detail = String((e && e.message) || e).slice(0, 250);
        console.error('[launch] free deploy rejected —', detail);
        return json(res, 400, { error: `The collection could not be deployed: ${detail}` });
      }
      const done = await completeLaunch(address, key, v);
      return json(res, 200, { ok: true, launched: true, collection: address, ...done });
    }

    pendingLaunches.set(tx.transaction.id, {
      at: Date.now(), wif: key.getPrivateKey('wif', true), address,
      spec: v, header: JSON.stringify(tx.transaction.header),
    });
    for (const [id, p] of pendingLaunches) {
      if (Date.now() - p.at > 900000) pendingLaunches.delete(id);
    }

    json(res, 200, {
      transaction: tx.transaction,
      collection: address,
      feeKoin: CFG.LAUNCH_FEE_KOIN,
    });
  },

  /** Step two: the creator's signature comes back, we co-sign and send.
      Then the collection is named and handed over, and registered here. */
  async launchSubmit(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!dev) return json(res, 503, { error: 'Launching is not configured on this server' });
    const body = await readBody(req);
    const signed = body.transaction;
    const pending = signed && signed.id ? pendingLaunches.get(signed.id) : null;
    if (!pending) return json(res, 400, { error: 'That launch has expired — start again' });
    // The signed copy must be the one we built, byte for byte.
    if (JSON.stringify(signed.header) !== pending.header) {
      return json(res, 400, { error: 'The transaction was altered after it was prepared' });
    }
    let signers = [];
    try { signers = await Signer.recoverAddresses(signed); } catch (_) {}
    if (!signers.includes(pending.spec.owner)) {
      return json(res, 400, { error: 'The creator has not signed this launch' });
    }

    pendingLaunches.delete(signed.id);
    const key = Signer.fromWif(pending.wif);
    key.provider = provider;

    /* Rebuild from the four fields the protocol defines rather than
       forwarding the object the browser handed back. The transaction we
       BUILT here deploys fine; the one that returns through a browser
       round trip was being refused with "parameters could not be parsed",
       which is the node rejecting the request shape — anything koilib
       attached client-side rides along in that JSON otherwise. */
    const clean = {
      id: signed.id,
      header: signed.header,
      operations: signed.operations,
      signatures: signed.signatures,
    };

    try {
      await dev.signTransaction(clean);           // payer
      const tx = new Transaction({ provider });
      tx.transaction = clean;
      await tx.send();
      await tx.wait('byTransactionId', 60000);
    } catch (e) {
      const detail = String((e && e.message) || e).slice(0, 250);
      // If the shape is still wrong, say what was in it — guessing costs
      // the creator a fee and 59 KOIN of mana per attempt.
      console.error('[launch] deploy rejected —', detail,
        '| tx keys:', Object.keys(signed).join(','),
        '| header keys:', Object.keys(signed.header || {}).join(','),
        '| ops:', (signed.operations || []).map(o => Object.keys(o)[0]).join(','),
        '| sigs:', (signed.signatures || []).length);
      return json(res, 400, {
        error: `The collection could not be deployed: ${detail}`,
        sent: {
          txKeys: Object.keys(signed),
          headerKeys: Object.keys(signed.header || {}),
          ops: (signed.operations || []).map(o => Object.keys(o)[0]),
          signatures: (signed.signatures || []).length,
        },
      });
    }

    /* Named and handed over. Separate transaction because the contract has
       to exist before it can be called; we hold the key, so a failure here
       is retryable rather than lost. */
    const { initialized, error: lastInitError } = await completeLaunch(pending.address, key, pending.spec);

    json(res, 200, { ok: true, collection: pending.address, initialized, error: lastInitError });
  },


  /** Finish a launch that deployed but never got named. The fee is already
      paid and the contract is already on chain, so this only completes work
      the creator bought — no key needed, and it can only ever act on an
      address this server itself launched and recorded as unfinished. */
  async launchFinish(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!dev) return json(res, 503, { error: 'Launching is not configured on this server' });
    const body = await readBody(req);
    const address = String(body.address || '').trim();
    /* The KEY is what makes recovery possible, so it is the thing to look
       for — the launch log is only bookkeeping and a redeploy can lose it. */
    let keys = {};
    try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (_) {}
    const held = keys[address];
    if (!held || !held.wif) {
      return json(res, 404, {
        error: 'No key is held for that collection, so it cannot be finished from here',
      });
    }
    const rec = launches.items.find(l => l.address === address) || { address, owner: held.owner };

    // Already named? Then there is nothing to do.
    try {
      const live = await collectionInfo(address);
      if (live.name && !/^Uninitialized/.test(live.name)) {
        return json(res, 200, { ok: true, already: true, name: live.name });
      }
    } catch (_) {}

    const reg = registry.collections.find(c => c.address === address) || {};
    const spec = {
      name: String(body.name || reg.name || '').trim(),
      symbol: String(body.symbol || reg.symbol || '').trim().toUpperCase(),
      description: String(body.description ?? reg.description ?? ''),
      uri: '', owner: held.owner,
      royaltyBps: Math.round(Number(body.royaltyBps ?? reg.royaltyBps ?? 0)),
    };
    if (!spec.name || !/^[A-Z0-9]{1,16}$/.test(spec.symbol)) {
      return json(res, 400, { error: 'Send the name and symbol to finish this collection with' });
    }

    const key = Signer.fromWif(held.wif);
    key.provider = provider;
    try {
      /* Collections launched before the null-field fix carry a binary whose
         initialize traps on an absent uri or description. We hold the
         account key, so the fix is an upgrade in place rather than a
         write-off — uploading the current contract over the old one. */
      if (fs.existsSync(COLLECTION_WASM)) {
        const up = new Transaction({
          signer: key, provider,
          options: { payer: dev.getAddress(), payee: address, rcLimit: String(80e8) },
        });
        await up.pushOperation({
          upload_contract: {
            contract_id: address,
            // Padded, via koilib — see launchPrepare for the hard-won why.
            bytecode: utils.encodeBase64url(fs.readFileSync(COLLECTION_WASM)),
          },
        });
        await up.prepare();
        await up.sign();
        await dev.signTransaction(up.transaction);
        await up.send();
        await up.wait('byTransactionId', 60000);
      }
      const id = await initializeCollection(address, key, spec);
      rec.initialized = true;
      try { saveJson(LAUNCH_LOG, launches); } catch (_) {}
      Object.assign(reg, { name: spec.name });
      saveJson(REGISTRY_FILE, registry);
      caches.delete('info:' + address);
      return json(res, 200, { ok: true, collection: address, tx: id, name: spec.name });
    } catch (e) {
      // The reason, verbatim: this is the step that has already failed once.
      const detail = String((e && e.message) || e).slice(0, 300);
      console.error('[launch] finish failed —', detail);
      return json(res, 400, { error: 'Could not finish the collection', detail });
    }
  },

  /** Bulk mint: a whole drop in one request — names, art and traits per
      item — server-signed like single free mints, batched five items to a
      transaction so ten NFTs cost two blocks, not ten. The daily budget is
      spent per ITEM: a ten-item batch is ten of the day's mints, checked
      before anything touches the chain so a batch either fits or is
      refused whole. */
  async mintBatch(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!dev) return json(res, 503, { error: 'Minting is not configured on this server' });
    if (CFG.MINT_FEE_KOIN > 0) {
      return json(res, 400, { error: 'Bulk minting is only available while minting is free', external: true });
    }
    const body = await readBody(req);
    const collection = String(body.collection || '').trim();
    const owner = String(body.owner || '').trim();
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!isAddr(collection) || !isAddr(owner)) return json(res, 400, { error: 'A collection and an owner are required' });
    if (!rawItems.length) return json(res, 400, { error: 'No items to mint' });
    if (rawItems.length > CFG.MINT_PER_DAY_TOTAL) {
      return json(res, 400, { error: `That is ${rawItems.length} items — the site mints at most ${CFG.MINT_PER_DAY_TOTAL} a day` });
    }

    const items = [];
    const seenIds = new Set();
    for (let i = 0; i < rawItems.length; i++) {
      const it = cleanMintItem(rawItems[i], i);
      if (it.error) return json(res, 400, { error: it.error });
      if (seenIds.has(it.tokenId)) return json(res, 400, { error: `item ${i + 1}: token id ${it.tokenId} repeats within the batch` });
      seenIds.add(it.tokenId);
      items.push(it);
    }

    const remaining = CFG.MINT_PER_DAY_TOTAL - mintsSince(DAY);
    if (items.length > remaining) {
      return json(res, 429, { error: `Only ${Math.max(0, remaining)} of today's mint budget remains — this batch needs ${items.length}` });
    }
    if (rateLimited('mintbatch-ip:' + clientIp(req), 5, DAY)) {
      return json(res, 429, { error: 'Too many batches from here today' });
    }

    const key = collectionKeyFor(collection);
    if (!key) return json(res, 400, { error: 'This collection was not launched here — mint it from your wallet', external: true });
    const info = await collectionInfo(collection).catch(() => ({}));
    if (info.owner !== owner) return json(res, 403, { error: 'Only the collection owner can mint into it' });

    // A batch that half-lands is worse than one that fails whole, so every
    // id is checked against the chain before the first transaction.
    const c = nftC(collection);
    for (const it of items) {
      try {
        const existing = (await c.functions.owner_of({ token_id: it.tokenId })).result?.value;
        if (existing) return json(res, 400, { error: `Token ${it.tokenId} already exists in this collection` });
      } catch (_) {}
    }

    const mintC = new Contract({ id: collection, provider, abi: COLLECTION_ABI, signer: key });
    const origin = publicOrigin(req);
    const results = [];
    let healed = false;
    const CHUNK = 5;
    try {
      for (let at = 0; at < items.length; at += CHUNK) {
        const slice = items.slice(at, at + CHUNK);
        const ops = [];
        for (const it of slice) {
          ops.push(await mintC.encodeOperation({ name: 'mint', args: { to: owner, token_id: it.tokenId } }));
          ops.push(await mintC.encodeOperation({
            name: 'set_metadata',
            args: {
              token_id: it.tokenId,
              metadata: JSON.stringify({
                name: it.name, description: it.description,
                image: it.image.startsWith('/u/') ? `${origin}${it.image}` : it.image,
                attributes: it.attributes,
              }),
            },
          }));
        }
        let txId;
        try { txId = await sendAsCollection(collection, key, ops, 3 * ops.length); }
        catch (e) {
          if (healed || !/not authorized/i.test(String((e && e.message) || e))) throw e;
          await healMintAuthority(collection, key);
          healed = true;
          txId = await sendAsCollection(collection, key, ops, 3 * ops.length);
        }
        for (const it of slice) {
          mints.items.push({ at: Date.now(), collection, tokenId: it.tokenId, owner });
          results.push({ tokenId: it.tokenId, name: it.name, tx: txId });
        }
        try { saveJson(MINT_LOG, mints); } catch (_) {}
      }
    } catch (e) {
      const detail = String((e && e.message) || e).slice(0, 250);
      console.error('[mint-batch] failed —', detail);
      forgetCollection(collection);
      // Whatever landed, landed: say exactly which, so nothing is re-minted.
      return json(res, results.length ? 207 : 400, {
        error: `Stopped after ${results.length} of ${items.length}: ${detail}`,
        minted: results,
      });
    }
    forgetCollection(collection);
    json(res, 200, { ok: true, minted: results, collection });
  },

  /** Mint with no wallet signature. Possible because launched collections
      accept their OWN account's authority for mint/set_metadata, and OURO
      holds that key — which it already holds as the upgrade authority, so
      no new trust is created. The token still lands in the owner's wallet;
      this endpoint only works when the claimed owner IS the on-chain owner.
      Free mints only: a fee means spending someone's KOIN, and only their
      wallet can authorize that. */
  async mint(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!dev) return json(res, 503, { error: 'Minting is not configured on this server' });
    if (CFG.MINT_FEE_KOIN > 0) {
      return json(res, 400, { error: 'Minting carries a fee right now — sign it from your wallet', external: true });
    }
    const body = await readBody(req);
    const collection = String(body.collection || '').trim();
    const owner = String(body.owner || '').trim();
    const tokenId = String(body.tokenId || '').trim().toLowerCase();
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim().slice(0, 1000);
    const image = safeImage(body.image);
    if (!isAddr(collection) || !isAddr(owner)) return json(res, 400, { error: 'A collection and an owner are required' });
    if (!/^0x[0-9a-f]{2,64}$/.test(tokenId)) return json(res, 400, { error: 'Token id must be hex' });
    if (name.length < 1 || name.length > 80) return json(res, 400, { error: 'Name must be 1-80 characters' });
    if (!image) return json(res, 400, { error: 'Artwork is required — upload a file or paste a link' });
    const attributes = (Array.isArray(body.attributes) ? body.attributes : [])
      .slice(0, 24)
      .map(a => ({ trait_type: String(a.trait_type || '').slice(0, 60), value: String(a.value ?? '').slice(0, 60) }))
      .filter(a => a.trait_type && a.value);

    if (mintsSince(DAY) >= CFG.MINT_PER_DAY_TOTAL) {
      return json(res, 429, { error: `The site-wide budget of ${CFG.MINT_PER_DAY_TOTAL} mints per day is spent — try again tomorrow` });
    }
    if (rateLimited('mint-ip:' + clientIp(req), 10, DAY)) {
      return json(res, 429, { error: 'Too many mints from here today' });
    }

    let keys = {};
    try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (_) {}
    const held = keys[collection];
    if (!held || !held.wif) {
      // Not one of ours: their own wallet is the only mint authority.
      return json(res, 400, { error: 'This collection was not launched here — mint it from your wallet', external: true });
    }

    // Whoever the chain says owns it is the only person minting into it —
    // and the only wallet the token can land in.
    const info = await collectionInfo(collection).catch(() => ({}));
    if (info.owner !== owner) return json(res, 403, { error: 'Only the collection owner can mint into it' });

    const key = Signer.fromWif(held.wif);
    key.provider = provider;
    const meta = JSON.stringify({
      name, description,
      image: image.startsWith('/u/') ? `${publicOrigin(req)}${image}` : image,
      attributes,
    });

    const buildAndSend = async () => {
      const c = new Contract({ id: collection, provider, abi: COLLECTION_ABI, signer: key });
      const mintOp = await c.encodeOperation({ name: 'mint', args: { to: owner, token_id: tokenId } });
      const metaOp = await c.encodeOperation({ name: 'set_metadata', args: { token_id: tokenId, metadata: meta } });
      const tx = new Transaction({
        signer: key, provider,
        options: { payer: dev.getAddress(), payee: collection, rcLimit: String(6e8) },
      });
      await tx.pushOperation(mintOp);
      await tx.pushOperation(metaOp);
      await tx.prepare();
      await tx.sign();
      await dev.signTransaction(tx.transaction);
      const send = new Transaction({ provider });
      send.transaction = tx.transaction;
      await send.send();
      await send.wait('byTransactionId', 60000);
      return send.transaction.id;
    };

    let txId = null;
    try {
      try { txId = await buildAndSend(); }
      catch (e) {
        /* Collections launched before the mint-authority change refuse the
           collection account. We hold the upgrade key, so heal in place —
           upload the current binary — and mint again. */
        if (!/not authorized/i.test(String((e && e.message) || e))) throw e;
        const up = new Transaction({
          signer: key, provider,
          options: { payer: dev.getAddress(), payee: collection, rcLimit: String(80e8) },
        });
        await up.pushOperation({
          upload_contract: {
            contract_id: collection,
            bytecode: utils.encodeBase64url(fs.readFileSync(COLLECTION_WASM)),
          },
        });
        await up.prepare(); await up.sign();
        await dev.signTransaction(up.transaction);
        const send = new Transaction({ provider });
        send.transaction = up.transaction;
        await send.send();
        await send.wait('byTransactionId', 60000);
        txId = await buildAndSend();
      }
    } catch (e) {
      const detail = String((e && e.message) || e).slice(0, 250);
      console.error('[mint] failed —', detail);
      return json(res, 400, { error: `Could not mint: ${detail}` });
    }

    mints.items.push({ at: Date.now(), collection, tokenId, owner });
    mints.items = mints.items.filter(m => Date.now() - m.at < 7 * DAY);
    try { saveJson(MINT_LOG, mints); } catch (_) {}
    forgetCollection(collection);
    json(res, 200, { ok: true, tx: txId, collection, tokenId });
  },

  /** Restore art the internet lost. When a collection's metadata still
      resolves but its image host died (a deleted bucket, an unpinned
      CID), the operator can import the original files: each upload is
      matched BY FILENAME against the image urls in the collection's own
      metadata — the client never says where art "should" come from, it
      can only fill in bytes for a url the chain already names — and the
      bytes are stored pinned, exempt from the cache sweep. Admin-only:
      whoever holds the key is vouching these bytes are the real art. */
  async art(req, res, q) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!CFG.ADMIN_KEY || q.get('key') !== CFG.ADMIN_KEY) {
      return json(res, 403, { error: 'the admin key opens this door' });
    }
    const addr = String(q.get('collection') || '');
    const file = decodeURIComponent(String(q.get('file') || '')).slice(0, 200).toLowerCase();
    const tokenId = String(q.get('token') || '').toLowerCase();
    if (!isAddr(addr)) return json(res, 400, { error: 'A collection address is required' });
    if (!file && !tokenId) return json(res, 400, { error: 'Pass ?file=<name.ext> as the metadata names it, or ?token=0x…' });
    if (tokenId && !/^0x[0-9a-f]{2,128}$/.test(tokenId)) return json(res, 400, { error: 'token must be 0x-hex' });
    const buf = await readRaw(req, IMG_FILE_MAX);
    if (buf === 'OVERSIZE') return json(res, 413, { error: `Art larger than ${Math.round(IMG_FILE_MAX / 1048576)}MB` });
    if (!buf || !buf.length) return json(res, 400, { error: 'The upload did not arrive whole — try again' });
    const sniffed = IMG_MAGIC.find(([m]) => buf.subarray(0, m.length).equals(m));
    if (!sniffed) return json(res, 400, { error: 'That file is not a PNG, JPEG, GIF, WebP or SVG image' });

    /* Named a specific token? Resolve THAT token's metadata on the spot
       — one fetch, not a sixty-token walk — pin against the url it
       names, and heal the index row so the grid shows the art without
       waiting for the next full rebuild. The invariant holds either
       way: bytes attach only to a url the token's own metadata names. */
    if (tokenId) {
      /* The index may already hold this token's art url from an earlier
         resolution — no need to win a rate-limit fight with a gateway
         to learn something we already know. */
      const knownRow = indexPeek(addr)?.value?.tokens?.find(
        (t) => String(t.tokenId).toLowerCase() === tokenId && t.image);
      const meta = knownRow
        ? { name: knownRow.name, image: knownRow.image, attributes: null }
        : await tokenMeta(addr, tokenId).catch(() => null);
      const url = rewriteImg(meta?.image);
      if (!url) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '15' });
        return res.end(JSON.stringify({ error: 'That token\'s metadata is unreachable right now — retry in a moment' }));
      }
      const base = decodeURIComponent(url.split('/').pop() || '').toLowerCase();
      if (file && base !== file) {
        return json(res, 400, { error: `That token's metadata names its art ${base}, not ${file}` });
      }
      pinArt(url, buf, sniffed[1]);
      const hit = indexPeek(addr);
      const row = hit?.value?.tokens?.find((t) => String(t.tokenId).toLowerCase() === tokenId);
      if (row && !knownRow) { // fresh metadata heals the row; a reused row has nothing new to say
        row.name = meta.name || row.name;
        row.image = url;
        row.traits = traitsOf(meta);
        saveJson(path.join(IDX_DIR, addr + '.json'), hit);
      }
      return json(res, 200, {
        ok: true, pinned: 1, bytes: buf.length,
        tokens: [{ tokenId, label: hexToLabel(tokenId), name: meta.name || null }],
      });
    }

    /* A cold collection's index takes minutes to build, and the proxy
       in front of a deployment kills requests long before that — the
       build must never ride on THIS request. Kick it and say so; the
       importing tool retries until the index is there. */
    const hit = indexPeek(addr);
    if (!hit) {
      queueRebuild(addr);
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '20' });
      return res.end(JSON.stringify({ error: 'Indexing this collection first — retry in a moment', building: true }));
    }
    const idx = hit.value;
    if (!idx) return json(res, 400, { error: 'That collection cannot be indexed' });
    const matches = (idx.tokens || []).filter((t) => {
      const base = decodeURIComponent(String(t.image || '').split('/').pop() || '').toLowerCase();
      return base && base === file;
    });
    if (!matches.length) return json(res, 404, { error: `No token in this collection names its art ${file}` });
    const sources = [...new Set(matches.map((t) => t.image))];
    for (const src of sources) pinArt(src, buf, sniffed[1]);
    json(res, 200, {
      ok: true, pinned: sources.length, bytes: buf.length,
      tokens: matches.slice(0, 20).map((t) => ({ tokenId: t.tokenId, label: t.label, name: t.name })),
    });
  },

  /** Artwork, either uploaded here or linked from anywhere. Uploads are
      content-addressed, so the same picture twice costs one file. */
  async upload(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (rateLimited('upload:' + clientIp(req), 120, 3600000)) {
      return json(res, 429, { error: 'Too many uploads — slow down' });
    }
    const buf = await readRaw(req, CFG.UPLOAD_MAX_BYTES);
    if (buf === 'OVERSIZE') {
      return json(res, 413, { error: `That image is larger than ${Math.round(CFG.UPLOAD_MAX_BYTES / 1048576)}MB — resize it and try again` });
    }
    if (!buf) return json(res, 400, { error: 'The upload did not arrive whole — try again' });
    const kind = imageKind(buf);
    if (!kind) return json(res, 400, { error: 'That file is not a PNG, JPEG, GIF or WebP image' });
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 40);
    const file = path.join(UPLOAD_DIR, `${hash}.${kind}`);
    try { if (!fs.existsSync(file)) fs.writeFileSync(file, buf); }
    catch (e) { return json(res, 500, { error: 'Could not store that image' }); }
    json(res, 200, { ok: true, url: `${publicOrigin(req)}/u/${hash}.${kind}`, path: `/u/${hash}.${kind}`, bytes: buf.length });
  },

  async balance(req, res, q) {
    const addr = String(q.get('address') || '');
    if (!isAddr(addr)) return json(res, 400, { error: 'bad address' });
    let koin = '0', mana = '0';
    try {
      const koinC = new Contract({ id: NET.koinContract, provider, abi: TOKEN_ABI });
      koin = (await koinC.functions.balanceOf({ owner: addr })).result?.value || '0';
    } catch (_) {}
    try { mana = String(await provider.getAccountRc(addr)); } catch (_) {}
    json(res, 200, { koin, mana });
  },
};

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/config') return await api.config(req, res);
    if (p === '/api/collections') return await api.collections(req, res);
    let m;
    if ((m = /^\/api\/collections\/([1-9A-HJ-NP-Za-km-z]+)$/.exec(p))) return await api.collection(req, res, m[1]);
    if ((m = /^\/api\/collections\/([1-9A-HJ-NP-Za-km-z]+)\/tokens$/.exec(p))) return await api.tokens(req, res, m[1], url.searchParams);
    if ((m = /^\/api\/collections\/([1-9A-HJ-NP-Za-km-z]+)\/facets$/.exec(p))) return await api.facets(req, res, m[1]);
    if ((m = /^\/api\/collections\/([1-9A-HJ-NP-Za-km-z]+)\/token\/([0-9a-fx]+)$/i.exec(p))) return await api.token(req, res, m[1], m[2]);
    if (p === '/api/owned') return await api.owned(req, res, url.searchParams);
    if (p === '/api/account') return await api.account(req, res);
    if (p === '/api/sponsor') return await api.sponsor(req, res);
    if (p === '/api/balance') return await api.balance(req, res, url.searchParams);
    if (p === '/api/history') return await api.history(req, res, url.searchParams);
    if (p === '/api/diag') return await api.diag(req, res, url.searchParams);
    if (p === '/api/launch') return await api.launchInfo(req, res, url.searchParams);
    if (p === '/api/launch/prepare') return await api.launchPrepare(req, res);
    if (p === '/api/launch/submit') return await api.launchSubmit(req, res);
    if (p === '/api/launch/finish') return await api.launchFinish(req, res);
    if (p === '/api/mint') return await api.mint(req, res);
    if (p === '/api/mint-batch') return await api.mintBatch(req, res);
    if (p === '/api/upload') return await api.upload(req, res);
    if (p === '/api/art') return await api.art(req, res, url.searchParams);
    const wantThumb = url.searchParams.get('w') === String(480);
    if ((m = /^\/u\/([a-f0-9]{8,64}\.(?:png|jpg|gif|webp))$/.exec(p))) return await serveUpload(res, m[1], wantThumb);
    if ((m = /^\/img\/c\/([1-9A-HJ-NP-Za-km-z]{25,35})$/.exec(p))) return await serveCoverArt(req, res, m[1], wantThumb);
    if ((m = /^\/img\/t\/([1-9A-HJ-NP-Za-km-z]{25,35})\/(0x[0-9a-fA-F]{2,128})$/.exec(p))) return await serveTokenArt(req, res, m[1], m[2], wantThumb);
    if (p.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    return serveStatic(res, p === '/' ? '/index.html' : p);
  } catch (e) {
    console.error('[api]', p, String(e && e.message || e).slice(0, 200));
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
  }
});

/* Say WHY rather than dying silently — a port already held by the previous
   process is the classic restart failure, and it looks identical to a
   crash from the outside. */
server.on('error', (e) => {
  console.error(`[listen] cannot bind port ${CFG.PORT}:`, String((e && e.message) || e));
  if (e && e.code === 'EADDRINUSE') {
    console.error('        something is already serving that port — stop the old process first');
  }
  process.exit(1);
});

server.listen(CFG.PORT, () => {
  console.log(`⭕ OURO marketplace listening on http://0.0.0.0:${CFG.PORT}`);
  if (PORT_CHOICE.from) {
    console.log(`   port:    ${CFG.PORT} (from ${PORT_CHOICE.from})`);
  } else {
    /* Nothing told us, so this is a guess — and a wrong guess looks
       exactly like a healthy app that nobody can reach. List what the
       environment actually offers so the answer stops being a hunt. */
    const candidates = Object.keys(process.env)
      .filter((k) => /PORT/i.test(k))
      .map((k) => `${k}=${process.env[k]}`);
    console.warn(`   ⚠ port:  ${CFG.PORT} is a FALLBACK — no port variable was set.`);
    console.warn(`     If the site answers 503 while this log looks fine, the host is`);
    console.warn(`     proxying to a different port. Set PORT to the one it expects.`);
    console.warn(`     Port-ish variables present: ${candidates.length ? candidates.join(', ') : '(none)'}`);
  }
  console.log(`   chain:   ${NET.label} · ${RPCS.join(', ')}`);
  console.log(`   market:  ${CFG.MARKET_ADDR || 'NOT SET — deploy the contract and set MARKET_ADDR'}`);
  console.log(`   sponsor: ${dev ? `on — payer ${dev.getAddress()}` : 'OFF (KOINOS_DEV_WIF not set)'}`);
  console.log(`   sign-in: bridged to ${CFG.AURVANIA_API}`);
  console.log(`   registry: ${registry.collections.length} collection(s) · admin ${CFG.ADMIN_KEY ? 'enabled' : 'OFF'}`);
  console.log(`   history: ${history.events.length} known event(s)`);
  if (CFG.DATA_DIR.startsWith(__dirname)) {
    console.warn(`   ⚠ DATA_DIR is inside the app directory (${CFG.DATA_DIR}).`);
    console.warn('     A deploy that replaces the app replaces this too — and it holds the');
    console.warn('     collection upgrade keys. Point DATA_DIR somewhere the deploy cannot reach.');
  }
  /* Is the platform relaunching us in a loop? A respawn every second or
     two pegs the host — each cold boot loads the whole dependency tree —
     and from outside it reads as "hosting maxed" plus requests that hang
     forever, with no error anywhere. Count our own births and say so. */
  const BOOTS_FILE = path.join(CFG.DATA_DIR, 'boots.json');
  try {
    const boots = (loadJson(BOOTS_FILE, { times: [] }).times || [])
      .filter(t => Date.now() - t < 120000);
    boots.push(Date.now());
    saveJson(BOOTS_FILE, { times: boots.slice(-20) });
    if (boots.length >= 3) {
      console.warn(`   ⚠ THIS APP HAS STARTED ${boots.length} TIMES IN TWO MINUTES.`);
      console.warn('     The platform is relaunching it in a loop — that is what maxes the');
      console.warn('     hosting and hangs every request. Usual cause: the app binds a port');
      console.warn('     the platform is not proxying to (check the "port:" line above), or');
      console.warn('     a supervisor health check that cannot reach it.');
    }
  } catch (_) {}

  /* Warm the trade history AFTER things settle rather than at each birth:
     a boot must cost nearly nothing, precisely because of the loop above. */
  setTimeout(() => {
    refreshHistory({ force: true })
      .then((h) => { if (h.events.length) console.log(`   history: indexed to ${h.events.length} event(s)`); })
      .catch(() => {});
  }, 20000);

  /* Same reasoning for the pages: once the boot has proven it will live,
     warm the home snapshot, then walk the registry's indexes one at a
     time. Requests arriving meanwhile get stale-and-instant answers from
     disk rather than cold-and-slow ones from the chain. */
  setTimeout(() => {
    (async () => {
      await refreshHome({ maxAgeMs: 0 }).catch(() => {});
      /* Art too — covers first (the home page IS covers), then the
         first grid page of every collection. Left to the first
         visitors, this burst hits the gateways all at once, gets
         rate-limited, and paints broken tiles; done here it is six
         fetches at a time into the disk cache, once per DATA_DIR ever. */
      for (const c of registry.collections.slice()) {
        const src = rewriteImg(c.image);
        if (src) fetchArt(src).catch(() => {});
      }
      for (const c of registry.collections.slice()) {
        try {
          const idx = await collectionIndex(c.address);
          for (const t of (idx.tokens || []).slice(0, 24)) {
            if (t.image) await fetchArt(t.image).catch(() => {});
          }
        } catch (_) {}
      }
    })().catch(() => {});
  }, 8000);
});
