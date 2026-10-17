# Algorand-part of LeakSwap

Note that everything in this folder is licensed under MIT license.

## ALGO Platform Fee

New deployments charge a 0.5% ALGO fee only on successful `leakyClaim`:
`floor(escrowBalance / 200)` microAlgos, computed from the application's balance
before payout. The fixed recipient is
`KMRBWAK47LNYSDWH2FW3Q7BLZFXKHXURZG3SVUONHBHG5MPBNB2PIZKZBA`.
Xin receives the remaining escrow. `leakyRefund` and `punishRefund` charge no
platform fee. These rules are immutable for each new deployment, introduce no
ABI change, and do not modify already-deployed applications.

Recipient balance/minimum queries use nonasserting `RawAcctParams` access,
including missing-account data. The required recipient balance is
`max(100,000 base minimum, reported minimum balance)` microAlgos; a missing
account uses the base minimum. Waive the entire fee if it cannot cover the
recipient's balance shortfall or would leave the app below 100,000 microAlgos
before final payout. A rounded-zero fee produces no fee payment.

The fee is an ALGO inner payment with `fee: 0`, not a recipient-authorized
transfer. It needs no treasury signature, admin approval, or callback.
Treasury rekeying, closing the account, or asset holdings cannot veto settlement
through fee collection: the minimum-balance guards waive an unpayable fee.
This recipient-side protection is not an absolute claim guarantee; valid
authorization, signature, timing, resources, funding and network execution are
still required. Mainnet operation is not certified.

`leakyClaim` uses `ensureBudget(2400)` and a 7,000-microAlgo outer application
fee. Sponsor funding is now 209,000 microAlgos, previously 204,000. These
network/sponsor amounts are separate from the percentage fee.

Trade quotes describe the gross escrow amount, excluding sponsor refunds and
network fees; Xin's net ALGO is reduced by any collected platform fee. Parties
can negotiate the rate to compensate Ali for the fee's economic cost. There
is no oracle or automatic rate adjustment.

## Recorded Validation

Local validation passed 57 contract unit tests, 11 live platform-fee checks,
20 sponsor adversarial cases, five settlement competition cases and four
settlement scenarios. The protocol E2E's actual claim passed, but its later
Indexer lookup failed because the Indexer was unavailable; the full E2E did
not pass. These results do not certify mainnet behavior.
