import { offerDigest, verifyHandshake, type SignedOffer, type SignedAcceptance } from './swapHandshake.ts';

export interface SwapAgreement { offer: SignedOffer; acceptance: SignedAcceptance }

export interface AgreementState {
  genesisHash: string;
  moneroNetwork: string;
  aliAddress: string;
  xinAddress: string;
  aliPublicSpendKey: string;
  xinPublicSpendKey: string;
  t0: number;
  t1: number;
}

export async function verifySwapAgreement(agreement: SwapAgreement, aliPublicKey: Uint8Array, xinPublicKey: Uint8Array): Promise<void> {
  if (agreement.offer.kind !== 'invite' || agreement.acceptance.kind !== 'accept') throw new Error('Invalid swap agreement.');
  await verifyHandshake(agreement.offer, aliPublicKey);
  await verifyHandshake(agreement.acceptance, xinPublicKey);
  if (agreement.acceptance.payload.offerDigest !== await offerDigest(agreement.offer.payload)) throw new Error('Acceptance does not match the offer.');
  if (agreement.offer.payload.aliAlgoAddress === agreement.acceptance.payload.xinAlgoAddress) throw new Error('Swap parties must differ.');
}

export function assertAgreementState(agreement: SwapAgreement, state: AgreementState): void {
  const offer = agreement.offer.payload;
  const acceptance = agreement.acceptance.payload;
  if (state.genesisHash !== offer.algoGenesisHash || state.moneroNetwork !== offer.moneroNetwork
    || state.aliAddress !== offer.aliAlgoAddress || state.xinAddress !== acceptance.xinAlgoAddress
    || state.aliPublicSpendKey !== offer.aliPublicSpendKey || state.xinPublicSpendKey !== acceptance.xinPublicSpendKey
    || state.t0 !== offer.t0 || state.t1 !== offer.t1) throw new Error('Swap does not match the authenticated agreement.');
}

export function assertAgreementFunding(agreement: SwapAgreement, amount: bigint): void {
  if (amount !== BigInt(agreement.offer.payload.algoAmount)) throw new Error('ALGO funding must equal the authenticated amount.');
}