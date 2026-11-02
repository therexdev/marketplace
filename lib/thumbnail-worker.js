'use strict';
const { parentPort } = require('worker_threads');
const fs = require('fs/promises');
const { Jimp } = require('jimp');
parentPort.on('message', async ({ file, width, type: sourceType }) => {
  try {
    if (sourceType === 'image/gif') {
      // Guard before Jimp allocates width * height * 4 bytes. Its GIF
      // decoder reads frame zero only, so animation length adds no frames.
      const handle = await fs.open(file, 'r');
      const header = Buffer.alloc(10);
      try { await handle.read(header, 0, header.length, 0); }
      finally { await handle.close(); }
      const pixels = header.readUInt16LE(6) * header.readUInt16LE(8);
      if (!/^GIF8[79]a/.test(header.toString('latin1', 0, 6)) || !pixels || pixels > 16 * 1024 * 1024) {
        throw new Error('GIF dimensions exceed preview limit');
      }
    }
    const img = await Jimp.read(file);
    if (img.width > width || img.height > width) img.scaleToFit({ w: width, h: width });
    let alpha = false;
    for (let i = 3; i < img.bitmap.data.length; i += 4) {
      if (img.bitmap.data[i] < 255) { alpha = true; break; }
    }
    const type = alpha ? 'image/png' : 'image/jpeg';
    const bytes = await img.getBuffer(type, { quality: 80 });
    parentPort.postMessage({ bytes, type });
  } catch (e) { parentPort.postMessage({ error: e.message }); }
});
