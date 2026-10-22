/**
 * Recovery-machinery regression tests for the robustness audit fixes:
 * per-entry journal atomicity, intent markers, abort retention,
 * already-broadcast detection, notification retry, and cross-tab lock
 * semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
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
import { reconcileWallet, ABORT_RETRY_CAP, SWEEP_MIN_AGE_MS } from './reconcile.js'
import {
  notifyPut,
  notifyList,
  notifyClear,
  reconcileNotifications
} from './notifyJournal.js'
import { tryWithLock } from './webLocks.js'
import { isAlreadyBroadcast, submitAndBroadcast } from './overlay.js'
import { registerAsset } from './issuerOps.js'
import { BusyError } from './singleFlight.js'
import { configureMandala } from './constants.js'

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
    // Old enough for the sweep's own age guard, so the intent is what decides.
    const stuck = { txid: 'x', status: 'nosend', reference: 'ref-x', createdAt: Date.now() - SWEEP_MIN_AGE_MS - 1 }
    const wallet = mkWallet({ listActions: vi.fn().mockResolvedValue({ actions: [stuck] }) })
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

const ISSUER = '02' + 'ab'.repeat(32)

// BRC-162 locks/unlocks run for real against these wallet key stubs.
function stubTemplates (): void {}
const STUB_KEY = PrivateKey.fromHex('11'.repeat(32))
// A wallet's revelation echoes the request (BRC-72), as revealIssuerLinkage checks.
const revealStub = () => vi.fn(async (a: { counterparty: string, verifier: string, protocolID: [2, string], keyID: string }) => ({
  prover: STUB_KEY.toPublicKey().toString(),
  verifier: a.verifier,
  counterparty: a.counterparty,
  protocolID: a.protocolID,
  keyID: a.keyID,
  encryptedLinkage: [1],
  encryptedLinkageProof: [2],
  proofType: 0
}))
const keyStubs = () => ({
  getPublicKey: vi.fn().mockResolvedValue({ publicKey: STUB_KEY.toPublicKey().toString() }),
  createSignature: vi.fn().mockResolvedValue({ signature: STUB_KEY.sign([1, 2, 3]).toDER() as number[] })
})

describe('A15 registerAsset runs under an intent marker and the mandala.register lock', () => {
  const REG_TXID = 'd'.repeat(64)
  const mkRegWallet = () => ({
    createAction: vi.fn().mockResolvedValue({ tx: [1, 2, 3], txid: REG_TXID }),
    listActions: vi.fn().mockResolvedValue({ actions: [{ txid: 'stuck' }] }),
    abortAction: vi.fn().mockResolvedValue({ aborted: true }),
    revealSpecificKeyLinkage: revealStub(),
    ...keyStubs()
  })
  const params = (wallet: ReturnType<typeof mkRegWallet>) =>
    ({ wallet: wallet as any, identityKey: ISSUER, label: 'Gold', ticker: 'gld', decimals: 2 })

  beforeEach(() => {
    stubTemplates()
    vi.mocked(submitAndBroadcast).mockReset()
    // The deploy payload's req names K = the overlay identity key (C§4).
    configureMandala({ overlayIdentityKey: STUB_KEY.toPublicKey().toString() })
  })
  afterEach(() => {
    configureMandala({ overlayIdentityKey: '' })
    vi.restoreAllMocks()
  })

  it('refuses before createAction while the overlay identity key is unset (no req K)', async () => {
    configureMandala({ overlayIdentityKey: '' })
    const wallet = mkRegWallet()
    await expect(registerAsset(params(wallet))).rejects.toThrow(/overlay identity key/)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(await hasFreshIntent()).toBe(false)
  })

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
    await expect(inFlight).resolves.toMatchObject({ assetId: `${REG_TXID}_0` })
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
    await expect(registerAsset(params(wallet))).resolves.toMatchObject({ assetId: `${REG_TXID}_0` })
  })

  it('forwards the wallet reference (when one exists) so an overlay rejection can abort the held action', async () => {
    vi.mocked(submitAndBroadcast).mockRejectedValue(new Error('overlay rejected'))
    const wallet = mkRegWallet()
    wallet.createAction.mockResolvedValue({ tx: [1], txid: REG_TXID, signableTransaction: { tx: [1], reference: 'reg-ref' } })

    await expect(registerAsset(params(wallet))).rejects.toThrow('overlay rejected')
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][3]).toBe('reg-ref')
    // Deploy submit topics are exactly [tm_mandala, tm_color_<txid>_0] (C§0).
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][5]).toEqual(['tm_mandala', `tm_color_${REG_TXID}_0`])
    // Intent cleared on settle either way.
    expect(await hasFreshIntent()).toBe(false)
  })
})
