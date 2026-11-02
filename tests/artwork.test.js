'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { GifWriter, GifReader } = require('omggif');
const { Jimp } = require('jimp');
const { downloadImage } = require('../lib/artwork-download');
const { harness, PAINT, TOKEN } = require('./fixtures/server-harness');

function animatedGif(minBytes = 0) {
  const buffer = Buffer.alloc(10000);
  const writer = new GifWriter(buffer, 8, 8, { palette: [0xff0000, 0x0000ff], loop: 0 });
  writer.addFrame(0, 0, 8, 8, Buffer.alloc(64, 0), { delay: 10 });
  writer.addFrame(0, 0, 8, 8, Buffer.alloc(64, 1), { delay: 10 });
  const gif = buffer.subarray(0, writer.end());
  // Valid GIF comment blocks make a deterministic original larger than the
  // former 12 MiB cap without storing a large binary fixture in git.
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 255]), Buffer.alloc(255, 65), Buffer.from([0])]);
  return Buffer.concat([gif.subarray(0, -1), ...Array(Math.ceil(minBytes / comment.length)).fill(comment), gif.subarray(-1)]);
}

test('large animated originals load unchanged while grids and covers receive small stills', async () => {
  const gif = animatedGif(13 * 1048576);
  let reads = 0;
  const source = 'https://art.example.test/animation.gif';
  const app = await harness({
    chain: (id, method) => method === 'metadata_of' && id === PAINT
      ? { result: { value: JSON.stringify({ name: 'Animated art', image: source }) } } : undefined,
    fetch: async url => {
      assert.equal(url, source);
      reads++;
      return new Response(new ReadableStream({
        start(controller) {
          for (let at = 0; at < gif.length; at += 65536) controller.enqueue(gif.subarray(at, at + 65536));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'image/gif', 'Content-Length': String(gif.length) } });
    },
  });
  try {
    await app.rebuildIndex(PAINT);
    const url = `/img/t/${PAINT}/${TOKEN}`;
    const responses = await Promise.all([fetch(app.base + url + '?w=480&v=2'), fetch(app.base + url)]);
    const [preview, original] = responses;
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/jpeg');
    const stillBytes = Buffer.from(await preview.arrayBuffer());
    assert.ok(stillBytes.length < 100000);
    const still = await Jimp.read(stillBytes);
    assert.ok(still.width <= 480 && still.height <= 480);
    assert.ok(still.bitmap.data[0] > 240 && still.bitmap.data[2] < 20, 'preview is the red first frame');
    assert.equal(original.status, 200);
    assert.equal(original.headers.get('content-type'), 'image/gif');
    const originalBytes = Buffer.from(await original.arrayBuffer());
    assert.deepEqual(originalBytes, gif);
    assert.equal(new GifReader(originalBytes).numFrames(), 2, 'animation is preserved');
    const cover = await fetch(app.base + `/img/c/${PAINT}?w=480&v=2`);
    assert.equal(cover.status, 200);
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), stillBytes);
    assert.equal(reads, 1, 'grid, detail and cover share one cached original');
    assert.deepEqual(fs.readdirSync(path.join(app.dataDir, 'imgcache')).filter(x => x.endsWith('.part')), []);
  } finally { await app.close(); }
});

test('failed large GIF previews do not fall back to downloading the animation in the grid', async () => {
  const gif = animatedGif(128 * 1024);
  gif.writeUInt16LE(65535, 6);
  gif.writeUInt16LE(65535, 8); // reject excessive dimensions before allocating pixels
  const app = await harness({ chain: (id, method) => method === 'metadata_of' && id === PAINT
    ? { result: { value: JSON.stringify({ image: 'https://art.example.test/huge.gif' }) } } : undefined,
    fetch: async () => new Response(gif, { headers: { 'Content-Type': 'image/gif' } }),
  });
  try {
    await app.rebuildIndex(PAINT);
    const response = await fetch(app.base + `/img/t/${PAINT}/${TOKEN}?w=480`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), '15');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  } finally { await app.close(); }
});

