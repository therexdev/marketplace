#!/usr/bin/env node
/* Why does a listing show on the token page but nowhere else?

   Two different reads answer that question, and only one of them feeds
   the counts. The token page asks the market contract for ONE order
   (get_order, an exact key lookup). The collection page and the home
   card ask it to WALK the book (get_orders, a prefix scan over the
   orders space). When a listing is real but every count says zero, the
   walk is the thing that is broken — and this asks both, side by side,
   plus the same walk unscoped, so the answer is not a guess.

     node tools/order-book.js --collection 1EpeEKtMaH7nV3ZthEk1Emw4F6y6ZEhQNa \
          --token DUCK0001

   --token takes the id as the site shows it (DUCK0001) or as hex
   (0x4455434b30303031). Reads only — nothing is signed, nothing is
   spent, no admin key. It reads the market address and RPC from the
   site's own /api/config so it asks exactly what the site asks.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { Contract, Provider } = require('koilib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const SITE = String(arg('site', 'https://ouro.lifestyle')).replace(/\/$/, '');
const ADDR = arg('collection', '');
const TOKEN_IN = arg('token', '');

if (!ADDR) {
  console.error('usage: node tools/order-book.js --collection 1… [--token DUCK0001] [--site https://…]');
  process.exit(1);
}
const tokenId = !TOKEN_IN ? '' : /^0x[0-9a-fA-F]+$/.test(TOKEN_IN)
  ? TOKEN_IN.toLowerCase()
  : '0x' + Buffer.from(TOKEN_IN, 'utf8').toString('hex');

function sanitizeAbi(abi) {
  const k = abi.koilib_types && abi.koilib_types.nested && abi.koilib_types.nested.koinos &&
    abi.koilib_types.nested.koinos.nested;
  if (k) { delete k.btype; delete k._btype; }
  return abi;
}
const MARKET_ABI = sanitizeAbi(JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'server-abi', 'market-abi.json'), 'utf8')));

const show = (v) => JSON.stringify(v, null, 1);

(async () => {
  const cfg = await (await fetch(`${SITE}/api/config`, { signal: AbortSignal.timeout(30000) })).json();
  const MARKET = arg('market', cfg.market);
  const RPC = arg('rpc', (cfg.rpcs && cfg.rpcs[0]) || cfg.rpc || 'https://api.koinos.io');
  if (!MARKET) { console.error(`${SITE} reports no market contract — nothing can be listed there.`); process.exit(1); }
  console.log(`market ${MARKET}\nrpc    ${RPC}\n`);

  let market;
  try { market = new Contract({ id: MARKET, provider: new Provider([RPC]), abi: MARKET_ABI }); }
  catch (e) { console.error(`that market address does not parse: ${String((e && e.message) || e)}`); process.exit(1); }
  const call = async (fn, args) => {
    try { return { ok: true, value: (await market.functions[fn](args)).result }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 400) }; }
  };

  /* 1. the exact-key read — what the TOKEN page shows */
  let one = null;
  if (tokenId) {
    one = await call('get_order', { collection: ADDR, token_id: tokenId });
    console.log(`get_order(${ADDR}, ${tokenId})  ← the token page's read`);
    console.log(one.ok ? show(one.value) : `ERROR ${one.error}`);
    console.log('');
  }

  /* 2. the same book, walked and scoped — what the COUNTS come from */
  const scoped = await call('get_orders', { collection: ADDR, limit: 100 });
  console.log(`get_orders(collection=${ADDR}, limit=100)  ← the collection page and home card`);
  console.log(scoped.ok ? show(scoped.value) : `ERROR ${scoped.error}`);
  console.log('');

  /* 3. the walk with no collection at all — does it work for ANYONE? */
  const whole = await call('get_orders', { limit: 100 });
  const wholeRows = (whole.ok && whole.value && whole.value.value) || [];
  console.log(`get_orders(limit=100)  ← the whole market, unscoped`);
  console.log(whole.ok ? `${wholeRows.length} order(s)` : `ERROR ${whole.error}`);
  for (const o of wholeRows.slice(0, 10)) {
    console.log(`  ${o.collection} ${o.token_id} ${o.price} seller=${o.seller}`);
  }
  console.log('');

  /* ---- what that means ---- */
  const scopedRows = (scoped.ok && scoped.value && scoped.value.value) || [];
  const listed = one && one.ok && one.value && one.value.seller;
  const inScoped = scopedRows.some((o) => !tokenId || String(o.token_id).toLowerCase() === tokenId);
  const inWhole = wholeRows.some((o) => o.collection === ADDR && (!tokenId || String(o.token_id).toLowerCase() === tokenId));

  console.log('---');
  /* A read that ERRORED says nothing about what is on chain, and a
     verdict built on one would be a confident lie — the RPC being
     unreachable looks exactly like an empty order book from here. */
  const broke = [one, scoped, whole].filter((r) => r && !r.ok);
  if (broke.length) {
    console.log(`${broke.length} of these reads did not complete, so nothing below could be concluded.`);
    console.log('The RPC is unreachable or answering with something that is not JSON — retry,');
    console.log('or point --rpc at another Koinos node.');
    process.exit(1);
  }
  if (!listed && tokenId) {
    console.log('That token has NO order on chain. The listing transaction never landed —');
    console.log('check the wallet history; a page can show a listing it only tried to make.');
  } else if (inScoped) {
    console.log('The order IS in the scoped walk, so the contract is fine and the site is');
    console.log('reading a stale cache. Counts refresh within a minute; if they do not,');
    console.log('the order book read is erroring on the server, not here.');
  } else if (inWhole) {
    console.log('THE SCOPED WALK IS THE BUG: the order is in the unscoped book but not when');
    console.log('get_orders is asked for this collection — so the prefix walk in the market');
    console.log('contract is skipping it. Every "0 listed" on the site comes from that call.');
  } else if (wholeRows.length) {
    console.log('The order is not in EITHER walk, though other orders are — so this order was');
    console.log('written under a key the walk does not reach. Send this whole output over.');
  } else {
    console.log('THE WALK RETURNS NOTHING AT ALL, scoped or not, while get_order finds the');
    console.log('order by key — so getMany over the orders space is not returning rows, and');
    console.log('no listing anywhere on this market will ever be counted. That is a contract');
    console.log('bug, not a caching one.');
  }
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
