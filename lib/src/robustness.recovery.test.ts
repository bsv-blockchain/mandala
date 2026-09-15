/**
 * Recovery-machinery regression tests for the robustness audit fixes:
 * per-entry journal atomicity, intent markers, abort retention,
 * already-broadcast detection, notification retry, receive verification,
 * and cross-tab lock semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PrivateKey, Hash, Transaction, P2PKH, LockingScript, UnlockingScript } from '@bsv/sdk'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import type { MandalaActionDetails } from '@bsv/templates'
import {
  journalPut,
  journalList,
  journalClear,
  journalIntentBegin,
  journalIntentEnd,
  withIntent,
  hasFreshIntent,
  INTENT_TTL_MS
} from './txJournal.js'
import { reconcileWallet, ABORT_RETRY_CAP } from './reconcile.js'
import {
  notifyPut,
  notifyList,
  notifyClear,
  reconcileNotifications,
  PendingNotification
} from './notifyJournal.js'
import { receiveTokens, InvalidTransferError } from './receive.js'
import { tryWithLock } from './webLocks.js'
import { isAlreadyBroadcast, submitAndBroadcast } from './overlay.js'
import { submitAdminAction } from './assets.js'
import type { AdminAsset } from './assets.js'
import { registerAsset } from './issuerOps.js'
import { clearAdminAuthGates } from './adminAuthGate.js'
import { BusyError } from './singleFlight.js'
import { MESSAGEBOX } from './constants.js'

// Label lookup only; an unconfigured overlay URL now throws (see overlayUrlGuard.test.ts),
// and these tests are about journal/receive ordering, not metadata.
vi.mock('./metadata.js', () => ({ resolveAssetMetadata: vi.fn().mockResolvedValue(null) }))

// The pipelines under test commit through submitAndBroadcast; the overlay
// round-trip itself is covered by overlay.test.ts. Everything else in the
// module (isAlreadyBroadcast, broadcastAcceptedTx for reconcile) stays real.
vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitAndBroadcast: vi.fn()
}))

const mkWallet = (over: Partial<Record<'createAction' | 'abortAction' | 'listActions' | 'internalizeAction', any>> = {}) => ({
  createAction: vi.fn().mockResolvedValue({}),
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  listActions: vi.fn().mockResolvedValue({ actions: [] }),
  internalizeAction: vi.fn().mockResolvedValue({ accepted: true }),
  ...over
})

beforeEach(async () => {
  await journalClear()
  await notifyClear()
})

describe('txJournal intents', () => {
  it('withIntent marks a pipeline in flight and always clears', async () => {
    await withIntent(async () => {
      expect(await hasFreshIntent()).toBe(true)
    })
    expect(await hasFreshIntent()).toBe(false)
    await expect(withIntent(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await hasFreshIntent()).toBe(false)
  })

  it('a fresh intent blocks the bulk sweep; a stale one is expired and unblocks it', async () => {
    const id = await journalIntentBegin()
    const wallet = mkWallet({ listActions: vi.fn().mockResolvedValue({ actions: [{ txid: 'x' }] }) })
    const r1 = await reconcileWallet(wallet as any)
    expect(r1.swept).toBe(0)
    expect(wallet.listActions).not.toHaveBeenCalled()
    await journalIntentEnd(id)

    // Stale intent (crashed pipeline): expired on the next pass, sweep runs.
    await journalPut({ txid: 'intent:crashed', stage: 'intent', at: Date.now() - INTENT_TTL_MS - 1 })
    const r2 = await reconcileWallet(wallet as any)
    expect(r2.swept).toBe(1)
    expect((await journalList()).filter(e => e.stage === 'intent')).toEqual([])
  })
})

describe('reconcile abort retention', () => {
  it('keeps a failing abort entry with attempts++ instead of dropping it', async () => {
    await journalPut({ txid: 'rej', stage: 'abort', reference: 'ref-x', at: 1 })
    const wallet = mkWallet({ abortAction: vi.fn().mockRejectedValue(new Error('wallet offline')) })
    await reconcileWallet(wallet as any)
    const entry = (await journalList()).find(e => e.txid === 'rej')
    expect(entry).toBeDefined()
    expect(entry?.attempts).toBe(1)
  })

  it('hands a persistently-failing abort to the sweep only after the cap', async () => {
    await journalPut({ txid: 'rej', stage: 'abort', reference: 'ref-x', at: 1, attempts: ABORT_RETRY_CAP - 1 })
    const wallet = mkWallet({ abortAction: vi.fn().mockRejectedValue(new Error('still failing')) })
    await reconcileWallet(wallet as any)
    expect(await journalList()).toEqual([])
  })

  it('clears an accepted entry when the broadcast error means already-known', async () => {
    await journalPut({ txid: 'dup', stage: 'accepted', at: 1 })
    const wallet = mkWallet({
      createAction: vi.fn().mockRejectedValue(new Error('txn-already-known'))
    })
    const r = await reconcileWallet(wallet as any)
    expect(r.rebroadcast).toEqual(['dup'])
    expect(await journalList()).toEqual([])
  })

  it('isAlreadyBroadcast matches known duplicates, not transient failures', () => {
    expect(isAlreadyBroadcast(new Error('txn-already-known'))).toBe(true)
    expect(isAlreadyBroadcast(new Error('Transaction already exists in mempool'))).toBe(true)
    expect(isAlreadyBroadcast(new Error('network unreachable'))).toBe(false)
  })
})

describe('notification journal', () => {
  it('retries pending notifications and clears on delivery', async () => {
    await notifyPut({ txid: 't1', recipient: '02ab', messageBox: 'mandala-payments', body: { assetId: 'a.0' }, at: 1 })
    const mbc = { sendMessage: vi.fn().mockResolvedValue({}) }
    const delivered = await reconcileNotifications(mbc)
    expect(delivered).toEqual(['t1'])
    expect(await notifyList()).toEqual([])
    expect(mbc.sendMessage).toHaveBeenCalledWith({
      recipient: '02ab',
      messageBox: 'mandala-payments',
      body: { assetId: 'a.0' }
    })
  })

  it('keeps a failed notification (attempts++) for the next pass', async () => {
    await notifyPut({ txid: 't1', recipient: '02ab', messageBox: 'mb', body: {}, at: 1 })
    const mbc = { sendMessage: vi.fn().mockRejectedValue(new Error('box down')) }
    const delivered = await reconcileNotifications(mbc)
    expect(delivered).toEqual([])
    expect((await notifyList())[0]?.attempts).toBe(1)
  })
})

describe('receive verification', () => {
  const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
  const assetId = `${'a'.repeat(64)}.0`

  const mkMbc = (messages: Array<{ messageId: string, body: any }>) => ({
    listMessages: vi.fn().mockResolvedValue(messages),
    acknowledgeMessage: vi.fn().mockResolvedValue({})
  })

  it('acks and drops a message whose transaction does not parse (poisoned)', async () => {
    const mbc = mkMbc([{
      messageId: 'm1',
      body: { assetId, amount: '25', sender: '02ab', keyID: 'k', protocolID: [2, 'mandala token'], transaction: [1, 2, 3], outputIndex: 0 }
    }])
    const wallet = mkWallet()
    const { accepted, failed } = await receiveTokens({ wallet: wallet as any, messageBoxClient: mbc })
    expect(accepted).toEqual([])
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toBeInstanceOf(InvalidTransferError)
    // Poisoned message is acknowledged so it never replays.
    expect(mbc.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    // And the wallet was never touched.
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('treats an already-internalized output as success and acknowledges', async () => {
    const { Transaction: Tx, P2PKH, UnlockingScript } = await import('@bsv/sdk')
    const src = new Tx()
    src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
    const tx = new Tx()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 25, pkh) })
    const atomic = tx.toAtomicBEEF(true)

    const mbc = mkMbc([{
      messageId: 'm2',
      body: { assetId, amount: '25', sender: '02ab', keyID: 'k', protocolID: [2, 'mandala token'], transaction: atomic, outputIndex: 0 }
    }])
    const wallet = mkWallet({
      internalizeAction: vi.fn().mockRejectedValue(new Error('output already exists in basket'))
    })
    const { accepted, failed } = await receiveTokens({ wallet: wallet as any, messageBoxClient: mbc })
    expect(failed).toEqual([])
    expect(accepted).toHaveLength(1)
    expect(mbc.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m2'] })
  })

  it('rejects a body/output mismatch (wrong amount) without wallet work', async () => {
    const { Transaction: Tx, P2PKH, UnlockingScript } = await import('@bsv/sdk')
    const src = new Tx()
    src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
    const tx = new Tx()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 25, pkh) })
    const atomic = tx.toAtomicBEEF(true)

    const mbc = mkMbc([{
      messageId: 'm3',
      body: { assetId, amount: '1000000', sender: '02ab', keyID: 'k', protocolID: [2, 'mandala token'], transaction: atomic, outputIndex: 0 }
    }])
    const wallet = mkWallet()
    const { accepted, failed } = await receiveTokens({ wallet: wallet as any, messageBoxClient: mbc })
    expect(accepted).toEqual([])
    expect(failed[0].error).toBeInstanceOf(InvalidTransferError)
    expect(String(failed[0].error)).toMatch(/amount mismatch/)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })
})

describe('webLocks', () => {
  it('second concurrent holder is refused, lock releases after settle', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const first = tryWithLock('t.lock', async () => {
      await gate
      return 1
    })
    const second = await tryWithLock('t.lock', async () => 2)
    expect(second.acquired).toBe(false)
    release()
    expect((await first)).toEqual({ acquired: true, result: 1 })
    const third = await tryWithLock('t.lock', async () => 3)
    expect(third).toEqual({ acquired: true, result: 3 })
  })
})

// ---------------------------------------------------------------------------
// Admin pipelines driven end-to-end with the wallet + templates stubbed.
// ---------------------------------------------------------------------------

const ASSET_ID = 'a'.repeat(64) + '.0'
const PRIOR = 'b'.repeat(64) + '.1'
const ISSUER = '02' + 'ab'.repeat(32)
const RECIPIENT = '03' + 'cd'.repeat(32)
const COMMIT_TXID = 'c'.repeat(64)

/** A signable BEEF with `n` inputs — what createAction hands back for signing. */
function signableBeef (n = 1): number[] {
  const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
  const src = new Transaction()
  for (let i = 0; i < n; i++) src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  for (let i = 0; i < n; i++) {
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: i, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(pkh) })
  return tx.toBEEF(true)
}

