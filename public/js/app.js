/* ============================================================
   OURO — the app. Hash-routed, no framework: four views over a thin
   API, with every mutating action going through Wallet.send.
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* Grid tiles ask the art cache for a 480px derivative — a tile never
   needs the multi-MB original. Full art stays for the token page. */
const thumb = (u) => u && (u.startsWith('/img/') || u.startsWith('/u/')) ? u + (u.includes('?') ? '&' : '?') + 'w=480' : u;

const KOIN = (sats) => {
  const n = Number(BigInt(sats || '0')) / 1e8;
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 8 });
};
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';

function toast(msg, cls = '', ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function api(path) {
  const r = await fetch('/api' + path);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------------- modal ---------------- */

function modal(html) {
  $('#modal').innerHTML = html;
  $('#modal-back').classList.remove('hidden');
  return $('#modal');
}
function closeModal() { $('#modal-back').classList.add('hidden'); }
$('#modal-back').addEventListener('mousedown', (e) => { if (e.target === $('#modal-back')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ---------------- connect ---------------- */

function connectModal() {
  const m = modal(`
    <h3>Connect</h3>
    <p class="sub">Kondor if you hold your own keys — or the same Google /
    email sign-in as Aurvania, which opens the <b>same wallet</b> you have
    in the game. Mana fees are on us either way.</p>
    <div class="stack">
      <button class="btn big" id="w-kondor">🦅 Kondor wallet</button>
      <div class="g-wrap" id="w-google-wrap">
        <button class="btn big g-face" type="button" tabindex="-1" aria-hidden="true">
          <svg class="g-mark" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
            <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
            <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
            <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
          </svg>
          <span>Sign in with Google</span>
        </button>
        <div class="g-overlay" id="w-google-slot" aria-label="Sign in with Google"></div>
      </div>
      <div class="alt">— or email —</div>
      <input id="w-email" type="email" placeholder="email" autocomplete="email">
      <input id="w-pass" type="password" placeholder="password" autocomplete="current-password">
      <button class="btn primary big" id="w-login">Log in</button>
      <div class="alt">New here? <button class="linkish" id="w-register">Create an account</button></div>
    </div>
  `);
  m.querySelector('#w-kondor').onclick = async () => {
    try { await Wallet.connectKondor(); closeModal(); toast('Kondor connected', 'good'); }
    catch (e) { toast(esc(e.message), 'bad'); }
  };

  /* Google, as its own RENDERED button rather than One Tap. The first version
     called google.accounts.id.prompt(), and One Tap is silently suppressed all
     the time — third-party cookie settings, a previously dismissed prompt
     (hours of backoff), private windows — which reads as a button that simply
     does nothing. Only Google's iframe may open the popup and it cannot be
     styled, so it is stretched invisibly over a button of ours (the pattern
     the game already ships). */
  const wrap = m.querySelector('#w-google-wrap');
  const slot = m.querySelector('#w-google-slot');
  const cid = Wallet.cfg.googleClientId;
  const googleDead = (why) => {
    if (!wrap.isConnected) return;
    wrap.classList.add('g-dead');
    wrap.onclick = () => toast(why, 'bad', 6000);
  };
  const renderGoogle = () => {
    window.google.accounts.id.initialize({
      client_id: cid,
      ux_mode: 'popup',
      callback: async (resp) => {
        try { await Wallet.hostedLogin({ action: 'google', idToken: resp.credential }); closeModal(); toast('Signed in — same wallet as Aurvania', 'good'); }
        catch (e) { toast(esc(e.message), 'bad'); }
      },
    });
    /* Match our face exactly so the invisible hit area covers all of it. */
    const w = Math.max(200, Math.min(400, Math.round(wrap.getBoundingClientRect().width) || 320));
    window.google.accounts.id.renderButton(slot, {
      theme: 'filled_black', size: 'large', text: 'signin_with',
      shape: 'rectangular', width: w,
    });
  };
  if (!cid) {
    googleDead('Google sign-in is not configured — use email');
  } else {
    /* The GSI script is async: the modal can open before it lands. Our button
       is on screen either way, so wait for Google rather than declaring it
       broken on the first look. */
    let waited = 0;
    (function awaitGsi() {
      if (!wrap.isConnected) return;
      if (window.google?.accounts?.id) {
        try { renderGoogle(); }
        catch (e) { console.warn('Google button failed to render', e); googleDead('Google sign-in could not start — use email'); }
        return;
      }
      if ((waited += 150) > 8000) return googleDead('The Google sign-in script could not load — check for blockers, or use email');
      setTimeout(awaitGsi, 150);
    })();
  }
  const emailAction = (action) => async () => {
    const email = m.querySelector('#w-email').value.trim();
    const password = m.querySelector('#w-pass').value;
    if (!email || !password) return toast('Email and password required', 'bad');
    try {
      await Wallet.hostedLogin({ action, email, password });
      closeModal(); toast(action === 'register' ? 'Account created' : 'Signed in', 'good');
    } catch (e) { toast(esc(e.message), 'bad'); }
  };
  m.querySelector('#w-login').onclick = emailAction('login');
  m.querySelector('#w-register').onclick = emailAction('register');
}

function walletModal() {
  const a = Wallet.account;
  const m = modal(`
    <h3>Your wallet</h3>
    <div class="wallet-row">
      <div>
        <div class="mono" style="font-size:13px;word-break:break-all">${esc(a.address)}</div>
        <div class="sub" style="margin:4px 0 0">${a.kind === 'kondor' ? 'Kondor' : 'Aurvania account (hosted key)'} · <span id="wm-bal"><span class="spin"></span></span></div>
      </div>
    </div>
    <div class="stack">
      <button class="btn" id="wm-copy">Copy address</button>
      <a class="btn" style="text-align:center" href="${Wallet.cfg.explorer}/address/${esc(a.address)}" target="_blank" rel="noopener">View on koinosblocks</a>
      <button class="btn danger" id="wm-out">Disconnect</button>
    </div>
  `);
  api('/balance?address=' + a.address).then((b) => {
    const el = m.querySelector('#wm-bal');
    if (el) el.textContent = `${KOIN(b.koin)} KOIN`;
  }).catch(() => {});
  m.querySelector('#wm-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(a.address); toast('Address copied', 'good'); } catch (_) {}
  };
  m.querySelector('#wm-out').onclick = () => { Wallet.disconnect(); closeModal(); };
}

/* ---------------- shared renderers ---------------- */

const tokCard = (colAddr, t) => `
  <a class="tok-card" href="#/t/${colAddr}/${encodeURIComponent(t.tokenId)}">
    <div class="tok-art">${t.image ? `<img src="${esc(thumb(t.image))}" alt="" loading="lazy">` : '<div class="ph">🖼️</div>'}</div>
    <div class="tok-body">
      <span class="tok-name">${esc(t.name || t.label)}</span>
      ${t.order ? `<span class="price">${KOIN(t.order.price)} <small>KOIN</small></span>` : ''}
    </div>
  </a>`;

/* ---------------- views ---------------- */

async function homeView() {
  view.innerHTML = '<div class="loading"><span class="spin"></span> Loading collections…</div>';
  const { collections } = await api('/collections');
  const listed = collections.reduce((s, c) => s + (c.listed || 0), 0);
  view.innerHTML = `
    <section class="hero">
      <h1>Every Koinos collection.<br>One <em>endless</em> market.</h1>
      <p>Buy and sell NFTs in KOIN with zero mana fees — the marketplace pays
      them for you. 2.5% platform fee, collection royalties honored, and your
      Aurvania account works here out of the box.</p>
      <div class="hero-stats">
        <div class="hstat"><b>${collections.length}</b><span>collections</span></div>
        <div class="hstat"><b>${listed}</b><span>live listings</span></div>
        <div class="hstat"><b>2.5%</b><span>platform fee</span></div>
      </div>
    </section>
    <div class="section-head">Collections</div>
    <div class="grid">
      ${collections.map((c) => `
        <a class="col-card" href="#/c/${c.address}">
          <div class="col-art">${c.image ? `<img src="${esc(thumb(c.image))}" alt="" loading="lazy">` : '<div class="ph">◆</div>'}</div>
          <div class="col-body">
            <div class="col-name">${esc(c.name || c.address)}</div>
            <div class="col-desc">${esc(c.description || '')}</div>
            <div class="col-meta">
              <div><b>${c.floor != null ? KOIN(c.floor) : '—'}</b><span>floor</span></div>
              <div><b>${c.listed || 0}</b><span>listed</span></div>
              <div><b>${Number(c.totalSupply || 0).toLocaleString('en-US')}</b><span>items</span></div>
            </div>
          </div>
        </a>`).join('')}
    </div>
    ${collections.length ? '' : '<div class="empty">No collections registered yet.</div>'}`;
}

/* The collection page keeps its filters IN THE URL, so a filtered view can
   be shared, bookmarked and reloaded. Changing a filter rewrites the query
   and repaints the grid alone — repainting the whole page would throw away
   the sidebar's scroll position on every click. */
async function collectionView(addr, queryString) {
  view.innerHTML = '<div class="loading"><span class="spin"></span> Loading collection…</div>';
  const state = new URLSearchParams(queryString || '');
  const [data, facetData] = await Promise.all([
    api('/collections/' + addr),
    api(`/collections/${addr}/facets`).catch(() => ({ facets: [], indexed: 0, partial: false })),
  ]);
  const info = data.info || {};

  const activeTraits = () => {
    const m = new Map();
    for (const raw of state.getAll('t')) {
      const i = raw.indexOf(':');
      if (i < 1) continue;
      const k = raw.slice(0, i);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(raw.slice(i + 1));
    }
    return m;
  };
  const filterCount = () => state.getAll('t').length
    + (state.get('status') && state.get('status') !== 'all' ? 1 : 0)
    + (state.get('q') ? 1 : 0);

  view.innerHTML = `
    <div class="c-head">
      <div class="c-title">
        <h2>${esc(info.name || addr)} ${info.symbol ? `<span class="dim-chip chip">${esc(info.symbol)}</span>` : ''}</h2>
        <a class="mono" href="${Wallet.cfg.explorer}/address/${addr}" target="_blank" rel="noopener">${addr}</a>
        <p>${esc((data.meta && data.meta.description) || info.description || '')}</p>
      </div>
      <div class="c-stats">
        <div class="hstat"><b>${data.orders.length}</b><span>listed</span></div>
        <div class="hstat"><b>${Number(info.totalSupply || 0).toLocaleString('en-US')}</b><span>items</span></div>
        <div class="hstat"><b>${((info.royaltyBps || 0) / 100).toFixed(1)}%</b><span>royalty</span></div>
      </div>
    </div>
    <div class="c-layout">
      <aside class="c-side" id="c-side"></aside>
      <div class="c-main">
        <div class="c-toolbar">
          <button class="btn filt-toggle" id="c-filt-open">☰ Filters<span id="c-filt-n"></span></button>
          <input id="c-search" type="search" placeholder="Search by name" value="${esc(state.get('q') || '')}">
          <select id="c-sort">
            <option value="default">Sort: default</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="name">Name A–Z</option>
          </select>
          <span class="c-count" id="c-count"></span>
        </div>
        <div id="c-grid"></div>
      </div>
    </div>`;

  /* A collection that deployed but never got named is recoverable, and the
     person looking at it is the one who paid for it — so offer the repair
     here rather than leaving them with "Uninitialized collection". */
  if (/^Uninitialized/.test(info.name || '')) {
    view.querySelector('.c-title').insertAdjacentHTML('beforeend',
      `<div class="warn" id="c-unfinished">This collection deployed but never finished setup.
       <button class="linkish" id="c-finish">Finish it now</button></div>`);
    $('#c-finish').onclick = async () => {
      const name = prompt('Collection name:', data.meta?.name || '');
      if (!name) return;
      const symbol = prompt('Symbol (1-16 letters or digits):', '');
      if (!symbol) return;
      const btn = $('#c-finish');
      btn.disabled = true; btn.textContent = 'Finishing…';
      try {
        const r = await fetch('/api/launch/finish', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr, name, symbol }),
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.detail ? `${d.error}: ${d.detail}` : d.error);
        toast('Collection is live', 'good', 6000);
        collectionView(addr, queryString);
      } catch (e) {
        toast(esc(e.message), 'bad', 9000);
        btn.disabled = false; btn.textContent = 'Finish it now';
      }
    };
  }

  const side = $('#c-side');
  const grid = $('#c-grid');
  $('#c-sort').value = state.get('sort') || 'default';

  /* Rewrite the address bar without navigating: a hashchange here would
     re-enter route() and rebuild the page we are standing on. */
  const syncUrl = () => {
    const qs = state.toString();
    history.replaceState(null, '', `#/c/${addr}${qs ? '?' + qs : ''}`);
  };

  const paintSidebar = () => {
    const active = activeTraits();
    const status = state.get('status') || 'all';
    const n = filterCount();
    $('#c-filt-n').textContent = n ? ` (${n})` : '';
    side.innerHTML = `
      <div class="side-head">
        <b>Filters</b>
        ${n ? '<button class="linkish" id="c-clear">Clear all</button>' : ''}
        <button class="side-x" id="c-filt-close" aria-label="Close filters">✕</button>
      </div>
      <div class="facet">
        <div class="facet-h">Status</div>
        ${[['all', 'Everything'], ['listed', 'For sale'], ['unlisted', 'Not listed'], ['mine', 'Mine']]
          .map(([v, label]) => `
          <label class="fopt${v === 'mine' && !Wallet.account ? ' dim' : ''}">
            <input type="radio" name="c-status" value="${v}"${status === v ? ' checked' : ''}>
            <span>${label}</span>
          </label>`).join('')}
      </div>
      ${facetData.facets.map((f, i) => `
        <div class="facet">
          <div class="facet-h">${esc(f.trait)}</div>
          <div class="facet-vals${f.values.length > 8 ? ' scrolly' : ''}">
            ${f.values.map((v) => {
              const on = active.get(f.trait)?.has(String(v.value));
              return `<label class="fopt">
                <input type="checkbox" data-trait="${esc(f.trait)}" value="${esc(String(v.value))}"${on ? ' checked' : ''}>
                <span>${esc(String(v.value))}</span><em>${v.count}</em>
              </label>`;
            }).join('')}
          </div>
        </div>`).join('')}
      ${facetData.facets.length ? '' : '<div class="facet dim">This collection publishes no traits to filter on.</div>'}
      ${facetData.partial ? `<div class="facet dim">Filters cover the first ${facetData.indexed} items of this collection.</div>` : ''}`;

    side.querySelectorAll('input[name="c-status"]').forEach((el) => {
      el.onchange = () => {
        if (el.value === 'mine' && !Wallet.account) { connectModal(); return paintSidebar(); }
        state.set('status', el.value);
        apply();
      };
    });
    side.querySelectorAll('input[type="checkbox"][data-trait]').forEach((el) => {
      el.onchange = () => {
        const key = `${el.dataset.trait}:${el.value}`;
        const kept = state.getAll('t').filter((x) => x !== key);
        state.delete('t');
        for (const k of kept) state.append('t', k);
        if (el.checked) state.append('t', key);
        apply();
      };
    });
    const clear = side.querySelector('#c-clear');
    if (clear) clear.onclick = () => {
      for (const k of ['t', 'status', 'q']) state.delete(k);
      $('#c-search').value = '';
      apply();
    };
    side.querySelector('#c-filt-close').onclick = () => {
      side.classList.remove('open');
      view.querySelector('.c-layout')?.classList.remove('filters-open');
    };
  };

  let reqId = 0;
  const paintGrid = async () => {
    const mine = state.get('status') === 'mine';
    const params = new URLSearchParams();
    for (const t of state.getAll('t')) params.append('t', t);
    const status = state.get('status') || 'all';
    if (status !== 'all' && status !== 'mine') params.set('status', status);
    if (mine && Wallet.account) params.set('owner', Wallet.account.address);
    if (state.get('q')) params.set('q', state.get('q'));
    if (state.get('sort') && state.get('sort') !== 'default') params.set('sort', state.get('sort'));

    const mine_ = ++reqId;
    grid.innerHTML = '<div class="loading"><span class="spin"></span></div>';
    let offset = 0;
    const page = async () => {
      const q = await api(`/collections/${addr}/tokens?limit=24&offset=${offset}&${params}`);
      if (mine_ !== reqId) return;                 // a newer filter won
      $('#c-count').textContent = `${q.matched.toLocaleString('en-US')} item${q.matched === 1 ? '' : 's'}`;
      if (!offset) {
        grid.innerHTML = q.matched
          ? '<div class="grid"></div>'
          : '<div class="empty">Nothing matches these filters.</div>';
      }
      const g = grid.querySelector('.grid');
      if (!g) return;
      g.insertAdjacentHTML('beforeend', q.tokens.map((t) => tokCard(addr, t)).join(''));
      grid.querySelector('.load-more')?.remove();
      if (q.nextOffset != null) {
        offset = q.nextOffset;
        grid.insertAdjacentHTML('beforeend', '<button class="btn load-more">Load more</button>');
        grid.querySelector('.load-more').onclick = page;
      }
    };
    try { await page(); }
    catch (e) { if (mine_ === reqId) grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };

  const apply = () => { syncUrl(); paintSidebar(); paintGrid(); };

  $('#c-sort').onchange = (e) => { state.set('sort', e.target.value); apply(); };
  let searchTimer;
  $('#c-search').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const v = e.target.value.trim();
      if (v) state.set('q', v); else state.delete('q');
      syncUrl(); paintGrid();
    }, 250);
  };
  const layout = view.querySelector('.c-layout');
  const drawer = (open) => {
    side.classList.toggle('open', open);
    layout.classList.toggle('filters-open', open);
  };
  $('#c-filt-open').onclick = () => drawer(true);
  // The backdrop is a pseudo-element, so its clicks land on the layout.
  layout.onclick = (e) => { if (e.target === layout) drawer(false); };
  document.addEventListener('keydown', function esc(e) {
    if (!layout.isConnected) return document.removeEventListener('keydown', esc);
    if (e.key === 'Escape') drawer(false);
  });

  /* Land on what is for sale — but only when arriving with no filters of
     your own. A shared ?t=Rarity:rare link that quietly also means "and
     for sale" lands on an empty grid with the box ticked, which reads as
     broken rather than as a default. */
  const arrivedFiltered = state.getAll('t').length > 0 || !!state.get('q') || !!state.get('status');
  if (!arrivedFiltered && data.orders.length) state.set('status', 'listed');
  apply();

  /* Your own unlisted items, listable in one go — the recovery path for a
     bulk mint whose listing step failed, and the fast path for anyone
     sitting on a pile. Painted after the grid so it never delays the page,
     and independent of the filters so the "for sale" default cannot hide
     the fact that your items exist. */
  const bulkBar = async () => {
    if (!Wallet.account) return;
    const me = Wallet.account.address;
    const myLayout = view.querySelector('.c-layout');
    const mine = [];
    let offset = 0;
    for (let guard = 0; guard < 25; guard++) {
      const q = await api(`/collections/${addr}/tokens?owner=${me}&status=unlisted&limit=60&offset=${offset}`).catch(() => null);
      if (!q) return;
      mine.push(...q.tokens);
      if (q.nextOffset == null) break;
      offset = q.nextOffset;
    }
    // Only decorate the page this was started for — not whatever replaced it.
    if (mine.length < 2 || !myLayout.isConnected || $('#c-bulklist')) return;
    view.querySelector('.c-toolbar').insertAdjacentHTML('beforebegin', `
      <div class="bulk-bar" id="c-bulklist">
        <span><b>${mine.length}</b> of your items here are not for sale.</span>
        <div class="price-field">
          <input id="bl-price" type="number" min="0" step="0.00000001" placeholder="price each" inputmode="decimal">
          <span>KOIN</span>
        </div>
        <button class="btn primary" id="bl-go">List all ${mine.length}</button>
      </div>`);
    $('#bl-go').onclick = async () => {
      const koin = parseFloat($('#bl-price').value);
      if (!(koin > 0)) { toast('Set a price in KOIN first', 'bad', 4000); $('#bl-price').focus(); return; }
      const priceSats = BigInt(Math.round(koin * 1e8)).toString();
      const btn = $('#bl-go');
      btn.disabled = true; $('#bl-price').disabled = true;
      btn.innerHTML = '<span class="spin"></span> Listing…';
      try {
        await Wallet.listTokens(addr, mine.map((t) => ({ tokenId: t.tokenId, priceSats })), {
          onProgress: (done, total) => { btn.innerHTML = `<span class="spin"></span> Listed ${done} of ${total}…`; },
        });
        /* The last chunk returns the moment it is sent; wait for its final
           order to be readable before repainting the shopfront. */
        const lastId = mine[mine.length - 1].tokenId;
        for (let w = 0; w < 10; w++) {
          await new Promise((r) => setTimeout(r, 2000));
          const d = await api(`/collections/${addr}/token/${encodeURIComponent(lastId)}`).catch(() => null);
          if (d && d.order && !d.order.dead) break;
        }
        toast(`🎉 All ${mine.length} listed at ${koin} KOIN`, 'good', 8000);
        $('#c-bulklist')?.remove();
        state.set('status', 'listed');
        apply();
      } catch (e) {
        toast(esc(e.message), 'bad', 10000);
        btn.disabled = false; $('#bl-price').disabled = false;
        btn.textContent = `List all ${mine.length}`;
      }
    };
  };
  bulkBar().catch(() => {});
}

async function tokenView(addr, tokenId) {
  view.innerHTML = '<div class="loading"><span class="spin"></span> Loading item…</div>';
  const t = await api(`/collections/${addr}/token/${encodeURIComponent(tokenId)}`);
  const me = Wallet.account && Wallet.account.address;
  const isOwner = me && t.owner === me;
  const order = t.order && !t.order.dead ? t.order : null;
  const feeBps = Wallet.cfg.feeBps || 250;
  const royBps = t.collection.royaltyBps || 0;

  const dealHtml = () => {
    if (order && !isOwner) {
      const sellerGets = (BigInt(order.price) * BigInt(10000 - feeBps - royBps)) / 10000n;
      return `
        <div class="big-price">${KOIN(order.price)} <small style="font-size:16px">KOIN</small></div>
        <div class="fee-note">seller receives ${KOIN(sellerGets.toString())} · ${(feeBps / 100).toFixed(1)}% platform fee${royBps ? ` · ${(royBps / 100).toFixed(1)}% creator royalty` : ''} · mana on us</div>
        <div class="row"><button class="btn primary big" id="t-buy">Buy now</button></div>`;
    }
    if (order && isOwner) {
      return `
        <div class="big-price">${KOIN(order.price)} <small style="font-size:16px">KOIN</small></div>
        <div class="fee-note">your listing</div>
        <div class="row"><button class="btn danger big" id="t-cancel">Cancel listing</button></div>`;
    }
    if (isOwner) {
      return `
        <div class="fee-note">You own this. Listing it costs you nothing — the NFT stays in your wallet until it sells.</div>
        <div class="row"><a class="btn primary big" href="#/list/${addr}/${encodeURIComponent(tokenId)}">List Item</a></div>`;
    }
    return `<div class="fee-note">Not listed for sale.${t.owner ? '' : ' This token may not exist yet.'}</div>`;
  };

  view.innerHTML = `
    <div class="t-wrap">
      <div class="t-art">${t.meta?.image ? `<img src="${esc(t.meta.image)}" alt="">` : '<div class="ph">🖼️</div>'}</div>
      <div class="t-info">
        <a class="crumb" href="#/c/${addr}">← ${esc(t.collection.name || addr)}</a>
        <h2>${esc(t.meta?.name || t.label)}</h2>
        ${t.meta?.description ? `<p style="color:var(--dim);margin-top:6px">${esc(t.meta.description)}</p>` : ''}
        <div class="kv">Owner <a class="mono" href="${Wallet.cfg.explorer}/address/${esc(t.owner || '')}" target="_blank" rel="noopener">${esc(short(t.owner))}</a>
          · Token <span class="mono">${esc(t.label)}</span></div>
        <div class="deal" id="t-deal">${dealHtml()}</div>
        ${t.meta?.attributes?.length ? `<div class="attrs">${t.meta.attributes.map((a) => `
          <div class="attr"><span>${esc(a.trait_type || a.name || '')}</span><b>${esc(String(a.value ?? ''))}</b></div>`).join('')}</div>` : ''}
        <div id="t-history"></div>
      </div>
    </div>`;

  paintHistory($('#t-history'), addr, tokenId);

  /* An action, then patient polling: the receipt comes back fast but the
     read layer only sees the new state once the block lands and the cache
     rolls. The poll watches for the STATE CHANGE, not the receipt. */
  const busy = (btn, label) => { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${label}`; };
  async function follow(test, done) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const fresh = await api(`/collections/${addr}/token/${encodeURIComponent(tokenId)}`);
        if (test(fresh)) { toast(done, 'good', 6000); return tokenView(addr, tokenId); }
      } catch (_) {}
    }
    toast('Still settling — refresh in a moment.', '', 6000);
  }

  const buyBtn = $('#t-buy');
  if (buyBtn) buyBtn.onclick = async () => {
    if (!Wallet.account) return connectModal();
    busy(buyBtn, 'Buying…');
    try {
      await Wallet.buyToken(addr, tokenId, order.price);
      toast('Purchase sent — waiting for the block…');
      follow((f) => f.owner === Wallet.account.address, '🎉 It is yours — the NFT is in your wallet.');
    } catch (e) { toast(esc(e.message), 'bad', 7000); tokenView(addr, tokenId); }
  };

  const cancelBtn = $('#t-cancel');
  if (cancelBtn) cancelBtn.onclick = async () => {
    busy(cancelBtn, 'Cancelling…');
    try {
      await Wallet.cancelOrder(addr, tokenId);
      toast('Cancel sent — waiting for the block…');
      follow((f) => !f.order || f.order.dead, 'Listing cancelled.');
    } catch (e) { toast(esc(e.message), 'bad', 7000); tokenView(addr, tokenId); }
  };
}

/* What has happened to this token before — read from the contract's own
   events, so a sale made straight against the contract still shows up. */
const WHEN = (ms) => {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const days = (Date.now() - Number(ms)) / 86400000;
  if (days < 1) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days < 300) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
};

async function paintHistory(el, addr, tokenId) {
  if (!el) return;
  let events = [];
  try {
    const r = await api(`/history?collection=${addr}&token_id=${encodeURIComponent(tokenId)}`);
    events = r.events || [];
  } catch (_) { return; }
  if (!events.length) {
    el.innerHTML = '<div class="hist"><div class="hist-h">History</div><div class="fee-note">No listings or sales yet — this one has never been to market.</div></div>';
    return;
  }
  const who = (a) => `<a class="mono" href="${Wallet.cfg.explorer}/address/${esc(a || '')}" target="_blank" rel="noopener">${esc(short(a))}</a>`;
  const line = (e) => {
    const tx = e.tx ? `<a class="hist-tx" href="${Wallet.cfg.explorer}/tx/${esc(e.tx)}" target="_blank" rel="noopener" title="View transaction">↗</a>` : '';
    if (e.kind === 'sold') {
      const net = e.price ? (BigInt(e.price) - BigInt(e.fee || 0) - BigInt(e.royalty || 0)).toString() : null;
      return `<div class="hist-row sold">
        <span class="hist-tag">Sold</span>
        <span class="hist-what">${who(e.seller)} → ${who(e.buyer)}${net ? `<em>seller received ${KOIN(net)} KOIN</em>` : ''}</span>
        <span class="hist-amt">${KOIN(e.price)} KOIN</span>
        <span class="hist-when">${WHEN(e.at)}${tx}</span></div>`;
    }
    if (e.kind === 'cancelled') {
      return `<div class="hist-row cancelled">
        <span class="hist-tag">Cancelled</span>
        <span class="hist-what">by ${who(e.seller)}</span>
        <span class="hist-amt">—</span>
        <span class="hist-when">${WHEN(e.at)}${tx}</span></div>`;
    }
    return `<div class="hist-row listed">
      <span class="hist-tag">Listed</span>
      <span class="hist-what">by ${who(e.seller)}</span>
      <span class="hist-amt">${KOIN(e.price)} KOIN</span>
      <span class="hist-when">${WHEN(e.at)}${tx}</span></div>`;
  };
  el.innerHTML = `<div class="hist"><div class="hist-h">History</div>${events.map(line).join('')}</div>`;
}

/* Listing is its own page: the price, what each cut takes, and what
   actually lands in your wallet — all visible before you commit. */
async function listView(addr, tokenId) {
  if (!Wallet.account) { connectModal(); }
  view.innerHTML = '<div class="loading"><span class="spin"></span> Loading item…</div>';
  const t = await api(`/collections/${addr}/token/${encodeURIComponent(tokenId)}`);
  const me = Wallet.account && Wallet.account.address;
  const back = `#/t/${addr}/${encodeURIComponent(tokenId)}`;

  if (!me) {
    view.innerHTML = `<div class="empty">Connect a wallet to list this item. <a href="${back}">Back to the item</a></div>`;
    return;
  }
  if (t.owner !== me) {
    view.innerHTML = `<div class="empty">This item is not in your wallet, so you cannot list it. <a href="${back}">Back to the item</a></div>`;
    return;
  }

  const feeBps = Wallet.cfg.feeBps || 250;
  const royBps = t.collection.royaltyBps || 0;

  view.innerHTML = `
    <a class="crumb" href="${back}">← ${esc(t.meta?.name || t.label)}</a>
    <div class="list-wrap">
      <div class="list-item">
        <div class="t-art">${t.meta?.image ? `<img src="${esc(thumb(t.meta.image))}" alt="">` : '<div class="ph">🖼️</div>'}</div>
        <div>
          <h2>${esc(t.meta?.name || t.label)}</h2>
          <div class="kv">${esc(t.collection.name || addr)} · <span class="mono">${esc(t.label)}</span></div>
          ${t.meta?.description ? `<p class="sub" style="margin-top:8px">${esc(t.meta.description)}</p>` : ''}
          ${t.meta?.attributes?.length ? `<div class="attrs">${t.meta.attributes.map((a) => `
            <div class="attr"><span>${esc(a.trait_type || a.name || '')}</span><b>${esc(String(a.value ?? ''))}</b></div>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="list-panel">
        <h3>List for sale</h3>
        <label for="l-price">Your price</label>
        <div class="price-field">
          <input id="l-price" type="number" min="0" step="0.00000001" placeholder="0.00" inputmode="decimal" autofocus>
          <span>KOIN</span>
        </div>

        <div class="breakdown" id="l-break"></div>

        <button class="btn primary big" id="l-go" disabled>List it</button>
        <div class="fee-note">The NFT stays in your wallet until someone buys it. You can cancel any
        time. Mana fees are on us${t.approved ? '' : ', including the one-off approval this first listing needs'}.</div>
      </div>
    </div>`;

  const priceEl = $('#l-price');
  const breakEl = $('#l-break');
  const goBtn = $('#l-go');

  const row = (label, value, cls = '') => `<div class="brow ${cls}"><span>${label}</span><b>${value}</b></div>`;
  const repaint = () => {
    const koin = parseFloat(priceEl.value);
    const ok = koin > 0 && Number.isFinite(koin);
    goBtn.disabled = !ok;
    if (!ok) {
      breakEl.innerHTML =
        row('Platform fee', `${(feeBps / 100).toFixed(2)}%`) +
        (royBps ? row('Collection royalty', `${(royBps / 100).toFixed(2)}%`) : '') +
        row('You receive', 'enter a price', 'total');
      return;
    }
    const sats = BigInt(Math.round(koin * 1e8));
    const fee = (sats * BigInt(feeBps)) / 10000n;
    const roy = (sats * BigInt(royBps)) / 10000n;
    const net = sats - fee - roy;
    breakEl.innerHTML =
      row('Listing price', `${KOIN(sats.toString())} KOIN`) +
      row(`Platform fee · ${(feeBps / 100).toFixed(2)}%`, `− ${KOIN(fee.toString())} KOIN`, 'minus') +
      (royBps ? row(`Collection royalty · ${(royBps / 100).toFixed(2)}%`, `− ${KOIN(roy.toString())} KOIN`, 'minus') : '') +
      row('You receive', `${KOIN(net.toString())} KOIN`, 'total');
  };
  priceEl.oninput = repaint;
  repaint();

  goBtn.onclick = async () => {
    const koin = parseFloat(priceEl.value);
    if (!(koin > 0)) return toast('Set a price first', 'bad');
    const sats = BigInt(Math.round(koin * 1e8)).toString();
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spin"></span> Listing…';
    try {
      await Wallet.listToken(addr, tokenId, sats, { approved: t.approved });
      toast('Listing sent — waiting for the block…');
      location.hash = back;
      // The token page polls for the order to appear.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const f = await api(`/collections/${addr}/token/${encodeURIComponent(tokenId)}`);
          if (f.order && !f.order.dead) { toast('Listed. It stays in your wallet until it sells.', 'good', 6000); return route(); }
        } catch (_) {}
      }
    } catch (e) {
      toast(esc(e.message), 'bad', 8000);
      goBtn.disabled = false;
      goBtn.textContent = 'List it';
    }
  };
}

/* ---------------- creating ----------------

   Three doors: bring a collection that already exists, launch a new one,
   or mint into one you own. */

/** Art: a file goes to OURO, a link goes in as-is. Returns a url or null. */
function artField(id, label) {
  return `
    <label>${label}</label>
    <div class="art-pick">
      <div class="art-prev" id="${id}-prev"><span>no image</span></div>
      <div class="art-ctl">
        <input type="file" id="${id}-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
        <button class="btn" id="${id}-btn" type="button">Upload an image</button>
        <div class="alt">or paste a link</div>
        <input id="${id}-url" type="url" placeholder="https://… or ipfs://…">
      </div>
    </div>`;
}
function wireArt(id) {
  const state = { url: '' };
  const prev = $(`#${id}-prev`), urlEl = $(`#${id}-url`), fileEl = $(`#${id}-file`);
  const show = (u) => {
    state.url = u || '';
    prev.innerHTML = u ? `<img src="${esc(u)}" alt="">` : '<span>no image</span>';
  };
  $(`#${id}-btn`).onclick = () => fileEl.click();
  fileEl.onchange = async () => {
    const f = fileEl.files && fileEl.files[0];
    if (!f) return;
    $(`#${id}-btn`).disabled = true;
    $(`#${id}-btn`).innerHTML = '<span class="spin"></span> Uploading…';
    try {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || 'Upload failed');
      urlEl.value = d.url;
      show(d.url);
      toast('Image uploaded', 'good');
    } catch (e) { toast(esc(e.message), 'bad'); }
    $(`#${id}-btn`).disabled = false;
    $(`#${id}-btn`).textContent = 'Upload an image';
  };
  urlEl.oninput = () => show(urlEl.value.trim());
  return { get: () => (urlEl.value.trim() || state.url || '') };
}

async function createView(tab) {
  const me = Wallet.account && Wallet.account.address;
  const info = await api('/launch?owner=' + (me || '')).catch(() => ({ feeKoin: 0, ready: false }));
  const on = (t) => (tab === t ? ' on' : '');
  view.innerHTML = `
    <section class="hero" style="padding-bottom:4px">
      <h1 style="font-size:26px">Create</h1>
      <p>Bring a collection that already exists on Koinos, launch a brand new one,
      or mint into a collection you own. Mana is on us throughout.</p>
    </section>
    <div class="tabs">
      <button class="tab${on('launch')}" data-t="launch">Launch a collection</button>
      <button class="tab${on('add')}" data-t="add">Add an existing one</button>
      <button class="tab${on('mint')}" data-t="mint">Mint an NFT</button>
    </div>
    <div id="cr-body"></div>`;
  view.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { location.hash = '#/create/' + t.dataset.t; }));

  const body = $('#cr-body');
  if (tab === 'add') return createAdd(body);
  if (tab === 'mint') return createMint(body, me, info);
  return createLaunch(body, me, info);
}