test('disk downloads reject announced and streamed oversize files and remove partial files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ouro-download-'));
  const file = path.join(dir, 'art');
  try {
    for (const declared of [true, false]) {
      const got = await downloadImage(['large'], file, { maxBytes: 128, fetch: async () => new Response(Buffer.alloc(129), {
        headers: { 'Content-Type': 'image/gif', ...(declared ? { 'Content-Length': '129' } : {}) },
      }) });
      assert.equal(got, null);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('gateway racing cancels the stalled body, cleans losers, and atomically keeps the winner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ouro-race-'));
  const file = path.join(dir, 'art');
  const gif = animatedGif();
  let aborted = false;
  try {
    const got = await downloadImage(['bad', 'slow', 'good'], file, { timeoutMs: 1000, fetch: async (url, { signal }) => {
      if (url === 'bad') return new Response('missing', { status: 404 });
      if (url === 'good') {
        await new Promise(r => setTimeout(r, 20));
        return new Response(gif, { headers: { 'Content-Type': 'image/gif' } });
      }
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(gif.subarray(0, 20));
        signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('cancelled')); });
      } }), { headers: { 'Content-Type': 'image/gif' } });
    } });
    assert.equal(got.type, 'image/gif');
    assert.equal(aborted, true);
    assert.deepEqual(fs.readFileSync(file), gif);
    assert.deepEqual(fs.readdirSync(dir), ['art']);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a timed-out artwork stream leaves no incomplete cache entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ouro-timeout-'));
  try {
    const got = await downloadImage(['slow'], path.join(dir, 'art'), { timeoutMs: 20, fetch: async (_, { signal }) =>
      new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from('GIF89a'));
        signal.addEventListener('abort', () => controller.error(new Error('timeout')));
      } }), { headers: { 'Content-Type': 'image/gif' } }),
    });
    assert.equal(got, null);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('cache sweeping removes abandoned downloads and preserves active ones', async () => {
  const app = await harness();
  try {
    const dir = path.join(app.dataDir, 'imgcache');
    const stale = path.join(dir, `${'a'.repeat(64)}.${'b'.repeat(16)}.part`);
    const active = path.join(dir, `${'c'.repeat(64)}.${'d'.repeat(16)}.part`);
    fs.writeFileSync(stale, 'interrupted');
    fs.writeFileSync(active, 'downloading');
    const old = new Date(Date.now() - 7200000);
    fs.utimesSync(stale, old, old);
    app.sweepImgCache();
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(active), true);
  } finally { await app.close(); }
});

test('artwork retries are bounded, stop on detach, and restore a successfully loaded card', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const code = source.slice(source.indexOf('const ART_RETRY_DELAYS'), source.indexOf('/* Google One Tap'));
  const events = {}, timers = new Map();
  let nextTimer = 0;
  class Image {
    constructor() { this.dataset = {}; this.src = 'https://ouro.lifestyle/img/t/example/0x31?w=480&v=2'; this.isConnected = true; }
    closest() { return true; }
  }
  const img = new Image();
  let placeholder;
  img.parentElement = { querySelector: () => placeholder, append: el => { placeholder = el; } };
  vm.runInNewContext(code, {
    HTMLImageElement: Image, URL, Date,
    document: { addEventListener: (event, fn) => { events[event] = fn; }, createElement: () => ({ remove: () => { placeholder = null; } }) },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id),
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    events.error({ target: img });
    assert.equal(placeholder.textContent, 'Loading artwork…');
    const timer = timers.get(img.artRetryTimer);
    timers.delete(img.artRetryTimer);
    timer();
    assert.equal(new URL(img.src).searchParams.get('w'), '480');
  }
  events.error({ target: img });
  assert.equal(placeholder.textContent, 'Artwork unavailable');
  assert.equal(timers.size, 0);
  events.load({ target: img });
  assert.equal(img.hidden, false);
  assert.equal(placeholder, null);
  events.error({ target: img });
  const before = img.src;
  img.isConnected = false;
  timers.get(img.artRetryTimer)();
  assert.equal(img.src, before);
  events.load({ target: img });
  assert.equal(timers.size, 0);
});
