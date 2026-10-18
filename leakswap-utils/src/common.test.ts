import { MoneroNetworkType } from './monero-utils';
import {
  getPK,
  leakySign,
  extractScalarFromLeakySignature,
  hexToUint8Array,
  uint8ArrayToHex,
  scalarSign
} from './common';
import { computeCombinedAddress, genPrivateSpendKey, genPrivateViewKey, getCompleteAddressFromPrivate } from './monero-utils';
import { moneroBase58Decode } from './base58';
import { ed25519 } from '@noble/curves/ed25519';

describe('Leaky Schnorr Signature Protocol', () => {
  let scalar: Uint8Array;
  let pk: Uint8Array;

  beforeEach(() => {
    const privSpendHex = genPrivateSpendKey(); // hex string, LE
    scalar = hexToUint8Array(privSpendHex); // Uint8Array, LE
    pk = getPK(scalar);
  });

  it('getPK should derive a public key from a scalar', () => {
    expect(pk).toBeInstanceOf(Uint8Array);
    expect(pk.length).toBe(32);
  });

  it('leakySignature should produce a valid signature and allow scalar extraction', () => {
    const message = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const signature = leakySign(message, scalar);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);

    // Extract scalar from signature and check that it produces the same PK
    const extractedScalar = extractScalarFromLeakySignature(signature, message, pk);
    const extractedPK = getPK(extractedScalar);
    expect(Array.from(pk)).toEqual(Array.from(extractedPK));
  });

  it('extractScalarFromLeakySignature should throw on invalid signature length', () => {
    const message = new Uint8Array([1, 2, 3]);
    expect(() => extractScalarFromLeakySignature(new Uint8Array(10), message, pk)).toThrow('Invalid signature length');
  });

  it('extractScalarFromLeakySignature should throw if R is not BASEPOINT', () => {
    const message = new Uint8Array([1, 2, 3]);
    // Create a fake signature with wrong R
    const signature = new Uint8Array(64);
    signature.set(new Uint8Array(32).fill(42), 0); // R is not BASEPOINT
    expect(() => extractScalarFromLeakySignature(signature, message, pk)).toThrow('R value of signature does not match BASEPOINT');
  });
});

describe('Combining Addresses', () => {
  let privateSpendKeyAli: string;
  let privateSpendKeyXin: string;
  let privateViewKeyAli: string;
  let privateViewKeyXin: string;
  let publicSpendKeyAli: string;
  let publicSpendKeyXin: string;
  let addressAli: string;
  let addressXin: string;
  beforeAll(() => {
    // <--- INFORMATION PRIVATE TO BOTH ALI AND XIN
    privateSpendKeyAli = genPrivateSpendKey();
    privateSpendKeyXin = genPrivateSpendKey();
    expect(privateSpendKeyAli).not.toEqual(privateSpendKeyXin);
    // --->

    // <--- INFORMATION FREELY SHARED BETWEEN ALI AND XIN
    privateViewKeyAli = genPrivateViewKey(privateSpendKeyAli);
    privateViewKeyXin = genPrivateViewKey(privateSpendKeyXin);
    publicSpendKeyAli = uint8ArrayToHex(getPK(hexToUint8Array(privateSpendKeyAli)));
    publicSpendKeyXin = uint8ArrayToHex(getPK(hexToUint8Array(privateSpendKeyXin)));
    expect(privateSpendKeyAli).not.toEqual(privateSpendKeyXin);
    expect(privateViewKeyAli).not.toEqual(privateViewKeyXin);
    expect(publicSpendKeyAli).not.toEqual(publicSpendKeyXin);
    // --->
    // Ali and Xin can generate their own addresses
    addressAli = getCompleteAddressFromPrivate(privateSpendKeyAli, privateViewKeyAli, MoneroNetworkType.MAINNET);
    addressXin = getCompleteAddressFromPrivate(privateSpendKeyXin, privateViewKeyXin, MoneroNetworkType.MAINNET);
    expect(addressAli).not.toEqual(addressXin);
  })

  it('Extract from Address: Public SpendKey', () => {
    // First decode the base58 address to get raw bytes
    const decodedAli = hexToUint8Array(moneroBase58Decode(addressAli));
    const decodedXin = hexToUint8Array(moneroBase58Decode(addressXin));

    // Skip prefix (1 byte), then extract 32 bytes for spend key
    const extractedPublicSpendKeyAli = decodedAli.slice(1, 33);
    const extractedPublicSpendKeyXin = decodedXin.slice(1, 33);

    // Convert to hex for comparison
    expect(uint8ArrayToHex(extractedPublicSpendKeyAli)).toEqual(publicSpendKeyAli);
    expect(uint8ArrayToHex(extractedPublicSpendKeyXin)).toEqual(publicSpendKeyXin);
  });

  it('Extract from Address: Public View Key', () => {
    const decodedAli = hexToUint8Array(moneroBase58Decode(addressAli));
    const decodedXin = hexToUint8Array(moneroBase58Decode(addressXin));

    // Skip prefix (1 byte) + spend key (32 bytes), then extract 32 bytes for view key
    const extractedPublicViewKeyAli = decodedAli.slice(33, 65); // Bytes 33-64
    const extractedPublicViewKeyXin = decodedXin.slice(33, 65);

    expect(uint8ArrayToHex(extractedPublicViewKeyAli)).toEqual(uint8ArrayToHex(getPK(hexToUint8Array(privateViewKeyAli))));
    expect(uint8ArrayToHex(extractedPublicViewKeyXin)).toEqual(uint8ArrayToHex(getPK(hexToUint8Array(privateViewKeyXin))));
  });

  it('Sign normal (NON-LEAKY) signature with privateSpendKey, proving ownership', () => {
    // Ali and Xin can sign a normal (non-leaky) signature with their private spend keys
    const message = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // does sign function treat the secret key as something to hash?
    const signatureAli = scalarSign(message, hexToUint8Array(privateSpendKeyAli));
    const signatureXin = scalarSign(message, hexToUint8Array(privateSpendKeyXin));

    expect(ed25519.verify(signatureAli, message, hexToUint8Array(publicSpendKeyAli))).toBe(true);
    expect(ed25519.verify(signatureXin, message, hexToUint8Array(publicSpendKeyXin))).toBe(true);

  });


  it('Ali & Xin generate the same complete address from their private spend keys and public info', () => {
    const {
      combinedPublicSpendKey: combinedPublicSpendKey1,
      combinedPublicViewKey: combinedPublicViewKey1,
      combinedAddress: combinedAddress1
    } = computeCombinedAddress(privateSpendKeyAli, privateViewKeyAli, privateViewKeyXin, publicSpendKeyXin, MoneroNetworkType.MAINNET);
    const {
      combinedPublicSpendKey: combinedPublicSpendKey2,
      combinedPublicViewKey: combinedPublicViewKey2,
      combinedAddress: combinedAddress2
    } = computeCombinedAddress(privateSpendKeyXin, privateViewKeyXin, privateViewKeyAli, publicSpendKeyAli, MoneroNetworkType.MAINNET);

    expect(combinedPublicSpendKey1).toEqual(combinedPublicSpendKey2);
    expect(combinedPublicViewKey1).toEqual(combinedPublicViewKey2);
    expect(combinedAddress1).toEqual(combinedAddress2);


  });
});