function createAdd(body) {
  body.innerHTML = `
    <div class="form-card">
      <h3>Add an existing collection</h3>
      <p class="sub">Any KCS-2 collection on Koinos can be listed here. Paste its
      contract address — we read the name, symbol and supply straight off the chain.</p>
      <label for="ad-addr">Contract address</label>
      <input id="ad-addr" placeholder="1…" spellcheck="false">
      <label for="ad-desc">Description <span class="dim">(optional)</span></label>
      <textarea id="ad-desc" rows="3" placeholder="What is this collection?"></textarea>
      ${artField('ad-img', 'Cover image <span class="dim">(optional)</span>')}
      <button class="btn primary big" id="ad-go">Add collection</button>
    </div>`;
  const art = wireArt('ad-img');
  $('#ad-go').onclick = async () => {
    const address = $('#ad-addr').value.trim();
    if (!address) return toast('Paste a contract address', 'bad');
    const btn = $('#ad-go');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Checking the chain…';
    try {
      const r = await fetch('/api/collections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address, description: $('#ad-desc').value.trim(), image: art.get(),
          by: Wallet.account ? Wallet.account.address : null,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || 'Could not add that collection');
      toast(`Added ${esc(d.collection.name || address)}`, 'good');
      location.hash = '#/c/' + address;
    } catch (e) {
      toast(esc(e.message), 'bad', 7000);
      btn.disabled = false; btn.textContent = 'Add collection';
    }
  };
}

