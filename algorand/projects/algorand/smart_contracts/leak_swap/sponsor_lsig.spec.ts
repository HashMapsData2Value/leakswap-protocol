import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { arc4, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { describe, expect, it } from 'vitest'
import { FeeSponsorLSig } from './sponsor_lsig.algo'

describe('sponsor group shape', () => {
  const ctx = new TestExecutionContext()
  for (const layout of ['pair', 'prefix', 'suffix', 'repeated', 'reversed'] as const) {
    it(`validates ${layout} layout`, () => {
      const ali = ctx.any.account()
      const xin = ctx.any.account()
      const app = ctx.any.application()
      ctx.setTemplateVar('APP_ID', app.id)
      ctx.setTemplateVar('ALI_ADDR', ali)
      ctx.setTemplateVar('XIN_ADDR', xin)
      ctx.ledger.patchGlobalData({ minBalance: 100_000, minTxnFee: 1000 })
      const payment = ctx.any.txn.payment({ fee: 0, receiver: ali, amount: 102_000 })
      const call = ctx.any.txn.applicationCall({
        appId: app, sender: ali, onCompletion: OnCompleteAction.NoOp,
        appArgs: [arc4.methodSelector('setReady(pay)void')],
      })
      const extra = ctx.any.txn.payment()
      const group = layout === 'prefix' ? [extra, payment, call]
        : layout === 'suffix' ? [payment, call, extra]
          : layout === 'repeated' ? [payment, call, payment, call]
            : layout === 'reversed' ? [call, payment] : [payment, call]
      const execute = () => ctx.txn.createScope(group, layout === 'prefix' || layout === 'reversed' ? 1 : 0)
        .execute(() => ctx.executeLogicSig(new FeeSponsorLSig()))
      if (layout === 'pair') expect(execute()).toBe(true)
      else expect(execute).toThrow(layout === 'reversed'
        ? 'Sponsor payment must be first in the group'
        : 'Sponsored group must contain exactly two transactions')
    })
  }
})