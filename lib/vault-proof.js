'use strict';
const crypto = require('node:crypto');
const pending = new Map();
function issue(session, address, origin, rpId) {
  for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key);
  // HEX for the on-chain verifier, with a domain prefix that cannot be a transaction id.
  const challenge = '0x' + Buffer.from('bio-wallet:connect:').toString('hex') + crypto.randomBytes(32).toString('hex');
  pending.set(challenge, { session, address, origin, rpId, expires: Date.now() + 120000 });
  return challenge;
}
async function verify(session, address, challenge, signature, chain) {
  const expected = pending.get(challenge);
  pending.delete(challenge); // single use, including failed attempts
  if (!expected || expected.session !== session || expected.address !== address || expected.expires <= Date.now()) throw new Error('Connection approval expired; scan again');
  return verifyProof(address, challenge, signature, chain, expected);
}
async function verifyProof(address, challenge, signature, chain, expected) {
  const raw = Buffer.from(String(signature || ''), 'base64url');
  if (raw.length > 8192 || raw[0] !== 255 || raw[1] !== 2) throw new Error('Passkey approval required');
  const auth = await chain.modSignSerializer().deserialize(raw.subarray(2), 'authentication_data');
  const client = JSON.parse(Buffer.from(auth.client_data, 'base64url').toString());
  const data = Buffer.from(auth.authenticator_data, 'base64url');
  if (client.type !== 'webauthn.get' || client.origin !== expected.origin || client.crossOrigin === true || client.challenge !== Buffer.from(challenge).toString('base64url')) throw new Error('Passkey approval does not match this connection');
  if (data.length < 37 || (data[32] & 5) !== 5 || !data.subarray(0, 32).equals(crypto.createHash('sha256').update(expected.rpId).digest())) throw new Error('Fresh device verification required');
  // Running the P-256 WASM verifier in chain.read_contract exceeds public
  // nodes' compute budget. Read the registered public key instead, then
  // verify this connection proof with Node's P-256 implementation. Never
  // trust a public key supplied by the browser or a cached local record.
  let credentials;
  try { credentials = await chain.accountCredentials(address); }
  catch (_) { throw new Error('Could not read registered passkeys from the blockchain. Please try again.'); }
  const credential = credentials.find(c => c.credential_id === auth.credential_id);
  if (!credential?.public_key) throw new Error('This passkey is not registered to this wallet. Unlock with a registered passkey and scan again.');
  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(credential.public_key, 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Expected P-256 key');
    const message = Buffer.concat([data, crypto.createHash('sha256').update(Buffer.from(auth.client_data, 'base64url')).digest()]);
    // WebauthnWire always pads both DER integers to 33 bytes for the chain's
    // ASN.1 reader. OpenSSL rejects that non-minimal DER for some signatures;
    // verify the exact same r/s values using the fixed-width P1363 encoding.
    const sig = Buffer.from(auth.signature, 'base64url');
    if (sig.length !== 72 || !sig.subarray(0, 5).equals(Buffer.from([0x30, 0x46, 0x02, 0x21, 0])) || !sig.subarray(37, 40).equals(Buffer.from([0x02, 0x21, 0]))) throw new Error('Malformed signature');
    valid = crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.concat([sig.subarray(5, 37), sig.subarray(40, 72)]));
  } catch (_) { /* malformed keys and signatures fail closed */ }
  if (!valid) throw new Error('Passkey signature verification failed. Please scan again.');
}
module.exports = { issue, verify, verifyProof };
