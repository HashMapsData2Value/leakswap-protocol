import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { arc4, Global, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { beforeEach, describe, expect, it } from 'vitest'
import { AsaFeeSponsorLSig } from './sponsor_lsig.algo'

describe('ASA sponsor', () => {
  const ctx = new TestExecutionContext()
  beforeEach(() => {
    ctx.reset()
    ctx.ledger.patchGlobalData({ minBalance: 100_000, minTxnFee: 1000 })
  })
  for (const method of ['ready', 'claim', 'refund', 'punish'] as const) {
    for (const attack of [
      'none',
      'prefix',
      'suffix',
      'reverse',
      'wrong-app',
      'caller',
      'receiver',
      'close',
      'amount',
      'fee',
      'rekey',
      'call-rekey',
      'completion',
      'selector',
    ]) {
      it(`${method}: ${attack}`, () => {
        const ali = ctx.any.account()
        const xin = ctx.any.account()
        const stranger = ctx.any.account()
        const app = ctx.any.application()
        ctx.setTemplateVar('APP_ID', app.id)
        ctx.setTemplateVar('ALI_ADDR', ali)
        ctx.setTemplateVar('XIN_ADDR', xin)
        const recipient = method === 'claim' ? xin : ali
        const ready = method === 'ready'
        const payment = ctx.any.txn.payment({
          receiver: attack === 'receiver' ? stranger : recipient,
          closeRemainderTo: attack === 'close' ? stranger : ready ? Global.zeroAddress : recipient,
          amount: attack === 'amount' ? 1 : ready ? 102_000 : 0,
          fee: attack === 'fee' ? 1 : 0,
          rekeyTo: attack === 'rekey' ? stranger : Global.zeroAddress,
        })
        const signature = ready
          ? 'setReady(pay)void'
          : method === 'claim'
            ? 'leakyClaim(byte[])void'
            : method === 'refund'
              ? 'leakyRefund(byte[])void'
              : 'punishRefund()void'
        const call = ctx.any.txn.applicationCall({
          appId: attack === 'wrong-app' ? ctx.any.application() : app,
          sender: attack === 'caller' ? stranger : recipient,
          appArgs: [arc4.methodSelector(attack === 'selector' ? 'unknown()void' : signature)],
          onCompletion:
            attack === 'completion'
              ? ready
                ? OnCompleteAction.DeleteApplication
                : OnCompleteAction.NoOp
              : ready
                ? OnCompleteAction.NoOp
                : OnCompleteAction.DeleteApplication,
          rekeyTo: attack === 'call-rekey' ? stranger : Global.zeroAddress,
        })
        const extra = ctx.any.txn.payment()
        const group =
          attack === 'prefix'
            ? [extra, payment, call]
            : attack === 'suffix'
              ? [payment, call, extra]
              : attack === 'reverse'
                ? [call, payment]
                : [payment, call]
        const execute = () =>
          ctx.txn
            .createScope(group, attack === 'prefix' || attack === 'reverse' ? 1 : 0)
            .execute(() => ctx.executeLogicSig(new AsaFeeSponsorLSig()))
        if (attack === 'none') expect(execute()).toBe(true)
        else expect(execute).toThrow()
      })
    }
  }
  for (const method of ['claim', 'refund', 'punish'] as const) {
    for (const attack of ['none', 'sender', 'receiver', 'amount', 'fee', 'rekey', 'close', 'clawback']) {
      it(`${method} with opt-in: ${attack}`, () => {
        const ali = ctx.any.account()
        const xin = ctx.any.account()
        const stranger = ctx.any.account()
        const app = ctx.any.application()
        ctx.setTemplateVar('APP_ID', app.id)
        ctx.setTemplateVar('ALI_ADDR', ali)
        ctx.setTemplateVar('XIN_ADDR', xin)
        const recipient = method === 'claim' ? xin : ali
        const payment = ctx.any.txn.payment({ receiver: recipient, closeRemainderTo: recipient, amount: 0, fee: 0 })
        const optIn = ctx.any.txn.assetTransfer({
          sender: attack === 'sender' ? stranger : recipient,
          assetReceiver: attack === 'receiver' ? stranger : recipient,
          assetAmount: attack === 'amount' ? 1 : 0,
          xferAsset: ctx.any.asset(),
          fee: attack === 'fee' ? 1 : 0,
          rekeyTo: attack === 'rekey' ? stranger : Global.zeroAddress,
          assetCloseTo: attack === 'close' ? stranger : Global.zeroAddress,
          assetSender: attack === 'clawback' ? stranger : Global.zeroAddress,
        })
        const call = ctx.any.txn.applicationCall({
          appId: app,
          sender: recipient,
          onCompletion: OnCompleteAction.DeleteApplication,
          appArgs: [
            arc4.methodSelector(
              method === 'claim'
                ? 'leakyClaim(byte[])void'
                : method === 'refund'
                  ? 'leakyRefund(byte[])void'
                  : 'punishRefund()void',
            ),
          ],
        })
        const execute = () =>
          ctx.txn.createScope([payment, optIn, call], 0).execute(() => ctx.executeLogicSig(new AsaFeeSponsorLSig()))
        if (attack === 'none') expect(execute()).toBe(true)
        else expect(execute).toThrow()
      })
    }
  }
})
