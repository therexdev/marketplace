'use strict';
const fs = require('fs/promises');
const crypto = require('crypto');
const { firstAvailable } = require('./media');

// Remote originals can be much larger than an upload or embedded data URL.
// Keep them off the JS heap while retaining a hard per-file bound.
const MAX_REMOTE_IMAGE_BYTES = 128 * 1048576;

function imageType(head, claimed) {
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (/^GIF8[79]a/.test(head.toString('latin1', 0, 6))) return 'image/gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (/^\s*(<svg|<\?xml)/.test(head.toString())) return 'image/svg+xml';
  return /^image\//.test(claimed) ? claimed.split(';')[0] : null;
}

async function streamImage(response, file, maxBytes, signal) {
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error(response.ok ? 'image too large' : `HTTP ${response.status}`);
  }
  const handle = await fs.open(file, 'wx');
  let size = 0, head = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > maxBytes) throw new Error('image too large');
      if (head.length < 64) head = Buffer.concat([head, Buffer.from(chunk).subarray(0, 64 - head.length)]);
      await handle.writeFile(chunk);
    }
    signal?.throwIfAborted();
    const type = imageType(head, response.headers.get('content-type') || '');
    if (!size || !type) throw new Error('not an image');
    return { size, type };
  } finally { await handle.close(); }
}

async function downloadImage(urls, file, { fetch: fetcher = fetch, maxBytes = MAX_REMOTE_IMAGE_BYTES, timeoutMs = 45000 } = {}) {
  const attempts = [];
  try {
    const winner = await firstAvailable(urls, (url, signal) => {
      const part = `${file}.${crypto.randomBytes(8).toString('hex')}.part`;
      const job = (async () => {
        const response = await fetcher(url, { signal });
        const result = await streamImage(response, part, maxBytes, signal);
        return { file: part, ...result };
      })();
      attempts.push({ part, job });
      return job;
    }, timeoutMs);
    if (!winner) return null;
    // A reader can only see the complete winning file, never a partial download.
    await fs.rename(winner.file, file);
    return { file, type: winner.type, size: winner.size };
  } finally {
    // firstAvailable aborts losers. Also remove a loser that finished just as
    // another gateway won, plus partial files from errors and timeouts.
    await Promise.allSettled(attempts.map(({ job }) => job));
    await Promise.all(attempts.map(({ part }) => fs.unlink(part).catch(() => {})));
  }
}

module.exports = { MAX_REMOTE_IMAGE_BYTES, downloadImage };
