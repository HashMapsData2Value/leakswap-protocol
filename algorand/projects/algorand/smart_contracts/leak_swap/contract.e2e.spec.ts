import { AlgorandClient, Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, test, expect } from 'vitest'
import { LeakSwapClient, LeakSwapFactory } from '../artifacts/leak_swap/LeakSwapClient'
import { genPrivateSpendKey, extractScalarFromLeakySignature, hexToUint8Array, getPK, leakySign } from 'leakswap-utils'
import algosdk, { Account, Address } from 'algosdk'
import { IndexerClient } from 'algosdk/dist/types/client/v2/indexer/indexer'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { readFileSync } from 'fs'
import { join } from 'path'

// Vendored FeeSponsorLSig TEAL *template* - read straight from the build
// artifact (not copy-pasted), so this test can never drift from the real
// compiled LSig that sponsor_lsig.algo.ts produces.
const FEE_SPONSOR_LSIG_TEAL_TEMPLATE = readFileSync(
  join(__dirname, '../artifacts/leak_swap/FeeSponsorLSig.teal'),
  'utf-8'
)

// Helper function to sleep for a given number of milliseconds
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const fundAmount = (10).algo()
// Extra fee the app call must pool in, to cover the zero-fee sponsor payment paired with it
const sponsorLegFee = (1000).microAlgos()
const claimPooledFee = (7000).microAlgos()
const treasuryAddress = 'KMRBWAK47LNYSDWH2FW3Q7BLZFXKHXURZG3SVUONHBHG5MPBNB2PIZKZBA'


type LeakSwapCreateAppParams = {
  aliXternalPK: Uint8Array,
  xinAlgoAddr: string,
  xinXternalPK: Uint8Array,
  t0: number,
  t1: number,
}

describe('LeakSwap contract', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
      // traceAll: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  const deploy = async (account: string, params: LeakSwapCreateAppParams) => {
    const factory = localnet.algorand.client.getTypedAppFactory(LeakSwapFactory, {
      defaultSender: account,
    })

    const { appClient } = await factory.send.create.createApplication({
      args: [
        params.aliXternalPK,
        params.xinAlgoAddr,
        params.xinXternalPK,
        params.t0, // Convert to seconds
        params.t1, // Convert to seconds
      ],
      extraProgramPages: 0,
    })

    return { client: appClient }
  }

  test('LeakSwap: Happy Path', { timeout: 60000 }, async () => {
    const { testAccount } = localnet.context
    localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (20).algo())

    // TODO: replace with 0 Algo initial funds, funding by calling funder LSIG
    // Xin starts completely broke - proves the fee-sponsor LSig, not Xin's
    // own balance, is what covers her leakyClaim call's fees.
    const xinAlgoAccount = (await localnet.context.generateAccount({ initialFunds: (0).algo(), suppressLog: true }))
    const aliXternalSK = hexToUint8Array(genPrivateSpendKey())//genScalar()
    const xinXternalSK = hexToUint8Array(genPrivateSpendKey())//genScalar()

    const leakySwapCreateParams: LeakSwapCreateAppParams = {
      aliXternalPK: getPK(aliXternalSK),
      xinAlgoAddr: xinAlgoAccount.addr.toString(),
      xinXternalPK: getPK(xinXternalSK),
      t0: Date.now() + 3600, // 1 hour from now
      t1: Date.now() + 5400, // 1.5 hours from now
    }

    const { client } = await deploy(testAccount.addr.toString(), leakySwapCreateParams)

    // Basic test - check that the contract was deployed successfully
    expect(client.appId).toBeGreaterThan(0)
    expect((await client.send.getContractState()).return).toEqual(0n)

    // After deploying the contract, Ali needs to fund it
    await aliFundContract(
      localnet.algorand,
      testAccount,
      client.appAddress,
    )

    // Fund the fee-sponsor LSig once, up front - mirrors what swap-page's
    // "Fund Contract" step does right after funding the contract itself.
    await fundFeeSponsorLsig(
      localnet.algorand,
      testAccount,
      client.appId,
      testAccount.addr.toString(),
      xinAlgoAccount.addr.toString(),
    )

    await localnet.algorand.send.payment({
      sender: testAccount.addr,
      receiver: treasuryAddress,
      amount: (100_000).microAlgos(),
    })

    // Ali sets the contract to ready
    await aliSetReady(localnet.algorand, testAccount, xinAlgoAccount.addr.toString(), client)

    await callLeakyClaimFromXin(
      localnet.algorand,
      client.appId,
      testAccount.addr.toString(),
      xinAlgoAccount,
      leakySign( // Xin's leaky signature leaks his xternal secret key, on purrpose
        client.appAddress.publicKey,
        xinXternalSK,
      ))

    const leakedScalar = await repeatedlySearchForLeakedScalar(
      localnet.algorand.client.indexer,
      client.appAddress,
      getPK(xinXternalSK)
    )

    console.log(getPK(leakedScalar))
    console.log(getPK(xinXternalSK))

    expect(Array.from(getPK(leakedScalar))).toEqual(Array.from(getPK(xinXternalSK)))

  })

})