function stubTemplates (): void {
  vi.spyOn(MandalaAdmin, 'lock').mockResolvedValue(new LockingScript([]))
  vi.spyOn(MandalaAdmin, 'unlock').mockReturnValue({
    sign: async () => new UnlockingScript([]),
    estimateLength: async () => 108
  })
  vi.spyOn(MandalaToken.prototype, 'lockBRC29').mockResolvedValue(new LockingScript([]))
}

const mkAdminWallet = () => ({
  listOutputs: vi.fn().mockResolvedValue({ outputs: [{ outpoint: PRIOR }], BEEF: [1] }),
  createAction: vi.fn().mockResolvedValue({ signableTransaction: { tx: signableBeef(1), reference: 'ref-1' } }),
  signAction: vi.fn().mockResolvedValue({ tx: [9, 9, 9], txid: COMMIT_TXID }),
  revealSpecificKeyLinkage: vi.fn().mockResolvedValue({ keyID: 'k' }),
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  listActions: vi.fn().mockResolvedValue({ actions: [] })
})

const asset: AdminAsset = {
  assetId: ASSET_ID,
  label: 'USD',
  authOutpoint: PRIOR,
  authDetails: { kind: 'issue', assetId: ASSET_ID, amount: 1, priorOutpoint: 'genesis.0' }
}

