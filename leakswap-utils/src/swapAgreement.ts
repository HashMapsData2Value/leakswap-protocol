import {
  offerDigest,
  verifyHandshake,
  isAsaOffer,
  type SignedOffer,
  type SignedAcceptance,
} from './swapHandshake';

export interface SwapAgreement {
  offer: SignedOffer;
  acceptance: SignedAcceptance;
}

export interface AgreementState {
  deadlineUnit: 'round';
  genesisHash: string;
  moneroNetwork: string;
  aliAddress: string;
  xinAddress: string;
  aliPublicSpendKey: string;
  xinPublicSpendKey: string;
  t0: number;
  t1: number;
  contract?: 'asa';
  asset?: { id: string; amount: string; decimals: number };
}

export async function verifySwapAgreement(
  agreement: SwapAgreement,
  aliPublicKey: Uint8Array,
  xinPublicKey: Uint8Array,
): Promise<void> {
  if (agreement.offer.kind !== 'invite' || agreement.acceptance.kind !== 'accept')
    throw new Error('Invalid swap agreement.');
  await verifyHandshake(agreement.offer, aliPublicKey);
  await verifyHandshake(agreement.acceptance, xinPublicKey);
  if (isAsaOffer(agreement.offer.payload) !== (agreement.acceptance.payload.contract === 'asa'))
    throw new Error('Offer and acceptance contract types do not match.');
  if (agreement.acceptance.payload.offerDigest !== (await offerDigest(agreement.offer.payload)))
    throw new Error('Acceptance does not match the offer.');
  if (agreement.offer.payload.aliAlgoAddress === agreement.acceptance.payload.xinAlgoAddress)
    throw new Error('Swap parties must differ.');
}

export function assertAgreementState(agreement: SwapAgreement, state: AgreementState): void {
  const offer = agreement.offer.payload;
  const acceptance = agreement.acceptance.payload;
  if (
    state.genesisHash !== offer.algoGenesisHash ||
    state.moneroNetwork !== offer.moneroNetwork ||
    state.aliAddress !== offer.aliAlgoAddress ||
    state.xinAddress !== acceptance.xinAlgoAddress ||
    state.aliPublicSpendKey !== offer.aliPublicSpendKey ||
    state.xinPublicSpendKey !== acceptance.xinPublicSpendKey ||
    state.deadlineUnit !== 'round' ||
    offer.deadlineUnit !== 'round' ||
    state.t0 !== offer.t0 ||
    state.t1 !== offer.t1
  )
    throw new Error('Swap does not match the authenticated agreement.');
  if (isAsaOffer(offer)) {
    if (
      state.contract !== offer.contract ||
      state.asset?.id !== offer.asset.id ||
      state.asset.amount !== offer.asset.amount ||
      state.asset.decimals !== offer.asset.decimals
    )
      throw new Error('ASA escrow does not match the authenticated asset terms.');
  } else if (state.asset || state.contract) {
    throw new Error('ALGO agreement cannot authorize an ASA escrow.');
  }
}

export function assertAgreementFunding(agreement: SwapAgreement, amount: bigint): void {
  if (isAsaOffer(agreement.offer.payload))
    throw new Error('ASA funding must use the authenticated asset terms.');
  if (amount !== BigInt(agreement.offer.payload.algoAmount))
    throw new Error('ALGO funding must equal the authenticated amount.');
}

export function assertAgreementAssetFunding(
  agreement: SwapAgreement,
  id: bigint,
  amount: bigint,
): void {
  const offer = agreement.offer.payload;
  if (!isAsaOffer(offer) || id !== BigInt(offer.asset.id) || amount !== BigInt(offer.asset.amount))
    throw new Error('ASA funding must equal the authenticated asset and quantity.');
}
