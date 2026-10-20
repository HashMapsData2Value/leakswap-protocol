import { Account, arc4, assert, Global, gtxn, LogicSig, OnCompleteAction, TemplateVar, Txn, uint64, Uint64 } from '@algorandfoundation/algorand-typescript'

/*
 * Per-swap fee-sponsoring LogicSig for the LeakSwap contract.
 *
 * Signs a zero-fee payment transaction that tops up whichever party (Ali or Xin)
 * needs to pay for the LeakSwap ApplicationCall sitting right after it in the
 * same atomic group. This account never pays a fee itself - the paired app call
 * absorbs the whole group's fee, using the ALGO it just received here (group
 * transactions within an atomic group apply sequentially).
 *
 * APP_ID/ALI_ADDR/XIN_ADDR are template variables baked in per-swap at compile
 * time, once the LeakSwap app has been created.
 */
export class FeeSponsorLSig extends LogicSig {
  program(): boolean {
    const appId = TemplateVar<uint64>('APP_ID')
    const aliAddr = TemplateVar<Account>('ALI_ADDR')
    const xinAddr = TemplateVar<Account>('XIN_ADDR')

    assert(Global.groupSize === Uint64(2), 'Sponsored group must contain exactly two transactions')
    assert(Txn.groupIndex === Uint64(0), 'Sponsor payment must be first in the group')
    assert(Txn.fee === Uint64(0), 'Sponsor payment must not pay a fee')
    assert(Txn.rekeyTo === Global.zeroAddress, 'Sponsor payment must not rekey')

    // Must be paired with the LeakSwap app call immediately following it
    const appCall = gtxn.ApplicationCallTxn(Txn.groupIndex + Uint64(1))
    assert(appCall.appId.id === appId, 'Must be paired with the LeakSwap app call')
    const selector = appCall.appArgs(Uint64(0))

    // setReady: Ali may be broke if she already closed out into the contract.
    // Top her up with enough to cover her own minimum balance plus the whole
    // group's fee, but don't close out the sponsor - it's needed again later.
    if (selector === arc4.methodSelector('setReady(pay)void')) {
      assert(appCall.onCompletion === OnCompleteAction.NoOp, 'setReady must not delete the application')
      assert(Txn.closeRemainderTo === Global.zeroAddress, 'Cannot close out for setReady')
      assert(Txn.receiver === aliAddr, 'setReady funding must go to Ali')
      assert(Txn.amount === Global.minBalance + Global.minTxnFee * Uint64(2), 'Wrong setReady funding amount')
      return true
    }

    // Terminal methods are mutually exclusive, so it's safe to sweep the
    // sponsor's entire remaining balance to whichever party disburseFunds()
    // is about to pay out to.
    if (selector === arc4.methodSelector('leakyClaim(byte[],pay)void')) {
      assert(appCall.onCompletion === OnCompleteAction.DeleteApplication, 'Claim must delete the application')
      assert(Txn.amount === Uint64(0), 'leakyClaim funding must not transfer an extra amount')
      assert(Txn.closeRemainderTo === xinAddr, 'leakyClaim must sweep the remainder to Xin')
      return true
    }
    if (
      selector === arc4.methodSelector('leakyRefund(byte[],pay)void') ||
      selector === arc4.methodSelector('punishRefund(pay)void')
    ) {
      assert(appCall.onCompletion === OnCompleteAction.DeleteApplication, 'Refund must delete the application')
      assert(Txn.amount === Uint64(0), 'refund funding must not transfer an extra amount')
      assert(Txn.closeRemainderTo === aliAddr, 'refund must sweep the remainder to Ali')
      return true
    }

    return false
  }
}