// Ali funds the contract
// This function is used to fund the LeakSwap contract after it has been deployed
async function aliFundContract(
  algorand: AlgorandClient,
  aliAccount: Address & Account & TransactionSignerAccount,
  appAddress: Address
): Promise<void> {

  // After deploying the contract, Ali needs to fund it
  const aliFund = await algorand.createTransaction.payment({
    sender: aliAccount.addr.toString(),
    receiver: appAddress,
    amount: fundAmount,
  })
  await algorand.client.algod.sendRawTransaction(await aliAccount.signer([aliFund], [0])).do()

  // Check that the contract has been funded
  expect((await algorand.client.algod.accountInformation(appAddress).do()).amount).toEqual(fundAmount.microAlgos)
}

type SponsoredMethod = 'setReady' | 'leakyClaim' | 'leakyRefund' | 'punishRefund'

const MIN_BALANCE_MICROALGOS = 100_000
const MIN_TXN_FEE_MICROALGOS = 1000

const feeSponsorFundingAmount = MIN_BALANCE_MICROALGOS + MIN_TXN_FEE_MICROALGOS * 2
  + MIN_BALANCE_MICROALGOS + Number(claimPooledFee.microAlgos)

async function compileFeeSponsorLsig(
  algorand: AlgorandClient,
  appId: bigint,
  aliAddress: string,
  xinAddress: string
): Promise<algosdk.LogicSigAccount> {
  const compiled = await algorand.app.compileTealTemplate(FEE_SPONSOR_LSIG_TEAL_TEMPLATE, {
    TMPL_APP_ID: appId,
    TMPL_ALI_ADDR: algosdk.decodeAddress(aliAddress).publicKey,
    TMPL_XIN_ADDR: algosdk.decodeAddress(xinAddress).publicKey,
  })
  return new algosdk.LogicSigAccount(compiled.compiledBase64ToBytes)
}

// Funds the per-swap FeeSponsorLSig account, mirroring what swap-page's
// `fundFeeSponsorLsig` does client-side - must happen once, after the
// contract itself has been deployed and funded.
async function fundFeeSponsorLsig(
  algorand: AlgorandClient,
  funderAccount: Address & Account & TransactionSignerAccount,
  appId: bigint,
  aliAddress: string,
  xinAddress: string
): Promise<string> {
  const sponsorLsig = await compileFeeSponsorLsig(algorand, appId, aliAddress, xinAddress)
  const sponsorAddress = sponsorLsig.address().toString()
  await algorand.send.payment({
    sender: funderAccount.addr.toString(),
    receiver: sponsorAddress,
    amount: (feeSponsorFundingAmount).microAlgos(),
  })
  return sponsorAddress
}

// Builds the real, compiled-and-signed FeeSponsorLSig payment leg that must
// be paired with `method`'s app call - see sponsor_lsig.algo.ts for exactly
// what it checks per method.
async function buildSponsorPaymentTxn(
  algorand: AlgorandClient,
  method: SponsoredMethod,
  appId: bigint,
  aliAddress: string,
  xinAddress: string
): Promise<algosdk.TransactionWithSigner> {
  const sponsorLsig = await compileFeeSponsorLsig(algorand, appId, aliAddress, xinAddress)
  const sponsorAddress = sponsorLsig.address()
  const zeroFee = (0).microAlgos()

  const txn =
    method === 'setReady'
      ? await algorand.createTransaction.payment({
        sender: sponsorAddress,
        receiver: aliAddress,
        amount: (MIN_BALANCE_MICROALGOS + MIN_TXN_FEE_MICROALGOS * 2).microAlgos(),
        staticFee: zeroFee,
      })
      : await algorand.createTransaction.payment({
        sender: sponsorAddress,
        receiver: method === 'leakyClaim' ? xinAddress : aliAddress,
        amount: (0).microAlgos(),
        closeRemainderTo: method === 'leakyClaim' ? xinAddress : aliAddress,
        staticFee: zeroFee,
      })

  return { txn, signer: algosdk.makeLogicSigAccountTransactionSigner(sponsorLsig) }
}

// After Xin has locked up funds on the xternal chain, Ali sets the contract to ready
// This function is used to set the contract to ready state after Ali has funded it
async function aliSetReady(
  algorand: AlgorandClient,
  aliAccount: Address & Account & TransactionSignerAccount,
  xinAddress: string,
  client: LeakSwapClient
): Promise<void> {
  const sponsorPayment = await buildSponsorPaymentTxn(algorand, 'setReady', client.appId, aliAccount.addr.toString(), xinAddress)
  await client.send.setReady({
    args: [sponsorPayment],
    extraFee: sponsorLegFee,
  })
  const state = await client.send.getContractState()
  expect(state.return).toEqual(1n)
}