function createLaunch(body, me, info) {
  const fee = Number(info.feeKoin || 0);
  body.innerHTML = `
    <div class="form-card">
      <h3>Launch a new collection</h3>
      <p class="sub">Deploys your own NFT contract on Koinos. You own it outright —
      minting, metadata and royalties are yours. ${fee > 0
        ? `Launching costs <b>${fee} KOIN</b>, which covers deploying the contract.`
        : 'Launching is free right now.'}</p>
      ${info.ready === false ? '<div class="warn">Launching is not configured on this server yet.</div>' : ''}
      <label for="lc-name">Collection name</label>
      <input id="lc-name" maxlength="64" placeholder="Moonlit Wanderers">
      <label for="lc-sym">Symbol</label>
      <input id="lc-sym" maxlength="16" placeholder="MOON" spellcheck="false" style="text-transform:uppercase">
      <label for="lc-desc">Description <span class="dim">(optional)</span></label>
      <textarea id="lc-desc" rows="3" maxlength="1000" placeholder="What is this collection about?"></textarea>
      ${artField('lc-img', 'Cover image <span class="dim">(optional)</span>')}
      <label for="lc-roy">Creator royalty — you earn this on every resale</label>
      <div class="price-field">
        <input id="lc-roy" type="number" min="0" max="10" step="0.25" value="5">
        <span>%</span>
      </div>
      <div class="breakdown" id="lc-break"></div>
      <button class="btn primary big" id="lc-go"${info.ready === false ? ' disabled' : ''}>
        ${fee > 0 ? `Launch for ${fee} KOIN` : 'Launch collection'}</button>
      <div class="fee-note">Deploying takes a few seconds. ${fee > 0
        ? `Your wallet signs once, to pay the fee — the deployment itself is ours to
           authorize, and rides in the same transaction so one cannot happen without
           the other.`
        : 'Launching is free right now, so your wallet is not asked to sign anything at all.'}</div>
    </div>`;
  const art = wireArt('lc-img');
  const brk = $('#lc-break');
  const paint = () => {
    const roy = Math.max(0, Math.min(10, Number($('#lc-roy').value || 0)));
    brk.innerHTML =
      `<div class="brow"><span>Launch fee</span><b>${fee > 0 ? fee + ' KOIN' : 'free'}</b></div>` +
      `<div class="brow"><span>Mana for deployment</span><b>on us</b></div>` +
      `<div class="brow"><span>Your royalty on resales</span><b>${roy.toFixed(2)}%</b></div>` +
      `<div class="brow total"><span>Collections left today</span><b>${info.globalRemaining ?? '—'}</b></div>`;
  };
  $('#lc-roy').oninput = paint; paint();

  $('#lc-go').onclick = async () => {
    if (!Wallet.account) return connectModal();
    const name = $('#lc-name').value.trim();
    const symbol = $('#lc-sym').value.trim().toUpperCase();
    if (!name) return toast('Give the collection a name', 'bad');
    if (!/^[A-Z0-9]{1,16}$/.test(symbol)) return toast('Symbol must be 1-16 letters or digits', 'bad');
    const btn = $('#lc-go');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Deploying — this takes a moment…';
    try {
      const r = await Wallet.launchCollection({
        name, symbol,
        description: $('#lc-desc').value.trim(),
        image: art.get(),
        royaltyBps: Math.round(Math.max(0, Math.min(10, Number($('#lc-roy').value || 0))) * 100),
      });
      toast(r.initialized ? '🎉 Your collection is live' : 'Deployed — finishing setup…', 'good', 8000);
      location.hash = '#/c/' + r.collection;
    } catch (e) {
      /* A failed launch still costs the fee and the mana, so the reason
         goes on screen in full rather than into a log nobody can reach. */
      toast(esc(e.message), 'bad', 15000);
      if (e.sent) console.error('launch payload shape:', e.sent);
      btn.disabled = false; btn.textContent = fee > 0 ? `Launch for ${fee} KOIN` : 'Launch collection';
    }
  };
}

