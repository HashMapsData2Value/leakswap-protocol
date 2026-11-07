import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { Account, Bytes, Global, OnCompleteAction, Uint64 } from '@algorandfoundation/algorand-typescript'
import { beforeEach, describe, expect, it } from 'vitest'
import { genPrivateSpendKey, getPK, hexToUint8Array, leakySign } from 'leakswap-utils'
import { AsaLeakSwap } from './contract.algo'
import { asaSponsorAddress } from './sponsor_address.algo'
import fixtures from './sponsor-address-fixtures.json'

const networks = {
  mainnet: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  testnet: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
  betanet: 'mFgazF+2uRS1tMiL9dsj01hJGySEmPN28B/TjjvpVW0=',
}

describe('curated ASA escrow', () => {
  const ctx = new TestExecutionContext()
  beforeEach(() => {
    ctx.reset()
    ctx.defaultSender = ctx.any.account()
    ctx.ledger.patchGlobalData({
      round: 100,
      minTxnFee: 1000,
      minBalance: 100_000,
      assetOptInMinBalance: 100_000,
      genesisHash: Bytes.fromBase64(networks.testnet),
    })
  })

  function fixture(quantity = 1_000_199n, id = 10458941, network: keyof typeof networks = 'testnet') {
    ctx.ledger.patchGlobalData({ genesisHash: Bytes.fromBase64(networks[network]) })
    const contract = ctx.contract.create(AsaLeakSwap)
    const ali = ctx.defaultSender
    const xin = ctx.any.account()
    const asset = ctx.any.asset({ assetId: id, decimals: Uint64(6), defaultFrozen: false })
    const aliSecret = hexToUint8Array(genPrivateSpendKey())
    const xinSecret = hexToUint8Array(genPrivateSpendKey())
    ctx.txn
      .createScope([ctx.any.txn.applicationCall({ appId: contract })])
      .execute(() =>
        contract.createApplication(
          Bytes(getPK(aliSecret)),
          xin,
          Bytes(getPK(xinSecret)),
          1000,
          2000,
          asset,
          Uint64(quantity),
        ),
      )
    const app = ctx.ledger.getApplicationForContract(contract)
    ctx.ledger.patchAccountData(app.address, { account: { balance: Uint64(200_000), minBalance: Uint64(100_000) } })
    const funding = ctx.any.txn.payment({ sender: ali, receiver: app.address, amount: 200_000 })
    ctx.txn
      .createScope([funding, ctx.any.txn.applicationCall({ appId: contract })], 1)
      .execute(() => contract.initializeEscrow(funding))
    ctx.ledger.updateAssetHolding(app.address, asset, quantity, false)
    ctx.ledger.updateAssetHolding(ali, asset, 0, false)
    ctx.ledger.updateAssetHolding(xin, asset, 0, false)
    const treasury = ctx.any.account({
      address: Bytes.fromHex('53221b015cfadb890ec7d16db87c2bc96ea3de91c9b72ad1cd384e6eb1e16874'),
      balance: Uint64(100_000),
      minBalance: Uint64(100_000),
    })
    const sponsor = asaSponsorAddress(app.id, ali, xin)
    return { contract, app, ali, xin, asset, aliSecret, xinSecret, treasury, sponsor }
  }

  function settle(
    state: ReturnType<typeof fixture>,
    method: 'claim' | 'refund' | 'punish',
    optIn = false,
    attack = '',
  ) {
    const recipient = method === 'claim' ? state.xin : state.ali
    const stranger = ctx.any.account()
    const payment = ctx.any.txn.payment({
      sender: attack === 'sponsor' ? stranger : state.sponsor,
      receiver: attack === 'receiver' ? stranger : recipient,
      amount: attack === 'amount' ? 1 : 0,
      fee: attack === 'fee' ? 1 : 0,
      closeRemainderTo: attack === 'close' ? stranger : recipient,
      rekeyTo: attack === 'rekey' ? stranger : Global.zeroAddress,
    })
    const transfer = ctx.any.txn.assetTransfer({
      sender: attack === 'opt-sender' ? stranger : recipient,
      assetReceiver: attack === 'opt-receiver' ? stranger : recipient,
      xferAsset: attack === 'opt-asset' ? ctx.any.asset() : state.asset,
      assetAmount: attack === 'opt-amount' ? 1 : 0,
      fee: attack === 'opt-fee' ? 1 : 0,
      assetCloseTo: attack === 'opt-close' ? stranger : Global.zeroAddress,
      assetSender: attack === 'opt-clawback' ? stranger : Global.zeroAddress,
      rekeyTo: attack === 'opt-rekey' ? stranger : Global.zeroAddress,
    })
    const call = ctx.any.txn.applicationCall({
      appId: state.contract,
      sender: attack === 'caller' ? stranger : recipient,
      onCompletion: OnCompleteAction.DeleteApplication,
      rekeyTo: attack === 'call-rekey' ? stranger : Global.zeroAddress,
    })
    const group = optIn ? [payment, transfer, call] : [payment, call]
    if (attack === 'suffix') group.push(ctx.any.txn.payment())
    return ctx.txn.createScope(group, optIn ? 2 : 1).execute(() => {
      const signature = Bytes(
        leakySign(
          Buffer.from(state.app.address.bytes as unknown as string, 'hex'),
          method === 'claim' ? state.xinSecret : state.aliSecret,
        ),
      )
      if (method === 'claim') state.contract.leakyClaim(signature)
      else if (method === 'refund') state.contract.leakyRefund(signature)
      else state.contract.punishRefund()
    })
  }

  for (const [network, ids] of Object.entries({
    mainnet: [31566704, 246516580, 246519683],
    testnet: [10458941],
    betanet: [],
  })) {
    for (const id of [31566704, 246516580, 246519683, 10458941, 12345]) {
      it(`${network} accepts only its curated asset IDs: ${id}`, () => {
        const create = () => fixture(1_000_000n, id, network as keyof typeof networks)
        if ((ids as number[]).includes(id)) expect(create).not.toThrow()
        else expect(create).toThrow('Asset is not curated on this network')
      })
    }
  }

  for (const fixture of fixtures) {
    it(`ASA sponsor address matches separately compiled app ${fixture.appId}`, () => {
      expect(
        asaSponsorAddress(
          Uint64(BigInt(fixture.appId)),
          Account(Bytes.fromHex(fixture.ali)),
          Account(Bytes.fromHex(fixture.xin)),
        ),
      ).toEqual(Account(Bytes.fromHex(fixture.address)))
    })
  }

  it('initialization opts into the exact ASA and cannot run twice', () => {
    const state = fixture()
    expect(state.contract.initialized.value).toBe(true)
    const optIn = ctx.txn.lastGroup.lastItxnGroup().getAssetTransferInnerTxn()
    expect(optIn.xferAsset).toEqual(state.asset)
    expect(Number(optIn.assetAmount)).toBe(0)
    expect(optIn.assetReceiver).toEqual(state.app.address)
    const funding = ctx.any.txn.payment({ sender: state.ali, receiver: state.app.address })
    expect(() =>
      ctx.txn
        .createScope([funding, ctx.any.txn.applicationCall({ appId: state.contract })], 1)
        .execute(() => state.contract.initializeEscrow(funding)),
    ).toThrow('Escrow is already initialized')
  })

  for (const ready of [false, true]) {
    for (const round of [999, 1000, 1001, 1999, 2000, 2001]) {
      for (const method of ['claim', 'refund', 'punish'] as const) {
        it(`${method} round=${round}, ready=${ready}`, () => {
          const state = fixture()
          state.contract.aliReady.value = ready
          ctx.ledger.patchGlobalData({ round })
          const allowed =
            method === 'claim'
              ? (ready || round > 1000) && round < 2000
              : method === 'refund'
                ? !ready && round <= 1000
                : round >= 2000
          if (allowed) expect(() => settle(state, method)).not.toThrow()
          else expect(() => settle(state, method)).toThrow()
        })
      }
    }
  }

  for (const quantity of [1n, 199n, 200n, 201n, 1_000_199n, 1_000_200n, 18_446_744_073_709_551_615n]) {
    for (const eligibility of ['opted-in', 'missing', 'frozen']) {
      it(`claim quantity=${quantity}, treasury=${eligibility}`, () => {
        const state = fixture(quantity)
        ctx.ledger.patchGlobalData({ round: 1001 })
        if (eligibility !== 'missing')
          ctx.ledger.updateAssetHolding(state.treasury, state.asset, 0, eligibility === 'frozen')
        settle(state, 'claim', true)
        const transfers = ctx.txn.lastGroup.itxnGroups
          .flatMap((group) => group.itxns)
          .filter((transaction) => 'assetReceiver' in transaction)
        const fee = eligibility === 'opted-in' ? quantity / 200n : 0n
        expect(transfers).toHaveLength(fee > 0n ? 2 : 1)
        if (fee > 0n) {
          expect(transfers[0].assetReceiver).toEqual(state.treasury)
          expect(BigInt(transfers[0].assetAmount.toString())).toBe(fee)
          expect(Number(transfers[0].fee)).toBe(0)
        }
        expect(transfers[transfers.length - 1]?.assetCloseTo).toEqual(state.xin)
        expect(transfers[transfers.length - 1]?.xferAsset).toEqual(state.asset)
        expect(ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn().closeRemainderTo).toEqual(state.ali)
      })
    }
  }

  for (const attack of [
    'sponsor',
    'receiver',
    'amount',
    'fee',
    'close',
    'rekey',
    'caller',
    'call-rekey',
    'suffix',
    'opt-sender',
    'opt-receiver',
    'opt-asset',
    'opt-amount',
    'opt-fee',
    'opt-close',
    'opt-clawback',
    'opt-rekey',
  ]) {
    it(`rejects settlement attack: ${attack}`, () => {
      const state = fixture()
      ctx.ledger.patchGlobalData({ round: 1001 })
      expect(() => settle(state, 'claim', true, attack)).toThrow()
    })
  }

  for (const failure of ['underfunded', 'escrow-frozen', 'recipient-frozen']) {
    it(`does not settle unavailable funds: ${failure}`, () => {
      const state = fixture()
      ctx.ledger.patchGlobalData({ round: 1001 })
      ctx.ledger.updateAssetHolding(
        state.app.address,
        state.asset,
        failure === 'underfunded' ? 1 : 1_000_199,
        failure === 'escrow-frozen',
      )
      ctx.ledger.updateAssetHolding(state.xin, state.asset, 0, failure === 'recipient-frozen')
      expect(() => settle(state, 'claim')).toThrow()
    })
  }

  for (const method of ['refund', 'punish'] as const) {
    for (const attack of [
      'sponsor',
      'receiver',
      'close',
      'caller',
      'call-rekey',
      'suffix',
      'opt-asset',
      'opt-clawback',
    ]) {
      it(`${method} rejects settlement attack: ${attack}`, () => {
        const state = fixture()
        if (method === 'punish') ctx.ledger.patchGlobalData({ round: 2000 })
        expect(() => settle(state, method, true, attack)).toThrow()
      })
    }
    for (const frozen of ['escrow', 'recipient'] as const) {
      it(`${method} rejects a frozen ${frozen} holding even with a recipient self-opt-in`, () => {
        const state = fixture()
        if (method === 'punish') ctx.ledger.patchGlobalData({ round: 2000 })
        ctx.ledger.updateAssetHolding(frozen === 'escrow' ? state.app.address : state.ali, state.asset, 0, true)
        expect(() => settle(state, method, true)).toThrow()
      })
    }
    for (const deposited of [0, 100, 1_000_199, 2_000_398]) {
      for (const optIn of [false, true]) {
        it(`${method} returns empty, partial, full or surplus funding ${deposited} without a fee; opt-in=${optIn}`, () => {
          const state = fixture()
          if (method === 'punish') ctx.ledger.patchGlobalData({ round: 2000 })
          ctx.ledger.updateAssetHolding(state.app.address, state.asset, deposited, false)
          ctx.ledger.updateAssetHolding(state.treasury, state.asset, 0, false)
          settle(state, method, optIn)
          const transfers = ctx.txn.lastGroup.itxnGroups
            .flatMap((group) => group.itxns)
            .filter((transaction) => 'assetReceiver' in transaction)
          expect(transfers).toHaveLength(1)
          expect(transfers[0].xferAsset).toEqual(state.asset)
          expect(Number(transfers[0].assetAmount)).toBe(0)
          expect(transfers[0].assetCloseTo).toEqual(state.ali)
          expect(Number(transfers[0].fee)).toBe(0)
          const reserve = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
          expect(reserve.receiver).toEqual(state.ali)
          expect(reserve.closeRemainderTo).toEqual(state.ali)
          expect(Number(reserve.fee)).toBe(0)
        })
      }
    }
  }
})
