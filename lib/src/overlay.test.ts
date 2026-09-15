import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  broadcastAcceptedTx, createOverlayFacilitator, OverlayRefusedError, overlayErrorFromResponse,
  sendWithPosted, submitAndBroadcast, submitToOverlay
} from './overlay.js'
import { journalList, journalClear } from './txJournal.js'
import { configureMandala } from './constants.js'
import { configureStorage, memoryStorage } from './storage.js'

const OVERLAY = 'http://test-overlay'

/**
 * A wallet that really posts a `sendWith` batch: it answers with the
 * SendWithResult BRC-100 promises. Only that is proof of a broadcast — see
 * "the wallet must prove it posted" below.
 */
const postingWallet = async (args: any): Promise<any> => ({
  sendWithResults: ((args?.options?.sendWith ?? []) as string[]).map(txid => ({ txid, status: 'unproven' }))
})

beforeEach(async () => {
  await journalClear()
  configureMandala({ overlayUrl: OVERLAY })
})

describe('submitToOverlay', () => {
  it('returns admitted indices on success', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0, 1], coinsToRetain: [] } }) }
    const res = await submitToOverlay([1, 2, 3], [4, 5], facilitator as any)
    expect(res.outputsToAdmit).toEqual([0, 1])
    expect(facilitator.send).toHaveBeenCalledWith(OVERLAY, { beef: [1, 2, 3], topics: ['tm_mandala'], offChainValues: [4, 5] })
  })
  it('surfaces the overlay admission signature', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0], admissionSignature: 'dead', admissionIdentityKey: '02aa' } }) }
    const res = await submitToOverlay([1], undefined, facilitator as any)
    expect(res).toMatchObject({ outputsToAdmit: [0], admissionSignature: 'dead', admissionIdentityKey: '02aa' })
  })
  it('throws when nothing is admitted', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } }) }
    await expect(submitToOverlay([1], undefined, facilitator as any)).rejects.toThrow('overlay rejected')
  })
  it('refuses to send when configureMandala has not set the overlay URL', async () => {
    // Without this a missing configureMandala would POST to a relative /submit.
    configureMandala({ overlayUrl: '' })
    const facilitator = { send: vi.fn() }
    await expect(submitToOverlay([1], undefined, facilitator as any)).rejects.toThrow(/configureMandala/)
    expect(facilitator.send).not.toHaveBeenCalled()
  })
})

