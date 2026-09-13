/* KOIN Vault's QR relay. Session secrets stay in this tab; keys stay in Vault. */
'use strict';
const Vault = (() => {
  const origin = 'https://koinvault.app';
  const key = 'ouro:vault:v2:' + origin;
  async function json(path, body) {
    const r = await fetch(origin + path, {
      cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const error = new Error(data.error || 'KOIN Vault is unavailable. Please try again.');
      error.status = r.status;
      throw error;
    }
    return data;
  }
  const query = value => new URLSearchParams(value).toString();
  const status = session => json('/api/dapp/status?' + query(session));
  const isDisconnected = error => error?.status === 404 || error?.status === 410;
  function watch(session, onDisconnect) {
    let stopped = false, checking = false;
    const stop = () => {
      stopped = true; clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
    const ended = () => { if (!stopped) { stop(); onDisconnect(); } };
    async function check() {
      if (stopped || checking || document.hidden) return;
      checking = true;
      try {
        const live = await status(session);
        if (!live.connected || live.address !== session.address) ended();
      } catch (error) {
        // An outage is not a revocation. Retry without discarding the session.
        if (isDisconnected(error)) ended();
      } finally { checking = false; }
    }
    const timer = setInterval(check, 2000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    void check();
    return stop;
  }
  function save(session) { try { session ? sessionStorage.setItem(key, JSON.stringify(session)) : sessionStorage.removeItem(key); } catch (_) {} }
  function load() { try { const s = JSON.parse(sessionStorage.getItem(key)); return s?.sessionId && s?.secret && s?.address ? s : null; } catch (_) { return null; } }
  async function create() {
    const pair = await json('/api/dapp/create', { name: 'OURO', icon: location.origin + '/assets/mark.svg' });
    const uri = new URL(pair.uri);
    if (uri.origin !== origin || uri.pathname !== '/' || uri.username || uri.password
      || uri.searchParams.get('connect') !== pair.sessionId || uri.searchParams.get('secret') !== pair.secret) throw new Error('KOIN Vault returned an unexpected wallet address');
    return pair;
  }
  async function disconnect(session) { save(null); if (session) await json('/api/dapp/disconnect', session).catch(() => {}); }
  async function send(session, operations, transaction = null) {
    const request = transaction
      ? await json('/api/dapp/launch', { ...session, transaction })
      : await json('/api/dapp/request', { ...session, operations, summary: { title: 'OURO marketplace transaction', detail: `${operations.length} contract calls. Review the purchase, listing or mint in OURO before approving.`, network: 'mainnet' } });
    const deadline = Math.min(request.expiresAt || Infinity, Date.now() + 10 * 60000);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const result = await json('/api/dapp/request-status?' + query({ ...session, requestId: request.requestId }));
      if (transaction && result.status === 'signed' && result.signedTransaction) return result.signedTransaction;
      if (result.status === 'approved' && result.txid) return { id: result.txid, sponsored: true };
      if (result.status === 'rejected') throw new Error('Transaction rejected in KOIN Vault');
      if (result.status === 'failed') throw new Error(result.error || 'KOIN Vault could not submit the transaction');
    }
    throw new Error('KOIN Vault approval timed out. Check your wallet and the item before trying again.');
  }
  return { origin, create, status, watch, isDisconnected, save, load, disconnect, send, signLaunch: (session, tx) => send(session, null, tx) };
})();
