'use strict';
const { Contract, Serializer } = require('koilib');
const { verifyProof } = require('./vault-proof');
const abi = require('../server-abi/vault-sign-abi.json');
const nested = abi.koilib_types?.nested?.koinos?.nested;
if (nested) { delete nested.btype; delete nested._btype; }
const MODULE = '131Jpn6zzjfujgEwCU7U21CDCmFY85WFFQ';
async function verifyLaunch(signed, pending, provider) {
  if (!signed || signed.id !== pending.transaction.id || JSON.stringify(signed.header) !== pending.header || JSON.stringify(signed.operations) !== JSON.stringify(pending.transaction.operations)) throw new Error('Launch transaction was altered');
  if (signed.signatures?.length !== 1) throw new Error('Expected one KOIN Vault approval');
  await verifyProof(pending.spec.owner, signed.id, signed.signatures[0], {
    modSignSerializer: () => new Serializer(abi.koilib_types),
    accountCredentials: async address => {
      const contract = new Contract({ id: MODULE, abi, provider });
      const { result } = await contract.functions.get_credentials({ user: address });
      return result?.value || [];
    },
  }, { origin: 'https://wallet.usekoinos.com', rpId: 'wallet.usekoinos.com' });
}
module.exports = { verifyLaunch };
