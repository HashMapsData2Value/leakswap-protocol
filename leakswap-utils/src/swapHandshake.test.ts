import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  canonicalOffer,
  handshakeSigningBytes,
  offerDigest,
  encodeHandshake,
  decodeHandshake,
  verifyHandshake,
  type AlgoSwapOffer,
  type AsaSwapOffer,
  type SignedOffer,
} from './swapHandshake';
import {
  assertAgreementFunding,
  assertAgreementAssetFunding,
  verifySwapAgreement,
} from './swapAgreement';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const legacy: AlgoSwapOffer = {
  offerId: '01'.repeat(16),
  createdAt: 1,
  deadlineUnit: 'round',
  createdRound: 100,
  algoGenesisHash: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
  moneroNetwork: 'stagenet',
  algoAmount: '1000000',
  xmrAmount: '1000000000',
  t0: 1000,
  t1: 2000,
  aliAlgoAddress: 'A'.repeat(58),
  aliPublicSpendKey: '02'.repeat(32),
  aliPrivateViewKey: '03'.repeat(32),
};
const { algoAmount: _amount, ...common } = legacy;
const asa: AsaSwapOffer = {
  ...common,
  contract: 'asa',
  asset: { id: '10458941', amount: '1000001', decimals: 6 },
  feePolicy: 'asa-0.5%-if-eligible',
  reservePolicy: 'return-to-ali',
};

test('existing beta ALGO signing bytes preserve their canonical format', () => {
  const expected = {
    offerId: legacy.offerId,
    createdAt: 1,
    algoGenesisHash: legacy.algoGenesisHash,
    moneroNetwork: 'stagenet',
    algoAmount: '1000000',
    xmrAmount: '1000000000',
    t0: 1000,
    t1: 2000,
    aliAlgoAddress: legacy.aliAlgoAddress,
    aliPublicSpendKey: legacy.aliPublicSpendKey,
    aliPrivateViewKey: legacy.aliPrivateViewKey,
    deadlineUnit: 'round',
    createdRound: 100,
  };
  assert.equal(
    new TextDecoder().decode(handshakeSigningBytes('invite', legacy)),
    JSON.stringify({ domain: 'LeakSwap/Offer/v1', payload: expected }),
  );
});

test('ASA offers strictly bind curated network, asset, precision, quantity and settlement policies', () => {
  assert.deepEqual(canonicalOffer(asa), asa);
  for (const patch of [
    { version: 1 },
    { contract: 'algo' },
    { feePolicy: 'algo-fixed' },
    { reservePolicy: 'return-to-xin' },
    { algoAmount: '200000' },
    { algoGenesisHash: 'A'.repeat(43) + '=' },
    { moneroNetwork: 'mainnet' },
    { asset: { ...asa.asset, id: '31566704' } },
    { asset: { ...asa.asset, id: '12345' } },
    { asset: { ...asa.asset, decimals: 5 } },
    { asset: { ...asa.asset, amount: '0' } },
    { asset: { ...asa.asset, amount: '18446744073709551616' } },
    { asset: { ...asa.asset, symbol: 'USDC' } },
  ])
    assert.throws(() => canonicalOffer({ ...asa, ...patch }));
});

test('real ASA signatures and beta links reject validly shaped quantity or asset substitutions', async () => {
  const keys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      keys.privateKey,
      new Uint8Array(handshakeSigningBytes('invite', asa)),
    ),
  ).toString('hex');
  const signed: SignedOffer = { kind: 'invite', payload: asa, signature };
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  await verifyHandshake(signed, publicKey);
  const encoded = await encodeHandshake(signed);
  assert.match(encoded, /^v1\.invite\./);
  assert.equal('version' in signed.payload, false);
  assert.match(
    new TextDecoder().decode(handshakeSigningBytes('invite', asa)),
    /LeakSwap\/Offer\/ASA/,
  );
  assert.deepEqual(await decodeHandshake(encoded), signed);
  await assert.rejects(
    verifyHandshake(
      { ...signed, payload: { ...asa, asset: { ...asa.asset, amount: '1000002' } } },
      publicKey,
    ),
  );
  await assert.rejects(decodeHandshake(encoded.replace(/^v1/, 'unsupported')));
  assert.notEqual(await offerDigest(asa), await offerDigest(legacy));
});

test('ASA funding cannot be mistaken for ALGO funding or a different ASA quantity', async () => {
  const agreement = {
    offer: { kind: 'invite' as const, payload: asa, signature: '00'.repeat(64) },
    acceptance: {
      kind: 'accept' as const,
      payload: {
        offerDigest: await offerDigest(asa),
        xinAlgoAddress: 'B'.repeat(58),
        xinPublicSpendKey: '04'.repeat(32),
        xinPrivateViewKey: '05'.repeat(32),
        contract: 'asa' as const,
      },
      signature: '00'.repeat(64),
    },
  };
  assert.throws(() => assertAgreementFunding(agreement, 1000001n), /ASA funding/);
  assert.doesNotThrow(() => assertAgreementAssetFunding(agreement, 10458941n, 1000001n));
  assert.throws(() => assertAgreementAssetFunding(agreement, 31566704n, 1000001n));
  assert.throws(() => assertAgreementAssetFunding(agreement, 10458941n, 1000000n));
});
