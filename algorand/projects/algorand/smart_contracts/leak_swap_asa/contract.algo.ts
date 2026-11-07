import {
  abimethod,
  Account,
  Asset,
  assert,
  Bytes,
  bytes,
  Contract,
  ensureBudget,
  Global,
  GlobalState,
  gtxn,
  itxn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { AssetHolding, ed25519verifyBare, extract, Txn } from '@algorandfoundation/algorand-typescript/op'
import { asaSponsorAddress } from './sponsor_address.algo'

export class AsaLeakSwap extends Contract {
  public aliAlgoAddr = GlobalState<Account>()
  public xinAlgoAddr = GlobalState<Account>()
  public aliXternalPK = GlobalState<bytes>()
  public xinXternalPK = GlobalState<bytes>()
  public t0 = GlobalState<uint64>()
  public t1 = GlobalState<uint64>()
  public swapAsset = GlobalState<Asset>()
  public quantity = GlobalState<uint64>()
  public initialized = GlobalState({ initialValue: false })
  public aliReady = GlobalState({ initialValue: false })

  @abimethod({ allowActions: 'NoOp', onCreate: 'require' })
  public createApplication(
    aliXternalPK: bytes,
    xinAlgoAddr: Account,
    xinXternalPK: bytes,
    t0: uint64,
    t1: uint64,
    asset: Asset,
    quantity: uint64,
  ): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'Creation must not rekey')
    assert(xinAlgoAddr !== Global.creatorAddress && xinAlgoAddr !== Global.zeroAddress, 'Swap parties must differ')
    assert(aliXternalPK.length === 32 && xinXternalPK.length === 32, 'Invalid external public key length')
    assert(quantity > 0, 'ASA quantity must be positive')
    assert(this.acceptsAsset(asset), 'Asset is not curated on this network')
    assert(asset.decimals === 6 && !asset.defaultFrozen, 'Unsupported ASA parameters')
    assert(t1 > t0 && t0 > Global.round, 'Invalid round deadlines')
    this.aliAlgoAddr.value = Global.creatorAddress
    this.xinAlgoAddr.value = xinAlgoAddr
    this.aliXternalPK.value = aliXternalPK
    this.xinXternalPK.value = xinXternalPK
    this.t0.value = t0
    this.t1.value = t1
    this.swapAsset.value = asset
    this.quantity.value = quantity
  }

  protected acceptsAsset(asset: Asset): boolean {
    if (Global.genesisHash === Bytes.fromBase64('wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=')) {
      return asset.id === 31566704 || asset.id === 246516580 || asset.id === 246519683
    }
    return (
      Global.genesisHash === Bytes.fromBase64('SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=') && asset.id === 10458941
    )
  }

  protected feeRecipient(): Account {
    return Account(Bytes.fromHex('53221b015cfadb890ec7d16db87c2bc96ea3de91c9b72ad1cd384e6eb1e16874'))
  }

  public initializeEscrow(funding: gtxn.PaymentTxn): void {
    assert(!this.initialized.value, 'Escrow is already initialized')
    assert(Global.groupSize === 2 && Txn.groupIndex === 1 && funding.groupIndex === 0, 'Invalid initialization group')
    assert(
      Txn.sender === this.aliAlgoAddr.value && funding.sender === this.aliAlgoAddr.value,
      'Only Ali can initialize',
    )
    assert(
      Txn.rekeyTo === Global.zeroAddress && funding.rekeyTo === Global.zeroAddress,
      'Initialization must not rekey',
    )
    assert(
      funding.closeRemainderTo === Global.zeroAddress && funding.receiver === Global.currentApplicationAddress,
      'Invalid escrow funding',
    )
    assert(
      Global.currentApplicationAddress.balance >=
        Global.currentApplicationAddress.minBalance + Global.assetOptInMinBalance,
      'Insufficient escrow reserve',
    )
    itxn
      .assetTransfer({
        xferAsset: this.swapAsset.value,
        assetReceiver: Global.currentApplicationAddress,
        assetAmount: 0,
        fee: 0,
      })
      .submit()
    this.initialized.value = true
  }

  private requireSponsor(payment: gtxn.PaymentTxn, recipient: Account, ready: boolean): void {
    assert(this.initialized.value, 'Escrow is not initialized')
    assert(
      (Global.groupSize === 2 || (!ready && Global.groupSize === 3)) && Txn.groupIndex === Global.groupSize - 1,
      'Invalid ASA sponsor group',
    )
    assert(payment.groupIndex === 0, 'Sponsor must be first')
    assert(Txn.sender === recipient, 'Wrong settlement sender')
    assert(Txn.rekeyTo === Global.zeroAddress && payment.rekeyTo === Global.zeroAddress, 'Settlement must not rekey')
    assert(payment.fee === 0 && payment.receiver === recipient, 'Invalid sponsor payment')
    assert(
      payment.sender ===
        asaSponsorAddress(Global.currentApplicationId.id, this.aliAlgoAddr.value, this.xinAlgoAddr.value),
      'Wrong ASA sponsor',
    )
    if (ready) {
      assert(
        payment.amount === Global.minBalance + Global.minTxnFee * 2 && payment.closeRemainderTo === Global.zeroAddress,
        'Invalid readiness funding',
      )
    } else {
      assert(payment.amount === 0 && payment.closeRemainderTo === recipient, 'Invalid sponsor close-out')
      if (Global.groupSize === 3) {
        const optIn = gtxn.AssetTransferTxn(1)
        assert(optIn.sender === recipient && optIn.assetReceiver === recipient, 'Wrong opt-in recipient')
        assert(optIn.xferAsset === this.swapAsset.value && optIn.assetAmount === 0, 'Wrong opt-in asset or amount')
        assert(
          optIn.rekeyTo === Global.zeroAddress &&
            optIn.assetCloseTo === Global.zeroAddress &&
            optIn.assetSender === Global.zeroAddress,
          'Unsafe opt-in fields',
        )
        assert(optIn.fee === 0, 'Opt-in fees must be pooled')
      }
    }
  }

  private requireFunding(): void {
    const [balance, exists] = AssetHolding.assetBalance(Global.currentApplicationAddress, this.swapAsset.value)
    const [frozen] = AssetHolding.assetFrozen(Global.currentApplicationAddress, this.swapAsset.value)
    assert(exists && !frozen && balance >= this.quantity.value, 'Escrow ASA funding is unavailable')
  }

  private verifySignature(signature: bytes, publicKey: bytes): void {
    assert(signature.length === 64, 'Invalid leaky signature length')
    assert(
      extract(signature, 0, 32) === Bytes.fromHex('5866666666666666666666666666666666666666666666666666666666666666'),
      'Signature must leak the external secret',
    )
    assert(
      ed25519verifyBare(Global.currentApplicationAddress.bytes, signature, publicKey),
      'Signature verification failed',
    )
  }

  private settle(recipient: Account, chargeFee: boolean): void {
    const [escrowFrozen, escrowExists] = AssetHolding.assetFrozen(
      Global.currentApplicationAddress,
      this.swapAsset.value,
    )
    assert(escrowExists && !escrowFrozen, 'Escrow ASA holding is unavailable')
    if (chargeFee) this.requireFunding()
    const [recipientFrozen, recipientExists] = AssetHolding.assetFrozen(recipient, this.swapAsset.value)
    assert(recipientExists && !recipientFrozen, 'Recipient must have an unfrozen ASA holding')
    const treasury = this.feeRecipient()
    const [treasuryFrozen, treasuryExists] = AssetHolding.assetFrozen(treasury, this.swapAsset.value)
    let fee: uint64 = 0
    if (chargeFee && treasuryExists && !treasuryFrozen) {
      fee = this.quantity.value / 200
    }
    if (fee > 0) {
      itxn
        .assetTransfer({ xferAsset: this.swapAsset.value, assetReceiver: treasury, assetAmount: fee, fee: 0 })
        .submit()
    }
    itxn
      .assetTransfer({
        xferAsset: this.swapAsset.value,
        assetReceiver: recipient,
        assetAmount: 0,
        assetCloseTo: recipient,
        fee: 0,
      })
      .submit()
    itxn
      .payment({ receiver: this.aliAlgoAddr.value, amount: 0, closeRemainderTo: this.aliAlgoAddr.value, fee: 0 })
      .submit()
  }

  public setReady(sponsorPayment: gtxn.PaymentTxn): void {
    assert(!this.aliReady.value, 'Escrow is already ready')
    this.requireSponsor(sponsorPayment, this.aliAlgoAddr.value, true)
    this.requireFunding()
    assert(Global.round <= this.t0.value, 'Readiness deadline passed')
    this.aliReady.value = true
  }

  public getContractState(): uint64 {
    if (Global.round >= this.t1.value) return 3
    if (Global.round > this.t0.value) return 2
    return this.aliReady.value ? 1 : 0
  }

  @abimethod({ allowActions: 'DeleteApplication' })
  public leakyClaim(signature: bytes): void {
    this.requireSponsor(gtxn.PaymentTxn(0), this.xinAlgoAddr.value, false)
    assert(
      (this.aliReady.value || Global.round > this.t0.value) && Global.round < this.t1.value,
      'Claim is outside its round window',
    )
    ensureBudget(2400)
    this.verifySignature(signature, this.xinXternalPK.value)
    this.settle(this.xinAlgoAddr.value, true)
  }

  @abimethod({ allowActions: 'DeleteApplication' })
  public leakyRefund(signature: bytes): void {
    this.requireSponsor(gtxn.PaymentTxn(0), this.aliAlgoAddr.value, false)
    assert(!this.aliReady.value && Global.round <= this.t0.value, 'Refund is outside its round window')
    ensureBudget(2400)
    this.verifySignature(signature, this.aliXternalPK.value)
    this.settle(this.aliAlgoAddr.value, false)
  }

  @abimethod({ allowActions: 'DeleteApplication' })
  public punishRefund(): void {
    this.requireSponsor(gtxn.PaymentTxn(0), this.aliAlgoAddr.value, false)
    assert(Global.round >= this.t1.value, 'Cannot punish before t1')
    this.settle(this.aliAlgoAddr.value, false)
  }
}
