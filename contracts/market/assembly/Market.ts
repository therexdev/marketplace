// SPDX-License-Identifier: MIT
// The marketplace — every KCS-2 collection on Koinos, KOIN prices,
// Configurable platform fee (OURO defaults to 0%), collection royalties honored.
//
// A port of the open-source Kollection contract (MIT,
// github.com/kollection-nft/marketplace) onto the koinosbox toolchain,
// keeping its load-bearing design decisions:
//
//   * APPROVAL, not escrow. A listed NFT stays in the seller's wallet;
//     the seller approves this contract once and the transfer happens at
//     the moment of sale. Sell it elsewhere, send it away, keep playing
//     with it (Aurvania relics remain playable while listed) — the order
//     simply dies, because execution re-checks ownership.
//
//   * One atomic settle. Buyer's KOIN splits fee -> royalties -> seller
//     and the NFT moves seller -> buyer in a single transaction; there is
//     no state in which money moved and the NFT did not.
//
//   * Royalties are the COLLECTION's, not ours. Whatever the collection
//     contract declares through royalties() is paid, capped at 10% — the
//     same cap Kollection enforced. KCS-2 contracts declare per 10,000;
//     Kollection-era contracts declared per 100,000, and are recognized
//     by their missing get_tokens.
//
// Where it deliberately differs from the original:
//
//   * The buyer is explicit and signs for a MAXIMUM price. The original
//     derived the buyer from payer/payee headers and paid whatever the
//     order said at execution time, which allowed a listing to be repriced
//     under a pending buy. Here the buy states the price it agreed to.
//
//   * Orders are readable ON CHAIN, paginated per collection. Kollection
//     rebuilt listings from events in a backend; get_orders makes the
//     order book a plain RPC read, so the site (or anyone) can render the
//     market without trusting an indexer.
//
//   * The fee is configuration (capped at 10%), not a constant, so a fee
//     change is a signed config op rather than a contract migration.

import { System, Storage, authority, Arrays, Protobuf } from "@koinos/sdk-as";
import { System2, INft, IToken, common, nft, token } from "@koinosbox/contracts";
import { market } from "./proto/market";

const CONFIG_SPACE_ID = 0;
const ORDERS_SPACE_ID = 1;

const FEE_CAP: u32 = 1000;        // 10% — the most set_config will ever accept
const ROYALTY_CAP: u64 = 1000;    // 10% of the sale, same ceiling Kollection used
const MAX_EXPIRY_MS: u64 = 31536000000; // one year — beyond that, list again
const GET_TOKENS_ENTRY: u32 = 0x7d5b5ed7; // KCS-2 get_tokens — the dialect probe

export class Market {
  callArgs: System.getArgumentsReturn | null;

  contractId: Uint8Array = System.getContractId();

  config: Storage.Obj<market.config> = new Storage.Obj(
    this.contractId,
    CONFIG_SPACE_ID,
    market.config.decode,
    market.config.encode,
    () => new market.config()
  );

  // Keyed by collection || token_id, so one collection's orders are one
  // contiguous key range — which is what makes get_orders a prefix walk.
  orders: Storage.Map<Uint8Array, market.order> = new Storage.Map(
    this.contractId,
    ORDERS_SPACE_ID,
    market.order.decode,
    market.order.encode,
    () => new market.order()
  );

  private orderKey(collection: Uint8Array, tokenId: Uint8Array): Uint8Array {
    const key = new Uint8Array(collection.length + tokenId.length);
    key.set(collection, 0);
    key.set(tokenId, collection.length);
    return key;
  }

  private nowMs(): u64 {
    const ts = System.getBlockField("header.timestamp");
    System.require(ts != null, "no block timestamp");
    return ts!.uint64_value as u64;
  }

  /**
   * Authorize function
   * @external
   */
  authorize(args: authority.authorize_arguments): common.boole {
    // This contract holds nothing — no escrowed NFTs, no balances — so the
    // only thing worth authorizing is maintenance signed with its own key.
    const signers = System2.getSigners();
    for (let i = 0; i < signers.length; i += 1) {
      if (Arrays.equal(signers[i], this.contractId)) return new common.boole(true);
    }
    return new common.boole(false);
  }

  /**
   * Set the marketplace configuration (contract key only)
   * @external
   * @event market.config_event market.config
   */
  set_config(args: market.config): void {
    System.require(System2.isSignedBy(this.contractId), "not signed by the market key");
    System.require(!!args.treasury && args.treasury!.length > 0, "treasury required");
    System.require(!!args.koin && args.koin!.length > 0, "koin contract required");
    // The cap is the promise: whoever holds the config key can never take
    // more than 10%, and anyone can read that from the bytecode.
    System.require(args.fee_bps <= FEE_CAP, "fee capped at 10%");
    this.config.put(args);
    System.event("market.config_event", this.callArgs!.args, []);
  }