// Function to call leakyClaim from Xin's account
// This function will be used to test the leakyClaim functionality
// It will send a transaction to the LeakSwap contract, passing the leaky signature as an argument
async function callLeakyClaimFromXin(
  algorand: AlgorandClient,
  appId: bigint,
  aliAddress: string,
  xinAlgoAccount: Address & Account & TransactionSignerAccount,
  xinLeakySignature: Uint8Array
) {

  const algod = algorand.client.algod
  const xinAlgoBalanceBefore = (await algod.accountInformation(xinAlgoAccount).do()).amount
  const treasuryBefore = (await algod.accountInformation(treasuryAddress).do()).amount
  const escrowBefore = (await algod.accountInformation(algosdk.getApplicationAddress(appId)).do()).amount
  const platformFee = escrowBefore / 200n

  const sponsorPayment = await buildSponsorPaymentTxn(algorand, 'leakyClaim', appId, aliAddress, xinAlgoAccount.addr.toString())

  const result = await AlgorandClient.defaultLocalNet()
    .setDefaultSigner(xinAlgoAccount.signer)
    .client.getTypedAppClientById(LeakSwapClient, {
      appId: appId,
      defaultSender: xinAlgoAccount.addr,
      defaultSigner: xinAlgoAccount.signer,
    }).send.delete.leakyClaim({
      args: [xinLeakySignature, sponsorPayment],
      accountReferences: [treasuryAddress],
      staticFee: claimPooledFee,
    })
  const confirmed = await algod.pendingTransactionInformation(result.txIds[result.txIds.length - 1]).do()
  const inner = confirmed.innerTxns ?? []
  const fees = inner.reduce((total, entry) => total + entry.txn.txn.fee, 0n)
  const collected = inner.filter(entry => entry.txn.txn.payment?.receiver.toString() === treasuryAddress)
  expect(collected).toHaveLength(1)
  expect(collected[0].txn.txn.payment?.amount).toBe(platformFee)
  expect(collected[0].txn.txn.fee).toBe(0n)
  expect((await algod.accountInformation(treasuryAddress).do()).amount - treasuryBefore).toBe(platformFee)

  const xinAlgoBalanceAfter = (await algod.accountInformation(xinAlgoAccount).do()).amount
  await expect(algod.getApplicationByID(appId).do()).rejects.toMatchObject({ status: 404 })

  expect(xinAlgoBalanceAfter - xinAlgoBalanceBefore).toEqual(
    escrowBefore - platformFee - claimPooledFee.microAlgos - fees
    + BigInt(feeSponsorFundingAmount - MIN_BALANCE_MICROALGOS - MIN_TXN_FEE_MICROALGOS * 2)
  )

}

// We must try to find the leaked scalar with retries. The delay depends on the indexer processing time.
// We will retry a few times, with a delay between each attempt, until the indexer has processed.
const repeatedlySearchForLeakedScalar = async (indexer: IndexerClient, appAddress: Address, xinXternalPK: Uint8Array): Promise<Uint8Array> => {
  let leakedScalar: Uint8Array | undefined
  const maxRetries = 6
  const retryDelay = 5000 // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      leakedScalar = await findLeakedScalarInAppHistory(
        indexer,
        appAddress,
        xinXternalPK
      )
      break // Success, exit the loop
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(retryDelay)
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to find leaked scalar after ${maxRetries} attempts: ${errorMessage}`)
      }
    }
  }

  if (!leakedScalar) {
    throw new Error('Leaked scalar not found after all retries')
  }

  return leakedScalar
}


// Searches through the transaction history of the app to find the leaky signature.
// Calculates the leaked scalar from the signature, before returning it.
const findLeakedScalarInAppHistory = async (
  indexer: IndexerClient,
  appAddress: Address,
  xinXternalPK: Uint8Array) => {

  const res = await indexer.searchForTransactions().address(appAddress).do();

  // Look for the transaction with the leaky signature (starts with the broken R-point)
  const targetRPoint = new Uint8Array([
    88, 102, 102, 102, 102, 102, 102, 102, 102, 102,
    102, 102, 102, 102, 102, 102, 102, 102, 102, 102,
    102, 102, 102, 102, 102, 102, 102, 102, 102, 102,
    102, 102
  ])

  let leakySignatureArg: Uint8Array | undefined

  for (const transaction of res.transactions) {
    const appArgs = transaction.applicationTransaction?.applicationArgs
    if (appArgs && appArgs.length > 1) {
      const arg1 = appArgs[1]
      // Check if this argument starts with the target R-point
      if (arg1.length == 66) { // 2-byte prefix + 64-byte signature
        const rPoint = arg1.slice(2, 34)
        let matches = true
        for (let i = 0; i < targetRPoint.length; i++) {
          if (rPoint[i] !== targetRPoint[i]) {
            matches = false
            break
          }
        }
        if (matches) {
          leakySignatureArg = arg1.slice(2, 66) // First two bytes are a prefix
          break
        }
      }
    }
  }

  if (!leakySignatureArg) {
    throw new Error('Could not find leaky signature in transaction history')
  }

  return extractScalarFromLeakySignature(leakySignatureArg, appAddress.publicKey, xinXternalPK)
}
