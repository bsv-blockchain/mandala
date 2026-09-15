import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  reconcileWallet, SPEC_OP_NOSEND_ACTIONS, BROADCAST_RETRY_CAP, RETRY_CAP, SWEEP_MIN_AGE_MS
} from './reconcile.js'
import { journalPut, journalList, journalListStranded, journalClear, JournalEntry } from './txJournal.js'
import { configureMandala } from './constants.js'

/**
 * A wallet that actually posts what it is handed: `createAction({sendWith})`
 * answers with the SendWithResult the BRC-100 contract promises. Anything less
 * (a bare `{}`, a storage hold) is no longer proof of a broadcast — see the
 * 'the wallet must prove it posted' block below.
 */
const posted = (args: any): any => ({
  sendWithResults: ((args?.options?.sendWith ?? []) as string[]).map(txid => ({ txid, status: 'unproven' }))
})

const mkWallet = (over: Partial<Record<'createAction' | 'abortAction' | 'listActions', any>> = {}) => ({
  createAction: vi.fn().mockImplementation(async (args: any) => posted(args)),
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  listActions: vi.fn().mockResolvedValue({ actions: [] }),
  ...over
})

/**
 * A stuck noSend action the sweep is allowed to touch: old enough to be past
 * SWEEP_MIN_AGE_MS and carrying a creation time the wallet actually reports.
 */
