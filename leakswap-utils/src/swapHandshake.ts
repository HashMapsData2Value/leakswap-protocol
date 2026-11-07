import { requireCuratedAsset } from './algorandAssets';

export interface AlgoSwapOffer {
  offerId: string;
  createdAt: number;
  deadlineUnit: 'round';
  createdRound: number;
  moneroRestoreHeight?: number;
  algoGenesisHash: string;
  moneroNetwork: 'mainnet' | 'testnet' | 'stagenet' | 'regtest';
  algoAmount: string;
  xmrAmount: string;
  t0: number;
  t1: number;
  aliAlgoAddress: string;
  aliPublicSpendKey: string;
  aliPrivateViewKey: string;
}

export interface AsaSwapOffer extends Omit<AlgoSwapOffer, 'algoAmount'> {
  contract: 'asa';
  asset: { id: string; amount: string; decimals: number };
  feePolicy: 'asa-0.5%-if-eligible';
  reservePolicy: 'return-to-ali';
  algoAmount?: never;
}

export type SwapOffer = AlgoSwapOffer | AsaSwapOffer;

export function isAsaOffer(offer: SwapOffer): offer is AsaSwapOffer {
  return 'contract' in offer && offer.contract === 'asa';
}

export interface SwapAcceptance {
  offerDigest: string;
  xinAlgoAddress: string;
  xinPublicSpendKey: string;
  xinPrivateViewKey: string;
  contract?: 'asa';
}

export interface SignedOffer {
  kind: 'invite';
  payload: SwapOffer;
  signature: string;
}
export interface SignedAcceptance {
  kind: 'accept';
  payload: SwapAcceptance;
  signature: string;
}
export type Handshake = SignedOffer | SignedAcceptance;

const LIMIT = 12000;
const HEX_KEY = /^[0-9a-f]{64}$/;
const ADDRESS = /^[A-Z2-7]{58}$/;
const ERROR = 'Incomplete or damaged swap link. Ask your counterparty to resend the full link.';
const LEGACY_ERROR =
  'Legacy timestamp swaps are not supported. Request a new round-based invitation.';

function exactFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields.sort().join(',')
  )
    throw new Error('Invalid swap message fields.');
}

export function canonicalOffer(value: unknown): SwapOffer {
  if (value && typeof value === 'object' && 'contract' in value) return canonicalAsaOffer(value);
  return canonicalAlgoOffer(value);
}

function canonicalAsaOffer(value: unknown): AsaSwapOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid ASA swap offer.');
  const { contract, asset, feePolicy, reservePolicy, ...common } = value as AsaSwapOffer;
  if (
    contract !== 'asa' ||
    feePolicy !== 'asa-0.5%-if-eligible' ||
    reservePolicy !== 'return-to-ali' ||
    Object.prototype.hasOwnProperty.call(common, 'algoAmount')
  )
    throw new Error('Unsupported ASA swap policy.');
  exactFields(asset, ['id', 'amount', 'decimals']);
  if (typeof asset.id !== 'string' || typeof asset.amount !== 'string')
    throw new Error('Invalid ASA swap asset.');
  const network =
    common.algoGenesisHash === 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
      ? 'mainnet'
      : common.algoGenesisHash === 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
        ? 'testnet'
        : null;
  if (!network) throw new Error('ASA swaps require a supported public network.');
  const curated = requireCuratedAsset(network, asset.id);
  if (asset.decimals !== curated.decimals)
    throw new Error('ASA precision does not match the curated asset.');
  if (common.moneroNetwork !== (network === 'mainnet' ? 'mainnet' : 'stagenet'))
    throw new Error('ASA swap network pair is not supported.');
  const { algoAmount, ...checked } = canonicalAlgoOffer({ ...common, algoAmount: asset.amount });
  return {
    ...checked,
    contract: 'asa',
    asset: { id: curated.id, amount: algoAmount, decimals: curated.decimals },
    feePolicy: 'asa-0.5%-if-eligible',
    reservePolicy: 'return-to-ali',
  };
}

