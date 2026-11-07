# ASA Development Status

This work is local to `feat/asa-support` in the protocol, wallet, and swap-app
repositories. Nothing here has been published, deployed, or enabled for public
ASA swaps. Existing ALGO contracts and signed agreements remain unchanged.

## Implemented

- Shared network-specific curated asset registry and uint64-safe quantity,
  precision, and fee utilities.
- Wallet holdings for arbitrary opted-in ASAs, including zero and frozen balances.
- Wallet explicit opt-in and transfers through the existing transaction review
  and PIN flow. ASA quantities, ALGO fees, and extra minimum balance are separate.
- Separate `AsaLeakSwap` and `AsaFeeSponsorLSig` contracts. Existing ALGO contract
  bytecode is not replaced.
- Beta ASA signed offers and acceptances bind the exact curated asset, atomic
  quantity, contract type, conditional 0.5% fee, and reserve ownership. Existing
  ALGO signing bytes and link framing are preserved; ASA uses `contract: 'asa'`.
- Wallet artifact pinning, offline sponsor derivation, agreement-bound creation,
  initialization, funding, readiness, and expiry-refund validation. Generic dApp
  signing still cannot authorize arbitrary ASA transfers or revealing settlements.
- Wallet-owned claim/refund construction, optional recipient opt-in, fee and
  balance preflights, simulation, and transaction journaling.
- Immutable encrypted ASA records, deleted-app settlement reconciliation, and
  historical Monero-share recovery, including pruned node transaction lookups.
- Swap-page curated asset selection, token-aware minimums and fee disclosures,
  pinned ASA deployment, escrow opt-in initialization, exact ASA/sponsor funding,
  readiness resources, expiry refunds, and saved-swap token balances and labels.

Curated beta swap agreements admit only these exact network/asset combinations:

| Network | Symbol  | Asset ID  | Decimals |
| ------- | ------- | --------- | -------- |
| Mainnet | USDC    | 31566704  | 6        |
| Mainnet | GOLD$   | 246516580 | 6        |
| Mainnet | SILVER$ | 246519683 | 6        |
| Testnet | USDC    | 10458941  | 6        |

The contract verifies the network genesis hash, asset ID, precision, and default
freeze setting. A matching ticker alone does not establish identity. There are
no publicly supported LocalNet asset IDs and no Testnet GOLD$/SILVER$ entries.

## Escrow Rules

- Ali initializes the escrow ASA holding with ALGO reserve funding before
  transferring the committed ASA quantity.
- Readiness requires the committed quantity to be available and unfrozen.
- Claim charges `floor(committed atomic quantity / 200)` in the ASA, only if the
  treasury has an unfrozen holding. A missing or frozen treasury holding waives
  the fee. Refunds do not charge this fee.
- Settlement groups are sponsor payment, optional recipient-signed zero self
  transfer, and app deletion. The ASA settlement methods deliberately have no
  payment ABI argument, because ARC-4 transaction arguments must immediately
  precede the app call.
- The escrow ASA holding closes to the settlement recipient. Unsolicited excess
  ASA also goes to that recipient. The escrow ALGO reserve closes to Ali.
- Ali can recover partial or empty ASA funding by refunding in the applicable
  round window. An opted-out recipient can re-opt in atomically.
- Issuer freeze or clawback powers remain external risks. A frozen escrow or
  frozen settlement recipient can prevent settlement; this contract cannot
  override the issuer.

The current beta wallet/page policy funds the sponsor with 320,000 microALGO,
separate from the 200,000 microALGO escrow reserve. ASA settlement uses a
conservative twelve-minimum-fee budget, subject to the wallet's signing ceiling.
The LocalNet integration test uses 12,000 microALGO. This is not a measured
minimum fee. The ASA claim fee is collected in the token, not in ALGO.

ASA punish-refund construction checks the live minimum fee, escrow/recipient
holdings, sponsor funds and any recipient re-opt-in reserve before requesting
wallet signatures. Its fee scales with the network minimum and must fit Zebgen's
20,000-microALGO signing ceiling. Leaky settlement rejects an unsupported ASA
fee before generating a revealing signature. Page tests decode the actual SDK2
punish groups with Zebgen's SDK3 and run its signing guards across exact funding
thresholds and one-microALGO shortfalls. These preflights cannot guarantee against
state changes, deadline expiry or network failure during approval/submission.

## Validation

From `leakswap-utils`:

```sh
npm test -- --runInBand algorandAssets
npm run build
```

From `algorand/projects/algorand`:

```sh
npm run test:asa
npm run test:asa:localnet
npm run check-types
npm run build
```

The ASA contract/sponsor unit suites cover 213 cases. The real AVM suite covers
31 scenarios (32 reported tests including the parent), including both group
shapes, all three terminal paths, zero-ALGO recipient opt-in, fee collection/waiver,
rollback, and leaky-key recovery. Refund coverage includes:

- Empty, partial, exact and surplus ASA deposits with and without recipient re-opt-in.
- Full ASA return with no treasury fee, exact escrow ALGO reserve and sponsor
  accounting, app deletion and rejected repeat settlement.
- Leaky refund revealing Ali's recoverable key share; punish refund carrying no
  signature argument, including confirmation exactly at `t1` and punishment after Ready.
