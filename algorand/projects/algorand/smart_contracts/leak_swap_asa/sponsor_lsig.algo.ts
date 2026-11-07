import {
  Account,
  arc4,
  assert,
  Global,
  gtxn,
  LogicSig,
  OnCompleteAction,
  TemplateVar,
  Txn,
  uint64,
  Uint64,
} from '@algorandfoundation/algorand-typescript'

export class AsaFeeSponsorLSig extends LogicSig {
  program(): boolean {
    const appId = TemplateVar<uint64>('APP_ID')
    const ali = TemplateVar<Account>('ALI_ADDR')
    const xin = TemplateVar<Account>('XIN_ADDR')
    assert(Global.groupSize === Uint64(2) || Global.groupSize === Uint64(3), 'Invalid ASA settlement group size')
    assert(Txn.groupIndex === Uint64(0), 'Sponsor must be first')
    assert(Txn.fee === Uint64(0), 'Sponsor must not pay fees')
    assert(Txn.rekeyTo === Global.zeroAddress, 'Sponsor must not rekey')
    const call = gtxn.ApplicationCallTxn(Global.groupSize - Uint64(1))
    assert(call.appId.id === appId, 'Wrong ASA swap application')
    assert(call.rekeyTo === Global.zeroAddress, 'Application call must not rekey')
    const selector = call.appArgs(Uint64(0))
    if (selector === arc4.methodSelector('setReady(pay)void')) {
      assert(Global.groupSize === Uint64(2), 'Readiness must use two transactions')
      assert(call.sender === ali, 'Only Ali can set ready')
      assert(call.onCompletion === OnCompleteAction.NoOp, 'Readiness must not delete')
      assert(Txn.receiver === ali, 'Readiness top-up must go to Ali')
      assert(Txn.amount === Global.minBalance + Global.minTxnFee * Uint64(2), 'Wrong readiness top-up')
      assert(Txn.closeRemainderTo === Global.zeroAddress, 'Readiness must not close sponsor')
      return true
    }
    const claim = selector === arc4.methodSelector('leakyClaim(byte[])void')
    assert(
      claim ||
        selector === arc4.methodSelector('leakyRefund(byte[])void') ||
        selector === arc4.methodSelector('punishRefund()void'),
      'Unsupported ASA settlement',
    )
    const recipient = claim ? xin : ali
    assert(call.sender === recipient, 'Wrong settlement sender')
    assert(call.onCompletion === OnCompleteAction.DeleteApplication, 'Settlement must delete')
    assert(Txn.amount === Uint64(0), 'Settlement top-up must use close-out only')
    assert(Txn.receiver === recipient, 'Wrong settlement receiver')
    assert(Txn.closeRemainderTo === recipient, 'Wrong settlement close-out')
    if (Global.groupSize === Uint64(3)) {
      const optIn = gtxn.AssetTransferTxn(Uint64(1))
      assert(optIn.sender === recipient && optIn.assetReceiver === recipient, 'Opt-in must belong to recipient')
      assert(optIn.assetAmount === Uint64(0), 'Opt-in must have zero amount')
      assert(optIn.fee === Uint64(0), 'Opt-in fees must be pooled')
      assert(
        optIn.assetCloseTo === Global.zeroAddress && optIn.assetSender === Global.zeroAddress,
        'Opt-in must not close or claw back',
      )
      assert(optIn.rekeyTo === Global.zeroAddress, 'Opt-in must not rekey')
    }
    return true
  }
}