async function createMint(body, me, info = {}) {
  const fee = Number(info.mintFeeKoin ?? (Wallet.cfg && Wallet.cfg.mintFeeKoin) ?? 0);
  const left = info.mintsRemaining;
  if (!me) { body.innerHTML = '<div class="empty">Connect a wallet to mint.</div>'; connectModal(); return; }
  body.innerHTML = '<div class="loading"><span class="spin"></span> Finding collections you own…</div>';
  const { collections } = await api('/collections');
  const mine = [];
  for (const c of collections) {
    try {
      const t = await api('/collections/' + c.address);
      if ((t.info && t.info.owner) === me) mine.push(c);
    } catch (_) {}
  }
  body.innerHTML = `
    <div class="form-card">
      <h3>Mint an NFT</h3>
      ${mine.length ? '' : `<div class="warn">No collections here are owned by your wallet yet.
        <a href="#/create/launch">Launch one</a> and it will appear.</div>`}
      <label for="mt-col">Collection</label>
      <select id="mt-col">${mine.map((c) => `<option value="${c.address}">${esc(c.name || c.address)}</option>`).join('')}</select>
      <label for="mt-name">Name of this NFT</label>
      <input id="mt-name" maxlength="80" placeholder="Wanderer #1">
      <label for="mt-id">Token id <span class="dim">— its permanent identifier</span></label>
      <input id="mt-id" maxlength="32" placeholder="WANDERER0001" spellcheck="false">
      <label for="mt-desc">Description <span class="dim">(optional)</span></label>
      <textarea id="mt-desc" rows="3" placeholder="Anything a collector should know"></textarea>
      ${artField('mt-img', 'Artwork')}
      <label for="mt-price">List for sale <span class="dim">(optional) — price in KOIN; leave empty to just mint</span></label>
      <div class="price-field">
        <input id="mt-price" type="number" min="0" step="0.00000001" placeholder="not for sale" inputmode="decimal">
        <span>KOIN</span>
      </div>
      <label>Traits <span class="dim">(optional)</span></label>
      <div id="mt-traits"></div>
      <button class="btn" id="mt-addtrait" type="button">+ Add a trait</button>
      <button class="btn primary big" id="mt-go"${mine.length ? '' : ' disabled'}>${fee > 0 ? `Mint for ${fee} KOIN` : 'Mint it'}</button>
      <div class="fee-note">The NFT is minted to your wallet with its metadata written on chain.
      Mana is on us. ${fee > 0
        ? 'Your wallet signs once, to pay the fee.'
        : 'Free mints need no signature at all.'}${Number.isFinite(left) ? ` ${left} of the site's daily mints remain.` : ''}</div>
    </div>

    ${fee === 0 ? `
    <div class="form-card" style="margin-top:18px" id="bulk-card">
      <h3>Bulk mint a drop</h3>
      <p class="sub">A whole set at once: pick every image, then the metadata JSON that
      describes them — an array of <span class="mono">{"image": "1.png", "attributes": […]}</span>
      entries, names optional. Items are matched to images by filename.</p>
      <label for="bk-col">Collection</label>
      <select id="bk-col">${mine.map((c) => `<option value="${c.address}">${esc(c.name || c.address)}</option>`).join('')}</select>
      <label for="bk-prefix">Name prefix — items become "Prefix #1", "Prefix #2"… unless the JSON names them</label>
      <input id="bk-prefix" maxlength="40" placeholder="Duck">
      <label for="bk-files">Images</label>
      <input id="bk-files" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp">
      <label for="bk-price">List each for sale <span class="dim">(optional) — KOIN each; a "price" field on a JSON item overrides it</span></label>
      <div class="price-field">
        <input id="bk-price" type="number" min="0" step="0.00000001" placeholder="not for sale" inputmode="decimal">
        <span>KOIN</span>
      </div>
      <label for="bk-json">Metadata JSON — pick the file or paste it</label>
      <input id="bk-json" type="file" accept=".json,application/json">
      <textarea id="bk-paste" rows="3" placeholder='[{"image":"1.png","attributes":[{"trait_type":"Rarity","value":"Common"}]}]'></textarea>
      <div id="bk-preview" class="fee-note"></div>
      <button class="btn primary big" id="bk-go" disabled>Mint the drop</button>
      <div class="fee-note">Free bulk mints need no signature. Each item spends one of the
      site's daily mints${Number.isFinite(left) ? ` (${left} left today)` : ''}.</div>
    </div>` : ''}`;
  const art = wireArt('mt-img');
  const traits = $('#mt-traits');
  const addTrait = () => {
    const row = document.createElement('div');
    row.className = 'trait-row';
    row.innerHTML = `<input placeholder="Trait (e.g. Rarity)" class="t-k">
      <input placeholder="Value (e.g. rare)" class="t-v">
      <button class="btn t-x" type="button" aria-label="Remove">✕</button>`;
    row.querySelector('.t-x').onclick = () => row.remove();
    traits.appendChild(row);
  };
  $('#mt-addtrait').onclick = addTrait;

  $('#mt-go').onclick = async () => {
    const collection = $('#mt-col').value;
    const name = $('#mt-name').value.trim();
    const rawId = $('#mt-id').value.trim();
    if (!collection) return toast('Pick a collection', 'bad');
    if (!name) return toast('Give the NFT a name', 'bad');
    if (!/^[\x20-\x7e]{1,32}$/.test(rawId)) return toast('Token id must be 1-32 plain characters', 'bad');
    const image = art.get();
    if (!image) return toast('Add artwork — upload a file or paste a link', 'bad');

    const attributes = [...traits.querySelectorAll('.trait-row')].map((r) => ({
      trait_type: r.querySelector('.t-k').value.trim(),
      value: r.querySelector('.t-v').value.trim(),
    })).filter((a) => a.trait_type && a.value);

    // Token ids travel as hex, the way every KCS-2 collection stores them.
    const tokenId = '0x' + [...rawId].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const btn = $('#mt-go');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Minting…';
    try {
      const meta = {
        name, description: $('#mt-desc').value.trim(),
        image: image.startsWith('/u/') ? location.origin + image : image,
        attributes,
      };
      const priceKoin = parseFloat($('#mt-price').value);
      const priceSats = priceKoin > 0 ? BigInt(Math.round(priceKoin * 1e8)).toString() : null;
      if (fee === 0) {
        /* Server-signed: the collection mints as itself, so nothing needs
           your key. Collections not launched here fall back to the wallet. */
        let external = false;
        try {
          await Wallet.serverMint({ collection, tokenId, name, description: meta.description, image, attributes });
        } catch (e) {
          if (!e.external) throw e;
          external = true;
          await Wallet.mintToken(collection, tokenId, meta, { listPriceSats: priceSats });
        }
        if (priceSats && !external) {
          /* Listing moves YOUR property, so it carries YOUR signature —
             silent for hosted keys, one Kondor popup. A mint that landed
             stays landed even if the listing then fails. */
          btn.innerHTML = '<span class="spin"></span> Listing…';
          try { await Wallet.listTokens(collection, [{ tokenId, priceSats }]); }
          catch (e) { toast(`Minted, but the listing failed: ${esc(e.message)} — you can list it from the item page.`, 'bad', 9000); }
        }
      } else {
        await Wallet.mintToken(collection, tokenId, meta, { listPriceSats: priceSats });
      }
      toast('Minted — waiting for the block…', 'good');
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const t = await api(`/collections/${collection}/token/${encodeURIComponent(tokenId)}`);
          if (t.owner) { toast('🎉 Minted', 'good', 6000); location.hash = `#/t/${collection}/${encodeURIComponent(tokenId)}`; return; }
        } catch (_) {}
      }
      toast('Still settling — check the collection in a moment.', '', 7000);
    } catch (e) {
      toast(esc(e.message), 'bad', 9000);
      btn.disabled = false; btn.textContent = fee > 0 ? `Mint for ${fee} KOIN` : 'Mint it';
    }
  };

  /* ---- the drop ---- */
  const bulk = $('#bulk-card');
  if (bulk) {
    let files = new Map();     // basename -> File
    let entries = [];          // parsed metadata
    const prev = $('#bk-preview');
    const go = $('#bk-go');

    const idPrefix = () => {
      const raw = ($('#bk-prefix').value.trim() || 'ITEM').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return (raw || 'ITEM').slice(0, 12);
    };
    const toHexId = (str) => '0x' + [...str].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');

    /* Matching is the whole game — and exact filenames are a desktop
       luxury. Android's picker hands the browser RENAMED files
       ("1000012345.png", "1 (1).png"), so match in widening circles:
       exact name, then name with a duplicate-suffix stripped, then — when
       nothing matches but the counts agree — pair the two lists in
       natural order and say so out loud. The tally always shows BEFORE
       anything is spent. */
    let matchedFiles = [];   // File per entry, in entry order
    let matchMode = 'name';
    const core = (n) => {
      const b = String(n).split('/').pop().toLowerCase();
      const noExt = b.replace(/\.[a-z0-9]+$/, '');
      return noExt.replace(/ \(\d+\)$/, '').replace(/^img[_-]?/, '');
    };
    const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });
    const refresh = () => {
      matchedFiles = [];
      matchMode = 'name';
      const names = [...files.keys()];
      const missing = [];
      for (const e of entries) {
        const want = String(e.image || '').split('/').pop().toLowerCase();
        let hit = files.get(want) || null;
        if (!hit) {
          const c = core(want);
          const near = names.find((n) => core(n) === c);
          if (near) hit = files.get(near);
        }
        matchedFiles.push(hit);
        if (!hit) missing.push(want || '(no image field)');
      }
      let matched = matchedFiles.filter(Boolean).length;
      if (entries.length && matched === 0 && files.size === entries.length) {
        // Names are a total loss but the counts agree: order carries it.
        const ordered = names.slice().sort(naturalSort).map((n) => files.get(n));
        matchedFiles = entries.map((_, i) => ordered[i]);
        matched = entries.length;
        matchMode = 'order';
        missing.length = 0;
      }
      const unused = files.size - new Set(matchedFiles.filter(Boolean)).size;
      const bits = [];
      if (entries.length) {
        bits.push(`<b>${matched}</b> of <b>${entries.length}</b> items matched to images${matchMode === 'order'
          ? ' — <b>paired in order</b>, since your device renamed the files. Check the first item lands on the right art.'
          : ''}`);
      } else bits.push('waiting for the metadata JSON');
      if (missing.length) bits.push(`<span style="color:var(--bad)">missing images: ${esc(missing.slice(0, 6).join(', '))}${missing.length > 6 ? '…' : ''}</span>`);
      if (unused > 0 && matched < entries.length) bits.push(`${unused} image(s) not named by the JSON are ignored`);
      prev.innerHTML = bits.join('<br>');
      go.disabled = !(entries.length && matched === entries.length);
      go.textContent = go.disabled ? 'Mint the drop' : `Mint ${entries.length} NFTs`;
    };

    const adoptJson = (text) => {
      try {
        let d = JSON.parse(text);
        if (d && Array.isArray(d.items)) d = d.items;
        if (!Array.isArray(d) || !d.length) throw new Error('expected a JSON array of items');
        entries = d.slice(0, 100);
        refresh();
      } catch (e) { entries = []; prev.innerHTML = `<span style="color:var(--bad)">Could not read that JSON: ${esc(e.message)}</span>`; go.disabled = true; }
    };

    $('#bk-files').onchange = () => {
      files = new Map([...$('#bk-files').files].map((f) => [f.name.toLowerCase(), f]));
      refresh();
    };
    $('#bk-json').onchange = async () => {
      const f = $('#bk-json').files && $('#bk-json').files[0];
      if (f) adoptJson(await f.text());
    };
    let pasteTimer;
    $('#bk-paste').oninput = () => {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => { if ($('#bk-paste').value.trim()) adoptJson($('#bk-paste').value); }, 300);
    };

    go.onclick = async () => {
      if (!Wallet.account) return connectModal();
      const collection = $('#bk-col').value;
      const prefix = $('#bk-prefix').value.trim() || 'Item';
      const pid = idPrefix();
      go.disabled = true;
      try {
        /* Art first — content-addressed, so a retry re-uploads nothing,
           and the same File object dedupes however it was matched. */
        const urls = new Map();
        let n = 0;
        /* Phones drop connections; one blip must not kill a whole drop.
           Three tries per file, and a failure names the file and its size
           instead of the browser's bare "Failed to fetch". */
        const uploadOne = async (f) => {
          for (let a = 1; ; a++) {
            try {
              const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': f.type || 'image/png' }, body: f });
              const d = await r.json();
              if (!r.ok || d.error) throw new Error(d.error || `upload failed (HTTP ${r.status})`);
              return d.path || d.url;
            } catch (e) {
              const reason = /failed to fetch/i.test(e.message) ? 'the connection dropped' : e.message;
              if (a >= 3) throw new Error(`${f.name} (${(f.size / 1048576).toFixed(1)}MB): ${reason}. Nothing was minted — tap the button to try again.`);
              go.innerHTML = `<span class="spin"></span> Retrying ${esc(f.name)} (try ${a + 1} of 3)…`;
              await new Promise((r2) => setTimeout(r2, 1500 * a));
            }
          }
        };
        for (const f of matchedFiles) {
          if (urls.has(f)) continue;
          go.innerHTML = `<span class="spin"></span> Uploading art ${++n} of ${new Set(matchedFiles).size}…`;
          urls.set(f, await uploadOne(f));
        }
        const items = entries.map((e, i) => ({
          tokenId: toHexId(`${pid}${String(i + 1).padStart(4, '0')}`),
          name: String(e.name || `${prefix} #${i + 1}`).slice(0, 80),
          description: String(e.description || ''),
          image: urls.get(matchedFiles[i]),
          attributes: Array.isArray(e.attributes) ? e.attributes : [],
        }));
        go.innerHTML = `<span class="spin"></span> Minting ${items.length} on chain…`;
        const r = await fetch('/api/mint-batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection, owner: Wallet.account.address, items }),
        });
        const d = await r.json();
        if (r.status === 207) {
          toast(`${esc(d.error)} — the ${d.minted.length} that minted are safe`, 'bad', 12000);
          location.hash = '#/c/' + collection;
          return;
        }
        if (!r.ok || d.error) throw new Error(d.error || 'Bulk mint failed');

        /* Straight onto the shopfront. The default price comes from the
           field; a "price" on a JSON item wins for that item. */
        const defKoin = parseFloat($('#bk-price').value);
        const toList = d.minted.map((m, i) => {
          const koin = Number(entries[i] && entries[i].price != null ? entries[i].price : defKoin);
          return koin > 0 ? { tokenId: m.tokenId, priceSats: BigInt(Math.round(koin * 1e8)).toString() } : null;
        }).filter(Boolean);
        if (toList.length) {
          go.innerHTML = `<span class="spin"></span> Listing ${toList.length} for sale…`;
          try {
            await Wallet.listTokens(collection, toList, {
              onProgress: (done, total) => { go.innerHTML = `<span class="spin"></span> Listed ${done} of ${total}…`; },
            });
            toast(`🎉 ${d.minted.length} minted, ${toList.length} listed for sale`, 'good', 8000);
          } catch (e) {
            toast(`Minted ${d.minted.length}, but listing failed: ${esc(e.message)} — list them from their item pages.`, 'bad', 10000);
          }
        } else {
          toast(`🎉 ${d.minted.length} NFTs minted`, 'good', 8000);
        }
        location.hash = '#/c/' + collection;
      } catch (e) {
        toast(esc(e.message), 'bad', 10000);
        go.disabled = false;
        refresh();
      }
    };
  }
}