- Frozen escrow or recipient rejection with unchanged funds and a live app,
  followed by successful settlement after the issuer unfreezes the holding.
- Unit readiness/deadline boundaries and refund-specific sponsor, caller, group
  and opt-in attacks.
- Fast round-driving checks: leaky refund confirms before and exactly at `t0`;
  after `t0`, leaky refund and premature punish reject while timeout claim succeeds
  without Ready; after `t1`, claim/leaky refund reject while punish succeeds.
  Rejected actions preserve both parties' balances, escrow, sponsor and app state.

These tests do not execute a Monero transfer or the browser wallet. In particular,
refund signature recovery here does not prove a full recovered-XMR sweep.

`test:asa:localnet` requires running Docker and an already-cached
`algorand/algod:latest` image, optionally selected with `ASA_TEST_ALGOD_IMAGE`.
It never pulls images, resets existing chains, or mounts user wallets. It creates
one disposable node with random localhost ports and fresh keys, then removes
that container and its own temporary data.

The disposable DevMode node advances one round per confirmed zero-ALGO
self-payment. These are trigger transactions, not literally empty blocks. Short
test deadlines are ten/twenty rounds from creation, so crossing `t0`/`t1` does not
require waiting for wall-clock expiry. The test asserts the actual confirmation
round; submission on the last eligible round is not itself proof of eligibility.

The separate scanner Regtest test can accelerate Monero confirmations and verify
real payments, maturity and sweeps using its own disposable daemon/wallet RPC:

```sh
cd zebgen-monero-wasm
MONERO_TEST_IMAGE=docker-monerod node --test tests/fundedTransactionCheckpoint.cjs
```

Run this command from the workspace root with Docker running and the Monero image
already cached. It uses `generateblocks`, random localhost ports and fresh test
keys, never the user's existing Regtest chain. Its mining requests have a bounded
90-second timeout; ordinary RPC requests and Docker operations are also bounded.
It is a separate test layer, not a funded browser-to-extension ASA/XMR refund test.

The LocalNet fixture is generated structurally from the production contract.
Only its allowlist and treasury are changed to use disposable assets/accounts.
It is ignored by git and lives outside the production contract build directory.
The real production bytecode is tested separately to reject the fixture asset.

Wallet checks:

```sh
npm run compile
node --experimental-transform-types --no-warnings --test \
  scripts/asaAssets.test.mjs scripts/addressFeedbackUi.test.mjs \
  scripts/transactionApproval.test.mjs
```

Wallet refund and settlement authorization checks:

```sh
node --experimental-transform-types --no-warnings --test \
  scripts/settleLeakSwap.test.mjs scripts/swapRecordVaultAgreementUse.test.mjs \
  scripts/swapSettlement.test.mjs
```

These cover partial/surplus leaky-refund preflights, rejection before key disclosure,
and authenticated ASA punish groups with and without re-opt-in. Punish does not
use the wallet's revealing `settleLeakSwap` API or scan/simulate a Monero key share.

The wallet currently uses the local feature branch's built `leakswap-utils`
through a sibling `file:` dependency. This is intentionally not a published
dependency or a release-ready installation arrangement.

Swap-page local setup, from the private repository's `swap-page` directory:

```sh
node scripts/sync-asa-local.mjs
npm run build
```

The explicit sync copies only five ASA/shared files from the sibling feature
branch. It refuses to overwrite different pre-existing vendor edits. It does not
update the submodule pin or make the branch independently release-ready.

From the private repository's `e2e-ui` directory:

```sh
./node_modules/.bin/tsx --test deploymentBudget.test.ts fundingBudget.test.ts
HEADED=1 SWAP_URL=http://127.0.0.1:5187 ./node_modules/.bin/tsx swapAmountUi.ts
HEADED=1 SWAP_URL=http://127.0.0.1:5188 ./node_modules/.bin/tsx --test taskFirstSwapUi.test.ts
```

The amount-picker test uses the default Mainnet preview with mocked RPC. The
saved-swap suite uses a beta preview (`VITE_BETA_PAGE=true`) and mocked RPC/provider
responses. It covers empty/partial/full ASA holdings versus the separate ALGO
reserve, wrong asset globals, and wallet-owned claim/refund routing. It does not
broadcast or establish funded browser-to-wallet settlement coverage. Headed real
Zebgen navigation/persistence checks use isolated builds and disposable profiles.

## Verification Still Required

- The private repository's `e2e-ui` command `npm run test:browser:asa` now passes
  seven funded Localnet/Regtest cases with real extension approvals, deployment,
  initialization, token funding, XMR deposit, settlement, recovery/sweeps and
  independent receipts. It includes both claim fee-waiver branches and both
  punish paths. The test-only AST generator binds one exact minted ASA and a
  disposable treasury; production artifacts and public allowlists stay unchanged.
- Restart/fault injection across signing, journal, relay and receipt boundaries,
  competing tabs, account/network changes, and Firefox workflows remain required.
- No Testnet USDC/XMR or other public-chain swap has been certified yet.
- Release-ready dependency/submodule packaging and an explicit public-enablement
  decision. Local preview availability does not authorize public deployment.

Do not advertise or enable public ASA swaps until those paths are implemented
and verified together. Contract compilation or mocked RPC wallet tests alone
do not establish end-to-end ASA/XMR support.
