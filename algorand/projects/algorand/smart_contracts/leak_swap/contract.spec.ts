import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it } from 'vitest'
import { Bytes, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
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
    for (const timestamp of boundaries) {
      for (const method of ['claim', 'refund', 'punish'] as const) {
        it(`${method} at ${timestamp}, ready=${ready}`, () => {
          const execution = ctx
          execution.ledger.patchGlobalData({ latestTimestamp: 100 })
          const contract = execution.contract.create(LeakSwap)
          const ali = execution.defaultSender
          const xin = execution.any.account()
          const aliSecret = hexToUint8Array(genPrivateSpendKey())
          const xinSecret = hexToUint8Array(genPrivateSpendKey())
          execution.txn.createScope([execution.any.txn.applicationCall({ appId: contract, sender: ali })])
            .execute(() => contract.createApplication(Bytes(getPK(aliSecret)), xin, Bytes(getPK(xinSecret)), 1000, 2000))
          const sponsor = () => execution.any.txn.payment({ fee: 0 })
          if (ready) execution.txn.createScope([execution.any.txn.applicationCall({ appId: contract, sender: ali })])
            .execute(() => contract.setReady(sponsor()))
          execution.ledger.patchGlobalData({ latestTimestamp: timestamp })
          expect(contract.getContractState()).toEqual(timestamp >= 2000 ? LeakSwapState.T1Passed
            : timestamp > 1000 ? LeakSwapState.T0Passed : ready ? LeakSwapState.Ready : LeakSwapState.NotReady)
          const address = Buffer.from(execution.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex')
          const allowed = method === 'claim' ? (ready || timestamp > 1000) && timestamp < 2000
            : method === 'refund' ? !ready && timestamp <= 1000 : timestamp >= 2000
          const action = () => execution.txn.createScope([execution.any.txn.applicationCall({
            appId: contract, sender: method === 'claim' ? xin : ali, onCompletion: OnCompleteAction.DeleteApplication,
          })]).execute(() => {
            if (method === 'claim') contract.leakyClaim(Bytes(leakySign(address, xinSecret)), sponsor())
            else if (method === 'refund') contract.leakyRefund(Bytes(leakySign(address, aliSecret)), sponsor())
            else contract.punishRefund(sponsor())
          })
          if (allowed) expect(action).not.toThrow()
          else expect(action).toThrow()
          execution.ledger.patchGlobalData({ latestTimestamp: 0 })
          execution.txn.createScope([execution.any.txn.applicationCall({ appId: contract, sender: ali })]).execute(() => {})
        })
      }
    }
  }

  const ctx = new TestExecutionContext()
  for (const t0 of [999, 1000, 1001]) {
    it(`deployment uses committed chain time 1000, not browser time: t0=${t0}`, () => {
      ctx.ledger.patchGlobalData({ latestTimestamp: 1000 })
      const contract = ctx.contract.create(LeakSwap)
      const create = () => ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })])
        .execute(() => contract.createApplication(Bytes(new Uint8Array(32)), ctx.any.account(), Bytes(new Uint8Array(32)), t0, t0 + 1))
      try {
        if (t0 <= 1000) expect(create).toThrow('t0 must be in the future')
        else expect(create).not.toThrow()
      } finally {
        ctx.ledger.patchGlobalData({ latestTimestamp: 0 })
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })]).execute(() => {})
      }
    })
  }

  it('a stalled chain does not advance expiry; a resumed timestamp may skip the claim window', () => {
    ctx.ledger.patchGlobalData({ latestTimestamp: 100 })
    const contract = ctx.contract.create(LeakSwap)
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })])
      .execute(() => contract.createApplication(Bytes(new Uint8Array(32)), ctx.any.account(), Bytes(new Uint8Array(32)), 1000, 2000))
    try {
      ctx.ledger.patchGlobalData({ latestTimestamp: 999 })
      expect(contract.getContractState()).toEqual(LeakSwapState.NotReady)
      expect(contract.getContractState()).toEqual(LeakSwapState.NotReady)
      ctx.ledger.patchGlobalData({ latestTimestamp: 2000 })
      expect(contract.getContractState()).toEqual(LeakSwapState.T1Passed)
    } finally {
      ctx.ledger.patchGlobalData({ latestTimestamp: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract })]).execute(() => {})
    }
  })

  const aliAlgoAddr = ctx.defaultSender
  const xinAlgoAddr = ctx.any.account()
  // Mock of the fee-sponsor LogicSig's payment, paired with each sponsored call
  const sponsorPayment = () => ctx.any.txn.payment({ fee: 0 })
  const settle = (contract: LeakSwap, sender: typeof aliAlgoAddr, action: () => void) =>
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender, onCompletion: OnCompleteAction.DeleteApplication })]).execute(action)

  it('rejects an ordinary valid Xin signature even with the correct public key and application address', () => {
    ctx.ledger.patchGlobalData({ latestTimestamp: 100 })
    const contract = ctx.contract.create(LeakSwap)
    const ordinaryKeys = ed25519.keygen()
    const aliSecret = hexToUint8Array(genPrivateSpendKey())
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: aliAlgoAddr })]).execute(() => {
      contract.createApplication(Bytes(getPK(aliSecret)), xinAlgoAddr, Bytes(ordinaryKeys.publicKey), 1000, 2000)
      contract.setReady(sponsorPayment())
    })
    const address = Buffer.from(ctx.ledger.getApplicationForContract(contract).address.bytes as unknown as string, 'hex')
    const signature = ed25519.sign(address, ordinaryKeys.secretKey)
    expect(ed25519.verify(signature, address, ordinaryKeys.publicKey)).toBe(true)
    expect(() => settle(contract, xinAlgoAddr, () => contract.leakyClaim(Bytes(signature), sponsorPayment())))
      .toThrow('Signature R must be broken')
    ctx.ledger.patchGlobalData({ latestTimestamp: 0 })
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: aliAlgoAddr })]).execute(() => {})
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
    const t0 = Date.now() + 3600 * 1000 // 1 hour from current time
    const t1 = t0 + 1800 * 1000 // 30 minutes after t0

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
    ctx.txn.createScope([
      ctx.any.txn.applicationCall({
        appId: contract,
        sender: aliAlgoAddr,
      })
    ]).execute(() => contract.setReady(sponsorPayment()))

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

  it('LeakSwap: T0 TimeOut Path', async () => {
    const contract = ctx.contract.create(LeakSwap)

    const aliXternalSK = hexToUint8Array(genPrivateSpendKey())
    const aliXternalPK = getPK(aliXternalSK)
    const xinXternalSK = hexToUint8Array(genPrivateSpendKey())
    const xinXternalPK = getPK(xinXternalSK)
    const t0 = Date.now() + 3600 * 1000 // 1 hour from current time
    const t1 = t0 + 1800 * 1000 // 30 minutes after t0

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
    ctx.ledger.patchGlobalData({ latestTimestamp: t0 + 1 })

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
    const t0 = Date.now() + 3600 * 1000 // 1 hour from current time
    const t1 = t0 + 1800 * 1000 // 30 minutes after t0

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

  it('LeakSwap: T1 TimeOut PunishRefund Path', async () => {
    const contract = ctx.contract.create(LeakSwap)

    const aliXternalSK = hexToUint8Array(genPrivateSpendKey())
    const aliXternalPK = getPK(aliXternalSK)
    const xinXternalSK = hexToUint8Array(genPrivateSpendKey())
    const xinXternalPK = getPK(xinXternalSK)
    const t0 = Date.now() + 3600 * 1000 // 1 hour from current time
    const t1 = t0 + 1800 * 1000 // 30 minutes after t0

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

    // Xin does not call leakyClaim, so we simulate the passage of time to reach t1
    ctx.ledger.patchGlobalData({ latestTimestamp: t1 + 1 })

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
