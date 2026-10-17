export type SwapLiveState = 'unknown' | 'unavailable' | 'awaiting' | 'ready';

export function refundDecisionMargin(t0: number, t1: number): number {
  const claimWindow = t1 - t0;
  if (claimWindow === 2 * 3600) return 30 * 60;
  if (claimWindow === 6 * 3600) return 3600;
  if (claimWindow === 24 * 3600) return 2 * 3600;
  return Math.min(3600, Math.max(60, Math.floor(claimWindow / 4)));
}

export function deadlineRemaining(deadline: number, now: number): string {
  const seconds = Math.abs(deadline - now);
  const minutes = Math.ceil(seconds / 60);
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return deadline <= now ? `${duration} ago` : `in ${duration}`;
}

export function swapAttention(role: 'ali' | 'xin', t0: number, t1: number, now: number, state: SwapLiveState) {
  const decisionAt = t0 - refundDecisionMargin(t0, t1);
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