describe('submitAndBroadcast (overlay-gated finalize)', () => {
  const signed = { tx: [1, 2, 3], txid: 'abc' }

  it('broadcasts via sendWith only after the overlay accepts', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    const wallet = { createAction: vi.fn().mockResolvedValue({}), abortAction: vi.fn() }
    const res = await submitAndBroadcast(wallet as any, signed, [9], 'ref-1', facilitator as any)
    expect(res.outputsToAdmit).toEqual([0])
    expect(wallet.createAction).toHaveBeenCalledWith({
      description: 'broadcast overlay-accepted tx',
      options: { sendWith: ['abc'], acceptDelayedBroadcast: false }
    })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('never broadcasts and aborts (releasing inputs) when the overlay rejects', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [] } }) }
    const wallet = { createAction: vi.fn(), abortAction: vi.fn().mockResolvedValue({}) }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any))
      .rejects.toThrow('overlay rejected')
    expect(wallet.createAction).not.toHaveBeenCalled() // tx never hit the network
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
  })

  it('releases the held inputs and never broadcasts when the overlay URL is unconfigured', async () => {
    configureMandala({ overlayUrl: '' })
    const facilitator = { send: vi.fn() }
    const wallet = { createAction: vi.fn(), abortAction: vi.fn().mockResolvedValue({}) }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any))
      .rejects.toThrow(/configureMandala/)
    expect(facilitator.send).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
    expect(await journalList()).toEqual([])
  })

  it('skips abort with no reference (genesis) and still never broadcasts on reject', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [] } }) }
    const wallet = { createAction: vi.fn(), abortAction: vi.fn() }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, undefined, facilitator as any))
      .rejects.toThrow('overlay rejected')
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('resolves at accept and keeps the journal entry when the background broadcast fails', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    const wallet = { createAction: vi.fn().mockRejectedValue(new Error('net down')), abortAction: vi.fn() }
    // Resolves at the overlay-accept commit point despite the doomed broadcast.
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any))
      .resolves.toMatchObject({ outputsToAdmit: [0] })
    await new Promise(r => setTimeout(r, 0)) // let the background broadcast settle
    // Accepted by the overlay → must NOT be aborted, must stay journaled for retry.
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'accepted' }])
  })

  it('journals a pending abort when the overlay rejects and abortAction fails', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [] } }) }
    const wallet = { createAction: vi.fn(), abortAction: vi.fn().mockRejectedValue(new Error('offline')) }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any))
      .rejects.toThrow('overlay rejected')
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'abort', reference: 'ref-1' }])
  })

  it('clears the journal after a successful accept + broadcast', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0], admissionSignature: 'ab' } }) }
    const wallet = { createAction: vi.fn().mockImplementation(postingWallet), abortAction: vi.fn() }
    const res = await submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any)
    expect(res.admissionSignature).toBe('ab')
    await new Promise(r => setTimeout(r, 0)) // background broadcast
    expect(await journalList()).toEqual([])
  })

  it('journals accepted BEFORE background broadcast starts (crash window is recoverable)', async () => {
    let resolveBroadcast!: () => void
    const broadcastGate = new Promise<void>(r => {
      resolveBroadcast = r
    })
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    const wallet = {
      createAction: vi.fn().mockImplementation(async (args: any) => {
        await broadcastGate
        return await postingWallet(args)
      }),
      abortAction: vi.fn()
    }
    const done = submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any)
    // Commit point resolves with journal already written; broadcast still pending.
    await expect(done).resolves.toMatchObject({ outputsToAdmit: [0] })
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'accepted' }])
    resolveBroadcast()
    await new Promise(r => setTimeout(r, 0))
    expect(await journalList()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Wire contract v2 §2 — structured refusals (FIX D)
// ---------------------------------------------------------------------------

describe('overlayErrorFromResponse — one row per §2 status', () => {
  const body = (code: string, retryable: boolean, extra: object = {}): string =>
    JSON.stringify({ status: 'error', code, retryable, description: `${code} happened`, ...extra })

  it.each([
    ['ERR_CONSERVATION', 400, false],
    ['ERR_LINKAGE', 400, false],
    ['ERR_SHAPE', 400, false],
    ['ERR_SATOSHIS', 400, false],
    ['ERR_INPUT_SPENT', 400, false],
    ['ERR_PAUSED', 409, true],
    ['ERR_FROZEN', 409, true],
    ['ERR_SANCTIONED', 409, true],
    ['ERR_ACCESS', 409, true],
    ['ERR_MEMBERSHIP', 409, true],
    ['ERR_EVICTED', 410, false],
    ['ERR_UNAVAILABLE', 503, true]
  ])('%s at HTTP %i is retryable=%s', (code, status, retryable) => {
    const err = overlayErrorFromResponse(status as number, body(code as string, retryable as boolean))
    expect(err).toBeInstanceOf(OverlayRefusedError)
    expect(err.code).toBe(code)
    expect(err.retryable).toBe(retryable)
    expect(err.httpStatus).toBe(status)
    expect(err.message).toContain(code as string)
  })

  it('carries the competing txid on ERR_INPUT_SPENT', () => {
    const err = overlayErrorFromResponse(400, body('ERR_INPUT_SPENT', false, { spendTxid: 'c'.repeat(64) }))
    expect(err.spendTxid).toBe('c'.repeat(64))
  })

  it('trusts the contract table over a body that mislabels retryability', () => {
    // A server claiming a pause is permanent must not be able to strand a payment…
    expect(overlayErrorFromResponse(409, body('ERR_PAUSED', false)).retryable).toBe(true)
    // …nor claim a conservation failure will fix itself.
    expect(overlayErrorFromResponse(400, body('ERR_CONSERVATION', true)).retryable).toBe(false)
  })

  it('falls back to the body for a code the contract does not know', () => {
    expect(overlayErrorFromResponse(409, body('ERR_FUTURE', true)).retryable).toBe(true)
    expect(overlayErrorFromResponse(400, body('ERR_FUTURE', false)).retryable).toBe(false)
  })

  it('treats a non-JSON, empty or unstructured body as ERR_UNAVAILABLE/retryable', () => {
    for (const raw of ['<html>502 Bad Gateway</html>', '', null, undefined, '{"nope":1}']) {
      const err = overlayErrorFromResponse(502, raw)
      expect(err.code).toBe('ERR_UNAVAILABLE')
      expect(err.retryable).toBe(true)
    }
  })
})

describe('createOverlayFacilitator', () => {
  const ok = (json: object): any => ({ ok: true, status: 200, text: async () => JSON.stringify(json) })

  it('posts to /submit with the topics header and returns the STEAK', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ tm_mandala: { outputsToAdmit: [0] } }))
    const res = await createOverlayFacilitator(fetchImpl).send(OVERLAY, { beef: [1, 2], topics: ['tm_mandala'] })
    expect(res).toEqual({ tm_mandala: { outputsToAdmit: [0] } })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${OVERLAY}/submit`)
    expect(init.headers['X-Topics']).toBe('["tm_mandala"]')
    expect(init.headers['x-includes-off-chain-values']).toBeUndefined()
    expect([...init.body]).toEqual([1, 2])
  })

  it('varint-frames the beef ahead of the off-chain values, as the overlay expects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ tm_mandala: { outputsToAdmit: [0] } }))
    await createOverlayFacilitator(fetchImpl).send(OVERLAY, { beef: [1, 2], topics: ['tm_mandala'], offChainValues: [9] })
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers['x-includes-off-chain-values']).toBe('true')
    expect([...init.body]).toEqual([2, 1, 2, 9])
  })

  it('turns a structured error body into the matching OverlayRefusedError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ status: 'error', code: 'ERR_FROZEN', retryable: true, description: 'input frozen' })
    })
    await expect(createOverlayFacilitator(fetchImpl).send(OVERLAY, { beef: [1], topics: ['tm_mandala'] }))
      .rejects.toMatchObject({ code: 'ERR_FROZEN', retryable: true, httpStatus: 409 })
  })

  it('reports a network fault as ERR_UNAVAILABLE, never as a verdict', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(createOverlayFacilitator(fetchImpl).send(OVERLAY, { beef: [1], topics: ['tm_mandala'] }))
      .rejects.toMatchObject({ code: 'ERR_UNAVAILABLE', retryable: true, httpStatus: 0 })
  })

  it('reports an unparseable 200 body as ERR_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'not json' })
    await expect(createOverlayFacilitator(fetchImpl).send(OVERLAY, { beef: [1], topics: ['tm_mandala'] }))
      .rejects.toMatchObject({ code: 'ERR_UNAVAILABLE', retryable: true })
  })
})

describe('submitToOverlay — refusal plumbing', () => {
  it('surfaces a structured refusal unchanged', async () => {
    const refusal = new OverlayRefusedError({ code: 'ERR_CONSERVATION', httpStatus: 400 })
    const facilitator = { send: vi.fn().mockRejectedValue(refusal) }
    await expect(submitToOverlay([1], undefined, facilitator as any)).rejects.toBe(refusal)
  })

  it('normalises any other transport failure to ERR_UNAVAILABLE/retryable', async () => {
    const facilitator = { send: vi.fn().mockRejectedValue(new Error('socket hang up')) }
    await expect(submitToOverlay([1], undefined, facilitator as any))
      .rejects.toMatchObject({ code: 'ERR_UNAVAILABLE', retryable: true })
  })
})

describe('submitAndBroadcast — refusals never broadcast', () => {
  const signed = { tx: [1, 2, 3], txid: 'abc' }

  it.each([
    ['ERR_CONSERVATION', 400],
    ['ERR_LINKAGE', 400],
    ['ERR_SHAPE', 400],
    ['ERR_SATOSHIS', 400],
    ['ERR_INPUT_SPENT', 400],
    ['ERR_EVICTED', 410]
  ])('aborts (releasing inputs) and never broadcasts on a final %s', async (code, status) => {
    const facilitator = { send: vi.fn().mockRejectedValue(new OverlayRefusedError({ code: code as string, httpStatus: status as number })) }
    const wallet = { createAction: vi.fn(), abortAction: vi.fn().mockResolvedValue({}) }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any))
      .rejects.toMatchObject({ code, retryable: false })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
  })

  it.each([
    ['ERR_PAUSED', 409],
    ['ERR_FROZEN', 409],
    ['ERR_SANCTIONED', 409],
    ['ERR_ACCESS', 409],
    ['ERR_MEMBERSHIP', 409],
    ['ERR_UNAVAILABLE', 503]
  ])('keeps the action alive (no abort, no broadcast) on a retryable %s', async (code, status) => {
    const facilitator = { send: vi.fn().mockRejectedValue(new OverlayRefusedError({ code: code as string, httpStatus: status as number })) }
    const wallet = { createAction: vi.fn(), abortAction: vi.fn().mockResolvedValue({}) }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any))
      .rejects.toMatchObject({ code, retryable: true })
    expect(wallet.createAction).not.toHaveBeenCalled()
    // Inputs stay held: the very same tx is re-submittable once the condition lifts.
    expect(wallet.abortAction).not.toHaveBeenCalled()
    // …and §9.11: held inputs need a durable record, or a crash here leaks the
    // live noSend action forever.
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'retryable', code, reference: 'ref-1' }])
  })

  it('journals σ_I with the accepted entry (A12 durable receipt)', async () => {
    const facilitator = {
      send: vi.fn().mockResolvedValue({
        tm_mandala: { outputsToAdmit: [0, 2], admissionSignature: 'de', admissionIdentityKey: '02aa' }
      })
    }
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const wallet = { createAction: vi.fn().mockImplementation(async () => { await gate; return {} }), abortAction: vi.fn() }
    const res = await submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any)
    expect(res).toMatchObject({ outputsToAdmit: [0, 2], admissionSignature: 'de', admissionIdentityKey: '02aa' })
    expect(await journalList()).toMatchObject([{
      txid: 'abc',
      stage: 'accepted',
      admissionSignature: 'de',
      admissionIdentityKey: '02aa',
      outputsToAdmit: [0, 2]
    }])
    release()
    await new Promise(r => setTimeout(r, 0))
  })
})

// ---------------------------------------------------------------------------
// §9.11 — a retryable refusal leaves a DURABLE record of the live action
// ---------------------------------------------------------------------------

describe('submitAndBroadcast — retryable refusals are journaled (§9.11)', () => {
  const signed = { tx: [0xde, 0xad, 0xbe, 0xef], txid: 'abc' }

  const refusing = (code = 'ERR_PAUSED'): any => ({
    send: vi.fn().mockRejectedValue(new OverlayRefusedError({ code, httpStatus: 409 }))
  })

  it('journals the bytes, topics, reference and code so reconcile can re-POST them', async () => {
    const wallet = { createAction: vi.fn(), abortAction: vi.fn() }
    await expect(submitAndBroadcast(wallet as any, signed, [7, 8], 'ref-1', refusing(), ['tm_mandala_registry']))
      .rejects.toMatchObject({ code: 'ERR_PAUSED', retryable: true })
    expect(await journalList()).toMatchObject([{
      txid: 'abc',
      stage: 'retryable',
      code: 'ERR_PAUSED',
      reference: 'ref-1',
      attempts: 0,
      submit: { txHex: 'deadbeef', offChainHex: '0708', topics: ['tm_mandala_registry'] }
    }])
  })

  it('omits offChainHex when the flow had no off-chain payload', async () => {
    const wallet = { createAction: vi.fn(), abortAction: vi.fn() }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', refusing()))
      .rejects.toMatchObject({ retryable: true })
    const [entry] = await journalList()
    expect(entry.submit?.offChainHex).toBeUndefined()
    expect(entry.submit?.topics).toEqual(['tm_mandala'])
  })

  it('journals even with no reference (genesis): the record still names the txid', async () => {
    const wallet = { createAction: vi.fn(), abortAction: vi.fn() }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, undefined, refusing()))
      .rejects.toMatchObject({ retryable: true })
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'retryable' }])
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('a crash BETWEEN the journal write and the rethrow still leaves the record', async () => {
    // The write is awaited, so the rejection provably cannot reach the caller
    // before the entry is durable: hold setItem open and the promise is still
    // pending. A process that dies in this window finds the entry on reboot.
    let landed!: () => void
    const gate = new Promise<void>(r => { landed = r })
    const mem = memoryStorage()
    let wrote: string | null = null
    configureStorage({
      ...mem,
      setItem: async (key, value) => {
        await mem.setItem(key, value)
        wrote = key
        await gate // "crash" window: the store has it, the caller does not have the error
      }
    })
    try {
      const wallet = { createAction: vi.fn(), abortAction: vi.fn() }
      const p = submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', refusing())
      let settled = false
      void p.catch(() => { settled = true })
      await new Promise(r => setTimeout(r, 0))
      expect(settled).toBe(false) // error withheld until the write lands
      expect(wrote).toBe('mandala.txJournal.abc')
      landed()
      await expect(p).rejects.toMatchObject({ code: 'ERR_PAUSED' })
      expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'retryable' }])
    } finally {
      configureStorage(null)
    }
  })

  it('a later successful submit of the same txid replaces the retryable entry with accepted', async () => {
    const wallet = { createAction: vi.fn().mockImplementation(postingWallet), abortAction: vi.fn() }
    await expect(submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', refusing()))
      .rejects.toMatchObject({ retryable: true })
    expect(await journalList()).toMatchObject([{ stage: 'retryable' }])
    const ok = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    await submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', ok as any)
    await new Promise(r => setTimeout(r, 0))
    expect(await journalList()).toEqual([]) // accepted, broadcast, cleared
  })
})

// ---------------------------------------------------------------------------
// The 2026-09-15 incident — `createAction({sendWith})` RESOLVED without the
// wallet having posted anything (its storage intentionally holds token requests
// for its own settlement drain, returning a hold result rather than throwing).
// The lib read "resolved" as "broadcast" and dropped the 'accepted' entry; the
// sweep then aborted an action whose transaction was already on chain.
// ---------------------------------------------------------------------------

describe('the wallet must prove it posted the tx', () => {
  const signed = { tx: [1, 2, 3], txid: 'abc' }
  const accepting = () => ({ send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) })

  describe('sendWithPosted', () => {
    it.each(['unproven', 'sending'])('accepts a %s status for the txid', status => {
      expect(sendWithPosted({ sendWithResults: [{ txid: 'abc', status }] }, 'abc')).toBe(true)
    })

    it.each([
      ['a hold-shaped result', {}],
      ['an undefined result', undefined],
      ['an empty batch', { sendWithResults: [] }],
      ['a failed status', { sendWithResults: [{ txid: 'abc', status: 'failed' }] }],
      ['a status nobody defines', { sendWithResults: [{ txid: 'abc', status: 'held' }] }],
      ['another txid entirely', { sendWithResults: [{ txid: 'zzz', status: 'unproven' }] }],
      ['a non-array sendWithResults', { sendWithResults: 'sent' }]
    ])('rejects %s', (_label, result) => {
      expect(sendWithPosted(result, 'abc')).toBe(false)
    })

    it('accepts a lone result the wallet did not label with a txid', () => {
      // The batch was `sendWith: [txid]` — a single unlabelled result is that one.
      expect(sendWithPosted({ sendWithResults: [{ status: 'sending' }] }, 'abc')).toBe(true)
    })
  })

  it('broadcastAcceptedTx reports whether the wallet posted it', async () => {
    const holding = { createAction: vi.fn().mockResolvedValue({}) }
    expect(await broadcastAcceptedTx(holding as any, 'abc')).toBe(false)
    const sending = { createAction: vi.fn().mockImplementation(postingWallet) }
    expect(await broadcastAcceptedTx(sending as any, 'abc')).toBe(true)
  })

  it("keeps the 'accepted' entry when createAction resolves without posting", async () => {
    const wallet = { createAction: vi.fn().mockResolvedValue({}), abortAction: vi.fn() }
    await submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', accepting() as any)
    await new Promise(r => setTimeout(r, 0)) // background broadcast settles
    expect(wallet.createAction).toHaveBeenCalled()
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'accepted' }])
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it("keeps the 'accepted' entry when the wallet reports the sendWith as failed", async () => {
    const wallet = {
      createAction: vi.fn().mockResolvedValue({ sendWithResults: [{ txid: 'abc', status: 'failed' }] }),
      abortAction: vi.fn()
    }
    await submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', accepting() as any)
    await new Promise(r => setTimeout(r, 0))
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'accepted' }])
  })
})


// 2026-09-15 — an admitted set is not an admission without a verifying σ_I
import { PrivateKey, Beef, LockingScript, Transaction, Utils as U } from '@bsv/sdk'
import { admissionMessageV2 } from './admission.js'

describe('submitToOverlay requires a verifying admission signature when a key is configured', () => {
  const OVERLAY_PRIV = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000d4')
  const OVERLAY_KEY = OVERLAY_PRIV.toPublicKey().toString()
  const IMPOSTOR = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000e5')
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
  const beef = new Beef(); beef.mergeTransaction(tx)
  const bytes = beef.toBinaryAtomic(tx.id('hex'))
  const sign = (key = OVERLAY_PRIV, outs = [0]) =>
    U.toHex(key.sign(U.toArray(admissionMessageV2(tx.id('hex'), outs), 'utf8')).toDER() as number[])

  beforeEach(() => configureMandala({ overlayUrl: OVERLAY, overlayIdentityKey: OVERLAY_KEY }))

  it('accepts a σ_I by the configured key', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0], admissionSignature: sign(), admissionIdentityKey: OVERLAY_KEY } }) }
    await expect(submitToOverlay(bytes, undefined, facilitator as any)).resolves.toMatchObject({ outputsToAdmit: [0] })
  })
  it('an admitted set with NO signature is a retryable ERR_NO_ADMISSION, never a success', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    await expect(submitToOverlay(bytes, undefined, facilitator as any)).rejects.toMatchObject({ code: 'ERR_NO_ADMISSION', retryable: true })
  })
  it('a signature by another key, or over another admitted set, is ERR_BAD_ADMISSION', async () => {
    const wrongKey = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0], admissionSignature: sign(IMPOSTOR), admissionIdentityKey: IMPOSTOR.toPublicKey().toString() } }) }
    await expect(submitToOverlay(bytes, undefined, wrongKey as any)).rejects.toMatchObject({ code: 'ERR_BAD_ADMISSION', retryable: true })
    const wrongSet = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0, 1], admissionSignature: sign(OVERLAY_PRIV, [0]), admissionIdentityKey: OVERLAY_KEY } }) }
    await expect(submitToOverlay(bytes, undefined, wrongSet as any)).rejects.toMatchObject({ code: 'ERR_BAD_ADMISSION' })
  })
  it('never broadcasts on an unsigned admission', async () => {
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    const wallet = { createAction: vi.fn().mockImplementation(postingWallet), abortAction: vi.fn().mockResolvedValue({ aborted: true }) }
    await expect(submitAndBroadcast(wallet as any, { tx: bytes, txid: tx.id('hex') } as any, undefined, 'ref', facilitator as any)).rejects.toMatchObject({ code: 'ERR_NO_ADMISSION' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})
