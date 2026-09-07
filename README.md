# OURO — the Koinos NFT marketplace

Buy and sell NFTs from **every KCS-2 collection on Koinos**, in **KOIN**, with
**zero mana fees** — the platform's dev wallet pays them for every user. A
successor to [Kollection](https://github.com/kollection-nft/marketplace),
whose open-source contract this design is ported from.

Lives at **[ouro.lifestyle](https://ouro.lifestyle)**. The mark is an
ouroboros — the ring that feeds itself, which is also how the market works:
everything a player earns can be sold, and everything sold stays in play.

## What it is

| | |
|---|---|
| **Fee** | FREE (0%) after the marketplace configuration is applied; the UI always reports the actual on-chain fee |
| **Currency** | KOIN only, to start |
| **Royalties** | whatever the collection declares (KCS-2 `royalties()`), capped at 10% — same cap Kollection used |
| **Custody** | none: listings are approval-based, the NFT **stays in the seller's wallet** until the moment it sells |
| **Mana** | sponsored: users sign as *payee*, the server co-signs as *payer* with the dev wallet |
| **Wallets** | Kondor, or Google / email sign-in that opens the **same wallet as Aurvania** |
| **Order book** | on chain — `get_orders` is a paginated contract read, no indexer to trust |

## The contract (`contracts/market/`)

A port of Kollection's marketplace onto the modern koinosbox toolchain,
keeping its mechanics (approval-based orders, atomic settle, royalties)
and fixing what needed fixing:

* the **buyer is explicit and signs a `max_price`** — the original paid
  whatever the order said at execution, allowing repricing under a pending buy;
* the **seller is authorized by signature** (`checkAccountAuthority`), not by
  trusting payer/payee headers;
* **orders are readable on chain, paginated per collection** — Kollection
  rebuilt its order book from events in a backend;
* orders whose seller no longer owns the token can be **cleaned up by anyone**
  (they were unexecutable anyway);
* the order is **removed before any transfer** — re-entrancy through a hostile
  token contract finds nothing to spend twice.

```sh
cd contracts
npm install          # koinosbox toolchain (AssemblyScript 0.27)
node build.js market # -> market/build/release/contract.wasm + ABI
node deploy.js keygen --keys keys.env
node deploy.js deploy --keys keys.env --network harbinger   # test first
node deploy.js deploy --keys keys.env --network mainnet \
     --treasury <your-treasury-address> --fee-bps 0
```

`keys.env` is gitignored and holds `KOINOS_DEV_WIF` (pays all mana) and
`KOINOS_MARKET_WIF` (the account the contract lives on — on Koinos, a
contract IS an account). Verified prebuilt artifacts ship in
`contracts/prebuilt/`.

### Set the existing marketplace fee to FREE

A website deployment cannot change a deployed contract's stored fee. The current
OURO marketplace is `1BsZx4Hc69tWo1q9sXNP9ywvpBW2KdXwc8`; it reported 250 basis
points (2.5%) during the September 7, 2026 inspection. On the operator machine
that already holds the marketplace and mana-payer keys, run:

```sh
cd contracts
node deploy.js config --keys /secure/path/keys.env --network mainnet \
  --market 1BsZx4Hc69tWo1q9sXNP9ywvpBW2KdXwc8 --fee-bps 0
node deploy.js status --keys /secure/path/keys.env --network mainnet
```

This uses the existing contract and preserves its treasury, KOIN address, orders,
and collection royalties. No bytecode upgrade is needed. Verify `fee_bps` is zero
(an omitted protobuf zero field also means zero), wait up to five minutes for the
server's configuration cache, then reload and confirm `/api/config` returns
`feeBps: 0`. The home page, footer, item page and listing breakdown then show
**FREE**. Before configuration, they truthfully show the existing fee; if the
contract cannot be read, they show **Unavailable**, and checkout/listing is disabled.
Never upload the key file to GitHub or send it through chat.

## The server (`server.js`)

Keeps **no user state**. Serves the site, curates the collection registry,
caches chain reads, bridges sign-in to the Aurvania game server, and runs the
mana sponsor. Run it:

```sh
npm install
MARKET_ADDR=<deployed address> KOINOS_DEV_WIF=<dev wif> node server.js
```

| env | meaning |
|---|---|
| `PORT` | default 3100 |
| `KOINOS_NETWORK` | `mainnet` (default) or `harbinger` |
| `MARKET_ADDR` | the deployed marketplace contract |
| `KOINOS_DEV_WIF` | the mana payer — sponsorship is off without it |
| `SPONSOR_RC_PER_OP` | mana ceiling **per operation** in satoshis (default 3 KOIN) |
| `SPONSOR_RC_MAX` | absolute per-transaction mana ceiling (default 15 KOIN) |
| `INDEX_MAX_TOKENS` | how deep a collection is indexed for filters (default 1500) |
| `AURVANIA_API` | sign-in bridge target (default `https://aurvania.com`) |
| `GOOGLE_CLIENT_ID` | the game's Google OAuth client id — set it so sign-in does not depend on the bridge being reachable |
| `BRIDGE_UA` | User-Agent used when calling the game (default clears its host's filter) |
| `ADMIN_KEY` | privileged registry fields (`featured`) — adding collections needs no key |
| `LAUNCH_FEE_KOIN` | cost to launch a collection (default 100; set 0 for free) |
| `LAUNCH_PER_DAY_PER_ACCOUNT` | launches per wallet per day (default 3) |
| `LAUNCH_PER_DAY_TOTAL` | launches per day across the site (default 12) |
| `MINT_FEE_KOIN` | cost to mint an NFT (default 0 — free) |
| `MINT_PER_DAY_TOTAL` | mints per day across ALL collections (default 30) |
| `UPLOAD_MAX_BYTES` | largest image accepted (default 4MB) |
| `DATA_DIR` | runtime state (registry), default `./data-live` |

### One login, one wallet, two sites

`POST /api/account` forwards `register` / `login` / `google` to the Aurvania
server, which answers with the **same WIF/address** the same identity gets in
the game. Proven end-to-end in the test suite: register through the
marketplace, log in at aurvania.com, same address. For Google sign-in the
marketplace's domain must be added to the OAuth client's **authorized
JavaScript origins** in the Google console.

`GET /api/diag` answers, without a key, whether this server can actually
reach the game — the question worth asking first when sign-in misbehaves.
`?ua=…` retries with a different User-Agent from the server itself, which is
how the header below was found.

One hard-won detail: the host in front of aurvania.com answers **403** to
most User-Agents — an empty one, node's default `node`, a full Chrome
string, `python-requests`, `axios`, a plain product token — and lets
`curl/*` and `Wget/*` through. Nothing reaches the game's app to explain
itself, so it looks like the marketplace is broken. `BRIDGE_UA` therefore
defaults to `curl/8.5.0 (OURO-marketplace; +https://ouro.lifestyle)`: the
prefix clears the filter, the rest keeps us identifiable in the game's logs.
Set `GOOGLE_CLIENT_ID` here too: the client id never changes, and inheriting
it over the network means one unreachable host turns into "Google sign-in is
not configured" on a perfectly good OAuth setup.

### The mana sponsor

Users never need KOIN mana. The client builds every transaction with
`payer = dev wallet, payee = user`, the user signs, and `POST /api/sponsor`
co-signs and broadcasts. What keeps the dev wallet safe:

1. payer must be the dev address;
2. payee must be set, must not be dev, and **must have signed** (the chain
   also enforces this — the payee's nonce is consumed);
3. every operation must target the marketplace contract, or be an
   `approve`/`set_approval_for_all` on a **registered** collection;
4. rc is capped **per operation** with an absolute ceiling, and each payee
   and IP is rate-limited.

A note on that ceiling, because it bit us: a real Koinos contract call burns
roughly 0.4–1.3 KOIN of mana, so a two-operation listing (`approve` +
`create_order`) needs well over 2 KOIN. An earlier flat 2 KOIN budget was
under what the transaction actually cost, and the chain rejected listings
with `insufficient rc` — which reads like the dev wallet is broke when it is
not. `rc_limit` is a ceiling, not a charge: only `rc_used` ever leaves the
payer, so budgeting generously is free.

Kondor users additionally fall back to a self-paid transaction if the
sponsor is ever down.

### Filters, and why they are server-side

A sidebar built from the tokens currently on screen would show wrong counts
and hide matches further down the collection. So the server walks a
collection once — ids from `get_tokens`, traits from each token's metadata —
and holds the index for ten minutes:

* `GET /api/collections/:addr/facets` — every trait with real counts.
* `GET /api/collections/:addr/tokens?t=Rarity:rare&t=Kind:pet&status=listed&sort=price_asc&q=blade&owner=1…`
  — repeated `t=Trait:Value`; several values of the **same** trait are an OR,
  different traits are an AND. Paging is `offset`/`limit`.

Collections larger than `INDEX_MAX_TOKENS` are indexed to that depth and the
response says `partial: true` rather than pretending to be complete.

### Page and artwork loading

Home and collection indexes are persisted under `DATA_DIR`. Stale indexes remain
available during background refresh; a new collection returns `loading: true`
with a partial response while its index builds, and the browser polls without
holding an HTTP request open. Collection headers and grids do not wait for trait
facets. Concurrent cache misses share one request. Browsing reuses the last known order book while refreshing; purchase execution still checks current on-chain orders. Cached sign-in settings return
immediately while refreshing, and first-load configuration waits are bounded.

Artwork uses same-origin `/img/c/:address` and `/img/t/:address/:tokenId` routes:

* HTTPS/IPFS links, embedded raster/SVG data URLs, and SVG `image_data` are supported.
  This fixes Discover Koinos Paint, whose art is stored directly on chain.
* SVG is served as an image with a restrictive CSP and `nosniff`, never inserted
  as page markup. Collections without a cover derive one from their own NFTs.
* IPFS gateways race for a successful response within a fixed timeout; a quick
  failure cannot beat a healthy gateway. Body reads have a real size limit.
* Resolved metadata survives restarts in `DATA_DIR/metadata`. Existing audited
  per-token references recover sampled legacy NFTs (including six Crew NFTs)
  while a live metadata refresh runs; unsampled tokens are never guessed.
* Original art is cached on disk. PNG/JPEG thumbnails are generated in worker
  threads so CPU-heavy image work does not stop the HTTP server. GIF/WebP files
  retain their originals so animation is preserved. SVG remains vector artwork.
* Missing artwork shows a readable placeholder, retries once, and keeps the NFT
  clickable. Requests no longer redirect visitors back to a failing gateway.

The first deployment rebuilds old indexes with the new image support. Full filter
counts still require index completion; indexes remain capped by `INDEX_MAX_TOKENS`.
An unreachable IPFS file still needs a reachable pin or the original artwork.
Archived metadata restores its reference, not missing image bytes.

To restore originals, `POST /api/art?key=…&collection=…&file=Name.png` accepts raw
image bytes; names must match the collection's metadata. `tools/seed-art.js`
imports a directory. Restored images are pinned against cache eviction and their
old thumbnails are invalidated. Keep `DATA_DIR` on a persistent disk outside the
application checkout so deployments retain metadata, artwork and collection keys.

### Trade history

Every listing, cancellation and sale is already on chain: the contract emits
`market.create_order` / `execute_order` / `cancel_order`, and Koinos indexes a
contract's own events under its address. `GET /api/history?collection=&token_id=`
serves them, so a trade made straight against the contract — bypassing this
site — still shows up. The walk is incremental (records carry a sequence
number) and is written to `DATA_DIR/history.json` so a restart does not
re-read the chain.

### Creating: add, launch, mint

`/#/create` has three doors, and all of them are open to anyone:

* **Add an existing collection** — any KCS-2 address on Koinos. No admin key;
  the server checks the contract actually answers and rate-limits abuse.
* **Launch a new one** — deploys `contracts/collection`, one generic binary
  whose name, symbol, uri and royalty are written into state at setup, so
  every collection ever launched runs identical, reviewable code. It goes to
  its own fresh account; OURO keeps that account's key as the upgrade
  authority while the CREATOR owns the collection (mint, metadata,
  royalties). Keys are written 0600, returned by no endpoint, logged nowhere.
* **Mint** — mints to your wallet and writes the metadata on chain in one
  transaction, traits included. **Bulk mint** takes a whole drop at once:
  select the images and the drop's metadata JSON — an array of
  `{"image": "1.png", "attributes": [...]}` entries, names optional — and
  items are matched to files by name, tallied on screen, then minted
  server-signed in chunks of five per transaction. A batch spends the daily
  mint budget per item and either fits whole or is refused whole; if a chunk
  fails mid-drop the response lists exactly what minted so nothing is
  minted twice. Both mint forms take an optional **list-for-sale price in
  KOIN** — the drop lands straight on the shopfront. A `"price"` field on a
  JSON item overrides the batch price for that item. Minting can be
  server-signed, but LISTING moves the owner's property, so it carries the
  owner's signature: silent for hosted keys, one Kondor popup, one blanket
  approval plus ten orders per transaction. Free mints need **no wallet signature**: a
  launched collection accepts its own account's authority for
  mint/set_metadata, and OURO holds that key already (it is the upgrade
  authority — strictly stronger, so no new trust). The server mints as the
  collection, on the owner's behalf, into the owner's wallet — and only when
  the requester's address IS the on-chain owner. With `MINT_FEE_KOIN` set,
  the wallet signs once to pay the fee, which the sponsor verifies is
  exactly the fee, to the treasury, beside a mint — no other KOIN transfer
  is ever co-signed. Mints are capped by `MINT_PER_DAY_TOTAL` across the
  whole site.

An upload costs ~59 KOIN of mana against ~1 for an ordinary call, measured
on this marketplace's own deployment. Roughly 28 launches would drain the
sponsor wallet and freeze trading for everyone until it recharges, so a
launch is both paid for (`LAUNCH_FEE_KOIN`, default 100) and rationed. The
fee and the contract upload ride in ONE transaction, so a fee cannot be
taken without a collection being created.

Minting is covered by the existing sponsor: `mint`, `set_metadata`,
`set_royalties` and `transfer_ownership` are payable on registered
collections. That is safe because the collection itself decides who may run
them — the contract checks the caller owns it.

### Adding collections

```sh
curl -X POST https://<site>/api/collections \
  -H 'Content-Type: application/json' \
  -d '{"key":"<ADMIN_KEY>","address":"1...","description":"...","image":"https://..."}'
```

The address is validated against the chain before it is accepted (it must
answer as a KCS-2 collection). Aurvania Relics ships in the seed registry;
any collection is also reachable unregistered at `#/c/<address>` — the
registry only decides the home page, and which approvals the sponsor pays for.

## Tests (`tests/`)

`npm run test:regressions` runs deterministic fee, image, and loading regressions
without broadcasting transactions or relying on public RPC/IPFS availability.


* `market-check.js` — API surface, registry rules, and one crafted
  transaction per sponsor gate (the happy path is proven with a zero-mana
  payer, so nothing can land on chain: "passed validation, died at the
  mempool" is the success signal).
* `market-ui.js` — Playwright: home → collection → token → connect modal,
  against live mainnet reads. Needs `PLAYWRIGHT_DIR` and `CHROMIUM`.

## Launch checklist

1. `contracts`: keygen → deploy to **harbinger** → exercise list/buy/cancel →
   deploy to **mainnet** with `--treasury` set → fund the dev wallet with KOIN
   (mana regenerates; it is spent, not burned… but held as the ceiling).
2. Server env: `MARKET_ADDR`, `KOINOS_DEV_WIF`, `ADMIN_KEY`.
3. Google console: add the marketplace origin to the OAuth client.
4. Register collections through the admin endpoint.
