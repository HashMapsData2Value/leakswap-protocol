import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { Bytes, Global, gtxn, OnCompleteAction, Uint64 } from '@algorandfoundation/algorand-typescript'
import { sponsorAddress } from './sponsor_address.algo'
import sponsorFixtures from './sponsor-address-fixtures.json'
import { Account } from '@algorandfoundation/algorand-typescript'
import { LeakSwap } from './contract.algo'
import { genPrivateSpendKey, getPK, leakySign, hexToUint8Array } from 'leakswap-utils'
import { ed25519 } from '@noble/curves/ed25519'

export enum LeakSwapState {
  NotReady = 0, // Contract is not ready
  Ready = 1, // Contract is ready (Ali has set it to ready)
  T0Passed = 2, // T0 has passed, Xin can claim
  T1Passed = 3, // T1 has passed, Ali can punish refund
}

describe('LeakSwap contract', () => {
  const boundaries = [999, 1000, 1001, 1999, 2000, 2001]
  for (const ready of [false, true]) {
    for (const round of boundaries) {
      for (const method of ['claim', 'refund', 'punish'] as const) {
        it(`${method} at round ${round}, ready=${ready}`, () => {
          const execution = ctx
          execution.ledger.patchGlobalData({ round: 100 })
          const contract = execution.contract.create(LeakSwap)
          const ali = execution.defaultSender
          const xin = execution.any.account()
          const aliSecret = hexToUint8Array(genPrivateSpendKey())
          const xinSecret = hexToUint8Array(genPrivateSpendKey())
          execution.txn.createScope([execution.any.txn.applicationCall({ appId: contract, sender: ali })])
            .execute(() => contract.createApplication(Bytes(getPK(aliSecret)), xin, Bytes(getPK(xinSecret)), 1000, 2000))
          const sponsor = sponsorPayment
          if (ready) readyCall(contract)
          execution.ledger.patchGlobalData({ round })
          expect(contract.getContractState()).toEqual(round >= 2000 ? LeakSwapState.T1Passed
            : round > 1000 ? LeakSwapState.T0Passed : ready ? LeakSwapState.Ready : LeakSwapState.NotReady)
          const address = Buffer.from(execution.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex')
          const allowed = method === 'claim' ? (ready || round > 1000) && round < 2000
            : method === 'refund' ? !ready && round <= 1000 : round >= 2000
          const action = () => settle(contract, method === 'claim' ? xin : ali, () => {
            if (method === 'claim') contract.leakyClaim(Bytes(leakySign(address, xinSecret)), sponsor())
            else if (method === 'refund') contract.leakyRefund(Bytes(leakySign(address, aliSecret)), sponsor())
            else contract.punishRefund(sponsor())
          })
          if (allowed) expect(action).not.toThrow()
          else expect(action).toThrow()
          execution.ledger.patchGlobalData({ round: 0 })
          execution.txn.createScope([execution.any.txn.applicationCall({ appId: contract, sender: ali })]).execute(() => { })
        })
      }
    }
  }

  const ctx = new TestExecutionContext()
  beforeEach(() => ctx.ledger.patchGlobalData({ round: 100, latestTimestamp: 100 }))
  for (const fixture of sponsorFixtures) {
    it(`derives the independently compiled sponsor for app ${fixture.appId}`, () => {
      const address = sponsorAddress(Uint64(BigInt(fixture.appId)), Account(Bytes.fromHex(fixture.ali)), Account(Bytes.fromHex(fixture.xin)))
      expect(address).toEqual(Account(Bytes.fromHex(fixture.address)))
    })
  }
  for (const method of ['ready', 'claim', 'refund', 'punish'] as const) {
    for (const attack of ['sender', 'prefix', 'suffix', 'reversed', 'payment-rekey', 'call-rekey', 'receiver', 'amount', 'close', 'fee'] as const) {
      it(`${method} rejects invalid sponsor ${attack}`, () => {
        ctx.ledger.patchGlobalData({ round: 100, minBalance: 100_000, minTxnFee: 1000 })
        const contract = ctx.contract.create(LeakSwap)
        const xin = ctx.any.account()
        const secret = hexToUint8Array(genPrivateSpendKey())
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })]).execute(() =>
          contract.createApplication(Bytes(getPK(secret)), xin, Bytes(getPK(secret)), 1000, 2000))
        const app = ctx.ledger.getApplicationForContract(contract)
        const ready = method === 'ready'
        const recipient = method === 'claim' ? xin : contract.aliAlgoAddr.value
        const stranger = ctx.any.account()
        const payment = ctx.any.txn.payment({
          sender: attack === 'sender' ? stranger : sponsorAddress(app.id, contract.aliAlgoAddr.value, xin),
          receiver: attack === 'receiver' ? stranger : recipient,
          fee: attack === 'fee' ? 1 : 0,
          amount: attack === 'amount' ? 1 : ready ? 102_000 : 0,
          closeRemainderTo: attack === 'close' ? stranger : ready ? Global.zeroAddress : recipient,
          rekeyTo: attack === 'payment-rekey' ? stranger : Global.zeroAddress,
        })
        const call = ctx.any.txn.applicationCall({ appId: contract, sender: recipient,
          onCompletion: ready ? OnCompleteAction.NoOp : OnCompleteAction.DeleteApplication,
          rekeyTo: attack === 'call-rekey' ? stranger : Global.zeroAddress,
        })
        const extra = ctx.any.txn.payment()
        const group = attack === 'prefix' ? [extra, payment, call] : attack === 'suffix' ? [payment, call, extra]
          : attack === 'reversed' ? [call, payment] : [payment, call]
        const execute = () => ctx.txn.createScope(group, attack === 'prefix' ? 2 : attack === 'reversed' ? 0 : 1).execute(() => {
          if (ready) contract.setReady(payment)
          else if (method === 'claim') contract.leakyClaim(Bytes(new Uint8Array(64)), payment)
          else if (method === 'refund') contract.leakyRefund(Bytes(new Uint8Array(64)), payment)
          else contract.punishRefund(payment)
        })
        expect(execute).toThrow(attack === 'sender' ? 'Payment must come from the designated sponsor'
          : attack === 'prefix' || attack === 'suffix' ? 'Sponsored group must contain exactly two transactions'
            : attack === 'reversed' ? 'Swap application call must be second'
              : attack === 'payment-rekey' ? 'Sponsor payment must not rekey'
                : attack === 'call-rekey' ? 'Swap application call must not rekey'
                  : attack === 'receiver' ? 'Wrong sponsor payment receiver'
                    : attack === 'amount' ? ready ? 'Wrong setReady funding amount' : 'Settlement sponsor payment must have zero amount'
                      : attack === 'close' ? ready ? 'Cannot close out for setReady' : 'Wrong sponsor close-out recipient'
                        : 'Sponsor payment must not pay a fee')
        expect(contract.aliReady.value).toBe(false)
        ctx.ledger.patchGlobalData({ round: 0 })
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })]).execute(() => {})
      })
    }
  }
  const treasury = ctx.any.account({ address: Bytes.fromHex('53221b015cfadb890ec7d16db87c2bc96ea3de91c9b72ad1cd384e6eb1e16874'), balance: 0, minBalance: 0 })
  for (const [escrow, treasuryBalance, treasuryMinimum, expectedFee] of [
    [5_000_000n, 0n, 0n, 0n],
    [19_999_999n, 0n, 0n, 0n],
    [20_000_000n, 0n, 0n, 100_000n],
    [5_000_199n, 100_000n, 100_000n, 25_000n],
    [5_000_200n, 100_000n, 100_000n, 25_001n],
    [5_000_000n, 200_000n, 200_000n, 25_000n],
    [100_000n, 100_000n, 100_000n, 0n],
    [100_501n, 100_000n, 100_000n, 0n],
    [100_502n, 100_000n, 100_000n, 502n],
    [100_503n, 100_000n, 100_000n, 502n],
    [18_446_744_073_709_551_615n, 100_000n, 100_000n, 92_233_720_368_547_758n],
  ]) {
    it(`claim fee: escrow=${escrow}, treasury=${treasuryBalance}/${treasuryMinimum}`, () => {
      const execution = ctx
      execution.ledger.patchGlobalData({ round: 100, minBalance: 100_000 })
      execution.ledger.patchAccountData(treasury, { account: { balance: Uint64(treasuryBalance), minBalance: Uint64(treasuryMinimum) } })
      const contract = execution.contract.create(LeakSwap)
      const xin = execution.any.account()
      const xinSecret = hexToUint8Array(genPrivateSpendKey())
      execution.txn.createScope([execution.any.txn.applicationCall({ appId: contract })]).execute(() => {
        contract.createApplication(Bytes(new Uint8Array(32)), xin, Bytes(getPK(xinSecret)), 1000, 2000)
      })
      readyCall(contract)
      const app = execution.ledger.getApplicationForContract(contract)
      execution.ledger.patchAccountData(app.address, { account: { balance: Uint64(escrow) } })
      const signature = leakySign(Buffer.from(app.address.bytes as unknown as string, 'hex'), xinSecret)
      settle(contract, xin, () => contract.leakyClaim(Bytes(signature), sponsorPayment()))
      const payments = execution.txn.lastGroup.itxnGroups.flatMap((group) => group.itxns)
        .filter((transaction) => Number(transaction.type) === 1)
      expect(payments).toHaveLength(expectedFee > 0n ? 2 : 1)
      if (expectedFee > 0n) {
        const payment = execution.txn.lastGroup.getItxnGroup(0).getPaymentInnerTxn()
        expect(payment.receiver).toEqual(treasury)
        expect(BigInt(payment.amount.toString())).toEqual(expectedFee)
        expect(Number(payment.fee)).toEqual(0)
      }
      expect(execution.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn().closeRemainderTo).toEqual(xin)
      execution.ledger.patchGlobalData({ round: 0 })
      execution.ledger.patchAccountData(treasury, { account: { balance: Uint64(0), minBalance: Uint64(0) } })
      execution.txn.createScope([execution.any.txn.applicationCall({ appId: contract })]).execute(() => { })
    })
  }
  for (const t0 of [999, 1000, 1001]) {
    it(`deployment requires t0 after committed round 1000: t0=${t0}`, () => {
      ctx.ledger.patchGlobalData({ round: 1000 })
      const contract = ctx.contract.create(LeakSwap)
      const create = () => ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })])
        .execute(() => contract.createApplication(Bytes(new Uint8Array(32)), ctx.any.account(), Bytes(new Uint8Array(32)), t0, t0 + 1))
      try {
        if (t0 <= 1000) expect(create).toThrow('t0 must be in the future')
        else expect(create).not.toThrow()
      } finally {
        ctx.ledger.patchGlobalData({ round: 0 })
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })]).execute(() => { })
      }
    })
  }

  for (const resumedRound of [999, 1000]) {
    it(`Ready survives a huge chain-halt timestamp jump at round ${resumedRound}; punish fails and Xin can claim`, () => {
      ctx.ledger.patchGlobalData({ round: 999, latestTimestamp: 100 })
      const contract = ctx.contract.create(LeakSwap)
      const ali = ctx.defaultSender
      const xin = ctx.any.account()
      const xinSecret = hexToUint8Array(genPrivateSpendKey())
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: ali })])
        .execute(() => contract.createApplication(Bytes(new Uint8Array(32)), xin, Bytes(getPK(xinSecret)), 1000, 2000))
      readyCall(contract)
      expect(contract.getContractState()).toEqual(LeakSwapState.Ready)
      ctx.ledger.patchGlobalData({ round: resumedRound, latestTimestamp: 4_000_000_000 })
      expect(contract.getContractState()).toEqual(LeakSwapState.Ready)
      expect(() => settle(contract, ali, () => contract.punishRefund(sponsorPayment())))
        .toThrow('Cannot punish refund before t1!')
      expect(contract.getContractState()).toEqual(LeakSwapState.Ready)
      const address = Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex')
      expect(() => settle(contract, xin, () => contract.leakyClaim(Bytes(leakySign(address, xinSecret)), sponsorPayment())))
        .not.toThrow()
      expect(ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn().closeRemainderTo).toEqual(xin)
    })
  }

  const aliAlgoAddr = ctx.defaultSender
  const xinAlgoAddr = ctx.any.account()
  // Mock of the fee-sponsor LogicSig's payment, paired with each sponsored call
  const sponsorPayment = () => gtxn.PaymentTxn(0)
  const paymentFor = (contract: LeakSwap, recipient = contract.aliAlgoAddr.value, ready = false) => ctx.any.txn.payment({ fee: 0,
    receiver: recipient, amount: ready ? Global.minBalance + Global.minTxnFee * 2 : 0,
    closeRemainderTo: ready ? Global.zeroAddress : recipient,
    sender: sponsorAddress(ctx.ledger.getApplicationForContract(contract).id, contract.aliAlgoAddr.value, contract.xinAlgoAddr.value),
  })
  const readyCall = (contract: LeakSwap) => ctx.txn.createScope([
    paymentFor(contract, contract.aliAlgoAddr.value, true), ctx.any.txn.applicationCall({ appId: contract, sender: contract.aliAlgoAddr.value }),
  ], 1).execute(() => contract.setReady(sponsorPayment()))
  const settle = (contract: LeakSwap, sender: typeof aliAlgoAddr, action: () => void) =>
    ctx.txn.createScope([paymentFor(contract, sender), ctx.any.txn.applicationCall({ appId: contract, sender, onCompletion: OnCompleteAction.DeleteApplication })], 1).execute(action)

  it('rejects an ordinary valid Xin signature even with the correct public key and application address', () => {
    ctx.ledger.patchGlobalData({ round: 100 })
    const contract = ctx.contract.create(LeakSwap)
    const ordinaryKeys = ed25519.keygen()
    const aliSecret = hexToUint8Array(genPrivateSpendKey())
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: aliAlgoAddr })]).execute(() => {
      contract.createApplication(Bytes(getPK(aliSecret)), xinAlgoAddr, Bytes(ordinaryKeys.publicKey), 1000, 2000)
    })
    readyCall(contract)
    const address = Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex')
    const signature = ed25519.sign(address, ordinaryKeys.secretKey)
    expect(ed25519.verify(signature, address, ordinaryKeys.publicKey)).toBe(true)
    expect(() => settle(contract, xinAlgoAddr, () => contract.leakyClaim(Bytes(signature), sponsorPayment())))
      .toThrow('Signature R must be broken')
    ctx.ledger.patchGlobalData({ round: 0 })
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: aliAlgoAddr })]).execute(() => { })
  })

  it('testleakySign method in contract', () => {
    const contract = ctx.contract.create(LeakSwap)

    const a = hexToUint8Array(genPrivateSpendKey())
    const pk = getPK(a);

    const messageBytes = Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex')

    const signature = leakySign(messageBytes, a)

    contract.verifySignature(Bytes(signature), Bytes(pk))


    // Test that non-broken, aka a proper signature, fails:
    const { secretKey: k, publicKey: K } = ed25519.keygen()
    expect(() => {
      contract.verifySignature(Bytes(ed25519.sign(messageBytes, k)), Bytes(K))
    }).toThrow('R-point encoding not 0x58666... . Signature R must be broken (=BASEPOINT) to allow the secret key to be leaked!')

    // Test corrupted signature (in the R-value):
    const corruptedSignatureR = new Uint8Array(signature)
    corruptedSignatureR[15] = 0
    expect(() => {
      contract.verifySignature(Bytes(corruptedSignatureR), Bytes(pk))
    }).toThrow('R-point encoding not 0x58666... . Signature R must be broken (=BASEPOINT) to allow the secret key to be leaked!')

    // Test corrupted signature (in the S-value):
    const corruptedSignatureS = new Uint8Array(signature)
    corruptedSignatureS[55] = 0
    expect(() => {
      contract.verifySignature(Bytes(corruptedSignatureS), Bytes(pk))
    }).toThrow('Signature verification failed')

    // Test wrong PK:
    const corruptedPK = new Uint8Array(pk)
    corruptedPK[0] = 0
    expect(() => {
      contract.verifySignature(Bytes(signature), Bytes(corruptedPK))
    }).toThrow('Signature verification failed')
  })


  it('LeakSwap: Simple Happy Path', async () => {
    const contract = ctx.contract.create(LeakSwap)

    const aliXternalSK = hexToUint8Array(genPrivateSpendKey())
    const aliXternalPK = getPK(aliXternalSK)
    const xinXternalSK = hexToUint8Array(genPrivateSpendKey())
    const xinXternalPK = getPK(xinXternalSK)
    const t0 = 1000
    const t1 = 2000

    // Create application with the specified parameters
    contract.createApplication(
      Bytes(aliXternalPK),
      xinAlgoAddr,
      Bytes(xinXternalPK),
      t0,
      t1,
    )

    // Expect aliAlgoAddr to be the creator address
    expect(contract.aliAlgoAddr.value).toEqual(ctx.ledger.getApplicationForContract(contract).creator)
    expect(contract.getContractState()).toEqual(LeakSwapState.NotReady)

    // * <-- Xin *does* lock up funds in the combined Monero account --> *

    // Xin's leaky signature - convert contract address hex to bytes
    const xinSignature = leakySign(
      Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex'),
      xinXternalSK
    )

    // Ali sets the contract to ready state
    readyCall(contract)

    // Now the contract should be in ready state
    expect(contract.getContractState()).toEqual(LeakSwapState.Ready)

    // Ali, maliciously, tries to call leakyRefund
    // It should of course fail since the contract is in ready state
    const aliSignature = leakySign(
      Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex'),
      aliXternalSK
    )
    expect(() => {
      settle(contract, aliAlgoAddr, () => contract.leakyRefund(Bytes(aliSignature), sponsorPayment()))
    }).toThrow('Cannot refund after set ready!')

    // Ali, maliciously, tries to call punishRefund
    // It should of course fail since the contract t1 has not passed yet
    expect(() => {
      settle(contract, aliAlgoAddr, () => contract.punishRefund(sponsorPayment()))
    }).toThrow('Cannot punish refund before t1!')

    // Xin successfully claims the funds
    settle(contract, xinAlgoAddr, () => contract.leakyClaim(Bytes(xinSignature), sponsorPayment()))

    // Should be in some final state, e.g. funds are empty, contract deleted, added a 5th "complete" state that gets returned, etc
  })

  it('LeakSwap: claim after round t0 without setReady', async () => {
    const contract = ctx.contract.create(LeakSwap)

    const aliXternalSK = hexToUint8Array(genPrivateSpendKey())
    const aliXternalPK = getPK(aliXternalSK)
    const xinXternalSK = hexToUint8Array(genPrivateSpendKey())
    const xinXternalPK = getPK(xinXternalSK)
    const t0 = 1000
    const t1 = 2000

    // Create application with the specified parameters
    contract.createApplication(
      Bytes(aliXternalPK),
      xinAlgoAddr,
      Bytes(xinXternalPK),
      t0,
      t1,
    )

    // Expect aliAlgoAddr to be the creator address
    expect(contract.aliAlgoAddr.value).toEqual(ctx.ledger.getApplicationForContract(contract).creator)
    expect(contract.getContractState()).toEqual(LeakSwapState.NotReady)

    // * <-- Xin does or does not lock up funds in the combined Monero account --> *

    // Xin's leaky signature - convert contract address hex to bytes
    const xinSignature = leakySign(
      Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex'),
      xinXternalSK
    )

    // Let's test out some error cases

    // It should fail since we are not calling from Xin's account
    expect(() => {
      settle(contract, aliAlgoAddr, () => contract.leakyClaim(Bytes(xinSignature), sponsorPayment()))
    }).toThrow('Only Xin can do leaky claim')

    // should error out
    // Xin tries to premptively call leakyClaim before contract in ready state
    // This should fail since the contract is not ready yet
    expect(() => {
      settle(contract, xinAlgoAddr, () => contract.leakyClaim(Bytes(xinSignature), sponsorPayment()))
    }).toThrow('Cannot claim: time must be past t0 OR Ali must have set ready!')
    // Should still be in initial state
    expect(contract.getContractState()).toEqual(LeakSwapState.NotReady)

    // Ali does not set ready so Xin waits until t0 passes
    ctx.ledger.patchGlobalData({ round: t0 + 1 })

    // Now the contract should be in T0 Passed state
    expect(contract.getContractState()).toEqual(LeakSwapState.T0Passed)

    // Ali, in a panic, tries to call leakyRefund
    // This should fail since the contract has already passed t0
    const aliSignature = leakySign(
      Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex'),
      aliXternalSK
    )
    expect(() => {
      settle(contract, aliAlgoAddr, () => contract.leakyRefund(Bytes(aliSignature), sponsorPayment()))
    }).toThrow('Cannot refund after t0!')

    // Xin successfully claims the funds
    settle(contract, xinAlgoAddr, () => contract.leakyClaim(Bytes(xinSignature), sponsorPayment()))

    // Should be in some final state, e.g. funds are empty, contract deleted, added a 5th "complete" state that gets returned, etc
  })


  it('LeakSwap: Ali Leaky Refunds', async () => {
    const contract = ctx.contract.create(LeakSwap)

    const aliXternalSK = hexToUint8Array(genPrivateSpendKey())
    const aliXternalPK = getPK(aliXternalSK)
    const xinXternalSK = hexToUint8Array(genPrivateSpendKey())
    const xinXternalPK = getPK(xinXternalSK)
    const t0 = 1000
    const t1 = 2000

    // Create application with the specified parameters
    contract.createApplication(
      Bytes(aliXternalPK),
      xinAlgoAddr,
      Bytes(xinXternalPK),
      t0,
      t1,
    )

    // Expect aliAlgoAddr to be the creator address
    expect(contract.aliAlgoAddr.value).toEqual(ctx.ledger.getApplicationForContract(contract).creator)
    expect(contract.getContractState()).toEqual(LeakSwapState.NotReady)

    // * <-- Xin does not lock up funds in the combined Monero account --> *

    // Ali's leaky signature - convert contract address hex to bytes
    const aliSignature = leakySign(
      Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex'),
      aliXternalSK
    )

    // Ali calls leakyRefund
    settle(contract, aliAlgoAddr, () => contract.leakyRefund(Bytes(aliSignature), sponsorPayment()))

    // Should be in some final state, e.g. funds are empty, contract deleted, added a 5th "complete" state that gets returned, etc
  })

  it('LeakSwap: punish refund at round t1', async () => {
    const contract = ctx.contract.create(LeakSwap)

    const aliXternalSK = hexToUint8Array(genPrivateSpendKey())
    const aliXternalPK = getPK(aliXternalSK)
    const xinXternalSK = hexToUint8Array(genPrivateSpendKey())
    const xinXternalPK = getPK(xinXternalSK)
    const t0 = 1000
    const t1 = 2000

    // Create application with the specified parameters
    contract.createApplication(
      Bytes(aliXternalPK),
      xinAlgoAddr,
      Bytes(xinXternalPK),
      t0,
      t1,
    )

    // Expect aliAlgoAddr to be the creator address
    expect(contract.aliAlgoAddr.value).toEqual(ctx.ledger.getApplicationForContract(contract).creator)
    expect(contract.getContractState()).toEqual(LeakSwapState.NotReady)

    // * <-- Xin does or does not lock up funds in the combined Monero account --> *

    // Xin does not call leakyClaim, so advance the round to t1
    ctx.ledger.patchGlobalData({ round: t1 })

    // Now the contract should be in T1 passed state
    expect(contract.getContractState()).toEqual(LeakSwapState.T1Passed)

    const xinSignature = leakySign(
      Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex'),
      xinXternalSK
    )

    // Xin tries and fails to claim the funds
    expect(() => {
      settle(contract, xinAlgoAddr, () => contract.leakyClaim(Bytes(xinSignature), sponsorPayment()))
    }).toThrow('Cannot claim after t1!')

    // Ali successfully punishes refund
    settle(contract, aliAlgoAddr, () => contract.punishRefund(sponsorPayment()))

    // Should be in some final state, e.g. funds are empty, contract deleted, added a 5th "complete" state that gets returned, etc
  })

})
