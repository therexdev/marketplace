'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Serializer, utils } = require('koilib');
const { verifyLaunch } = require('../lib/vault-launch');
const abi = require('../server-abi/vault-sign-abi.json');
const ser = new Serializer(abi.koilib_types);
const origin = 'https://wallet.usekoinos.com';
const fs = require('node:fs');
const vm = require('node:vm');
test('launch submit locks concurrent attempts, preserves signature order, and returns the completed result on retry', async () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf('  async launchSubmit(req, res) {');
  const end = source.indexOf('  /** Finish a launch', start);
  const method = source.slice(start, end).trim();
  const tx = { id: 'id', header: { payer: 'payer' }, operations: [{}], signatures: ['collection'] };
  const pending = { transaction: tx, header: JSON.stringify(tx.header), vault: true, spec: { owner: 'owner' }, address: 'collection', wif: 'unused' };
  let release, sent = 0, finalized = 0, wire;
  const verify = new Promise(resolve => { release = resolve; });
  const context = {
    pendingLaunches: new Map([['id', pending]]), provider: {},
    json: (res, status, body) => Object.assign(res, { status, body }), readBody: async req => req.body,
    verifyVaultLaunch: async () => verify,
    Signer: { fromWif: () => ({}) },
    dev: { signTransaction: async clean => { clean.signatures.push('sponsor'); } },
    Transaction: class { async send() { sent++; wire = this.transaction; } async wait() {} },
    completeLaunch: async () => { finalized++; return { initialized: true }; },
    console,
  };
  const api = vm.runInNewContext('({' + method + '})', context);
  const request = { method: 'POST', body: { transaction: { ...tx, signatures: ['passkey'] } } };
  const first = {}, duplicate = {};
  const running = api.launchSubmit(request, first);
  await new Promise(resolve => setImmediate(resolve));
  await api.launchSubmit(request, duplicate);
  assert.equal(duplicate.status, 409); assert.equal(sent, 0);
  release(); await running;
  assert.equal(first.status, 200); assert.equal(sent, 1); assert.equal(finalized, 1);
  assert.deepEqual(Array.from(wire.signatures), ['sponsor', 'collection', 'passkey']);
  const again = {}; await api.launchSubmit(request, again);
  assert.equal(again.status, 200); assert.equal(sent, 1); assert.equal(finalized, 1);
});
test('OURO verifies a real Vault approval with the registered key and refuses tampering', async () => {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tx = { id: '0x1220' + 'ab'.repeat(32), header: { payer: 'sponsor' }, operations: [{ upload_contract: {} }] };
  const pending = { transaction: tx, header: JSON.stringify(tx.header), spec: { owner: '1J2gZWvrR23739vw3y9s8J5DKj7hbJnDv7' } };
  const data = Buffer.alloc(37); crypto.createHash('sha256').update('wallet.usekoinos.com').digest().copy(data); data[32] = 5;
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin, challenge: Buffer.from(tx.id).toString('base64url') }));
  const message = Buffer.concat([data, crypto.createHash('sha256').update(client).digest()]);
  const rs = crypto.sign('sha256', message, { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  const sig = Buffer.concat([Buffer.from([48,70,2,33,0]), rs.subarray(0,32), Buffer.from([2,33,0]), rs.subarray(32)]);
  const auth = await ser.serialize({ credential_id: 'test-key', signature: sig.toString('base64url'), authenticator_data: data.toString('base64url'), client_data: client.toString('base64url') }, 'authentication_data');
  const signed = { ...tx, signatures: [Buffer.concat([Buffer.from([255,2]),auth]).toString('base64url')] };
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const provider = { readContract: async op => {
    assert.equal(op.contract_id, '131Jpn6zzjfujgEwCU7U21CDCmFY85WFFQ');
    const args = await ser.deserialize(utils.decodeBase64url(op.args), abi.methods.get_credentials.argument);
    assert.equal(args.user, pending.spec.owner);
    return { result: utils.encodeBase64url(await ser.serialize({ value: [{ credential_id: 'test-key', public_key: publicKey }] }, abi.methods.get_credentials.return)) };
  } };
  await verifyLaunch(signed, pending, provider);
  await assert.rejects(verifyLaunch({ ...signed, operations: [] }, pending, provider), /altered/);
  await assert.rejects(verifyLaunch({ ...signed, id: 'wrong' }, pending, provider), /altered/);
  await assert.rejects(verifyLaunch({ ...signed, signatures: [] }, pending, provider), /one KOIN Vault/);
  await assert.rejects(verifyLaunch(signed, pending, { readContract: async () => { throw Error('RPC down'); } }), /Could not read/);
});
