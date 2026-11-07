import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import algosdk from 'algosdk'
import { generateAsaFixture } from './generate-asa-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  genPrivateSpendKey,
  getPK,
  hexToUint8Array,
  leakySign,
  extractScalarFromLeakySignature,
} = require('leakswap-utils')
const image = process.env.ASA_TEST_ALGOD_IMAGE ?? 'algorand/algod:latest'
const token = 'a'.repeat(64)
const quantity = 1_000_199n

test('ASA escrow executes on an isolated real AVM LocalNet', { timeout: 240_000 }, async (suite) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'leakswap-asa-avm-'))
  const container = `leakswap-asa-${randomUUID()}`
  let started = false
  function compile(source, output, name) {
    execFileSync(
      resolve('node_modules/.bin/puya-ts'),
      [source, '--output-bytecode', '--out-dir', resolve(directory, output)],
      { stdio: 'pipe' },
    )
    return JSON.parse(readFileSync(resolve(directory, output, `${name}.arc56.json`), 'utf8'))
  }
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
    generateAsaFixture()
    const production = compile('smart_contracts/leak_swap_asa/contract.algo.ts', 'production', 'AsaLeakSwap')
    const fixture = compile('tests/fixtures/asa_localnet.algo.ts', 'fixture', 'LocalnetAsaFixture')
    execFileSync(
      resolve('node_modules/.bin/puya-ts'),
      ['smart_contracts/leak_swap_asa/sponsor_lsig.algo.ts', '--out-dir', resolve(directory, 'sponsor')],
      { stdio: 'pipe' },
    )
    const sponsorTemplate = readFileSync(resolve(directory, 'sponsor/AsaFeeSponsorLSig.teal'), 'utf8')
    writeFileSync(
      resolve(directory, 'config.json'),
      JSON.stringify({
        GossipFanout: 1,
        EndpointAddress: '0.0.0.0:8080',
        DNSBootstrapID: '',
        IncomingConnectionsLimit: 0,
        Archival: true,
        EnableDeveloperAPI: true,
      }),
    )
    writeFileSync(
      resolve(directory, 'template.json'),
      JSON.stringify({
        Genesis: {
          NetworkName: 'asa-isolated-test',
          RewardsPoolBalance: 0,
          FirstPartKeyRound: 0,
          LastPartKeyRound: 10000,
          Wallets: [{ Name: 'Wallet1', Stake: 100, Online: true }],
          DevMode: true,
        },
        Nodes: [{ Name: 'data', IsRelay: true, Wallets: [{ Name: 'Wallet1', ParticipationOnly: false }] }],
      }),
    )
    execFileSync(
      'docker',
      [
        'run',
        '--detach',
        '--pull',
        'never',
        '--name',
        container,
        '--publish',
        '127.0.0.1::8080',
        '--publish',
        '127.0.0.1::7833',
        '--env',
        'START_KMD=1',
        '--env',
        'GOSSIP_PORT=10000',
        '--env',
        `TOKEN=${token}`,
        '--env',
        `ADMIN_TOKEN=${token}`,
        '--env',
        `KMD_TOKEN=${token}`,
        '--mount',
        `type=bind,source=${resolve(directory, 'config.json')},target=/etc/algorand/config.json,readonly`,
        '--mount',
        `type=bind,source=${resolve(directory, 'template.json')},target=/etc/algorand/template.json,readonly`,
        image,
      ],
      { stdio: 'pipe' },
    )
    started = true
    const ports = JSON.parse(
      execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', container], {
        encoding: 'utf8',
      }),
    )
    const algod = new algosdk.Algodv2(token, 'http://127.0.0.1', ports['8080/tcp'][0].HostPort)
    const kmd = new algosdk.Kmd(token, 'http://127.0.0.1', ports['7833/tcp'][0].HostPort)
    const deadline = Date.now() + 60_000
    let wallets
    let startupError
    while (Date.now() < deadline) {
      try {
        await algod.status().do()
        wallets = await kmd.listWallets()
        if (wallets.wallets.length) break
      } catch (error) {
        startupError = error
        const state = JSON.parse(
          execFileSync('docker', ['inspect', '--format', '{{json .State}}', container], { encoding: 'utf8' }),
        )
        assert.ok(state.Running, `Disposable LocalNet exited: ${JSON.stringify(state)}`)
      }
    }
    assert.ok(wallets?.wallets.length, `LocalNet failed to start: ${startupError}`)
    const handle = (await kmd.initWalletHandle(wallets.wallets[0].id, '')).wallet_handle_token
    let dispenser
    try {
      for (const address of (await kmd.listKeys(handle)).addresses) {
        if ((await algod.accountInformation(address).do()).amount > 1_000_000_000n) {
          dispenser = {
            addr: algosdk.decodeAddress(address),
            sk: (await kmd.exportKey(handle, '', address)).private_key,
          }
          break
        }
      }
    } finally {
      await kmd.releaseWalletHandle(handle)
    }
    assert.ok(dispenser, 'Isolated LocalNet must have a funded dispenser')

    async function send(transaction, account) {
      await algod.sendRawTransaction(transaction.signTxn(account.sk)).do()
      return algosdk.waitForConfirmation(algod, transaction.txID(), 4)
    }
    async function params(fee = 1000n) {
      return { ...(await algod.getTransactionParams().do()), flatFee: true, fee }
    }
    async function setup(deposited = quantity) {
      const ali = algosdk.generateAccount()
      const xin = algosdk.generateAccount()
      await send(
        algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: dispenser.addr,
          receiver: ali.addr,
          amount: 10_000_000n,
          suggestedParams: await params(),
        }),
        dispenser,
      )
      const created = await send(
        algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
          sender: dispenser.addr,
          total: quantity * 2n,
          decimals: 6,
          defaultFrozen: false,
          assetName: 'LocalNet fixture only',
          unitName: 'USDC',
          freeze: dispenser.addr,
          suggestedParams: await params(),
        }),
        dispenser,
      )
      const asset = created.assetIndex
      assert.ok(asset)
      await send(
        algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: ali.addr,
          receiver: ali.addr,
          amount: 0,
          assetIndex: asset,
          suggestedParams: await params(),
        }),
        ali,
      )
      await send(
        algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: dispenser.addr,
          receiver: ali.addr,
          amount: deposited,
          assetIndex: asset,
          suggestedParams: await params(),
        }),
        dispenser,
      )
      const aliSecret = hexToUint8Array(genPrivateSpendKey())
      const xinSecret = hexToUint8Array(genPrivateSpendKey())
      return { ali, xin, asset, aliSecret, xinSecret }
    }
    async function deploy(state, artifact = fixture, shortWindow = false, deposited = quantity) {
      const round = (await algod.status().do()).lastRound
      const t0 = round + (shortWindow ? 10n : 1000n)
      const t1 = round + (shortWindow ? 20n : 2000n)
      const composer = new algosdk.AtomicTransactionComposer()
      const approval = new Uint8Array(Buffer.from(artifact.byteCode.approval, 'base64'))
      const clear = new Uint8Array(Buffer.from(artifact.byteCode.clear, 'base64'))
      composer.addMethodCall({
        appID: 0,
        sender: state.ali.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(state.ali),
        suggestedParams: await params(),
        approvalProgram: approval,
        clearProgram: clear,
        numGlobalInts: artifact.state.schema.global.ints,
        numGlobalByteSlices: artifact.state.schema.global.bytes,
        numLocalInts: 0,
        numLocalByteSlices: 0,
        extraPages: Math.max(0, Math.ceil((approval.length + clear.length) / 2048) - 1),
        method: algosdk.ABIMethod.fromSignature(
          'createApplication(byte[],account,byte[],uint64,uint64,asset,uint64)void',
        ),
        methodArgs: [
          getPK(state.aliSecret),
          state.xin.addr.toString(),
          getPK(state.xinSecret),
          t0,
          t1,
          state.asset,
          quantity,
        ],
      })
      const result = await composer.execute(algod, 4)
      const appId = (await algod.pendingTransactionInformation(result.txIDs.at(-1)).do()).applicationIndex
      assert.ok(appId)
      const appAddress = algosdk.getApplicationAddress(appId)
      const values = {
        TMPL_APP_ID: appId.toString(),
        TMPL_ALI_ADDR: `0x${Buffer.from(state.ali.addr.publicKey).toString('hex')}`,
        TMPL_XIN_ADDR: `0x${Buffer.from(state.xin.addr.publicKey).toString('hex')}`,
      }
      const source = sponsorTemplate.replace(/\bTMPL_(?:APP_ID|ALI_ADDR|XIN_ADDR)\b/g, (name) => values[name])
      const compiled = await algod.compile(source).do()
      const sponsor = new algosdk.LogicSigAccount(new Uint8Array(Buffer.from(compiled.result, 'base64')))
      const initialize = new algosdk.AtomicTransactionComposer()
      initialize.addMethodCall({
        appID: appId,
        sender: state.ali.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(state.ali),
        suggestedParams: await params(2000n),
        appForeignAssets: [state.asset],
        method: algosdk.ABIMethod.fromSignature('initializeEscrow(pay)void'),
        methodArgs: [
          {
            txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
              sender: state.ali.addr,
              receiver: appAddress,
              amount: 200_000n,
              suggestedParams: await params(),
            }),
            signer: algosdk.makeBasicAccountTransactionSigner(state.ali),
          },
        ],
      })
      await initialize.execute(algod, 4)
      const funding = new algosdk.AtomicTransactionComposer()
      funding.addTransaction({
        txn: algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: state.ali.addr,
          receiver: appAddress,
          amount: deposited,
          assetIndex: state.asset,
          suggestedParams: await params(),
        }),
        signer: algosdk.makeBasicAccountTransactionSigner(state.ali),
      })
      funding.addTransaction({
        txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: state.ali.addr,
          receiver: sponsor.address(),
          amount: 320_000n,
          suggestedParams: await params(),
        }),
        signer: algosdk.makeBasicAccountTransactionSigner(state.ali),
      })
      await funding.execute(algod, 4)
      return { ...state, appId, appAddress, sponsor, t0, t1 }
    }
    async function ready(state) {
      const composer = new algosdk.AtomicTransactionComposer()
      composer.addMethodCall({
        appID: state.appId,
        sender: state.ali.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(state.ali),
        suggestedParams: await params(2000n),
        appForeignAssets: [state.asset],
        method: algosdk.ABIMethod.fromSignature('setReady(pay)void'),
        methodArgs: [
          {
            txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
              sender: state.sponsor.address(),
              receiver: state.ali.addr,
              amount: 102_000n,
              suggestedParams: await params(0n),
            }),
            signer: algosdk.makeLogicSigAccountTransactionSigner(state.sponsor),
          },
        ],
      })
      await composer.execute(algod, 4)
    }
    async function settle(state, method, withOptIn, wrongAsset = false) {
      const recipient = method === 'claim' ? state.xin : state.ali
      const signature = leakySign(state.appAddress.publicKey, method === 'claim' ? state.xinSecret : state.aliSecret)
      const composer = new algosdk.AtomicTransactionComposer()
      composer.addTransaction({
        txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: state.sponsor.address(),
          receiver: recipient.addr,
          amount: 0,
          closeRemainderTo: recipient.addr,
          suggestedParams: await params(0n),
        }),
        signer: algosdk.makeLogicSigAccountTransactionSigner(state.sponsor),
      })
      if (withOptIn)
        composer.addTransaction({
          txn: algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: recipient.addr,
            receiver: recipient.addr,
            amount: 0,
            assetIndex: wrongAsset ? 1n : state.asset,
            suggestedParams: await params(0n),
          }),
          signer: algosdk.makeBasicAccountTransactionSigner(recipient),
        })
      composer.addMethodCall({
        appID: state.appId,
        sender: recipient.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(recipient),
        suggestedParams: await params(12_000n),
        appAccounts: [state.ali.addr, state.xin.addr],
        appForeignAssets: [state.asset],
        onComplete: algosdk.OnApplicationComplete.DeleteApplicationOC,
        method: algosdk.ABIMethod.fromSignature(
          method === 'claim'
            ? 'leakyClaim(byte[])void'
            : method === 'refund'
              ? 'leakyRefund(byte[])void'
              : 'punishRefund()void',
        ),
        methodArgs: method === 'punish' ? [] : [signature],
      })
      const result = await composer.execute(algod, 4)
      return { result, signature }
    }
    async function holding(address, asset) {
      return (
        (await algod.accountInformation(address).do()).assets.find((value) => value.assetId === asset)?.amount ?? 0n
      )
    }
    async function advanceToRound(state, round) {
      while ((await algod.status().do()).lastRound < round)
        await send(
          algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            sender: state.ali.addr,
            receiver: state.ali.addr,
            amount: 0,
            suggestedParams: await params(),
          }),
          state.ali,
        )
    }
    async function rejectWithoutSettlement(state, method) {
      const addresses = [state.ali.addr, state.xin.addr, state.appAddress, state.sponsor.address()]
      const snapshot = async () =>
        Promise.all(
          addresses.map(async (address) => {
            const account = await algod.accountInformation(address).do()
            return { amount: account.amount, assets: account.assets }
          }),
        )
      const before = await snapshot()
      const applicationSnapshot = async () => {
        const application = await algod.getApplicationByID(state.appId).do()
        application.params.globalState.sort((first, second) => Buffer.compare(first.key, second.key))
        return application
      }
      const application = await applicationSnapshot()
      await assert.rejects(() => settle(state, method, method === 'claim'), /assert failed|logic eval/i)
      assert.deepEqual(await snapshot(), before)
      assert.deepEqual(await applicationSnapshot(), application)
    }

    await suite.test('production rejects an uncurated LocalNet asset, even with a USDC ticker', async () => {
      const state = await setup()
      await assert.rejects(() => deploy(state, production), /assert failed|logic eval/i)
    })
    for (const treasury of ['opted-in', 'missing', 'frozen']) {
      await suite.test(`fresh zero-ALGO Xin opts in atomically; treasury=${treasury}`, async () => {
        const state = await deploy(await setup())
        await ready(state)
        if (treasury === 'missing')
          await send(
            algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
              sender: state.ali.addr,
              receiver: dispenser.addr,
              amount: 0,
              assetIndex: state.asset,
              closeRemainderTo: dispenser.addr,
              suggestedParams: await params(),
            }),
            state.ali,
          )
        if (treasury === 'frozen')
          await send(
            algosdk.makeAssetFreezeTxnWithSuggestedParamsFromObject({
              sender: dispenser.addr,
              freezeTarget: state.ali.addr,
              assetIndex: state.asset,
              frozen: true,
              suggestedParams: await params(),
            }),
            dispenser,
          )
        assert.equal((await algod.accountInformation(state.xin.addr).do()).amount, 0n)
        const { result, signature } = await settle(state, 'claim', true)
        const fee = treasury === 'opted-in' ? quantity / 200n : 0n
        assert.equal(await holding(state.xin.addr, state.asset), quantity - fee)
        assert.equal(await holding(state.ali.addr, state.asset), fee)
        assert.equal((await algod.accountInformation(state.appAddress).do()).amount, 0n)
        assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, 0n)
        await assert.rejects(() => algod.getApplicationByID(state.appId).do(), /404|does not exist/i)
        const confirmed = await algod.pendingTransactionInformation(result.txIDs.at(-1)).do()
        assert.equal(confirmed.txn.txn.applicationCall.onComplete, algosdk.OnApplicationComplete.DeleteApplicationOC)
        assert.deepEqual(
          getPK(extractScalarFromLeakySignature(signature, state.appAddress.publicKey, getPK(state.xinSecret))),
          getPK(state.xinSecret),
        )
      })
    }
    for (const method of ['refund', 'punish']) {
      for (const deposited of [0n, 100n, quantity, quantity * 2n]) {
        for (const optIn of [false, true]) {
          await suite.test(`${method} returns ${deposited} ASA with no swap fee; re-opt-in=${optIn}`, async () => {
            const state = await deploy(await setup(deposited), fixture, method === 'punish', deposited)
            if (optIn)
              await send(
                algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
                  sender: state.ali.addr,
                  receiver: dispenser.addr,
                  amount: 0,
                  assetIndex: state.asset,
                  closeRemainderTo: dispenser.addr,
                  suggestedParams: await params(),
                }),
                state.ali,
              )
            if (method === 'punish') await advanceToRound(state, state.t1 - 1n)
            const before = await algod.accountInformation(state.ali.addr).do()
            const escrowBefore = (await algod.accountInformation(state.appAddress).do()).amount
            const sponsorBefore = (await algod.accountInformation(state.sponsor.address()).do()).amount
            assert.equal(await holding(state.ali.addr, state.asset), 0n)
            const { result, signature } = await settle(state, method, optIn)
            const after = await algod.accountInformation(state.ali.addr).do()
            assert.equal(await holding(state.ali.addr, state.asset), deposited)
            assert.equal(escrowBefore, 200_000n)
            assert.equal(after.amount, before.amount + escrowBefore + sponsorBefore - 12_000n)
            assert.equal((await algod.accountInformation(state.appAddress).do()).amount, 0n)
            assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, 0n)
            await assert.rejects(() => algod.getApplicationByID(state.appId).do(), /404|does not exist/i)
            const confirmed = await algod.pendingTransactionInformation(result.txIDs.at(-1)).do()
            if (method === 'punish') assert.equal(confirmed.confirmedRound, state.t1)
            const call = confirmed.txn.txn.applicationCall
            assert.equal(call.onComplete, algosdk.OnApplicationComplete.DeleteApplicationOC)
            assert.equal(call.appArgs.length, method === 'punish' ? 1 : 2)
            const transfers = confirmed.innerTxns.filter((entry) => entry.txn.txn.assetTransfer)
            assert.equal(transfers.length, 1, 'Refund must not create a treasury ASA fee transfer')
            assert.equal(transfers[0].txn.txn.assetTransfer.closeRemainderTo.toString(), state.ali.addr.toString())
            if (method === 'refund')
              assert.deepEqual(
                getPK(extractScalarFromLeakySignature(signature, state.appAddress.publicKey, getPK(state.aliSecret))),
                getPK(state.aliSecret),
              )
            await assert.rejects(() => settle(state, method, optIn), /404|does not exist|application|logic eval/i)
            assert.equal((await algod.accountInformation(state.ali.addr).do()).amount, after.amount)
            assert.equal(await holding(state.ali.addr, state.asset), deposited)
          })
        }
      }
    }
    for (const method of ['refund', 'punish']) {
      for (const frozen of ['escrow', 'recipient']) {
        await suite.test(`${method} frozen ${frozen} rejects atomically, then succeeds after unfreeze`, async () => {
          const state = await deploy(await setup(), fixture, method === 'punish')
          if (method === 'punish') await ready(state)
          const freezeTarget = frozen === 'escrow' ? state.appAddress : state.ali.addr
          const freeze = async (value) =>
            send(
              algosdk.makeAssetFreezeTxnWithSuggestedParamsFromObject({
                sender: dispenser.addr,
                freezeTarget,
                assetIndex: state.asset,
                frozen: value,
                suggestedParams: await params(),
              }),
              dispenser,
            )
          await freeze(true)
          if (method === 'punish') await advanceToRound(state, state.t1 - 1n)
          const before = (await algod.accountInformation(state.ali.addr).do()).amount
          const sponsorBefore = (await algod.accountInformation(state.sponsor.address()).do()).amount
          const escrowBefore = (await algod.accountInformation(state.appAddress).do()).amount
          await assert.rejects(() => settle(state, method, true), /assert failed|logic eval/i)
          assert.equal((await algod.accountInformation(state.ali.addr).do()).amount, before)
          assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, sponsorBefore)
          assert.equal((await algod.accountInformation(state.appAddress).do()).amount, escrowBefore)
          assert.equal(await holding(state.appAddress, state.asset), quantity)
          await algod.getApplicationByID(state.appId).do()
          await freeze(false)
          await settle(state, method, true)
          assert.equal(await holding(state.ali.addr, state.asset), quantity)
          assert.equal((await algod.accountInformation(state.appAddress).do()).amount, 0n)
          assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, 0n)
          await assert.rejects(() => algod.getApplicationByID(state.appId).do(), /404|does not exist/i)
        })
      }
    }
    for (const redundantOptIn of [false, true]) {
      await suite.test(
        `already opted-in Xin can claim ${redundantOptIn ? 'with a redundant opt-in' : 'with the two-transaction group'}`,
        async () => {
          const state = await deploy(await setup())
          await send(
            algosdk.makePaymentTxnWithSuggestedParamsFromObject({
              sender: dispenser.addr,
              receiver: state.xin.addr,
              amount: 300_000n,
              suggestedParams: await params(),
            }),
            dispenser,
          )
          await send(
            algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
              sender: state.xin.addr,
              receiver: state.xin.addr,
              amount: 0,
              assetIndex: state.asset,
              suggestedParams: await params(),
            }),
            state.xin,
          )
          await ready(state)
          const before = await algod.accountInformation(state.xin.addr).do()
          const sponsorBefore = (await algod.accountInformation(state.sponsor.address()).do()).amount
          assert.equal(await holding(state.xin.addr, state.asset), 0n)
          await settle(state, 'claim', redundantOptIn)
          const after = await algod.accountInformation(state.xin.addr).do()
          assert.equal(await holding(state.xin.addr, state.asset), quantity - quantity / 200n)
          assert.equal(after.minBalance, before.minBalance)
          assert.equal(after.assets.length, before.assets.length)
          assert.equal(after.amount, before.amount + sponsorBefore - 12_000n)
          assert.equal((await algod.accountInformation(state.appAddress).do()).amount, 0n)
          assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, 0n)
          await assert.rejects(() => algod.getApplicationByID(state.appId).do(), /404|does not exist/i)
        },
      )
    }
    for (const boundary of ['before-t0', 'at-t0']) {
      await suite.test(`leaky refund confirms ${boundary} with a recoverable Ali key share`, async () => {
        const state = await deploy(await setup(), fixture, true)
        await advanceToRound(state, state.t0 - (boundary === 'before-t0' ? 2n : 1n))
        const { result, signature } = await settle(state, 'refund', false)
        const confirmed = await algod.pendingTransactionInformation(result.txIDs.at(-1)).do()
        assert.equal(confirmed.confirmedRound, state.t0 - (boundary === 'before-t0' ? 1n : 0n))
        assert.equal(await holding(state.ali.addr, state.asset), quantity)
        assert.deepEqual(
          getPK(extractScalarFromLeakySignature(signature, state.appAddress.publicKey, getPK(state.aliSecret))),
          getPK(state.aliSecret),
        )
        assert.equal((await algod.accountInformation(state.appAddress).do()).amount, 0n)
        assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, 0n)
        await assert.rejects(() => algod.getApplicationByID(state.appId).do(), /404|does not exist/i)
      })
    }
    await suite.test(
      'after t0: leaky refund and early punish reject; timeout claim succeeds without Ready',
      async () => {
        const state = await deploy(await setup(), fixture, true)
        await advanceToRound(state, state.t0)
        await rejectWithoutSettlement(state, 'refund')
        await rejectWithoutSettlement(state, 'punish')
        const { result } = await settle(state, 'claim', true)
        const confirmed = await algod.pendingTransactionInformation(result.txIDs.at(-1)).do()
        assert.equal(confirmed.confirmedRound, state.t0 + 1n)
        assert.equal(await holding(state.xin.addr, state.asset), quantity - quantity / 200n)
        assert.equal((await algod.accountInformation(state.appAddress).do()).amount, 0n)
        assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, 0n)
        await assert.rejects(() => algod.getApplicationByID(state.appId).do(), /404|does not exist/i)
      },
    )
    await suite.test('past t1: claim and leaky refund reject; punish returns all ASA without a key share', async () => {
      const state = await deploy(await setup(), fixture, true)
      await advanceToRound(state, state.t1 - 2n)
      await rejectWithoutSettlement(state, 'punish')
      await advanceToRound(state, state.t1)
      await rejectWithoutSettlement(state, 'claim')
      await rejectWithoutSettlement(state, 'refund')
      const { result } = await settle(state, 'punish', false)
      const confirmed = await algod.pendingTransactionInformation(result.txIDs.at(-1)).do()
      assert.equal(confirmed.confirmedRound, state.t1 + 1n)
      assert.equal(confirmed.txn.txn.applicationCall.appArgs.length, 1)
      assert.equal(await holding(state.ali.addr, state.asset), quantity)
      assert.equal((await algod.accountInformation(state.appAddress).do()).amount, 0n)
      assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, 0n)
      await assert.rejects(() => algod.getApplicationByID(state.appId).do(), /404|does not exist/i)
    })
    await suite.test('wrong ASA opt-in fails atomically and leaves funded escrow and sponsor untouched', async () => {
      const state = await deploy(await setup())
      await ready(state)
      const before = (await algod.accountInformation(state.sponsor.address()).do()).amount
      await assert.rejects(() => settle(state, 'claim', true, true))
      assert.equal(await holding(state.appAddress, state.asset), quantity)
      assert.equal((await algod.accountInformation(state.sponsor.address()).do()).amount, before)
      assert.equal((await algod.accountInformation(state.xin.addr).do()).amount, 0n)
      await settle(state, 'claim', true)
    })
  } catch (error) {
    if (started) {
      try {
        console.error(execFileSync('docker', ['logs', container], { encoding: 'utf8' }))
      } catch (logsError) {
        console.error('Unable to read disposable LocalNet logs', logsError)
      }
    }
    throw error
  } finally {
    if (started) execFileSync('docker', ['rm', '--force', '--volumes', container], { stdio: 'pipe' })
    rmSync(directory, { recursive: true, force: true })
  }
})
