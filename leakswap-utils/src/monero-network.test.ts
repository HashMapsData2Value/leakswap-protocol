import { getCompleteAddressFromPrivate, MoneroNetworkType } from './monero-utils';
import { moneroBase58Decode } from './base58';

test.each([
  [MoneroNetworkType.MAINNET, 0, '12'],
  [MoneroNetworkType.TESTNET, 1, '35'],
  [MoneroNetworkType.STAGENET, 2, '18'],
])('network %s preserves its numeric value and address prefix', (network, expected, prefix) => {
  expect(network).toBe(expected);
  const privateKey = '01' + '00'.repeat(31);
  const address = getCompleteAddressFromPrivate(privateKey, privateKey, network as MoneroNetworkType);
  expect(moneroBase58Decode(address).slice(0, 2)).toBe(prefix);
});