describe('A08 reissue notification is journaled before the send (submitAdminAction)', () => {
  const reissue: MandalaActionDetails = {
    kind: 'reissue', assetId: ASSET_ID, outpoint: 'frozen.0', amount: 5, recipient: RECIPIENT, priorOutpoint: PRIOR
  }
  const run = (messageBoxClient: any, details: MandalaActionDetails = reissue, ftOutput?: { recipient: string, amount: number }) =>
    submitAdminAction({
      wallet: mkAdminWallet() as any,
      asset,
      details,
      ftOutput: ftOutput ?? (details.kind === 'reissue' ? { recipient: RECIPIENT, amount: 5 } : undefined),
      messageBoxClient,
      identityKey: ISSUER
    })

  beforeEach(() => {
    clearAdminAuthGates()
    stubTemplates()
    vi.mocked(submitAndBroadcast).mockReset().mockResolvedValue({ outputsToAdmit: [0, 1] })
  })
  afterEach(() => vi.restoreAllMocks())

  it('writes the journal entry before sendMessage, with outputIndex + senderMode, and clears it on success', async () => {
    const seenAtSend: PendingNotification[] = []
    const mbc = { sendMessage: vi.fn(async () => { seenAtSend.push(...(await notifyList())); return {} }) }

    const res = await run(mbc)

    expect(res.notified).toBe(true)
    expect(res.txid).toBe(COMMIT_TXID)
    // Journaled BEFORE the send — a crash between the two is recovered at boot.
    expect(seenAtSend).toHaveLength(1)
    expect(seenAtSend[0].txid).toBe(COMMIT_TXID)
    expect(seenAtSend[0].recipient).toBe(RECIPIENT)
    expect(seenAtSend[0].body).toMatchObject({
      assetId: ASSET_ID,
      amount: 5,
      transaction: [9, 9, 9],
      outputIndex: 0,
      sender: ISSUER,
      senderMode: 'unblinded'
    })
    expect(mbc.sendMessage).toHaveBeenCalledWith({ recipient: RECIPIENT, messageBox: MESSAGEBOX, body: seenAtSend[0].body })
    // Delivered → entry cleared.
    expect(await notifyList()).toEqual([])
  })

  it('a throwing sendMessage keeps the entry, does not throw out of the committed action, and reconcileNotifications retries it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mbc = { sendMessage: vi.fn().mockRejectedValue(new Error('messagebox down')) }

    const res = await run(mbc)

    expect(res.notified).toBe(false)
    expect(res.nextAuthOutpoint).toBe(`${COMMIT_TXID}.1`)
    expect(warn).toHaveBeenCalled()
    const pending = await notifyList()
    expect(pending).toHaveLength(1)
    expect(pending[0].txid).toBe(COMMIT_TXID)

    const retry = { sendMessage: vi.fn().mockResolvedValue({}) }
    expect(await reconcileNotifications(retry)).toEqual([COMMIT_TXID])
    expect(retry.sendMessage).toHaveBeenCalledWith({
      recipient: RECIPIENT,
      messageBox: MESSAGEBOX,
      body: expect.objectContaining({ outputIndex: 0, senderMode: 'unblinded', sender: ISSUER })
    })
    expect(await notifyList()).toEqual([])
  })

  it('a reissue with no MessageBox client is still journaled for the boot-time retry', async () => {
    const res = await run(undefined)
    expect(res.notified).toBe(false)
    expect((await notifyList()).map(n => n.txid)).toEqual([COMMIT_TXID])
  })

  it('actions without an FT output journal nothing and report notified', async () => {
    const mbc = { sendMessage: vi.fn() }
    const res = await run(mbc, { kind: 'pause', assetId: ASSET_ID, priorOutpoint: PRIOR })
    expect(res.notified).toBe(true)
    expect(res.nextAuthOutpoint).toBe(`${COMMIT_TXID}.0`)
    expect(mbc.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toEqual([])
  })
})

