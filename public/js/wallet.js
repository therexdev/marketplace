/* ============================================================
   Wallet — who you are, and how a transaction leaves the building.

   Two kinds of account, one interface:

     * KONDOR — the browser-extension wallet Kollection users know. We
       ask it for an address and a koilib-compatible signer; keys never
       leave the extension.

     * HOSTED — the Aurvania account. Google or email sign-in is bridged
       to the game's server, which answers with the SAME wallet the same
       login gets in the game (one identity, one address, both sites).
       The key lives in this browser's localStorage, exactly like in the
       game; the server never keeps a session.

   Every transaction goes out MANA-SPONSORED: built with payer = the
   marketplace's dev wallet and payee = you, signed here by you, then
   co-signed and broadcast by the server. You need ZERO KOIN mana to
   trade — the platform pays. If sponsorship is ever down and you are on
   Kondor, we fall back to a plain self-paid transaction.
   ============================================================ */
'use strict';

const Wallet = (() => {
  const LS_WIF = 'mk_wif';
  const LS_KIND = 'mk_kind';

  let cfg = null;              // /api/config, fetched once at boot
  let account = null;          // { kind: 'kondor'|'hosted', address, signer }
  let provider = null;
  const listeners = [];
  let stopVaultWatch = null;
  function stopWatchingVault() { if (stopVaultWatch) stopVaultWatch(); stopVaultWatch = null; }

  async function init() {
    cfg = await (await fetch('/api/config')).json();
    provider = new Provider(cfg.rpcs || [cfg.rpc]);
    // Wake a remembered account.
    const kind = localStorage.getItem(LS_KIND);
    const vault = Vault.load();
    if (kind === 'vault' && vault) {
      try {
        const live = await Vault.status(vault);
        if (live.connected && live.address === vault.address) adoptVault(vault);
        else Vault.save(null);
      } catch (_) { Vault.save(null); }
    }
    if (kind === 'hosted' && localStorage.getItem(LS_WIF)) {
      try { adoptWif(localStorage.getItem(LS_WIF)); } catch (_) { localStorage.removeItem(LS_WIF); }
    } else if (kind === 'kondor' && window.kondor) {
      // Kondor reconnects only on demand — a page load must never pop the
      // extension. The header shows "Connect" until the user asks.
    }
    return cfg;
  }

  function emit() { for (const fn of listeners) { try { fn(account); } catch (_) {} } }
  function onChange(fn) { listeners.push(fn); }

  function adoptWif(wif) {
    stopWatchingVault();
    Vault.disconnect(Vault.load());
    const signer = Signer.fromWif(wif);
    signer.provider = provider;
    account = { kind: 'hosted', address: signer.getAddress(), signer };
    localStorage.setItem(LS_WIF, wif);
    localStorage.setItem(LS_KIND, 'hosted');
    emit();
    return account;
  }

  async function connectKondor() {
    if (!window.kondor) throw new Error('Kondor is not installed — get it from the Chrome or Brave store');
    const accounts = await window.kondor.getAccounts();
    if (!accounts || !accounts.length) throw new Error('Kondor returned no accounts');
    const address = accounts[0].address;
    const signer = window.kondor.getSigner(address);
    stopWatchingVault();
    Vault.disconnect(Vault.load());
    account = { kind: 'kondor', address, signer };
    localStorage.setItem(LS_KIND, 'kondor');
    localStorage.removeItem(LS_WIF);
    emit();
    return account;
  }

  /** Google or email — the Aurvania bridge. Returns the same wallet the
      same login owns in the game. */
  async function hostedLogin(body) {
    const r = await fetch('/api/account', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok || !data.wif) {
      // The server knows WHY the bridge failed; passing that through beats
      // sending someone to hunt through browser settings.
      throw new Error(data.detail ? `${data.error} (${data.detail})` : (data.error || 'Sign-in failed'));
    }
    return adoptWif(data.wif);
  }

  function disconnect() {
    stopWatchingVault();
    Vault.disconnect(account?.session || Vault.load());
    account = null;
    localStorage.removeItem(LS_WIF);
    localStorage.removeItem(LS_KIND);
    emit();
  }

  /* ---------------- transactions ---------------- */
  function adoptVault(session) {
    if (cfg.network !== 'mainnet') throw new Error('KOIN Vault connects to Koinos mainnet only');
    stopWatchingVault();
    const connected = { kind: 'vault', address: session.address, session };
    account = connected;
    Vault.save(session);
    localStorage.removeItem(LS_WIF);
    localStorage.setItem(LS_KIND, 'vault');
    stopVaultWatch = Vault.watch(session, () => {
      if (account !== connected) return;
      // The relay already revoked it; clear only this website's wallet state.
      stopWatchingVault(); Vault.save(null); account = null;
      localStorage.removeItem(LS_KIND); localStorage.removeItem(LS_WIF);
      window.dispatchEvent(new Event('vault-settled'));
      emit();
    });
    emit();
    return account;
  }

  let abis = null;
  async function loadAbis() {
    if (abis) return abis;
    const [market, nft] = await Promise.all([
      (await fetch('/abi/market-abi.json')).json(),
      (await fetch('/abi/nft-abi.json')).json(),
    ]);
    // koilib's protobufjs rejects the btype extension declaration.
    for (const abi of [market, nft]) {
      const k = abi.koilib_types && abi.koilib_types.nested.koinos && abi.koilib_types.nested.koinos.nested;
      if (k) { delete k.btype; delete k._btype; }
    }
    abis = { market, nft };
    return abis;
  }

  async function encodeOp(contractId, abi, name, args) {
    const c = new Contract({ id: contractId, abi, provider });
    return c.encodeOperation({ name, args });
  }

  /* Mana budget. Measured on mainnet, a single Koinos contract call burns
     roughly 0.4–1.3 KOIN of mana, so a two-operation listing (approve +
     create_order) needs well over the flat 2 KOIN this used to ask for —
     which is exactly why listings came back "insufficient rc". rc_limit is
     a CEILING, not a charge: only what the transaction actually burns
     leaves the payer, so budgeting generously costs nothing, and the
     server caps it per operation anyway. */
  const RC_PER_OP = 300000000n;    // 3 KOIN of headroom for each operation
  const RC_CEILING = 1500000000n;  // never ask for more than 15 KOIN
  const rcFor = (opCount) => {
    const want = RC_PER_OP * BigInt(Math.max(1, opCount));
    return (want > RC_CEILING ? RC_CEILING : want).toString();
  };

  /** Chain errors arrive as raw JSON — {"error":"insufficient rc",…}.
      Nobody should ever have to read one of those. */
  function humanError(raw) {
    let msg = String(raw && raw.message ? raw.message : raw || 'Transaction failed');
    for (let i = 0; i < 3; i++) {
      try {
        const j = JSON.parse(msg);
        if (j && typeof j.error === 'string') { msg = j.error; continue; }
      } catch (_) {}
      break;
    }
    msg = msg.replace(/^transaction reverted:\s*/i, '').trim();
    if (/insufficient rc|rc limit/i.test(msg)) {
      return 'This transaction needed more mana than the ceiling allowed. Mana is on us, so this is ours to fix — please try again, and tell us if it repeats.';
    }
    if (/nonce/i.test(msg)) return 'Your account had another transaction in flight. Give it a few seconds and try again.';
    if (/insufficient balance|has no balance/i.test(msg)) return 'Not enough KOIN in your wallet for this purchase.';
    if (/not authorized|authoriz/i.test(msg)) return 'The chain refused that — this wallet is not allowed to perform it.';
    if (/order (does not exist|not found)/i.test(msg)) return 'That listing is gone — it was just bought or cancelled.';
    return msg.slice(0, 200);
  }

  /** Build, sign and submit a transaction of marketplace operations.
      Sponsored by default; self-paid through Kondor as the fallback. */
  async function send(ops, { rcLimit = rcFor(ops.length) } = {}) {
    if (!account) throw new Error('Connect a wallet first');

    if (account.kind === 'vault') {
      const connected = account;
      window.dispatchEvent(new Event('vault-approval'));
      try { return await Vault.send(connected.session, ops); }
      catch (e) {
        if (/connection not found|connection.*expired/i.test(e.message) && account === connected) disconnect();
        throw e;
      }
      finally { window.dispatchEvent(new Event('vault-settled')); }
    }

    if (cfg.sponsor && cfg.sponsorPayer) {
      const tx = new Transaction({
        signer: account.signer,
        provider,
        options: { payer: cfg.sponsorPayer, payee: account.address, rcLimit },
      });
      for (const op of ops) await tx.pushOperation(op);
      await tx.prepare();
      await tx.sign();
      const r = await fetch('/api/sponsor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: tx.transaction }),
      });
      const data = await r.json();
      if (r.ok && data.ok) return { id: data.id, sponsored: true };
      // A sponsorship outage must not strand Kondor users, who can pay
      // their own mana. Hosted accounts have no mana, so for them the
      // sponsor error is the real answer.
      if (account.kind !== 'kondor') throw new Error(humanError(data.error || 'The sponsor declined this transaction'));
    }

    const tx = new Transaction({
      signer: account.signer, provider, options: { rcLimit },
    });
    for (const op of ops) await tx.pushOperation(op);
    await tx.prepare();
    await tx.sign();
    try { await tx.send(); }
    catch (e) { throw new Error(humanError(e)); }
    return { id: tx.transaction.id, sponsored: false };
  }

  /* ---- the four marketplace actions ---- */

  async function listToken(collection, tokenId, priceSats, { approved = false } = {}) {
    const { market, nft } = await loadAbis();
    const ops = [];
    if (!approved) {
      ops.push(await encodeOp(collection, nft, 'approve', {
        approver_address: account.address, to: cfg.market, token_id: tokenId,
      }));
    }
    ops.push(await encodeOp(cfg.market, market, 'create_order', {
      collection, token_id: tokenId, price: String(priceSats), expires: '0',
    }));
    return send(ops);
  }

  /** koilib's token ABI, minus the btype declaration its protobufjs
      rejects. KOIN on mainnet is KCS-4 — allowances included. */
  function koinAbi() {
    const abi = JSON.parse(JSON.stringify(utils.tokenAbi));
    const k = abi.koilib_types && abi.koilib_types.nested.koinos && abi.koilib_types.nested.koinos.nested;
    if (k) { delete k.btype; delete k._btype; }
    return abi;
  }

  async function buyToken(collection, tokenId, priceSats) {
    const { market } = await loadAbis();
    /* The chain stopped letting a contract spend a bare signature: KOIN
       moves out of a wallet only on an allowance. So the buy grants the
       market exactly the price, and the market's own transfers consume
       the whole grant inside execute_order. */
    const ops = [
      await encodeOp(cfg.koin, koinAbi(), 'approve', {
        owner: account.address, spender: cfg.market, value: String(priceSats),
      }),
      await encodeOp(cfg.market, market, 'execute_order', {
        collection, token_id: tokenId, buyer: account.address, max_price: String(priceSats),
      }),
    ];
    // One approve plus one execute_order, which does the work of several
    // plain calls — budget it like five, matching the sponsor's weighting.
    return send(ops, { rcLimit: rcFor(5) });
  }

  /** Mint into a collection you own, metadata and all, in one transaction.
      When a mint fee is set, it rides along — your KOIN, so your signature. */
  async function mintToken(collection, tokenId, metadata, { listPriceSats = null } = {}) {
    const { nft, market } = await loadAbis();
    const ops = [];
    if (Number(cfg.mintFeeKoin) > 0 && cfg.treasury) {
      ops.push(await encodeOp(cfg.koin, koinAbi(), 'transfer', {
        from: account.address, to: cfg.treasury,
        value: BigInt(Math.round(Number(cfg.mintFeeKoin) * 1e8)).toString(),
      }));
    }
    ops.push(await encodeOp(collection, nft, 'mint', { to: account.address, token_id: tokenId }));
    if (metadata) {
      ops.push(await encodeOp(collection, nft, 'set_metadata', {
        token_id: tokenId, metadata: JSON.stringify(metadata),
      }));
    }
    if (listPriceSats) {
      // Mint and shopfront in one signature: approve the market, open the order.
      ops.push(await encodeOp(collection, nft, 'approve', {
        approver_address: account.address, to: cfg.market, token_id: tokenId,
      }));
      ops.push(await encodeOp(cfg.market, market, 'create_order', {
        collection, token_id: tokenId, price: String(listPriceSats), expires: '0',
      }));
    }
    return send(ops);
  }

  /** List several tokens in one go: one approval covering the collection,
      then an order per token. Listing is the one thing the collection
      cannot sign for its owner — an order moves YOUR property, so YOUR
      authority creates it (silent for hosted keys, one Kondor popup). */
  async function listTokens(collection, entries, { onProgress = null } = {}) {
    const { market, nft } = await loadAbis();
    if (!entries.length) return null;
    /* Measured on mainnet: an approval plus one order burns 3.46 KOIN, so
       a chunk of ten orders needs ~19 — past the 15 KOIN sponsor ceiling,
       and the whole transaction reverts with nothing listed. Five orders
       plus the approval stays near 12 whichever way the cost splits. Each
       chunk then waits for the previous one to reach the chain, because
       two transactions from one account cannot share a nonce. */
    const CHUNK = 5;
    let last = null;
    for (let at = 0; at < entries.length; at += CHUNK) {
      const slice = entries.slice(at, at + CHUNK);
      const ops = [];
      if (at === 0) {
        ops.push(slice.length === 1 && entries.length === 1
          ? await encodeOp(collection, nft, 'approve', {
              approver_address: account.address, to: cfg.market, token_id: slice[0].tokenId,
            })
          : await encodeOp(collection, nft, 'set_approval_for_all', {
              approver_address: account.address, operator_address: cfg.market, approved: true,
            }));
      }
      for (const e of slice) {
        ops.push(await encodeOp(cfg.market, market, 'create_order', {
          collection, token_id: e.tokenId, price: String(e.priceSats), expires: '0',
        }));
      }
      last = await send(ops);
      if (onProgress) { try { onProgress(Math.min(at + CHUNK, entries.length), entries.length); } catch (_) {} }
      if (at + CHUNK < entries.length) {
        // The next chunk needs this one's nonce settled on chain first.
        for (let w = 0; w < 15; w++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const q = await fetch(`/api/collections/${collection}/token/${encodeURIComponent(slice[slice.length - 1].tokenId)}`);
            const d = await q.json();
            if (d.order && !d.order.dead) break;
          } catch (_) {}
        }
      }
    }
    return last;
  }

  /** The signature-free path: the server mints as the collection itself.
      Only for free mints on collections launched here; the caller falls
      back to mintToken when the server says this one is not its to sign. */
  async function serverMint(body) {
    const r = await fetch('/api/mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, owner: account.address }),
    });
    const d = await r.json();
    if (!r.ok || d.error) {
      const err = new Error(d.error || 'Mint failed');
      err.external = !!d.external;
      throw err;
    }
    return d;
  }

  /** Launch a collection: the server builds it, you sign it, the server
      co-signs and deploys. Your signature is what pays the fee. */
  async function launchCollection(spec) {
    if (!account) throw new Error('Connect a wallet first');
    const connected = account;
    const prep = await (await fetch('/api/launch/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...spec, owner: connected.address, wallet: connected.kind }),
    })).json();
    if (prep.error) throw new Error(prep.error);

    /* A free launch is finished by the time this returns: nothing in it
       belongs to you, so nothing needed your key. Only a FEE requires a
       signature, because only you can authorize spending your KOIN. */
    if (prep.launched) return prep;

    let signed;
    if (connected.kind === 'vault') {
      window.dispatchEvent(new Event('vault-approval'));
      try { signed = await Vault.signLaunch(connected.session, prep.transaction); }
      finally { window.dispatchEvent(new Event('vault-settled')); }
      if (account !== connected) throw new Error('Wallet changed during launch approval');
    } else {
      const tx = new Transaction({ signer: connected.signer, provider });
      tx.transaction = prep.transaction;
      await tx.sign();
      signed = tx.transaction;
    }

    const done = await (await fetch('/api/launch/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: signed }),
    })).json();
    if (done.error) {
      const err = new Error(humanError(done.error));
      err.sent = done.sent;      // the shape the chain refused, for the console
      throw err;
    }
    return done;
  }

  async function cancelOrder(collection, tokenId) {
    const { market } = await loadAbis();
    const op = await encodeOp(cfg.market, market, 'cancel_order', {
      collection, token_id: tokenId,
    });
    return send([op]);
  }

  return {
    init, onChange, connectKondor, hostedLogin, disconnect, adoptWif, adoptVault,
    listToken, buyToken, cancelOrder, mintToken, serverMint, listTokens, launchCollection,
    get account() { return account; },
    get cfg() { return cfg; },
    get provider() { return provider; },
  };
})();