function canonicalAlgoOffer(value: unknown): AlgoSwapOffer {
  const hasRestoreHeight = Object.prototype.hasOwnProperty.call(value ?? {}, 'moneroRestoreHeight');
  if (value && typeof value === 'object' && (value as SwapOffer).deadlineUnit !== 'round')
    throw new Error(LEGACY_ERROR);
  exactFields(value, [
    'offerId',
    'createdAt',
    'algoGenesisHash',
    'moneroNetwork',
    'algoAmount',
    'xmrAmount',
    't0',
    't1',
    'aliAlgoAddress',
    'aliPublicSpendKey',
    'aliPrivateViewKey',
    ...(hasRestoreHeight ? ['moneroRestoreHeight'] : []),
    'deadlineUnit',
    'createdRound',
  ]);
  const offer = value as unknown as AlgoSwapOffer;
  if (
    typeof offer.offerId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(offer.offerId) ||
    !Number.isSafeInteger(offer.createdAt) ||
    offer.createdAt < 0 ||
    offer.deadlineUnit !== 'round' ||
    !Number.isSafeInteger(offer.createdRound) ||
    offer.createdRound <= 0 ||
    (hasRestoreHeight &&
      (!Number.isInteger(offer.moneroRestoreHeight) ||
        offer.moneroRestoreHeight! < 0 ||
        offer.moneroRestoreHeight! > 0xffffffff)) ||
    typeof offer.algoGenesisHash !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(offer.algoGenesisHash) ||
    !['mainnet', 'testnet', 'stagenet', 'regtest'].includes(offer.moneroNetwork) ||
    ![offer.algoAmount, offer.xmrAmount].every(
      (amount) =>
        typeof amount === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(amount) &&
        BigInt(amount) <= 0xffffffffffffffffn,
    ) ||
    !Number.isSafeInteger(offer.t0) ||
    offer.t0 <= offer.createdRound ||
    !Number.isSafeInteger(offer.t1) ||
    offer.t1 <= offer.t0 ||
    offer.t1 > 8640000000000 ||
    typeof offer.aliAlgoAddress !== 'string' ||
    !ADDRESS.test(offer.aliAlgoAddress) ||
    ![offer.aliPublicSpendKey, offer.aliPrivateViewKey].every(
      (key) => typeof key === 'string' && HEX_KEY.test(key),
    )
  )
    throw new Error('Invalid swap offer.');
  return {
    offerId: offer.offerId,
    createdAt: offer.createdAt,
    algoGenesisHash: offer.algoGenesisHash,
    moneroNetwork: offer.moneroNetwork,
    algoAmount: offer.algoAmount,
    xmrAmount: offer.xmrAmount,
    t0: offer.t0,
    t1: offer.t1,
    aliAlgoAddress: offer.aliAlgoAddress,
    aliPublicSpendKey: offer.aliPublicSpendKey,
    aliPrivateViewKey: offer.aliPrivateViewKey,
    ...(hasRestoreHeight ? { moneroRestoreHeight: offer.moneroRestoreHeight } : {}),
    deadlineUnit: offer.deadlineUnit,
    createdRound: offer.createdRound,
  };
}

export function canonicalAcceptance(value: unknown): SwapAcceptance {
  const assetAcceptance = Boolean(value && typeof value === 'object' && 'contract' in value);
  exactFields(value, [
    'offerDigest',
    'xinAlgoAddress',
    'xinPublicSpendKey',
    'xinPrivateViewKey',
    ...(assetAcceptance ? ['contract'] : []),
  ]);
  const accepted = value as unknown as SwapAcceptance;
  if (
    (assetAcceptance && accepted.contract !== 'asa') ||
    typeof accepted.offerDigest !== 'string' ||
    !HEX_KEY.test(accepted.offerDigest) ||
    typeof accepted.xinAlgoAddress !== 'string' ||
    !ADDRESS.test(accepted.xinAlgoAddress) ||
    ![accepted.xinPublicSpendKey, accepted.xinPrivateViewKey].every(
      (key) => typeof key === 'string' && HEX_KEY.test(key),
    )
  )
    throw new Error('Invalid swap acceptance.');
  return {
    offerDigest: accepted.offerDigest,
    xinAlgoAddress: accepted.xinAlgoAddress,
    xinPublicSpendKey: accepted.xinPublicSpendKey,
    xinPrivateViewKey: accepted.xinPrivateViewKey,
    ...(assetAcceptance ? { contract: 'asa' as const } : {}),
  };
}

