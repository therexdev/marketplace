'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { GifWriter, GifReader } = require('omggif');
const { gifPreview, MAX_PREVIEW_BYTES, MAX_PREVIEW_FRAMES, PREVIEW_WIDTH } = require('../lib/gif-preview');
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

test('large animated originals load unchanged while grids and covers receive small animations', async () => {
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
    const responses = await Promise.all([fetch(app.base + url + '?w=480&v=3'), fetch(app.base + url)]);
    const [preview, original] = responses;
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/gif');
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    assert.ok(previewBytes.length < 100000);
    const animation = new GifReader(previewBytes);
    assert.equal(animation.numFrames(), 2);
    assert.equal(animation.loopCount(), 0);
    assert.ok(animation.width <= PREVIEW_WIDTH && animation.height <= PREVIEW_WIDTH);
    for (const [i, color] of [[0, [255, 0, 0, 255]], [1, [0, 0, 255, 255]]]) {
      const pixels = Buffer.alloc(animation.width * animation.height * 4);
      animation.decodeAndBlitFrameRGBA(i, pixels);
      assert.deepEqual([...pixels.subarray(0, 4)], color, 'preview frames retain motion');
      assert.equal(animation.frameInfo(i).delay, 10);
    }
    assert.equal(original.status, 200);
    assert.equal(original.headers.get('content-type'), 'image/gif');
    const originalBytes = Buffer.from(await original.arrayBuffer());
    assert.deepEqual(originalBytes, gif);
    assert.equal(new GifReader(originalBytes).numFrames(), 2, 'animation is preserved');
    const cover = await fetch(app.base + `/img/c/${PAINT}?w=480&v=3`);
    assert.equal(cover.status, 200);
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), previewBytes);
    assert.equal(reads, 1, 'grid, detail and cover share one cached original');
    assert.deepEqual(fs.readdirSync(path.join(app.dataDir, 'imgcache')).filter(x => x.endsWith('.part')), []);
  } finally { await app.close(); }
});

test('GIF previews replace old still caches, are reused, and are invalidated when art changes', async () => {
  const app = await harness();
  try {
    const source = 'https://art.example.test/cached.gif';
    const gif = animatedGif(128 * 1024);
    const key = app.pinArt(source, gif, 'image/gif');
    const file = path.join(app.dataDir, 'imgcache', key);
    fs.writeFileSync(file + '.w480', 'old still');
    fs.writeFileSync(file + '.w480.json', JSON.stringify({ type: 'image/jpeg' }));
    const first = await app.thumbOf(file, 'image/gif');
    assert.equal(first.type, 'image/gif');
    assert.notEqual(first.file, file + '.w480');
    assert.equal(new GifReader(fs.readFileSync(first.file)).numFrames(), 2);
    const modified = fs.statSync(first.file).mtimeMs;
    const cached = await app.thumbOf(file, 'image/gif');
    assert.equal(cached.file, first.file);
    assert.equal(fs.statSync(cached.file).mtimeMs, modified, 'cached animation is reused');
    app.pinArt(source, gif, 'image/gif');
    assert.equal(fs.existsSync(first.file), false);
    assert.equal(fs.existsSync(first.file + '.json'), false);
    assert.equal(fs.existsSync(file + '.w480'), false);
  } finally { await app.close(); }
});

test('GIF previews compose partial frames, transparency and restore/background disposal', () => {
  const bytes = Buffer.alloc(10000);
  const writer = new GifWriter(bytes, 3, 1, { palette: [0, 0xff0000, 0x00ff00, 0x0000ff], loop: 3 });
  writer.addFrame(0, 0, 3, 1, Buffer.from([1, 1, 1]), { delay: 10, disposal: 1 });
  writer.addFrame(1, 0, 1, 1, Buffer.from([2]), { delay: 50, disposal: 3 });
  writer.addFrame(2, 0, 1, 1, Buffer.from([3]), { delay: 20, disposal: 2 });
  writer.addFrame(0, 0, 1, 1, Buffer.from([2]), { delay: 40, disposal: 1 });
  const preview = new GifReader(gifPreview(bytes.subarray(0, writer.end())));
  assert.equal(preview.numFrames(), 4);
  assert.equal(preview.loopCount(), 3);
  const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], clear = [0, 0, 0, 0];
  const expected = [[red, red, red], [red, green, red], [red, red, blue], [green, red, clear]];
  for (let i = 0; i < expected.length; i++) {
    const pixels = Buffer.alloc(12);
    preview.decodeAndBlitFrameRGBA(i, pixels);
    assert.deepEqual([...pixels], expected[i].flat());
    assert.equal(preview.frameInfo(i).delay, [10, 50, 20, 40][i]);
  }
});

test('GIF preview sampling preserves loop duration and bounds dimensions, frames and bytes', () => {
  const bytes = Buffer.alloc(8 * 1048576);
  const palette = Array.from({ length: 256 }, (_, i) => (i << 16) | (i << 8) | i);
  const writer = new GifWriter(bytes, 256, 256, { palette, loop: 0 });
  let seed = 7;
  const pixels = Buffer.alloc(256 * 256);
  for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
  for (let i = 0; i < 90; i++) writer.addFrame(0, 0, 256, 256, pixels, { delay: 20 });
  const output = gifPreview(bytes.subarray(0, writer.end()));
  assert.ok(output.length <= MAX_PREVIEW_BYTES);
  const preview = new GifReader(output);
  assert.ok(preview.width < PREVIEW_WIDTH, 'high-detail previews reduce resolution to meet byte budget');
  assert.equal(preview.numFrames(), MAX_PREVIEW_FRAMES);
  assert.equal(Array.from({ length: preview.numFrames() }, (_, i) => preview.frameInfo(i).delay).reduce((a, b) => a + b, 0), 1800);
  assert.equal(preview.loopCount(), 0);
});

test('a long opening hold does not erase the animation from a preview', () => {
  const bytes = Buffer.alloc(10000);
  const writer = new GifWriter(bytes, 1, 1, { palette: [0xff0000, 0x0000ff] });
  for (let i = 0; i < 100; i++) writer.addFrame(0, 0, 1, 1, Buffer.from([i === 99 ? 1 : 0]), { delay: i === 0 ? 50000 : 2 });
  const preview = new GifReader(gifPreview(bytes.subarray(0, writer.end())));
  assert.equal(preview.numFrames(), 2);
  assert.equal(preview.loopCount(), null);
  assert.equal(preview.frameInfo(0).delay + preview.frameInfo(1).delay, 50198);
  const pixels = Buffer.alloc(4);
  preview.decodeAndBlitFrameRGBA(1, pixels);
  assert.deepEqual([...pixels], [0, 0, 255, 255]);
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
    constructor() { this.dataset = {}; this.src = 'https://ouro.lifestyle/img/t/example/0x31?w=480&v=3'; this.isConnected = true; }
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
