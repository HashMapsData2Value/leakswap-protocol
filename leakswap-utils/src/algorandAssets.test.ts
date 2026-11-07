import assert from 'node:assert/strict';
import {
  ASA_HOLDING_RESERVE,
  assetId,
  asaSettlementAmounts,
  curatedAsset,
  formatAssetAmount,
  parseAssetAmount,
  requireCuratedAsset,
} from './algorandAssets';

test('curated assets are identified by network and ID, not ticker', () => {
  for (const [network, id, symbol] of [
    ['mainnet', '31566704', 'USDC'],
    ['testnet', '10458941', 'USDC'],
    ['mainnet', '246516580', 'GOLD$'],
    ['mainnet', '246519683', 'SILVER$'],
  ] as const) {
    assert.equal(requireCuratedAsset(network, id).symbol, symbol);
    assert.equal(requireCuratedAsset(network, id).decimals, 6);
  }
  for (const network of ['testnet', 'localnet'] as const)
    for (const id of ['31566704', '246516580', '246519683'])
      assert.throws(() => requireCuratedAsset(network, id), /not enabled/);
  assert.equal(curatedAsset('mainnet', '10458941'), undefined);
  assert.throws(() => requireCuratedAsset('mainnet', '123'), /not enabled/);
  assert.equal(ASA_HOLDING_RESERVE, 100_000n);
});

test('ASA amounts retain atomic precision and enforce uint64 limits', () => {
  assert.equal(parseAssetAmount('1.000001', 6), 1_000_001n);
  assert.equal(parseAssetAmount('18446744073709.551615', 6), 0xffffffffffffffffn);
  assert.equal(formatAssetAmount(0xffffffffffffffffn, 6), '18446744073709.551615');
  assert.equal(formatAssetAmount(0n, 6), '0');
  assert.equal(formatAssetAmount(100n, 0), '100');
  for (const value of [
    '1e6',
    '-1',
    '+1',
    '01',
    ' 1',
    '1.',
    '.1',
    '0.0000001',
    '18446744073709.551616',
  ])
    assert.throws(() => parseAssetAmount(value, 6));
  for (const value of ['0', '-1', '01', '1e2', '18446744073709551616'])
    assert.throws(() => assetId(value));
  for (const decimals of [-1, 1.5, 20, NaN]) {
    assert.throws(() => parseAssetAmount('1', decimals));
    assert.throws(() => formatAssetAmount(1n, decimals));
  }
});

test('ASA settlement takes 0.5 percent with downward integer rounding and no lost units', () => {
  for (const amount of [1n, 199n, 200n, 201n, 1_000_000n, 0xffffffffffffffffn]) {
    const paid = asaSettlementAmounts(amount, true);
    assert.equal(paid.fee, amount / 200n);
    assert.equal(paid.fee + paid.recipient, amount);
    assert.deepEqual(asaSettlementAmounts(amount, false), { fee: 0n, recipient: amount });
  }
  for (const amount of [0n, -1n, 0x10000000000000000n])
    assert.throws(() => asaSettlementAmounts(amount, true));
});