export function handshakeSigningBytes(kind: 'invite' | 'accept', payload: unknown): Uint8Array {
  if (kind !== 'invite' && kind !== 'accept') throw new Error('Unsupported swap message type.');
  const checked = kind === 'invite' ? canonicalOffer(payload) : canonicalAcceptance(payload);
  const variant = 'contract' in checked && checked.contract === 'asa' ? 'ASA' : 'v1';
  return new TextEncoder().encode(
    JSON.stringify({
      domain: `LeakSwap/${kind === 'invite' ? 'Offer' : 'Acceptance'}/${variant}`,
      payload: checked,
    }),
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

export async function offerDigest(offer: SwapOffer): Promise<string> {
  return digest(handshakeSigningBytes('invite', offer));
}

function envelope(message: Handshake): Handshake {
  exactFields(message, ['kind', 'payload', 'signature']);
  if (
    (message.kind !== 'invite' && message.kind !== 'accept') ||
    typeof message.signature !== 'string' ||
    !/^[0-9a-f]{128}$/.test(message.signature)
  )
    throw new Error('Invalid swap signature envelope.');
  return message.kind === 'invite'
    ? { kind: 'invite', payload: canonicalOffer(message.payload), signature: message.signature }
    : {
        kind: 'accept',
        payload: canonicalAcceptance(message.payload),
        signature: message.signature,
      };
}

export async function encodeHandshake(message: Handshake): Promise<string> {
  const checked = envelope(message);
  const bytes = new TextEncoder().encode(JSON.stringify(checked));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const body = `v1.${checked.kind}.${encoded}`;
  return `${body}.${await digest(new TextEncoder().encode(body))}`;
}

export async function decodeHandshake(value: string): Promise<Handshake> {
  try {
    if (typeof value !== 'string' || value.length > LIMIT) throw new Error(ERROR);
    const parts = value.split('.');
    if (
      parts.length !== 4 ||
      parts[0] !== 'v1' ||
      !['invite', 'accept'].includes(parts[1]) ||
      !/^[A-Za-z0-9_-]+$/.test(parts[2]) ||
      !HEX_KEY.test(parts[3])
    )
      throw new Error(ERROR);
    if ((await digest(new TextEncoder().encode(parts.slice(0, 3).join('.')))) !== parts[3])
      throw new Error(ERROR);
    const decoded = atob(parts[2].replace(/-/g, '+').replace(/_/g, '/'));
    const message = envelope(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
        ),
      ),
    );
    if (message.kind !== parts[1] || (await encodeHandshake(message)) !== value)
      throw new Error(ERROR);
    return message;
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === LEGACY_ERROR ? LEGACY_ERROR : ERROR,
    );
  }
}

export async function buildHandshakeUrl(origin: string, message: Handshake): Promise<string> {
  const url = new URL('/swap', origin);
  url.hash = `${message.kind}=${await encodeHandshake(message)}`;
  return url.toString();
}

export async function parseHandshakeLink(value: string): Promise<Handshake> {
  try {
    if (value.length > LIMIT + 512) throw new Error(ERROR);
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/swap' || url.search)
      throw new Error(ERROR);
    const entries = [...new URLSearchParams(url.hash.slice(1)).entries()];
    if (entries.length !== 1 || !['invite', 'accept'].includes(entries[0][0]))
      throw new Error(ERROR);
    const message = await decodeHandshake(entries[0][1]);
    if (message.kind !== entries[0][0]) throw new Error(ERROR);
    return message;
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === LEGACY_ERROR ? LEGACY_ERROR : ERROR,
    );
  }
}

export async function verifyHandshake(message: Handshake, publicKey: Uint8Array): Promise<void> {
  const checked = envelope(message);
  const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), 'Ed25519', false, [
    'verify',
  ]);
  const signature = Uint8Array.from(checked.signature.match(/../g)!, (byte) => parseInt(byte, 16));
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      key,
      signature,
      new Uint8Array(handshakeSigningBytes(checked.kind, checked.payload)),
    ))
  ) {
    throw new Error('Swap authentication signature is invalid.');
  }
}