async function meView() {
  if (!Wallet.account) { connectModal(); view.innerHTML = '<div class="empty">Connect a wallet to see your items.</div>'; return; }
  view.innerHTML = '<div class="loading"><span class="spin"></span> Reading your wallet…</div>';
  const me = Wallet.account.address;
  const [mine, bal] = await Promise.all([api('/owned?address=' + me), api('/balance?address=' + me)]);
  view.innerHTML = `
    <section class="hero" style="padding-bottom:6px">
      <h1 style="font-size:24px">Your items</h1>
      <p class="mono" style="word-break:break-all">${esc(me)}</p>
      <div class="hero-stats"><div class="hstat"><b>${KOIN(bal.koin)}</b><span>KOIN</span></div></div>
    </section>
    ${mine.collections.length ? mine.collections.map((c) => `
      <div class="section-head">${esc(c.collection.name || c.collection.address)}</div>
      <div class="grid">${c.tokens.map((t) => tokCard(c.collection.address, t)).join('')}</div>`).join('')
      : '<div class="empty">Nothing yet — everything you buy lands here, and Aurvania relics you mint show up too.</div>'}`;
}

/* ---------------- router / boot ---------------- */

async function route() {
  const h = location.hash || '#/';
  try {
    let m;
    if ((m = /^#\/c\/([1-9A-HJ-NP-Za-km-z]+)(?:\?(.*))?$/.exec(h))) return await collectionView(m[1], m[2] || '');
    if ((m = /^#\/t\/([1-9A-HJ-NP-Za-km-z]+)\/([^/?]+)$/.exec(h))) return await tokenView(m[1], decodeURIComponent(m[2]));
    if ((m = /^#\/list\/([1-9A-HJ-NP-Za-km-z]+)\/([^/?]+)$/.exec(h))) return await listView(m[1], decodeURIComponent(m[2]));
    if ((m = /^#\/create(?:\/(launch|add|mint))?$/.exec(h))) return await createView(m[1] || 'launch');
    if (h === '#/me') return await meView();
    return await homeView();
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message || 'Something went wrong')}</div>`;
  }
}

function paintHeader() {
  const a = Wallet.account;
  $('#btn-connect').textContent = a ? short(a.address) : 'Connect';
  $('#btn-me').classList.toggle('hidden', !a);
}

/* ipfs.io drops content that dweb.link still serves, and vice versa.
   When a piece of art dies on one gateway, retry it once on the other.
   Error events don't bubble, so this listens in capture. */
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const src = img.currentSrc || img.src || '';
  if (img.dataset.gwRetried) return;
  if (/^https:\/\/ipfs\.io\/ipfs\//.test(src)) {
    img.dataset.gwRetried = '1';
    img.src = src.replace('https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/');
  } else if (/^https:\/\/dweb\.link\/ipfs\//.test(src)) {
    img.dataset.gwRetried = '1';
    img.src = src.replace('https://dweb.link/ipfs/', 'https://ipfs.io/ipfs/');
  }
}, true);

(async () => {
  const cfg = await Wallet.init();
  $('#foot-market').textContent = cfg.market
    ? `${cfg.networkLabel || cfg.network} · market ${cfg.market}`
    : 'contract not deployed yet';
  paintHeader();
  Wallet.onChange(() => { paintHeader(); route(); });
  $('#btn-connect').onclick = () => (Wallet.account ? walletModal() : connectModal());
  $('#btn-me').onclick = () => { location.hash = '#/me'; };
  /* The phone-width popout. Any navigation closes it — including the
     Create link inside it, whose click is itself a hashchange. */
  const nav = $('#top-nav');
  const menuBtn = $('#btn-menu');
  const closeNav = () => { nav.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.onclick = () => {
    const open = nav.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  window.addEventListener('hashchange', closeNav);
  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target) && e.target !== menuBtn) closeNav();
  });
  window.addEventListener('hashchange', route);
  route();
})();