const staleAction = (over: Record<string, unknown> = {}): any => ({
  txid: 'stuck',
  status: 'nosend',
  createdAt: Date.now() - SWEEP_MIN_AGE_MS - 60_000,
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
    const wallet = mkWallet({
      listActions: vi.fn().mockResolvedValue({ actions: [staleAction({ txid: 'x' }), staleAction({ txid: 'y' })] })
    })
    const r = await reconcileWallet(wallet as any)
    // The FIRST listing is read-only — the 'abort' label (which bulk-aborts
    // server-side) may only follow the per-action guards.
    expect(wallet.listActions.mock.calls[0][0].labels).toContain(SPEC_OP_NOSEND_ACTIONS)
    expect(wallet.listActions.mock.calls[0][0].labels).not.toContain('abort')
    expect(wallet.listActions).toHaveBeenCalledWith(expect.objectContaining({
      labels: expect.arrayContaining([SPEC_OP_NOSEND_ACTIONS, 'mandala', 'abort']),
      limit: 100
    }))
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
      createAction: vi.fn().mockImplementation(async (args: any) => {
        order.push('broadcast')
        return posted(args)
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
    listActions: vi.fn().mockResolvedValue({ actions: [staleAction({ txid: 'swept-me' })] })
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

// ---------------------------------------------------------------------------
// The other half of the 2026-09-15 incident: `sendWith` resolved without the
// wallet having posted anything (its storage held the token request for its own
// settlement drain), and the 'accepted' entry was cleared on that alone.
// ---------------------------------------------------------------------------

describe('reconcileWallet — a broadcast clears the entry only when the wallet posted it', () => {
  it.each(['unproven', 'sending'] as const)('clears on a %s sendWith result', async status => {
    await journalPut({ txid: 'aa', stage: 'accepted', at: 1 })
    const wallet = mkWallet({
      createAction: vi.fn().mockResolvedValue({ sendWithResults: [{ txid: 'aa', status }] })
    })
    const r = await reconcileWallet(wallet as any)
    expect(r.rebroadcast).toEqual(['aa'])
    expect(await journalList()).toEqual([])
  })

  it.each([
    ['a hold-shaped result with no sendWithResults', {}],
    ['a failed sendWith result', { sendWithResults: [{ txid: 'aa', status: 'failed' }] }],
    ['a result for some other txid', { sendWithResults: [{ txid: 'zz', status: 'unproven' }] }]
  ])('keeps the accepted entry for %s', async (_label, result) => {
    await journalPut({ txid: 'aa', stage: 'accepted', at: 1 })
    const wallet = mkWallet({ createAction: vi.fn().mockResolvedValue(result) })
    const r = await reconcileWallet(wallet as any)
    expect(r.rebroadcast).toEqual([])
    expect(await journalList()).toMatchObject([{ txid: 'aa', stage: 'accepted', attempts: 1 }])
    // An unposted tx must keep blocking the sweep, exactly like a failed one.
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('strands an entry the wallet never posts, rather than retrying it forever', async () => {
    await journalPut({ txid: 'aa', stage: 'accepted', at: 1, attempts: BROADCAST_RETRY_CAP - 1 })
    const wallet = mkWallet({ createAction: vi.fn().mockResolvedValue({}) })
    const r = await reconcileWallet(wallet as any)
    expect(r.stranded).toEqual(['aa'])
    expect(await journalList()).toMatchObject([{ txid: 'aa', stage: 'stranded' }])
  })
})

// ---------------------------------------------------------------------------
// The 2026-09-15 incident — the bulk sweep aborted an action whose transaction
// was already on chain, releasing its inputs and double-spending the next send.
// ---------------------------------------------------------------------------

describe('reconcileWallet — bulk sweep guards', () => {
  const withActions = (...actions: any[]) => mkWallet({
    listActions: vi.fn().mockResolvedValue({ actions })
  })
  /** Every label set the sweep ever passes 'abort' in. */
  const abortCalls = (wallet: any): any[] =>
    wallet.listActions.mock.calls.filter((c: any[]) => (c[0]?.labels ?? []).includes('abort'))

  it('{ sweep: false } never lists or aborts the host’s noSend actions', async () => {
    const wallet = withActions(staleAction({ reference: 'ref-a' }))
    const r = await reconcileWallet(wallet as any, { sweep: false })
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(r.swept).toBe(0)
  })

  it('{ sweep: false } still runs journal-driven recovery', async () => {
    await journalPut({ txid: 'aa', stage: 'accepted', at: 1 })
    await journalPut({ txid: 'bb', stage: 'abort', reference: 'ref-b', at: 2 })
    const wallet = withActions(staleAction({ reference: 'ref-a' }))
    const r = await reconcileWallet(wallet as any, { sweep: false })
    expect(r.rebroadcast).toEqual(['aa'])
    expect(r.aborted).toEqual(['bb'])
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(await journalList()).toEqual([])
  })

  it('sweeping is the default (the web console has no other cleanup)', async () => {
    const wallet = withActions(staleAction({ reference: 'ref-a' }))
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-a' })
    expect(r.swept).toBe(1)
  })

  it('leaves an action younger than SWEEP_MIN_AGE_MS alone', async () => {
    const wallet = withActions(staleAction({
      reference: 'ref-a',
      createdAt: Date.now() - SWEEP_MIN_AGE_MS + 60_000
    }))
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(abortCalls(wallet)).toEqual([]) // and never the all-or-nothing bulk abort
    expect(r.swept).toBe(0)
  })

  it('skips an action whose creation time the wallet does not report', async () => {
    const wallet = withActions({ txid: 'ageless', status: 'nosend', reference: 'ref-a' })
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(abortCalls(wallet)).toEqual([])
    expect(r.swept).toBe(0)
  })

  it('reads the age from a BRC-114 `action time <ms>` label when that is all there is', async () => {
    const old = Date.now() - SWEEP_MIN_AGE_MS - 60_000
    const wallet = withActions({
      txid: 'labelled',
      status: 'nosend',
      reference: 'ref-a',
      labels: ['mandala', `action time ${old}`]
    })
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-a' })
    expect(r.swept).toBe(1)
  })

  const stages: Array<JournalEntry['stage']> =
    ['accepted', 'retryable', 'handed_over', 'stranded', 'abort', 'intent']

  it.each(stages)('never aborts an action whose txid has a %s journal entry', async stage => {
    // The incident: the 'accepted' entry cleared (the wallet "accepted" the
    // sendWith), and 0.7s later the same pass swept the action away — while the
    // transaction was already on chain. An entry seen at ANY point in the pass
    // protects its action for the whole pass.
    await journalPut({ txid: 'stuck', stage, at: Date.now(), reference: 'ref-j' })
    const wallet = withActions(staleAction({ txid: 'stuck', reference: 'ref-a' }))
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).not.toHaveBeenCalledWith({ reference: 'ref-a' })
    expect(abortCalls(wallet)).toEqual([])
    expect(r.swept).toBe(0)
  })

  it('logs every abort with the txid and the age', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const wallet = withActions(staleAction({ txid: 'loud', reference: 'ref-a' }))
      await reconcileWallet(wallet as any)
      const line = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('loud'))
      expect(line).toBeDefined()
      expect(line).toMatch(/age \d+m/)
    } finally {
      warn.mockRestore()
    }
  })

  it('bulk-aborts (all-or-nothing) only when every listed action is eligible', async () => {
    // One young action in the listing is enough: the spec-op abort cannot take
    // exceptions, so nothing may go through it this pass.
    const mixed = withActions(
      staleAction({ txid: 'old', createdAt: Date.now() - SWEEP_MIN_AGE_MS - 1 }),
      staleAction({ txid: 'young', createdAt: Date.now() })
    )
    const r1 = await reconcileWallet(mixed as any)
    expect(abortCalls(mixed)).toEqual([])
    expect(r1.swept).toBe(0)

    const allOld = withActions(staleAction({ txid: 'old' }), staleAction({ txid: 'older' }))
    const r2 = await reconcileWallet(allOld as any)
    expect(abortCalls(allOld)).toHaveLength(1)
    expect(r2.swept).toBe(2)
  })

  it('asks again without the BRC-114 time label when the first listing comes back empty', async () => {
    // A wallet that treats 'action time from 0' as an ordinary filter label
    // would otherwise silently answer "nothing stuck" for ever.
    const wallet = mkWallet({
      listActions: vi.fn()
        .mockResolvedValueOnce({ actions: [] })
        .mockResolvedValueOnce({ actions: [staleAction({ reference: 'ref-a' })] })
    })
    const r = await reconcileWallet(wallet as any)
    expect(wallet.listActions).toHaveBeenCalledTimes(2)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-a' })
    expect(r.swept).toBe(1)
  })

  it('never touches an action that is not nosend (a wallet that ignored the spec-op label)', async () => {
    const wallet = withActions(
      staleAction({ txid: 'done', status: 'completed', reference: 'ref-done' }),
      staleAction({ txid: 'sent', status: 'unproven', reference: 'ref-sent' })
    )
    const r = await reconcileWallet(wallet as any)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(abortCalls(wallet)).toEqual([])
    expect(r.swept).toBe(0)
  })

  it('treats an abort the wallet refuses as not swept', async () => {
    const wallet = mkWallet({
      listActions: vi.fn().mockResolvedValue({ actions: [staleAction({ reference: 'ref-a' })] }),
      abortAction: vi.fn().mockRejectedValue(new Error('already on chain'))
    })
    const r = await reconcileWallet(wallet as any)
    expect(r.swept).toBe(0)
  })
})

describe('reconcileWallet — handed_over entries (the payer’s optional later submit)', () => {
  const mockFetch = vi.fn()
  const OVERLAY = 'http://test-overlay'

  const handedOver = (over: Record<string, unknown> = {}): any => ({
    txid: 'ho',
    stage: 'handed_over',
    at: 1,
    reference: 'ref-ho',
    submit: { txHex: 'deadbeef', offChainHex: '0708', topics: ['tm_mandala'] },
    ...over
  })

  beforeEach(() => {
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
    configureMandala({ overlayUrl: OVERLAY })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('re-POSTs the stored bytes when online and commits + broadcasts on acceptance', async () => {
    await journalPut(handedOver())
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tm_mandala: { outputsToAdmit: [0], admissionSignature: 'de', admissionIdentityKey: '02aa' } })
    })
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)
    expect(mockFetch.mock.calls[0][0]).toBe(`${OVERLAY}/submit`)
    expect(r.resubmitted).toEqual(['ho'])
    expect(r.rebroadcast).toEqual(['ho'])
    expect(await journalList()).toEqual([])
  })

  it('keeps the entry (and blocks the bulk sweep) while the overlay is unreachable', async () => {
    await journalPut(handedOver())
    mockFetch.mockRejectedValue(new Error('offline'))
    const wallet = mkWallet()
    const r = await reconcileWallet(wallet as any)
    expect(await journalList()).toMatchObject([{ txid: 'ho', stage: 'handed_over', attempts: 1 }])
    expect(wallet.abortAction).not.toHaveBeenCalled()
    // The noSend action behind a handed-over tx still holds its inputs on
    // purpose — sweeping it would invalidate evidence the payee already has.
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(r.swept).toBe(0)
  })

  it('aborts the reference and drops the entry on a FINAL refusal', async () => {
    await journalPut(handedOver())
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ status: 'error', code: 'ERR_CONSERVATION', retryable: false })
    })
    const wallet = mkWallet()
    await reconcileWallet(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-ho' })
    expect(await journalList()).toEqual([])
  })
})
