#!/usr/bin/env node
/* The OURO frontend, driven in a real browser against live mainnet
   reads: home -> collection -> token, plus the connect modal. */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const SCRATCH = process.env.TEST_TMP || os.tmpdir();
/* Playwright is not a dependency of the marketplace itself — point
   PLAYWRIGHT_DIR at any install that has it (and CHROMIUM at a browser). */
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const crypto = require('crypto');
const { Signer } = require('koilib');
const PORT = 3979;
let srv, browser, fails = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail).slice(0, 160)}`);
  if (!ok) fails++;
};
process.on('exit', () => { try { browser && browser.close(); } catch (_) {} try { srv && srv.kill(); } catch (_) {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dataDir = path.join(SCRATCH, 'mk-ui-' + process.pid);
  fs.rmSync(dataDir, { recursive: true, force: true });
  srv = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    /* A throwaway payer with no KOIN: enough for the server to report
       launching as configured, never enough to actually spend. */
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, KOINOS_NETWORK: 'mainnet',
      MARKET_ADDR: '1BsZx4Hc69tWo1q9sXNP9ywvpBW2KdXwc8',
      KOINOS_DEV_WIF: new Signer({ privateKey: crypto.randomBytes(32).toString('hex') }).getPrivateKey('wif', true),
    }),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/config`); if (r.ok) break; } catch (_) {}
    await sleep(250);
  }

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  /* Resource-load failures are NOT script errors — and this sandbox's
     browser has no route to the public internet at all (proven earlier in
     the session: even a control load of the live site fails), so external
     images and the GSI script can never arrive here. pageerror stays
     strict; console noise about unreachable resources is expected. */
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text());
  });
  /* Probe egress the way an <img> experiences it — from the RENDERER.
     (page.request goes out through Node, which has the proxy; the
     renderer does not, and the renderer is what loads images.) */
  await page.goto('about:blank');
  const hasEgress = await page.evaluate(() => new Promise((resolve) => {
    const i = new Image();
    const t = setTimeout(() => resolve(false), 8000);
    i.onload = () => { clearTimeout(t); resolve(true); };
    i.onerror = () => { clearTimeout(t); resolve(false); };
    i.src = 'https://aurvania.com/assets/img/icon-192.png?probe=' + Math.random();
  }));

  const RELICS = '1E8hw3NiDPz9gcZ8BiWoTHzFz4H48dpFKq';
  const TOKEN = '0x4352534449544d30303031';   // Blood Blade +1, minted on mainnet

  // ---- home ----
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.col-card', { timeout: 30000 });
  const t1 = await page.evaluate(() => document.body.innerText);
  check('the home page renders the hero', /endless market/i.test(t1) || /OURO/.test(t1), t1.slice(0, 80));
  check('…with the relics collection from live mainnet', /Relic/i.test(t1), 'collection missing');
  check('…and the fee is stated', /(?:FREE|[0-9.]+%) platform fee|platform fee/.test(t1), 'fee not stated');
  await page.screenshot({ path: `${SCRATCH}/mk-1-home.png` });

  // ---- collection ----
  await page.click('.col-card');
  await page.waitForSelector('.tok-card', { timeout: 45000 });
  const t2 = await page.evaluate(() => document.body.innerText);
  check('the collection page reaches its tokens', (await page.$$('.tok-card')).length > 0, 'no token cards');
  check('…with real relic names from on-chain metadata', /Blade|Armor|Ring|Helm|Shield/i.test(t2), t2.slice(0, 200));
  const imgTags = await page.$$eval('.tok-art img', (els) => els.length);
  check('…and the cards carry image urls from the metadata', imgTags > 0, 'no <img> tags at all');
  if (hasEgress) {
    const imgs = await page.$$eval('.tok-art img', (els) => els.filter((i) => i.complete && i.naturalWidth > 0).length);
    check('…and the relic art actually loads (through the old-domain 301)', imgs > 0, `${imgs} images loaded`);
  } else {
    console.log('  ⚪ relic art load skipped — this sandbox browser has no internet egress');
  }
  await page.screenshot({ path: `${SCRATCH}/mk-2-collection.png` });

  // ---- token page ----
  await page.click('.tok-card');
  await page.waitForSelector('.deal', { timeout: 30000 });
  const t3 = await page.evaluate(() => document.body.innerText);
  check('the token page shows owner and deal box', /Owner/.test(t3), t3.slice(0, 120));
  /* Whether this token is for sale depends on the live order book, so
     assert the page AGREES WITH THE CHAIN rather than expecting one of
     the two states. */
  const shownId = await page.evaluate(() => decodeURIComponent(location.hash.split('/').pop()));
  const chainSays = await (await fetch(`http://127.0.0.1:${PORT}/api/collections/${RELICS}/token/${encodeURIComponent(shownId)}`)).json();
  const listedNow = !!(chainSays.order && !chainSays.order.dead);
  check(listedNow ? '…and a listed token shows its price and a way to buy' : '…and an unlisted token says so',
    listedNow ? /KOIN/.test(t3) && /(Buy now|your listing)/i.test(t3) : /Not listed/i.test(t3),
    `listed=${listedNow} :: ${t3.slice(0, 140)}`);
  await page.screenshot({ path: `${SCRATCH}/mk-3-token.png` });

  // ---- connect modal ----
  await page.click('#btn-connect');
  await page.waitForSelector('.modal', { timeout: 5000 });
  const t4 = await page.evaluate(() => document.querySelector('.modal').innerText);
  check('the connect modal offers Kondor', /Kondor/.test(t4), t4.slice(0, 100));
  check('…and Google', /Google/.test(t4), 'no google');
  check('…and email, promising the same wallet as the game', /same wallet/i.test(t4), 'promise missing');
  await page.screenshot({ path: `${SCRATCH}/mk-4-connect.png` });

  /* The Google control is ours to look at and Google's to click. Only
     Google's iframe may open the popup and it cannot be styled, so our
     button is the face and Google's lands invisibly on top — which is worth
     nothing unless it actually covers the face. GSI can never load in this
     sandbox, so stand in for it with an element the size Google renders and
     measure where a click would land. */
  const g = await page.evaluate(() => {
    const face = document.querySelector('.g-face');
    const kondor = document.querySelector('#w-kondor');
    const cs = (el) => { const s = getComputedStyle(el); return { h: Math.round(el.getBoundingClientRect().height), r: s.borderRadius, fs: s.fontSize, bg: s.backgroundColor, pe: s.pointerEvents }; };
    return { face: cs(face), kondor: cs(kondor), mark: !!face.querySelector('svg.g-mark'), text: face.innerText.trim() };
  });
  check('Google wears our button, not a stock Google widget',
    g.mark && /Sign in with Google/i.test(g.text), g.text);
  check('…sized and styled exactly like the Kondor button beside it',
    g.face.h === g.kondor.h && g.face.r === g.kondor.r && g.face.fs === g.kondor.fs && g.face.bg === g.kondor.bg,
    JSON.stringify(g));
  check('…and never eats the click itself', g.face.pe === 'none', g.face.pe);

  const cover = await page.evaluate(() => {
    const slot = document.querySelector('#w-google-slot');
    const wrap = document.querySelector('#w-google-wrap');
    const r = wrap.getBoundingClientRect();
    // Google renders an iframe of the asked-for width, ~44px tall.
    const fake = document.createElement('div');
    fake.style.cssText = `width:${Math.round(r.width)}px;height:44px`;
    slot.appendChild(fake);
    const at = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && slot.contains(el)); };
    return {
      centre: at(r.left + r.width / 2, r.top + r.height / 2),
      left: at(r.left + 6, r.top + r.height / 2),
      right: at(r.right - 6, r.top + r.height / 2),
      top: at(r.left + r.width / 2, r.top + 2),
      bottom: at(r.left + r.width / 2, r.bottom - 2),
      slotH: Math.round(slot.getBoundingClientRect().height),
      wrapH: Math.round(r.height),
    };
  });
  check('the invisible Google button covers our face, so the click reaches Google',
    cover.centre && cover.left && cover.right && cover.slotH === cover.wrapH, JSON.stringify(cover));
  check('…right to the top and bottom edges, not just the middle',
    cover.top && cover.bottom, JSON.stringify(cover));

  await page.keyboard.press('Escape');

  /* ---- the filter sidebar ---- */
  await page.goto(`http://127.0.0.1:${PORT}/#/c/${RELICS}`, { waitUntil: 'load' });
  await page.waitForSelector('.c-side .facet', { timeout: 30000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('#c-count')?.textContent || ''), { timeout: 30000 });

  const sidebar = await page.evaluate(() => {
    const traits = [...document.querySelectorAll('.c-side .facet-h')].map(e => e.textContent);
    const counts = [...document.querySelectorAll('.c-side .fopt em')].map(e => Number(e.textContent));
    return { traits, counts, total: document.querySelector('#c-count').textContent };
  });
  check('the collection page has a filter sidebar built from the metadata',
    sidebar.traits.includes('Status') && sidebar.traits.includes('Rarity'), JSON.stringify(sidebar.traits));
  check('…every trait value shows how many items carry it',
    sidebar.counts.length > 3 && sidebar.counts.every(n => n > 0), JSON.stringify(sidebar.counts.slice(0, 6)));

  // Everything, then narrowed to one rarity — the grid and count must follow.
  await page.click('.c-side .fopt input[value="all"]');
  await page.waitForFunction(() => !/^0 /.test(document.querySelector('#c-count').textContent), { timeout: 20000 });
  const before = await page.evaluate(() => ({
    count: document.querySelector('#c-count').textContent,
    cards: document.querySelectorAll('.tok-card').length,
  }));
  const rareCount = await page.evaluate(() => {
    const box = [...document.querySelectorAll('.c-side .facet')].find(f => f.querySelector('.facet-h')?.textContent === 'Rarity');
    const opt = [...box.querySelectorAll('.fopt')].find(o => /rare/i.test(o.querySelector('span').textContent));
    const n = Number(opt.querySelector('em').textContent);
    opt.querySelector('input').click();
    return n;
  });
  await page.waitForFunction((n) => document.querySelector('#c-count').textContent.startsWith(String(n)),
    rareCount, { timeout: 20000 });
  const after = await page.evaluate(() => ({
    count: document.querySelector('#c-count').textContent,
    cards: document.querySelectorAll('.tok-card').length,
    hash: location.hash,
  }));
  check('ticking a trait filters the whole collection, not just the loaded page',
    after.count.startsWith(String(rareCount)) && after.count !== before.count, `${before.count} -> ${after.count}`);
  check('…the grid actually repaints to the filtered set',
    after.cards > 0 && after.cards <= rareCount, `${after.cards} cards for ${rareCount} matches`);
  check('…and the filter lives in the URL, so the view can be shared',
    /t=Rarity/.test(decodeURIComponent(after.hash)), after.hash);
  await page.screenshot({ path: `${SCRATCH}/mk-5-filters.png`, fullPage: false });

  // A shared filtered URL must come back filtered.
  await page.goto(`http://127.0.0.1:${PORT}/#/c/${RELICS}?t=Rarity%3Arare`, { waitUntil: 'load' });
  await page.waitForFunction(() => /\d/.test(document.querySelector('#c-count')?.textContent || ''), { timeout: 30000 });
  const reloaded = await page.evaluate(() => ({
    count: document.querySelector('#c-count').textContent,
    checked: !!document.querySelector('.c-side input[type=checkbox]:checked'),
  }));
  check('a shared filter URL reopens filtered, with the box still ticked',
    reloaded.count.startsWith(String(rareCount)) && reloaded.checked, JSON.stringify(reloaded));

  /* ---- your unlisted items can be listed in one go ---- */
  // The bar wants a wallet owning unlisted items here; own that answer
  // instead of depending on live chain ownership.
  const ownerQuery = (url) => url.pathname === `/api/collections/${RELICS}/tokens` && url.searchParams.has('owner');
  await page.route(ownerQuery, (r) => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      tokens: [
        { tokenId: '0x4141', label: 'AA', name: 'Relic AA', image: null, order: null },
        { tokenId: '0x4242', label: 'BB', name: 'Relic BB', image: null, order: null },
        { tokenId: '0x4343', label: 'CC', name: 'Relic CC', image: null, order: null },
      ],
      matched: 3, indexed: 82, partial: false, nextOffset: null,
    }),
  }));
  await page.evaluate((addr) => {
    Object.defineProperty(Wallet, 'account', { get: () => ({ kind: 'hosted', address: addr }), configurable: true });
  }, '1NBe6YWf2JAqy5Eh2rQjb6jCRiwe47vyU');
  await page.evaluate(() => route());
  await page.waitForSelector('#c-bulklist', { timeout: 30000 });
  const bulkBar = await page.evaluate(() => ({
    text: document.querySelector('#c-bulklist').innerText,
    hasPrice: !!document.querySelector('#bl-price'),
    button: document.querySelector('#bl-go').textContent,
  }));
  check('owning unlisted items in a collection offers to list them all at once',
    /3/.test(bulkBar.text) && bulkBar.hasPrice, JSON.stringify(bulkBar));
  check('…and the button says how many it will list', /List all 3/.test(bulkBar.button), bulkBar.button);
  await page.click('#bl-go');
  await page.waitForFunction(() => /Set a price/.test(document.querySelector('#toasts')?.innerText || ''), { timeout: 10000 });
  check('…but refuses to list at no price rather than listing at zero', true, '');
  await page.unroute(ownerQuery);
  // Hash-only navigations share one document, so a toast outlives its page —
  // sweep it up before a later test reads the container.
  await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; delete Wallet.account; });

  /* ---- the item page hands listing to its own page ---- */
  const owned = await (await fetch(`http://127.0.0.1:${PORT}/api/collections/${RELICS}/token/${TOKEN}`)).json();
  await page.goto(`http://127.0.0.1:${PORT}/#/t/${RELICS}/${TOKEN}`, { waitUntil: 'load' });
  await page.waitForSelector('.t-info h2', { timeout: 20000 });
  await page.waitForSelector('#t-history .hist', { timeout: 20000 });
  const hist = await page.evaluate(() => document.querySelector('#t-history').innerText);
  check('the item page carries a history section', /History/i.test(hist), hist.slice(0, 80));
  check('…which says so plainly when the item has never been to market',
    /never been to market|No listings/i.test(hist), hist.slice(0, 120));

  /* Pretend to be the holder — the real one, from chain — so the owner's
     path can be driven without a funded wallet in the sandbox. */
  await page.evaluate((addr) => {
    Object.defineProperty(Wallet, 'account', { get: () => ({ kind: 'hosted', address: addr }), configurable: true });
  }, owned.owner);
  await page.evaluate(() => route());
  await page.waitForSelector('.deal a[href^="#/list/"]', { timeout: 20000 });
  const listCta = await page.evaluate(() => {
    const a = document.querySelector('.deal a[href^="#/list/"]');
    return { text: a.textContent.trim(), href: a.getAttribute('href'), priceInputs: document.querySelectorAll('.deal input').length };
  });
  check('the owner gets a single "List Item" button, not a price form',
    /List Item/i.test(listCta.text) && listCta.priceInputs === 0, JSON.stringify(listCta));
  const ctaBox = await page.evaluate(() => {
    const a = document.querySelector('.deal a[href^="#/list/"]');
    const r = a.getBoundingClientRect();
    return { h: Math.round(r.height), display: getComputedStyle(a).display };
  });
  check('…and it renders as a real button, not a bare link',
    ctaBox.h >= 40 && /flex/.test(ctaBox.display), JSON.stringify(ctaBox));
  await page.screenshot({ path: `${SCRATCH}/mk-7-owner.png` });

  /* ---- the listing page ---- */
  await page.goto(`http://127.0.0.1:${PORT}/#/list/${RELICS}/${TOKEN}`, { waitUntil: 'load' });
  await page.evaluate((addr) => {
    Object.defineProperty(Wallet, 'account', { get: () => ({ kind: 'hosted', address: addr }), configurable: true });
  }, owned.owner);
  await page.evaluate(() => route());
  await page.waitForSelector('#l-price', { timeout: 20000 });
  const listPage = await page.evaluate(() => ({
    art: !!document.querySelector('.list-item .t-art img'),
    name: document.querySelector('.list-item h2')?.textContent,
    attrs: document.querySelectorAll('.list-item .attr').length,
    disabled: document.querySelector('#l-go').disabled,
  }));
  check('the listing page shows the item art, name and details',
    listPage.art && !!listPage.name && listPage.attrs > 0, JSON.stringify(listPage));
  check('…and will not list until a price is entered', listPage.disabled === true, String(listPage.disabled));

  await page.fill('#l-price', '200');
  await page.waitForFunction(() => /200/.test(document.querySelector('#l-break').innerText), { timeout: 10000 });
  const breakdown = await page.evaluate(() => ({
    text: document.querySelector('#l-break').innerText,
    total: document.querySelector('.brow.total b').textContent,
    disabled: document.querySelector('#l-go').disabled,
  }));
  check('…the breakdown names the platform fee', /Platform fee/i.test(breakdown.text), breakdown.text);
  // Follow the deployed fee, including zero; this test may run before or after rollout.
  const feeConfig = await page.evaluate(() => fetch('/api/config').then(r => r.json()));
  const expectedNet = 200 - (200 * (feeConfig.feeBps ?? 0) / 10000);
  check('…and the final received amount is the price minus every cut',
    feeConfig.feeBps != null && Number(breakdown.total.replace(/[^0-9.]/g, '')) === expectedNet, `${breakdown.text} | total=${breakdown.total}`);
  check('…with the List button live once a price is set', breakdown.disabled === false, String(breakdown.disabled));
  await page.screenshot({ path: `${SCRATCH}/mk-6-list.png` });

  /* ---- the header chip is gone ---- */
  const chip = await page.evaluate(() => ({
    net: !!document.querySelector('#net-chip'),
    header: document.querySelector('.top-actions').innerText.trim(),
  }));
  check('the network chip beside "My items" is gone', !chip.net && !/Koinos/.test(chip.header), JSON.stringify(chip));


  /* ---- create: add, launch, mint ---- */
  await page.goto(`http://127.0.0.1:${PORT}/#/create/add`, { waitUntil: 'load' });
  await page.waitForSelector('#ad-go', { timeout: 20000 });
  const addForm = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs .tab')].map(t => t.textContent.trim()),
    hasAddr: !!document.querySelector('#ad-addr'),
    hasUpload: !!document.querySelector('#ad-img-file'),
    hasLink: !!document.querySelector('#ad-img-url'),
  }));
  check('Create offers all three doors',
    addForm.tabs.length === 3 && /Launch/.test(addForm.tabs[0]) && /existing/i.test(addForm.tabs[1]) && /Mint/.test(addForm.tabs[2]),
    JSON.stringify(addForm.tabs));
  check('…adding an existing collection asks only for its address',
    addForm.hasAddr, JSON.stringify(addForm));
  check('…and artwork can be uploaded OR linked', addForm.hasUpload && addForm.hasLink, JSON.stringify(addForm));

  // A junk address must be refused by the chain check, not accepted blindly.
  await page.fill('#ad-addr', '1NotARealCollectionAddress11111111');
  await page.click('#ad-go');
  await page.waitForFunction(() => /toast/.test(document.querySelector('#toasts')?.innerHTML || ''), { timeout: 25000 });
  const addErr = await page.evaluate(() => document.querySelector('#toasts').innerText);
  check('…and an address that is not a collection is refused',
    /not answer|required|Koinos address/i.test(addErr), addErr.slice(0, 120));

  await page.goto(`http://127.0.0.1:${PORT}/#/create/launch`, { waitUntil: 'load' });
  await page.waitForSelector('#lc-go', { timeout: 20000 });
  const launch = await page.evaluate(() => ({
    fee: document.querySelector('#lc-go').textContent.trim(),
    breakdown: document.querySelector('#lc-break').innerText,
    royalty: document.querySelector('#lc-roy').value,
  }));
  check('launching states the fee up front', /100 KOIN/.test(launch.fee), launch.fee);
  check('…and breaks down fee, mana and royalty before you commit',
    /Launch fee/i.test(launch.breakdown) && /on us/i.test(launch.breakdown) && /royalty/i.test(launch.breakdown),
    launch.breakdown.replace(/\n/g, ' | ').slice(0, 160));

  await page.fill('#lc-name', 'Moonlit Wanderers');
  await page.fill('#lc-sym', 'not a symbol!');
  await page.click('#lc-go');
  await page.waitForFunction(() => /Symbol/.test(document.querySelector('#toasts')?.innerText || ''), { timeout: 15000 });
  check('…a bad symbol is caught before any mana is spent',
    /Symbol must be/.test(await page.evaluate(() => document.querySelector('#toasts').innerText)), 'no symbol warning');
  await page.screenshot({ path: `${SCRATCH}/mk-8-launch.png` });

  await page.goto(`http://127.0.0.1:${PORT}/#/create/mint`, { waitUntil: 'load' });
  // Let the wallet-less render finish first: stubbing mid-flight leaves two
  // renders racing, and the loser repaints over the winner.
  await page.waitForSelector('#cr-body .empty, #cr-body .form-card', { timeout: 25000 });
  await page.evaluate((addr) => {
    Object.defineProperty(Wallet, 'account', { get: () => ({ kind: 'hosted', address: addr }), configurable: true });
  }, '1JtWgDM3tN2zEFUmhMvSJF43dCGRNsJ83m');
  await page.evaluate(() => route());
  await page.waitForSelector('#mt-go', { timeout: 30000 });
  const mint = await page.evaluate(() => {
    document.querySelector('#mt-addtrait').click();
    return {
      fields: ['#mt-col', '#mt-name', '#mt-id', '#mt-desc', '#mt-img-file', '#mt-img-url'].filter(s => !!document.querySelector(s)).length,
      traitRows: document.querySelectorAll('.trait-row').length,
    };
  });
  check('minting asks for a collection, name, id, description and artwork', mint.fields === 6, JSON.stringify(mint));
  check('…and traits can be added as key/value pairs', mint.traitRows === 1, JSON.stringify(mint));

  /* ---- bulk mint: matched by filename, tallied before anything is spent ---- */
  check('minting offers an optional list-for-sale price in KOIN',
    await page.evaluate(() => !!document.querySelector('#mt-price')), 'no price field on single mint');
  check('a bulk drop card is offered while minting is free',
    await page.evaluate(() => !!document.querySelector('#bulk-card')), 'no bulk card');
  check('…and the bulk card offers a per-drop price with JSON override',
    await page.evaluate(() => !!document.querySelector('#bk-price')), 'no bulk price field');
  await page.evaluate(() => {
    document.querySelector('#bk-paste').value = JSON.stringify([
      { image: '1.png', attributes: [{ trait_type: 'Rarity', value: 'Common' }] },
      { image: '2.png', attributes: [] },
    ]);
    document.querySelector('#bk-paste').dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => /missing images/.test(document.querySelector('#bk-preview')?.innerText || ''), { timeout: 10000 });
  check('…JSON without its images names the missing files and stays disarmed',
    await page.evaluate(() => document.querySelector('#bk-go').disabled), 'button enabled with missing art');

  {
    // Hand it the files and the tally must flip to ready. (Nothing gets
    // clicked, so the bytes only need a NAME — matching is by filename.)
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await page.setInputFiles('#bk-files', [
      { name: '1.png', mimeType: 'image/png', buffer: png },
      { name: '2.png', mimeType: 'image/png', buffer: png },
    ]);
    await page.waitForFunction(() => /2<\/b> of <b>2/.test(document.querySelector('#bk-preview')?.innerHTML || ''), { timeout: 10000 });
    const ready = await page.evaluate(() => ({ disabled: document.querySelector('#bk-go').disabled, label: document.querySelector('#bk-go').textContent.trim() }));
    check('…and with every image matched the button arms itself with the count',
      ready.disabled === false && /Mint 2 NFTs/.test(ready.label), JSON.stringify(ready));

    /* Android's picker renames files ("1000012345.png"), which is exactly
       how a real drop showed "0 of 10 matched" on a phone while the same
       files matched on desktop. When names are useless but counts agree,
       order carries it — loudly. */
    await page.setInputFiles('#bk-files', [
      { name: '1000012345.png', mimeType: 'image/png', buffer: png },
      { name: '1000012346.png', mimeType: 'image/png', buffer: png },
    ]);
    await page.waitForFunction(() => /paired in order/.test(document.querySelector('#bk-preview')?.innerText || ''), { timeout: 10000 });
    const renamed = await page.evaluate(() => ({ disabled: document.querySelector('#bk-go').disabled, text: document.querySelector('#bk-preview').innerText }));
    check('…files renamed by a phone still match, paired in order and saying so',
      renamed.disabled === false && /2 of 2/.test(renamed.text), JSON.stringify(renamed).slice(0, 160));
  }

  /* ---- the header on a phone ---- */
  {
    const phone = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await phone.goto(`http://127.0.0.1:${PORT}/#/`, { waitUntil: 'load' });
    await phone.waitForSelector('.col-card', { timeout: 30000 });
    await phone.evaluate((addr) => {
      Object.defineProperty(Wallet, 'account', { get: () => ({ kind: 'hosted', address: addr }), configurable: true });
      paintHeader();
    }, '1JtWgDM3tN2zEFUmhMvSJF43dCGRNsJ83m');
    const m = await phone.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      toggleShown: getComputedStyle(document.querySelector('#btn-menu')).display !== 'none',
      navHidden: getComputedStyle(document.querySelector('#top-nav')).display === 'none',
    }));
    check('signed in on a phone, the page no longer pans sideways', m.overflow <= 0, `overflow ${m.overflow}px`);
    check('…because the nav folds into a menu button', m.toggleShown && m.navHidden, JSON.stringify(m));
    await phone.click('#btn-menu');
    const open = await phone.evaluate(() => {
      const nav = document.querySelector('#top-nav');
      const r = nav.getBoundingClientRect();
      return { shown: getComputedStyle(nav).display !== 'none', onScreen: r.right <= window.innerWidth && r.left >= 0, items: nav.querySelectorAll('.btn:not(.hidden)').length };
    });
    check('…which opens a popout holding Create and My items, fully on screen',
      open.shown && open.onScreen && open.items === 2, JSON.stringify(open));
    await phone.screenshot({ path: `${SCRATCH}/mk-10-phone.png` });
    await phone.close();
  }
  await page.screenshot({ path: `${SCRATCH}/mk-9-mint.png` });

  check('no script errors anywhere', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
