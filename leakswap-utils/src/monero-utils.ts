import { keccak_256 } from 'js-sha3';
import { MoneroNetworkType } from 'monero-ts';
import { getPK, hexToUint8Array } from './common';
import { moneroBase58Encode } from './base58';
import { genScalar } from './algorand-utils';
import { ed25519 } from '@noble/curves/ed25519';

export const L = 2n ** 252n + 27742317777372353535851937790883648493n;

export function genPrivateSpendKey(): string {
  // Generate 32 random bytes
  const arr = genScalar();
  // Convert to BigInt (treat as BE)
  const bn = BigInt('0x' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(''));
  // Reduce modulo L
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const scalar = bn % L;
  // Convert reduced scalar to BE hex, then to bytes, then reverse for LE
  const hex = scalar.toString(16).padStart(64, '0');
  // Convert hex to Uint8Array (BE)
  const beBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    beBytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  // Reverse for LE
  const leBytes = beBytes.reverse();
  // Return as LE hex string
  return Array.from(leBytes).map(b => b.toString(16).padStart(2, '0')).join('');
}


export function genPrivateViewKey(privSpendHex: string): string {
  // Parse spend key as LE hex to bytes
  const spendBytes = hexToUint8Array(privSpendHex);
  // Hash with Keccak-256
  const hashHex = keccak_256(spendBytes); // 32 bytes, treat as LE hex
  // Parse hash as LE bytes
  const hashLEBytes = hexToUint8Array(hashHex);
  // Convert LE bytes to BigInt (LE)
  let bn = 0n;
  for (let i = 0; i < 32; i++) {
    bn += BigInt(hashLEBytes[i]) << (8n * BigInt(i));
  }
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const scalar = bn % L;
  // Convert to 32-byte LE hex
  const leHex = scalar.toString(16).padStart(64, '0');
  // Return as LE hex string
  return leHex.match(/.{2}/g)!.reverse().join('');
}

export function getCompleteAddressFromPrivate(
  privateSpendKey: string,
  privateViewKey: string,
  networkType: MoneroNetworkType): string {
  const spendPubKeyBytes = getPK(hexToUint8Array(privateSpendKey));
  const viewPubKeyBytes = getPK(hexToUint8Array(privateViewKey));
  return getCompleteAddressBase(spendPubKeyBytes, viewPubKeyBytes, networkType);
}

function getCompleteAddressBase(publicSpendKey: Uint8Array, publicViewKey: Uint8Array, networkType: MoneroNetworkType): string {
  let prefix: Uint8Array;
  switch (networkType) {
    case MoneroNetworkType.MAINNET:
      prefix = new Uint8Array([0x12]); // 18 decimal
      break;
    case MoneroNetworkType.STAGENET:
      prefix = new Uint8Array([0x18]); // 24 decimal
      break;
    case MoneroNetworkType.TESTNET:
      prefix = new Uint8Array([0x35]); // 53 decimal
      break;
    default:
      throw new Error("Unsupported network type");
  }

  // Concatenate prefix, spend key, and view key
  const addressBytes = new Uint8Array(prefix.length + publicSpendKey.length + publicViewKey.length);
  addressBytes.set(prefix);
  addressBytes.set(publicSpendKey, prefix.length);
  addressBytes.set(publicViewKey, prefix.length + publicSpendKey.length);

  // Hash with Keccak-256
  const hash = keccak_256(addressBytes);
  const hashBytes = hexToUint8Array(hash);

  // Take first 4 bytes as checksum
  const checksum = hashBytes.slice(0, 4);

  // Concatenate address and checksum
  const completeAddress = new Uint8Array(addressBytes.length + checksum.length);
  completeAddress.set(addressBytes);
  completeAddress.set(checksum, addressBytes.length);

  // Convert to hex string for base58 encoding
  const completeHex = Array.from(completeAddress).map(b => b.toString(16).padStart(2, '0')).join('');
  // Return base58 encoded address
  return moneroBase58Encode(completeHex);
}

export function computeCombinedAddress(
  myPrivateSpendKey: string,
  myPrivateViewKey: string,
  theirPrivateViewKey: string,
  theirPublicSpendKey: string,
  networkType: MoneroNetworkType = MoneroNetworkType.MAINNET
): {
  combinedPublicSpendKey: string;
  combinedPublicViewKey: string;
  combinedAddress: string;
} {

  const myPublicSpendKey = getPK(hexToUint8Array(myPrivateSpendKey));
  const myPublicViewKey = getPK(hexToUint8Array(myPrivateViewKey));
  const theirPublicViewKey = getPK(hexToUint8Array(theirPrivateViewKey));
  const theirPublicSpendKeyBytes = hexToUint8Array(theirPublicSpendKey);

  const combinedPublicSpendKeyPoint = ed25519.Point.fromBytes(myPublicSpendKey).add(ed25519.Point.fromBytes(theirPublicSpendKeyBytes));
  const combinedPublicViewKeyPoint = ed25519.Point.fromBytes(myPublicViewKey).add(ed25519.Point.fromBytes(theirPublicViewKey));

  let combinedAddress = getCompleteAddressBase(
    combinedPublicSpendKeyPoint.toBytes(), combinedPublicViewKeyPoint.toBytes(), networkType
  )

  return {
    combinedPublicSpendKey: combinedPublicSpendKeyPoint.toHex(),
    combinedPublicViewKey: combinedPublicViewKeyPoint.toHex(),
    combinedAddress
  };
}