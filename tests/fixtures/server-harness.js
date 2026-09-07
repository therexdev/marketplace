'use strict';
// Exercise the real HTTP handlers with deterministic chain/gateway boundaries.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ROOT = path.resolve(__dirname, '../..');
const localRequire = createRequire(path.join(ROOT, 'server.js'));
const PAINT = '1NgV8Jjr2YokXWSZ6a3Kddk4patYRDF8pU';
const CREW = '1FB7geE8MN1ViG91rkBE5iu27s2Khuo257';
const MARKET = '1BsZx4Hc69tWo1q9sXNP9ywvpBW2KdXwc8';
const TOKEN = '0x444b3030303031';
const paint = require('./discover-paint.json');
async function harness(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ouro-regression-'));
  const registry = { collections: [{ address: PAINT, name: 'Discover Koinos Paint', image: '' }, { address: CREW, name: 'The Crew', image: '' }] };
  if (!fs.existsSync(path.join(dataDir, 'collections.json'))) fs.writeFileSync(path.join(dataDir, 'collections.json'), JSON.stringify(registry));
  const calls = [];
  const respond = async (id, method, args) => {
    calls.push({ id, method, args });
    if (options.chain) {
      const custom = await options.chain(id, method, args);
      if (custom !== undefined) return custom;
    }
    if (method === 'get_config') return { result: { treasury: CREW, koin: PAINT, fee_bps: options.feeBps ?? 0 } };
    if (method === 'get_orders') return { result: { value: [] } };
    if (method === 'get_order') return { result: {} };
    if (method === 'get_info') return { result: { name: id === PAINT ? 'Discover Koinos Paint' : 'The Crew', symbol: 'NFT' } };
    if (method === 'total_supply') return { result: { value: '1' } };
    if (method === 'owner' || method === 'owner_of') return { result: { value: CREW } };
    if (method === 'royalties') return { result: { value: [] } };
    if (method === 'get_tokens') return { result: { token_ids: id === PAINT ? [TOKEN] : ['0x31'] } };
    if (method === 'metadata_of') return { result: { value: id === PAINT ? JSON.stringify(paint) : '' } };
    return { result: {} };
  };
  class Provider { async call() { return {}; } }
  class Contract { constructor({ id }) { this.functions = new Proxy({}, { get: (_, method) => args => respond(id, method, args) }); } }
  const realKoilib = localRequire('koilib');
  const sandbox = {
    require: name => name === 'koilib' ? { ...realKoilib, Provider, Contract } : localRequire(name),
    __dirname: ROOT, module: { exports: {} }, Buffer, URL, URLSearchParams, AbortController, AbortSignal,
    console: options.verbose ? console : { log() {}, warn() {}, error() {} },
    process: { ...process, env: { DATA_DIR: dataDir, MARKET_ADDR: MARKET, GOOGLE_CLIENT_ID: 'test-client', ...(options.env || {}) }, on() {} },
    fetch: options.fetch || (async () => { throw new Error('offline test'); }),
    setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval,
  };
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  vm.runInNewContext(source.slice(0, source.indexOf('server.listen(CFG.PORT')) + '\nmodule.exports = { server, tokenMeta, fetchArt, thumbOf, pinArt, cached, caches, rebuildIndex, indexPeek, imgBusy };', sandbox, { filename: path.join(ROOT, 'server.js') });
  const app = sandbox.module.exports;
  await new Promise(resolve => app.server.listen(options.port || 0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, dataDir, calls, close: async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); } };
}
module.exports = { harness, PAINT, CREW, MARKET, TOKEN, paint };
if (require.main === module) harness({ port: 3989, verbose: true }).then(app => console.log('Preview:', app.base));