  /**
   * Get the marketplace configuration
   * @external
   * @readonly
   */
  get_config(): market.config {
    return this.config.get()!;
  }

  /**
   * Get one order (empty seller = not listed)
   * @external
   * @readonly
   */
  get_order(args: market.order_key): market.order {
    return this.orders.get(this.orderKey(args.collection!, args.token_id!))!;
  }

  /**
   * Walk the order book, optionally scoped to one collection
   * @external
   * @readonly
   */
  get_orders(args: market.get_orders_args): market.order_list {
    const res = new market.order_list();
    let limit = args.limit == 0 ? 50 : args.limit;
    if (limit > 200) limit = 200;

    const scoped = !!args.collection && args.collection!.length > 0;
    const prefix = scoped ? args.collection! : new Uint8Array(0);
    let offset: Uint8Array;
    if (scoped && !!args.start_after && args.start_after!.length > 0) {
      offset = this.orderKey(prefix, args.start_after!);
    } else if (scoped) {
      offset = prefix;              // keys are strictly longer, so this is "before the first"
    } else {
      offset = args.start_after && args.start_after!.length > 0
        ? args.start_after!
        : new Uint8Array(0);
    }

    const rows = this.orders.getMany(offset, limit as i32);
    for (let i = 0; i < rows.length; i += 1) {
      const key = rows[i].key;
      if (scoped) {
        // The walk leaves the collection the moment the key prefix changes.
        if (key == null || key!.length < prefix.length) break;
        let same = true;
        for (let j = 0; j < prefix.length; j += 1) {
          if (key![j] != prefix[j]) { same = false; break; }
        }
        if (!same) break;
      }
      res.value.push(rows[i].value);
    }
    return res;
  }

  /**
   * List an NFT for sale in KOIN. The NFT stays with the seller; this
   * contract must already be approved to transfer it.
   * @external
   * @event market.create_order market.create_order_event
   */
  create_order(args: market.create_order_args): void {
    const cfg = this.config.get()!;
    System.require(!!cfg.treasury && cfg.treasury!.length > 0, "market not configured");
    System.require(args.price > 0, "price must be positive");
    // Keeps every later bps multiplication inside u64 without u128 maths.
    System.require(args.price <= u64.MAX_VALUE / 10000, "price too large");

    const collection = new INft(args.collection!);
    const owner = collection.owner_of(new nft.token(args.token_id!));
    System.require(!!owner.value && owner.value!.length > 0, "no such token");
    const seller = owner.value!;

    // The owner speaks with a signature, never with a header. The original
    // trusted payer/payee here, which made third parties able to act for a
    // seller under sponsored mana; a signature check does not.
    System.require(System.checkAccountAuthority(seller), "not authorized by the owner");

    const approvedOne = collection.get_approved(new nft.token(args.token_id!));
    const approvedAll = collection.is_approved_for_all(
      new nft.is_approved_for_all_args(seller, this.contractId)
    );
    System.require(
      (!!approvedOne.value && Arrays.equal(approvedOne.value!, this.contractId)) ||
        approvedAll.value,
      "market is not approved to transfer this token"
    );

    const now = this.nowMs();
    System.require(
      args.expires == 0 || (args.expires > now && args.expires <= now + MAX_EXPIRY_MS),
      "bad expiry"
    );

    this.orders.put(
      this.orderKey(args.collection!, args.token_id!),
      new market.order(seller, args.collection!, args.token_id!, args.price, args.expires, now)
    );

    System.event(
      "market.create_order",
      Protobuf.encode<market.create_order_event>(
        new market.create_order_event(seller, args.collection!, args.token_id!, args.price, args.expires),
        market.create_order_event.encode
      ),
      [seller]
    );
  }

