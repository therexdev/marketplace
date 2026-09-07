'use strict';
const { parentPort } = require('worker_threads');
const { Jimp } = require('jimp');
parentPort.on('message', async ({ file, width }) => {
  try {
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
