# Round Deadlines

All offers use absolute Algorand rounds for `t0` and `t1`. Signed `SwapOffer`
metadata requires `deadlineUnit: 'round'` and `createdRound: number`.
`createdRound` is the actual node round at creation;
`createdAt` remains Unix seconds for audit only. Neither creation time nor
local wall-clock time controls round offer expiry.

Legacy timestamp offers, links, and saved records are rejected. Do not add
metadata to old signed offers, convert deadline numbers, or infer units from
numeric size. Rejection leaves stored bytes intact; no deletion or migration
is performed. Create a new round-based invitation instead.

## Page And Wallet Interface

`createSwapInvite` accepts exactly:

```ts
interface SwapInviteTerms {
  algoAmount: string;
  xmrAmount: string;
  deadlineUnit: 'round';
  t0: number;
  t1: number;
}
```

The page obtains a node round to construct absolute deadlines. Zebgen fetches
its own fresh node round and inserts signed `createdRound`; do not supply
`createdRound` in this request. Saved swaps require `deadlineUnit` and
`createdRound`, also present in their signed agreement.

## Shared Exports

Import from `leakswap-utils/dist/swapTiming.js`:

```ts
const ROUNDS_PER_MINUTE = 20;
const MIN_SECONDS_PER_ROUND = 2.7;
const MAX_SECONDS_PER_ROUND = 3;
const MIN_DEPOSIT_WINDOW_ROUNDS = 1200;
const MIN_CLAIM_WINDOW_ROUNDS = 1200;

interface RoundDeadlines {
  deadlineUnit: 'round';
  createdRound: number;
  t0: number;
  t1: number;
}

function minutesToRounds(minutes: number): number;
function assertRoundDeadlines(terms: {
  deadlineUnit?: string; createdRound?: number; t0: number; t1: number;
}): asserts terms is RoundDeadlines;
function assertRoundFundingTime(terms: {
  deadlineUnit?: string; createdRound?: number; t0: number; t1: number;
}, currentRound: number): void;
function estimateRoundDuration(rounds: number): {
  minSeconds: number; maxSeconds: number;
};
function roundDeadlineRemaining(deadline: number, currentRound: number): string;
function formatRoundDeadline(deadline: number, currentRound?: number): string;
```

The funding check requires a positive safe node round not older than
`createdRound`, at least 1200 remaining deposit rounds, and at least 1200 claim
rounds. Estimates use 2.7-3 seconds per round and never determine eligibility.
Preset durations use exactly 20 rounds per minute.

`swapAttention.js` requires the final `deadlineUnit: 'round'` argument on
`refundDecisionMargin`, `deadlineRemaining`, and `swapAttention`. Pass a node
round as `now`. Missing or timestamp units are rejected.
`AgreementState.deadlineUnit` must be `'round'`, as must the signed offer's unit;
callers must establish the actual contract version from trusted program bytes.