  /**
   * Buy a listed NFT: fee, royalties and seller are paid and the NFT
   * moves to the buyer, all in one atomic transaction
   * @external
   * @event market.execute_order market.execute_order_event
   */
  execute_order(args: market.execute_order_args): void {
    const cfg = this.config.get()!;
    const key = this.orderKey(args.collection!, args.token_id!);
    const order = this.orders.get(key)!;
    System.require(!!order.seller && order.seller!.length > 0, "not listed");

    const buyer = args.buyer!;
    System.require(buyer.length > 0, "buyer required");
    System.require(!Arrays.equal(buyer, order.seller!), "that is your own listing");
    System.require(System.checkAccountAuthority(buyer), "not authorized by the buyer");
    // The price the buyer saw is the most they can be charged.
    System.require(order.price <= args.max_price, "price rose above your bid");

    const now = this.nowMs();
    System.require(order.expires == 0 || now <= order.expires, "order expired");

    // The seller must still own it — an NFT sold or moved elsewhere leaves
    // a dead order behind, and a dead order must never move money.
    const collection = new INft(args.collection!);
    const owner = collection.owner_of(new nft.token(args.token_id!));
    System.require(
      !!owner.value && Arrays.equal(owner.value!, order.seller!),
      "seller no longer owns this token"
    );

    // Order gone BEFORE any transfer: re-entrancy through a hostile token
    // contract finds no order to spend twice.
    this.orders.remove(key);

    const pay = new IToken(cfg.koin!);
    const price = order.price;
    let remain = price;

    // 1. The platform fee.
    const fee = (price * (cfg.fee_bps as u64)) / 10000;
    if (fee > 0) {
      pay.transfer(new token.transfer_args(buyer, cfg.treasury!, fee));
      remain -= fee;
    }

    // 2. The collection's royalties, exactly as declared, capped at 10%.
    //    Two royalty dialects exist on this chain: KCS-2 contracts declare
    //    basis points per 10,000, while Kollection-era contracts declared
    //    per 100,000 — The Crew's "5000" paid 5% on real Kollection sales,
    //    not 50%. They are told apart the only way the chain can: KCS-2
    //    contracts answer get_tokens, Kollection-era ones cannot.
    const probeArgs = new nft.get_tokens_args();
    probeArgs.limit = 1;
    const probe = System.call(
      args.collection!,
      GET_TOKENS_ENTRY,
      Protobuf.encode(probeArgs, nft.get_tokens_args.encode)
    );
    const royaltyBase: u64 = probe.code == 0 ? 10000 : 100000;

    let royaltiesPaid: u64 = 0;
    const royalties = collection.royalties();
    let royaltyBps: u64 = 0;
    for (let i = 0; i < royalties.value.length; i += 1) {
      const p = royalties.value[i].percentage;
      // A single share past the whole base is garbage; refusing it here
      // also keeps the sum below any overflow long before the cap check.
      System.require(p <= royaltyBase, "collection royalties exceed 10%");
      royaltyBps += p;
    }
    System.require(royaltyBps * 10000 <= ROYALTY_CAP * royaltyBase, "collection royalties exceed 10%");
    for (let i = 0; i < royalties.value.length; i += 1) {
      const r = royalties.value[i];
      const cut = (price * r.percentage) / royaltyBase;
      if (cut > 0 && !!r.address && r.address!.length > 0) {
        pay.transfer(new token.transfer_args(buyer, r.address!, cut));
        remain -= cut;
        royaltiesPaid += cut;
      }
    }

    // 3. The seller takes the rest.
    pay.transfer(new token.transfer_args(buyer, order.seller!, remain));

    // 4. The NFT. This contract is the approved operator, so the
    // collection lets it move seller -> buyer.
    collection.transfer(new nft.transfer_args(order.seller!, buyer, args.token_id!));

    System.event(
      "market.execute_order",
      Protobuf.encode<market.execute_order_event>(
        new market.execute_order_event(
          buyer, order.seller!, args.collection!, args.token_id!, price, fee, royaltiesPaid
        ),
        market.execute_order_event.encode
      ),
      [buyer, order.seller!]
    );
  }

  /**
   * Cancel an order. The seller can always cancel; ANYONE can clear an
   * order whose seller no longer owns the token (it is unexecutable — the
   * cleanup just keeps the book honest); the market key can delist spam.
   * @external
   * @event market.cancel_order market.cancel_order_event
   */
  cancel_order(args: market.order_key): void {
    const key = this.orderKey(args.collection!, args.token_id!);
    const order = this.orders.get(key)!;
    System.require(!!order.seller && order.seller!.length > 0, "not listed");

    const owner = new INft(args.collection!).owner_of(new nft.token(args.token_id!));
    const stale = !owner.value || !Arrays.equal(owner.value!, order.seller!);

    System.require(
      stale ||
        System.checkAccountAuthority(order.seller!) ||
        System2.isSignedBy(this.contractId),
      "not authorized by the seller"
    );

    this.orders.remove(key);

    System.event(
      "market.cancel_order",
      Protobuf.encode<market.cancel_order_event>(
        new market.cancel_order_event(order.seller!, args.collection!, args.token_id!),
        market.cancel_order_event.encode
      ),
      [order.seller!]
    );
  }
}
