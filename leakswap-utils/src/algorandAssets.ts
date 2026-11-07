export type AssetNetwork = 'mainnet' | 'testnet' | 'localnet';

export interface CuratedAsset {
  network: AssetNetwork;
  id: string;
  symbol: string;
  name: string;
  decimals: number;
}

export const CURATED_ASSETS: readonly CuratedAsset[] = Object.freeze([
  Object.freeze({
    network: 'mainnet',
    id: '31566704',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
  }),
  Object.freeze({
    network: 'testnet',
    id: '10458941',
    symbol: 'USDC',
    name: 'Testnet USD Coin',
    decimals: 6,
  }),
  Object.freeze({
    network: 'mainnet',
    id: '246516580',
    symbol: 'GOLD$',
    name: 'Meld Gold',
    decimals: 6,
  }),
  Object.freeze({
    network: 'mainnet',
    id: '246519683',
    symbol: 'SILVER$',
    name: 'Meld Silver',
    decimals: 6,
  }),
]);

export const ASA_HOLDING_RESERVE = 100_000n;
export const ASA_FEE_DENOMINATOR = 200n;
const MAX_UINT64 = 0xffffffffffffffffn;

export function assetId(value: string | bigint): bigint {
  if (!/^[1-9][0-9]*$/.test(String(value)) || BigInt(value) > MAX_UINT64)
    throw new Error('Asset ID must be a positive uint64 integer.');
  return BigInt(value);
}

export function curatedAsset(network: AssetNetwork, id: string | bigint): CuratedAsset | undefined {
  const canonicalId = assetId(id).toString();
  return CURATED_ASSETS.find((asset) => asset.network === network && asset.id === canonicalId);
}

export function requireCuratedAsset(network: AssetNetwork, id: string | bigint): CuratedAsset {
  const asset = curatedAsset(network, id);
  if (!asset) throw new Error('This asset is not enabled for LeakSwap on the selected network.');
  return asset;
}

export function parseAssetAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 19)
    throw new Error('Invalid asset decimals.');
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
    throw new Error('Enter a nonnegative decimal asset amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Amount exceeds the asset precision.');
  const amount =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount > MAX_UINT64) throw new Error('Asset amount exceeds uint64.');
  return amount;
}

export function formatAssetAmount(amount: bigint, decimals: number): string {
  if (
    amount < 0n ||
    amount > MAX_UINT64 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 19
  )
    throw new Error('Invalid asset amount or decimals.');
  if (decimals === 0) return amount.toString();
  const padded = amount.toString().padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}

export function asaSettlementAmounts(amount: bigint, feeRecipientEligible: boolean) {
  if (amount <= 0n || amount > MAX_UINT64)
    throw new Error('Swap quantity must be a positive uint64.');
  const fee = feeRecipientEligible ? amount / ASA_FEE_DENOMINATOR : 0n;
  return { fee, recipient: amount - fee };
}
