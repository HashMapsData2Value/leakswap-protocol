import { ROUNDS_PER_MINUTE, roundDeadlineRemaining } from './swapTiming.ts';

export type SwapLiveState = 'unknown' | 'unavailable' | 'awaiting' | 'ready';

export function refundDecisionMargin(t0: number, t1: number, deadlineUnit: 'round'): number {
  if (deadlineUnit !== 'round') throw new Error('Only round-based swap deadlines are supported.');
  const claimWindow = t1 - t0;
  if (claimWindow === 120 * ROUNDS_PER_MINUTE) return 30 * ROUNDS_PER_MINUTE;
  if (claimWindow === 360 * ROUNDS_PER_MINUTE) return 60 * ROUNDS_PER_MINUTE;
  if (claimWindow === 1440 * ROUNDS_PER_MINUTE) return 120 * ROUNDS_PER_MINUTE;
  return Math.min(60 * ROUNDS_PER_MINUTE, Math.max(ROUNDS_PER_MINUTE, Math.floor(claimWindow / 4)));
}

export function deadlineRemaining(deadline: number, now: number, deadlineUnit: 'round'): string {
  if (deadlineUnit !== 'round') throw new Error('Only round-based swap deadlines are supported.');
  return roundDeadlineRemaining(deadline, now);
}

export function swapAttention(role: 'ali' | 'xin', t0: number, t1: number, now: number, state: SwapLiveState, deadlineUnit: 'round') {
  const decisionAt = t0 - refundDecisionMargin(t0, t1, deadlineUnit);
  if (state === 'unavailable') return {
    priority: 0, title: 'Application unavailable',
    detail: 'Check settlement history and recovery references. An unavailable application does not confirm who settled it.', decisionAt
  };
  if (state === 'unknown') return {
    priority: now >= decisionAt ? 2 : 1, title: now >= decisionAt ? 'Check this swap urgently' : 'Verify swap status',
    detail: 'Live contract status is not verified. Check the chain before deciding whether to claim or refund.', decisionAt
  };
  if (now >= t1) return {
    priority: 3, title: role === 'ali' ? 'Final expiry reached: check refund' : 'Claim window may have closed',
    detail: role === 'ali' ? 'Check the chain for a punish refund. It does not reveal your Monero spend key.' : 'Check settlement and Monero recovery. Do not make a new deposit.', decisionAt
  };
  if (now > t0 || state === 'ready') return {
    priority: role === 'xin' ? 3 : 1, title: role === 'xin' ? 'Claim needs attention' : 'Xin can claim',
    detail: role === 'xin' ? 'Verify your deposit and submit the claim before final expiry. Claiming reveals your Monero spend key.' : 'Leaky refund is no longer available once ready or after t0. Monitor settlement.', decisionAt
  };
  if (now >= decisionAt) return {
    priority: 3, title: role === 'ali' ? 'Refund decision due' : 'Deposit window is closing',
    detail: role === 'ali' ? 'Recheck XMR funding now. If it cannot be verified, consider a leaky refund and get it confirmed before t0.' : 'Do not start a new deposit without allowing enough time for confirmations and Ali to verify it.', decisionAt
  };
  return { priority: 1, title: 'Awaiting Monero verification', detail: 'Keep both wallets available and monitor the agreed deadlines.', decisionAt };
}