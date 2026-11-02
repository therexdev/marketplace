'use strict';
const { GifReader, GifWriter } = require('omggif');

const MAX_PREVIEW_BYTES = 2 * 1048576;
const MAX_PREVIEW_FRAMES = 80;
const PREVIEW_WIDTH = 240;

function resizeRgba(data, width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * 4);
  // Nearest-neighbor sampling retains the source GIF's palette, avoiding a
  // costly full-color quantization pass for every frame of every card.
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / w));
      out.writeUInt32LE(data.readUInt32LE((sy * width + sx) * 4), (y * w + x) * 4);
    }
  }
  return { data: out, width: w, height: h };
}

function indexedFrame(data) {
  const colors = new Map();
  let transparent = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) { transparent = true; continue; }
    const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    colors.set(rgb, (colors.get(rgb) || 0) + 1);
  }
  // Compositing partial frames can combine several local palettes. Keep
  // common colors exactly and map only the remaining colors to their nearest.
  const palette = [...colors].sort((a, b) => b[1] - a[1]).slice(0, transparent ? 255 : 256).map(([rgb]) => rgb);
  if (transparent) palette.unshift(0);
  const firstColor = transparent ? 1 : 0;
  const indices = new Map(palette.slice(firstColor).map((rgb, i) => [rgb, i + firstColor]));
  for (const rgb of colors.keys()) {
    if (indices.has(rgb)) continue;
    let nearest = firstColor, distance = Infinity;
    for (let i = firstColor; i < palette.length; i++) {
      const color = palette[i];
      const dr = (rgb >> 16) - (color >> 16), dg = ((rgb >> 8) & 255) - ((color >> 8) & 255), db = (rgb & 255) - (color & 255);
      const d = dr * dr + dg * dg + db * db;
      if (d < distance) { distance = d; nearest = i; }
    }
    indices.set(rgb, nearest);
  }
  const pixels = Buffer.alloc(data.length / 4);
  for (let i = 0; i < pixels.length; i++) {
    const p = i * 4;
    if (data[p + 3] >= 128) pixels[i] = indices.get((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]);
  }
  let size = 2;
  while (size < palette.length) size *= 2;
  while (palette.length < size) palette.push(0);
  return { palette, pixels, transparent: transparent ? 0 : undefined };
}

function gifPreview(bytes, edge = PREVIEW_WIDTH) {
  const reader = new GifReader(bytes);
  const pixels = reader.width * reader.height;
  const frameCount = reader.numFrames();
  if (!pixels || pixels > 16 * 1024 * 1024 || !frameCount || frameCount > 5000) throw new Error('GIF exceeds preview limits');
  const info = [];
  let duration = 0, work = 0;
  for (let i = 0; i < frameCount; i++) {
    const frame = reader.frameInfo(i);
    if (!frame.width || !frame.height || frame.x + frame.width > reader.width || frame.y + frame.height > reader.height) throw new Error('Invalid GIF frame bounds');
    work += frame.width * frame.height + (frame.disposal === 3 ? pixels : 0);
    duration += Math.max(2, frame.delay); // browser-compatible minimum, in centiseconds
    info.push({ ...frame, end: duration });
  }
  if (work > 256 * 1024 * 1024 || duration > 60000) throw new Error('GIF exceeds preview work limit');

  // Sample at approximately six frames/second, at most 80 frames. Reassign
  // skipped-frame time so the preview still completes the original full loop.
  const count = Math.min(frameCount, MAX_PREVIEW_FRAMES, Math.max(2, Math.ceil(duration / 17)));
  const selected = new Map();
  let index = 0;
  if (count === frameCount) {
    // Slow animations need no sampling; keep even a short final frame.
    info.forEach((frame, i) => selected.set(i, frame.end - (info[i - 1]?.end || 0)));
  } else {
    for (let sample = 0; sample < count; sample++) {
      const at = Math.floor(sample * duration / count);
      while (info[index].end <= at) index++;
      const delay = Math.floor((sample + 1) * duration / count) - at;
      selected.set(index, (selected.get(index) || 0) + delay);
    }
    // A long opening hold must not turn an animation into a still.
    if (selected.size === 1 && frameCount > 1) {
      selected.set(0, info[frameCount - 2].end);
      selected.set(frameCount - 1, duration - info[frameCount - 2].end);
    }
  }
  const canvas = Buffer.alloc(pixels * 4), frames = [];
  const previewEdge = Math.min(PREVIEW_WIDTH, edge);
  for (let i = 0; i < frameCount; i++) {
    const frame = info[i];
    const previous = frame.disposal === 3 ? Buffer.from(canvas) : null;
    reader.decodeAndBlitFrameRGBA(i, canvas);
    if (selected.has(i)) frames.push({ ...resizeRgba(canvas, reader.width, reader.height, previewEdge), delay: selected.get(i) });
    if (frame.disposal === 2) {
      for (let y = frame.y; y < frame.y + frame.height; y++) {
        canvas.fill(0, (y * reader.width + frame.x) * 4, (y * reader.width + frame.x + frame.width) * 4);
      }
    } else if (previous) previous.copy(canvas);
  }

  // A high-detail animation may need a smaller preview to stay within the
  // byte budget. Only the small composited frames are resized again.
  for (const target of [...new Set([previewEdge, Math.min(previewEdge, 192), Math.min(previewEdge, 144), Math.min(previewEdge, 112)])]) {
    const first = resizeRgba(frames[0].data, frames[0].width, frames[0].height, target);
    const output = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const writer = new GifWriter(output, first.width, first.height, { loop: reader.loopCount() });
    let over = false;
    for (const frame of frames) {
      const resized = resizeRgba(frame.data, frame.width, frame.height, target);
      const indexed = indexedFrame(resized.data);
      const size = writer.addFrame(0, 0, resized.width, resized.height, indexed.pixels, {
        palette: indexed.palette, transparent: indexed.transparent, delay: frame.delay, disposal: 2,
      });
      if (size >= MAX_PREVIEW_BYTES) { over = true; break; }
    }
    if (!over) {
      const end = writer.end();
      if (end <= MAX_PREVIEW_BYTES) return output.subarray(0, end);
    }
  }
  throw new Error('Animated preview exceeds byte limit');
}

module.exports = { gifPreview, MAX_PREVIEW_BYTES, MAX_PREVIEW_FRAMES, PREVIEW_WIDTH };