describe('A15 registerAsset runs under an intent marker and the mandala.register lock', () => {
  const REG_TXID = 'd'.repeat(64)
  const mkRegWallet = () => ({
    createAction: vi.fn().mockResolvedValue({ tx: [1, 2, 3], txid: REG_TXID }),
    listActions: vi.fn().mockResolvedValue({ actions: [{ txid: 'stuck' }] }),
    abortAction: vi.fn().mockResolvedValue({ aborted: true })
  })
  const params = (wallet: ReturnType<typeof mkRegWallet>) =>
    ({ wallet: wallet as any, identityKey: ISSUER, label: 'Gold', ticker: 'gld', decimals: 2 })

  beforeEach(() => {
    stubTemplates()
    vi.mocked(submitAndBroadcast).mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('a crash after createAction leaves a fresh intent that the reconcile sweep respects until TTL', async () => {
    // "Crash" = the overlay round-trip never returns; the pipeline is stuck
    // between createAction and the journaled outcome.
    let commit!: (v: unknown) => void
    vi.mocked(submitAndBroadcast).mockReturnValue(new Promise(r => { commit = r }) as any)
    const wallet = mkRegWallet()

    const inFlight = registerAsset(params(wallet))
    await vi.waitFor(() => expect(wallet.createAction).toHaveBeenCalledTimes(1))
    expect(await hasFreshIntent()).toBe(true)

    // The bulk sweep must not abort the live noSend action.
    const r = await reconcileWallet(wallet as any)
    expect(r.swept).toBe(0)
    expect(wallet.listActions).not.toHaveBeenCalled()

    commit({ outputsToAdmit: [0] })
    // A12 widened the result with the overlay's acceptance proof; assetId is
    // still the contract this test is about.
    await expect(inFlight).resolves.toMatchObject({ assetId: `${REG_TXID}.0` })
    expect(await hasFreshIntent()).toBe(false)
  })

  it('a second register while one is in flight is refused (not queued) and never reaches createAction', async () => {
    let commit!: (v: unknown) => void
    vi.mocked(submitAndBroadcast).mockReturnValue(new Promise(r => { commit = r }) as any)
    const wallet = mkRegWallet()

    const first = registerAsset(params(wallet))
    await vi.waitFor(() => expect(wallet.createAction).toHaveBeenCalledTimes(1))
    await expect(registerAsset(params(wallet))).rejects.toBeInstanceOf(BusyError)
    expect(wallet.createAction).toHaveBeenCalledTimes(1)

    commit({ outputsToAdmit: [0] })
    await first
    // Released after settle — a later register is allowed again.
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    await expect(registerAsset(params(wallet))).resolves.toMatchObject({ assetId: `${REG_TXID}.0` })
  })

  it('forwards the wallet reference (when one exists) so an overlay rejection can abort the held action', async () => {
    vi.mocked(submitAndBroadcast).mockRejectedValue(new Error('overlay rejected'))
    const wallet = mkRegWallet()
    wallet.createAction.mockResolvedValue({ tx: [1], txid: REG_TXID, signableTransaction: { tx: [1], reference: 'reg-ref' } })

    await expect(registerAsset(params(wallet))).rejects.toThrow('overlay rejected')
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][3]).toBe('reg-ref')
    // Intent cleared on settle either way.
    expect(await hasFreshIntent()).toBe(false)
  })
})
