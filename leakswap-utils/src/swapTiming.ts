export const ROUNDS_PER_MINUTE = 20;
export const MIN_SECONDS_PER_ROUND = 2.7;
export const MAX_SECONDS_PER_ROUND = 3;
export const MIN_DEPOSIT_WINDOW_ROUNDS = 60 * ROUNDS_PER_MINUTE;
export const MIN_CLAIM_WINDOW_ROUNDS = 60 * ROUNDS_PER_MINUTE;

export interface RoundDeadlines {
  deadlineUnit: 'round';
  createdRound: number;
  t0: number;
  t1: number;
}

export function minutesToRounds(minutes: number): number {
  const rounds = minutes * ROUNDS_PER_MINUTE;
  if (!Number.isFinite(minutes) || minutes < 0 || !Number.isSafeInteger(rounds)) throw new Error('Duration must produce a non-negative safe number of rounds.');
  return rounds;
}

export function assertRoundDeadlines(terms: { deadlineUnit?: string; createdRound?: number; t0: number; t1: number }): asserts terms is RoundDeadlines {
  if (terms.deadlineUnit !== 'round') throw new Error('Legacy timestamp invitations cannot start or fund a new swap. Ask for a new round-based invitation.');
  if (![terms.createdRound, terms.t0, terms.t1].every(value => Number.isSafeInteger(value) && value! > 0)
    || terms.t0 <= terms.createdRound! || terms.t1 <= terms.t0) throw new Error('Invalid round-based swap deadlines.');
}

export function assertRoundFundingTime(terms: { deadlineUnit?: string; createdRound?: number; t0: number; t1: number }, currentRound: number): void {
  assertRoundDeadlines(terms);
  if (!Number.isSafeInteger(currentRound) || currentRound <= 0 || currentRound < terms.createdRound) throw new Error('A valid current node round at or after the offer creation round is required.');
  if (terms.t0 - currentRound < MIN_DEPOSIT_WINDOW_ROUNDS) throw new Error('At least 60 minutes (1200 rounds) must remain before the XMR deposit deadline. Ask for a new invitation.');
  if (terms.t1 - terms.t0 < MIN_CLAIM_WINDOW_ROUNDS) throw new Error('The ALGO claim window must be at least 60 minutes (1200 rounds) after the deposit deadline. Ask for a new invitation.');
}

export function estimateRoundDuration(rounds: number): { minSeconds: number; maxSeconds: number } {
  if (!Number.isSafeInteger(rounds) || rounds < 0) throw new Error('Round duration must be a non-negative safe integer.');
  return { minSeconds: rounds * MIN_SECONDS_PER_ROUND, maxSeconds: rounds * MAX_SECONDS_PER_ROUND };
}

export function roundDeadlineRemaining(deadline: number, currentRound: number): string {
  if (![deadline, currentRound].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Deadline and current node round must be positive safe integers.');
  const remaining = deadline - currentRound;
  if (remaining === 0) return 'deadline round reached';
  const estimate = estimateRoundDuration(Math.abs(remaining));
  const duration = `${Math.ceil(estimate.minSeconds / 60)}-${Math.ceil(estimate.maxSeconds / 60)} min estimated`;
  return `${Math.abs(remaining)} rounds ${remaining > 0 ? 'remaining' : 'past'} (${duration})`;
}

export function formatRoundDeadline(deadline: number, currentRound?: number): string {
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Invalid deadline round.');
  return `Round ${deadline}${currentRound === undefined ? '' : `; ${roundDeadlineRemaining(deadline, currentRound)}`}`;
}