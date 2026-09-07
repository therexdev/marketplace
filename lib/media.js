'use strict';
const MAX_IMAGE_BYTES = 12 * 1048576;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

function dataImage(source) {
  if (typeof source !== 'string' || source.length > MAX_IMAGE_BYTES * 1.5) return null;
  const m = /^data:(image\/[a-z0-9.+-]+)((?:;[^,]*)?),(.*)$/is.exec(source);
  if (!m || !TYPES.has(m[1].toLowerCase())) return null;
  try {
    const base64 = /;base64(?:;|$)/i.test(m[2]);
    if (base64 && (!/^[A-Za-z0-9+/]*={0,2}$/.test(m[3]) || m[3].length % 4 === 1)) return null;
    const bytes = base64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    return { bytes, type: m[1].toLowerCase() };
  } catch (_) { return null; }
}

function ipfsRoots(source) {
  const base = String(source || '').trim();
  let m = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(.*)$/i.exec(base)
    || /^https?:\/\/([a-z0-9]{46,})\.ipfs\.[^/]+(.*)$/i.exec(base)
    || /^https?:\/\/[^/]+\/ipfs\/([a-z0-9]{40,})(.*)$/i.exec(base);
  if (!m) return null;
  let [, cid, tail] = m;
  const nested = /^\/ipfs\/([a-z0-9]{40,})(.*)$/i.exec(tail);
  if (nested) [, cid, tail] = nested;
  tail = tail.split('#')[0];
  return ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'].map(root => root + cid + tail);
}

function normalizeImage(source) {
  if (typeof source !== 'string') return null;
  let u = source.trim();
  if (u.startsWith('data:')) return dataImage(u) ? u : null;
  if (u.startsWith('ipfs://')) return ipfsRoots(u)?.[0] || null;
  u = u.replace(/^https?:\/\/(www\.)?(koinoscrusaders\.com|aurvania\.quest)\//, 'https://aurvania.com/');
  return /^https:\/\//.test(u) ? u : null;
}

function metadataImage(meta) {
  const image = normalizeImage(meta?.image || meta?.image_url);
  if (image) return image;
  if (typeof meta?.image_data === 'string' && /^\s*<svg[\s>]/i.test(meta.image_data)) {
    return normalizeImage('data:image/svg+xml;base64,' + Buffer.from(meta.image_data).toString('base64'));
  }
  return null;
}

// The first SUCCESS wins; a quick 404 must not cancel a slower healthy gateway.
// Cancellation also stops response-body reads, not just connection setup.
async function firstAvailable(urls, read, timeoutMs = 8000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await Promise.any([...new Set(urls)].map(url => read(url, abort.signal)));
  } catch (_) { return null; }
  finally { clearTimeout(timer); abort.abort(); }
}

async function limitedBody(response, max) {
  const chunks = [];
  let size = 0;
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error('response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { MAX_IMAGE_BYTES, dataImage, ipfsRoots, normalizeImage, metadataImage, firstAvailable, limitedBody };
