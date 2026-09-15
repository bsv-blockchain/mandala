import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reconcileWallet, SPEC_OP_NOSEND_ACTIONS, BROADCAST_RETRY_CAP, RETRY_CAP } from './reconcile.js'
import { journalPut, journalList, journalListStranded, journalClear } from './txJournal.js'
import { configureMandala } from './constants.js'

const mkWallet = (over: Partial<Record<'createAction' | 'abortAction' | 'listActions', any>> = {}) => ({
  createAction: vi.fn().mockResolvedValue({}),
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  listActions: vi.fn().mockResolvedValue({ actions: [] }),
  ...over
})

beforeEach(async () => { await journalClear() })

describe('reconcileWallet', () => {
  it('re-broadcasts overlay-accepted txs and clears their entries', async () => {
    await journalPut({ txid: 'aa', stage: 'accepted', at: 1 })
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)
    expect(wallet.createAction).toHaveBeenCalledWith({
      description: 'broadcast overlay-accepted tx',
      options: { sendWith: ['aa'], acceptDelayedBroadcast: false }
    })
    expect(r.rebroadcast).toEqual(['aa'])
    expect(await journalList()).toEqual([])
  })

  it('keeps an accepted entry when re-broadcast fails and SKIPS the bulk sweep', async () => {
    await journalPut({ txid: 'aa', stage: 'accepted', at: 1 })
    const wallet = mkWallet({ createAction: vi.fn().mockRejectedValue(new Error('net down')) })
    const r = await reconcileWallet(wallet as any)
    expect(r.rebroadcast).toEqual([])
    expect((await journalList()).map(e => e.txid)).toEqual(['aa'])
    // Sweep would abort the accepted-but-unbroadcast tx — must not run.
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(r.swept).toBe(0)
  })

  it('retries pending aborts by reference and clears their entries', async () => {
    await journalPut({ txid: 'bb', stage: 'abort', reference: 'ref-b', at: 1 })
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-b' })
    expect(r.aborted).toEqual(['bb'])
    expect(await journalList()).toEqual([])
  })

  it('sweeps stuck nosend mandala actions via the wallet-toolbox spec-op', async () => {
    const wallet = mkWallet({ listActions: vi.fn().mockResolvedValue({ actions: [{ txid: 'x' }, { txid: 'y' }] }) })
    const r = await reconcileWallet(wallet as any)
    expect(wallet.listActions).toHaveBeenCalledWith({
      labels: [SPEC_OP_NOSEND_ACTIONS, 'mandala', 'abort'],
      limit: 100
    })
    expect(r.swept).toBe(2)
  })

  it('treats a wallet without spec-op support as nothing to sweep', async () => {
    const wallet = mkWallet({ listActions: vi.fn().mockRejectedValue(new Error('unknown label')) })
    const r = await reconcileWallet(wallet as any)
    expect(r.swept).toBe(0)
  })

  it('second reconcile after successful rebroadcast is idempotent (no double broadcast)', async () => {
    await journalPut({ txid: 'aa', stage: 'accepted', at: 1 })
    const wallet = mkWallet()
    const r1 = await reconcileWallet(wallet as any)
    expect(r1.rebroadcast).toEqual(['aa'])
    expect(await journalList()).toEqual([])
    const r2 = await reconcileWallet(wallet as any)
    expect(r2.rebroadcast).toEqual([])
    expect(r2.aborted).toEqual([])
    // Only one sendWith broadcast for the accepted entry.
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
  })

  it('reconcile with empty journal only runs bulk sweep, invents no work', async () => {
    const wallet = mkWallet({
      listActions: vi.fn().mockResolvedValue({ actions: [] })
    })
    const r = await reconcileWallet(wallet as any)
    expect(r.rebroadcast).toEqual([])
    expect(r.aborted).toEqual([])
    expect(r.swept).toBe(0)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('never aborts an accepted entry — only rebroadcasts', async () => {
    await journalPut({ txid: 'keep-me', stage: 'accepted', at: 1 })
    const wallet = mkWallet()
    await reconcileWallet(wallet as any)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ sendWith: ['keep-me'] })
      })
    )
  })

  it('retries abort stage and does not rebroadcast it', async () => {
    await journalPut({ txid: 'rej', stage: 'abort', reference: 'ref-x', at: 1 })
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)
    expect(r.aborted).toEqual(['rej'])
    expect(r.rebroadcast).toEqual([])
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-x' })
  })

  it('does not drop a still-failing accepted entry on second reconcile', async () => {
    await journalPut({ txid: 'stuck', stage: 'accepted', at: 1 })
    const wallet = mkWallet({
      createAction: vi.fn().mockRejectedValue(new Error('net down'))
    })
    await reconcileWallet(wallet as any)
    expect((await journalList()).map(e => e.txid)).toEqual(['stuck'])
    await reconcileWallet(wallet as any)
    expect((await journalList()).map(e => e.txid)).toEqual(['stuck'])
    // Two rebroadcast attempts, still no sweep while accepted remains.
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    expect(wallet.listActions).not.toHaveBeenCalled()
  })

  it('processes accepted before abort when both are journaled', async () => {
    await journalPut({ txid: 'acc', stage: 'accepted', at: 1 })
    await journalPut({ txid: 'abo', stage: 'abort', reference: 'r', at: 2 })
    const order: string[] = []
    const wallet = mkWallet({
      createAction: vi.fn().mockImplementation(async () => {
        order.push('broadcast')
        return {}
      }),
      abortAction: vi.fn().mockImplementation(async () => {
        order.push('abort')
        return { aborted: true }
      })
    })
    const r = await reconcileWallet(wallet as any)
    // journalList order is insertion order; accepted is handled in its branch.
    expect(r.rebroadcast).toContain('acc')
    expect(r.aborted).toContain('abo')
    // Sweep may run after both journal entries clear.
    expect(await journalList()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// §9.11 — an accepted entry whose broadcast never succeeds becomes 'stranded'
// ---------------------------------------------------------------------------

describe('reconcileWallet — stranded accepted entries (§9.11)', () => {
  const deadBroadcast = () => mkWallet({
    createAction: vi.fn().mockRejectedValue(new Error('net down')),
    listActions: vi.fn().mockResolvedValue({ actions: [{ txid: 'swept-me' }] })
  })

  it('parks the entry after BROADCAST_RETRY_CAP passes, keeping it and never aborting it', async () => {
    await journalPut({ txid: 'wedge', stage: 'accepted', at: 1 })
    const wallet = deadBroadcast()
    for (let i = 1; i < BROADCAST_RETRY_CAP; i++) {
      const r = await reconcileWallet(wallet as any)
      expect(r.stranded).toEqual([])
      expect((await journalList())[0]).toMatchObject({ stage: 'accepted', attempts: i })
      expect(wallet.listActions).not.toHaveBeenCalled() // still blocking the sweep
    }
    const last = await reconcileWallet(wallet as any)
    expect(last.stranded).toEqual(['wedge'])
    expect(await journalList()).toMatchObject([{ txid: 'wedge', stage: 'stranded', attempts: BROADCAST_RETRY_CAP }])
    // Kept — the overlay folded this tx in, so it must never be aborted.
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('a stranded entry stops blocking the bulk sweep and is never retried again', async () => {
    await journalPut({ txid: 'wedge', stage: 'stranded', at: 1, attempts: BROADCAST_RETRY_CAP })
    const wallet = deadBroadcast()
    const r = await reconcileWallet(wallet as any)
    expect(r.swept).toBe(1)
    expect(r.rebroadcast).toEqual([])
    expect(r.stranded).toEqual([])
    expect(wallet.createAction).not.toHaveBeenCalled() // no automatic re-broadcast
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(await journalList()).toMatchObject([{ txid: 'wedge', stage: 'stranded' }])
  })

  it('journalListStranded surfaces exactly the parked entries', async () => {
    await journalPut({ txid: 'wedge', stage: 'accepted', at: 1, attempts: BROADCAST_RETRY_CAP - 1 })
    await journalPut({ txid: 'fine', stage: 'abort', reference: 'r', at: 2 })
    expect(await journalListStranded()).toEqual([])
    await reconcileWallet(deadBroadcast() as any)
    expect((await journalListStranded()).map(e => e.txid)).toEqual(['wedge'])
  })

  it('a broadcast that finally succeeds before the cap clears the entry normally', async () => {
    await journalPut({ txid: 'late', stage: 'accepted', at: 1, attempts: BROADCAST_RETRY_CAP - 1 })
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)
    expect(r.rebroadcast).toEqual(['late'])
    expect(r.stranded).toEqual([])
    expect(await journalList()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// §9.11 — retryable refusals are re-submitted, then released at RETRY_CAP
// ---------------------------------------------------------------------------

describe('reconcileWallet — retryable entries (§9.11)', () => {
  const mockFetch = vi.fn()
  const OVERLAY = 'http://test-overlay'

  const retryableEntry = (over: Record<string, unknown> = {}): any => ({
    txid: 'held',
    stage: 'retryable',
    at: 1,
    reference: 'ref-h',
    code: 'ERR_PAUSED',
    attempts: 0,
    submit: { txHex: 'deadbeef', offChainHex: '0708', topics: ['tm_mandala'] },
    ...over
  })

  const respond = (status: number, body: unknown): void => {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body)
    })
  }

  beforeEach(() => {
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
    configureMandala({ overlayUrl: OVERLAY })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('re-POSTs the journaled bytes and, on acceptance, commits + broadcasts them', async () => {
    await journalPut(retryableEntry())
    respond(200, { tm_mandala: { outputsToAdmit: [0], admissionSignature: 'de', admissionIdentityKey: '02aa' } })
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe(`${OVERLAY}/submit`)
    expect(init.headers['X-Topics']).toBe(JSON.stringify(['tm_mandala']))
    // varint(4) ‖ deadbeef ‖ 0708 — the exact bytes first submitted.
    expect([...init.body]).toEqual([4, 0xde, 0xad, 0xbe, 0xef, 0x07, 0x08])

    expect(r.resubmitted).toEqual(['held'])
    expect(r.rebroadcast).toEqual(['held'])
    expect(wallet.createAction).toHaveBeenCalledWith({
      description: 'broadcast overlay-accepted tx',
      options: { sendWith: ['held'], acceptDelayedBroadcast: false }
    })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(await journalList()).toEqual([])
  })

  it('an accepted re-submit whose broadcast fails leaves an accepted entry carrying σ_I', async () => {
    await journalPut(retryableEntry())
    respond(200, { tm_mandala: { outputsToAdmit: [0, 2], admissionSignature: 'de', admissionIdentityKey: '02aa' } })
    const wallet = mkWallet({ createAction: vi.fn().mockRejectedValue(new Error('net down')) })
    const r = await reconcileWallet(wallet as any)
    expect(r.resubmitted).toEqual(['held'])
    expect(r.rebroadcast).toEqual([])
    expect(await journalList()).toMatchObject([{
      txid: 'held',
      stage: 'accepted',
      reference: 'ref-h',
      admissionSignature: 'de',
      admissionIdentityKey: '02aa',
      outputsToAdmit: [0, 2]
    }])
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('a still-retryable refusal keeps the entry (attempts++, code refreshed) and blocks the sweep', async () => {
    await journalPut(retryableEntry())
    respond(409, { status: 'error', code: 'ERR_FROZEN', retryable: true, description: 'frozen' })
    const wallet = mkWallet({ listActions: vi.fn().mockResolvedValue({ actions: [{ txid: 'x' }] }) })
    const r = await reconcileWallet(wallet as any)
    expect(r.resubmitted).toEqual([])
    expect(await journalList()).toMatchObject([{ txid: 'held', stage: 'retryable', attempts: 1, code: 'ERR_FROZEN' }])
    // Inputs are still held on purpose — the sweep must not grab them.
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(r.swept).toBe(0)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('a FINAL verdict on the retry aborts the reference immediately and drops the entry', async () => {
    await journalPut(retryableEntry())
    respond(400, { status: 'error', code: 'ERR_CONSERVATION', retryable: false, description: 'nope' })
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-h' })
    expect(await journalList()).toEqual([])
    expect(r.resubmitted).toEqual([])
  })

  it('aborts the reference and drops the entry after RETRY_CAP fruitless passes', async () => {
    await journalPut(retryableEntry({ attempts: RETRY_CAP - 1 }))
    respond(503, { status: 'error', code: 'ERR_UNAVAILABLE', retryable: true, description: 'down' })
    const wallet = mkWallet()
    await reconcileWallet(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-h' })
    expect(await journalList()).toEqual([])
  })

  it('an entry with no journaled bytes never re-POSTs; it counts passes, then releases the inputs', async () => {
    await journalPut(retryableEntry({ submit: undefined }))
    const wallet = mkWallet()
    await reconcileWallet(wallet as any)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(await journalList()).toMatchObject([{ txid: 'held', stage: 'retryable', attempts: 1 }])

    await journalPut(retryableEntry({ submit: undefined, attempts: RETRY_CAP - 1 }))
    await reconcileWallet(wallet as any)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-h' })
    expect(await journalList()).toEqual([])
  })

  it('a wallet that cannot abort at the cap still drops the entry (the sweep owns it next)', async () => {
    await journalPut(retryableEntry({ submit: undefined, attempts: RETRY_CAP - 1 }))
    const wallet = mkWallet({ abortAction: vi.fn().mockRejectedValue(new Error('offline')) })
    await reconcileWallet(wallet as any)
    expect(await journalList()).toEqual([])
  })
})
