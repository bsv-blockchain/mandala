import { describe, it, expect } from 'vitest'
import { Hash, P2PKH, PrivateKey, Signature, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import {
  admissionDigestV2, admissionMessageV2, outputSetString, signAdmissionV2Sync,
  attachAdmissionSignaturesSync, wrapSubmitJson, finalVerdictOf, EVICTED_DESCRIPTION,
  withPersistedVerdict, payloadHashOfValues, payloadHashOfBody, EMPTY_PAYLOAD_HASH,
  ensureAdmissionIndexes, FINALIZE_FAILED,
  type AdmissionAdmitted, type AdmissionRefusal, type AdmissionRecord, type AdmissionStore,
  type AppliedProof, type Steak
} from './admission.js'
import { SubmitSideChannel, withVerdictCapture } from './submitSideChannel.js'
import { InputSpentError, FinalVerdictError, InfraError, isInfraError } from './submitVerdict.js'

const priv = PrivateKey.fromRandom()

// ─────────────────────────── digest v2 (contract §1) ────────────────────────

describe('admissionDigestV2 — σ_I binds to the admitted OUTPUT SET (FIX A)', () => {
  const txid = 'ab'.repeat(32)

  it('is SHA-256("mandala-admit:" + txid + ":" + sorted indexes), computed independently here', () => {
    const expected = Hash.sha256(Utils.toArray(`mandala-admit:${txid}:0,2,3`, 'utf8'))
    expect(admissionDigestV2(txid, [3, 0, 2])).toEqual(expected)
    expect(admissionMessageV2(txid, [3, 0, 2])).toBe(`mandala-admit:${txid}:0,2,3`)
  })

  it('sorts ascending, numerically — never lexicographically', () => {
    expect(outputSetString([10, 2, 1])).toBe('1,2,10')
  })

  it('de-duplicates, matching @bsv/mandala canonicalOutputs exactly', () => {
    expect(outputSetString([2, 0, 2])).toBe('0,2')
    expect(admissionDigestV2(txid, [2, 0, 2])).toEqual(admissionDigestV2(txid, [0, 2]))
  })

  it('renders a single admitted output as bare "0"', () => {
    expect(admissionMessageV2(txid, [0])).toBe(`mandala-admit:${txid}:0`)
  })

  it('differs from the v1 message — the old digest is gone', () => {
    expect(admissionDigestV2(txid, [0])).not.toEqual(Hash.sha256(Utils.toArray(`mandala-admit:${txid}`, 'utf8')))
  })

  it('separates two different admitted sets over the same txid', () => {
    expect(admissionDigestV2(txid, [0])).not.toEqual(admissionDigestV2(txid, [0, 1]))
  })

  it('verifies as ECDSA/DER over the v2 message under the overlay identity', () => {
    const { admissionSignature, admissionIdentityKey } = signAdmissionV2Sync(priv, txid, [0, 2])
    expect(admissionIdentityKey).toBe(priv.toPublicKey().toString())
    const sig = Signature.fromDER(Utils.toArray(admissionSignature, 'hex'))
    expect(priv.verify(Utils.toArray(`mandala-admit:${txid}:0,2`, 'utf8'), sig)).toBe(true)
    // …and does NOT verify over a different admitted set.
    expect(priv.verify(Utils.toArray(`mandala-admit:${txid}:0`, 'utf8'), sig)).toBe(false)
  })

  it('is deterministic (RFC 6979) — the same admission re-signs identically', () => {
    expect(signAdmissionV2Sync(priv, txid, [0, 1]).admissionSignature)
      .toBe(signAdmissionV2Sync(priv, txid, [1, 0]).admissionSignature)
  })
})

describe('attachAdmissionSignaturesSync — gated on tm_mandala specifically', () => {
  const txid = 'cd'.repeat(32)

  it('signs over the tm_mandala admitted set only', () => {
    const steak: Steak = { tm_mandala: { outputsToAdmit: [2, 0], coinsToRetain: [] } }
    attachAdmissionSignaturesSync(steak, txid, priv)
    expect(steak.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, txid, [0, 2]).admissionSignature)
  })

  it('never signs a registry-only admission', () => {
    const steak: Steak = {
      tm_mandala: { outputsToAdmit: [], coinsToRetain: [] },
      tm_mandala_registry: { outputsToAdmit: [0], coinsToRetain: [] }
    }
    attachAdmissionSignaturesSync(steak, txid, priv)
    expect(steak.tm_mandala_registry.admissionSignature).toBeUndefined()
    expect(steak.tm_mandala.admissionSignature).toBeUndefined()
  })

  it('leaves other topics unsigned even when tm_mandala admitted', () => {
    const steak: Steak = {
      tm_mandala: { outputsToAdmit: [0], coinsToRetain: [] },
      tm_mandala_registry: { outputsToAdmit: [1], coinsToRetain: [] }
    }
    attachAdmissionSignaturesSync(steak, txid, priv)
    expect(steak.tm_mandala.admissionSignature).toBeTypeOf('string')
    expect(steak.tm_mandala_registry.admissionSignature).toBeUndefined()
  })
})

// ──────────────────────────── harness for /submit ───────────────────────────

interface Captured { status: number, body: any }

const memStore = (seed: Record<string, AdmissionRecord> = {}): AdmissionStore & {
  rows: Record<string, AdmissionRecord>
  admitted: AdmissionAdmitted[]
  refusals: AdmissionRefusal[]
} => {
  const rows: Record<string, AdmissionRecord> = { ...seed }
  const admitted: AdmissionAdmitted[] = []
  const refusals: AdmissionRefusal[] = []
  return {
    rows,
    admitted,
    refusals,
    get: async (txid) => rows[txid] ?? null,
    // Mirrors the Mongo store in index.ts: an admission CLEARS the refusal
    // fields and the pending flag (§9.1/§9.4).
    putAdmitted: async (rec) => {
      admitted.push(rec)
      const merged = { ...(rows[rec.txid] ?? {}), ...rec, pending: false }
      delete merged.refusedCode
      delete merged.refusedDescription
      delete merged.refusedAt
      delete merged.refusedPayloadHash
      delete merged.refusedSpendTxid
      rows[rec.txid] = merged
    },
    putRefusal: async (rec) => { refusals.push(rec); rows[rec.txid] = { ...(rows[rec.txid] ?? { txid: rec.txid }), ...rec } },
    markEvicted: async (txid, at) => { rows[txid] = { ...(rows[txid] ?? { txid }), evictedAt: at } },
    putPending: async (rec) => { rows[rec.txid] = { pending: true, ...(rows[rec.txid] ?? {}), ...rec } }
  }
}

const applied = (opts: { applied?: string[], outputs?: Record<string, number[]> } = {}): AppliedProof => ({
  wasApplied: async (txid) => (opts.applied ?? []).includes(txid),
  storedOutputs: async (txid) => opts.outputs?.[txid] ?? []
})

// A real /submit always carries X-Topics (the pinned route throws without it),
// so the harness does too — its absence is itself a request-level 400 now.
const harness = (
  deps: Parameters<typeof wrapSubmitJson>[0],
  seed = 31,
  headers: Record<string, unknown> = { 'x-topics': JSON.stringify(['tm_mandala']) }
) => {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: seed.toString(16).padStart(2, '0').repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(priv.toAddress()) })

  let statusCode = 200
  let resolveSend: (c: Captured) => void = () => {}
  const sent = new Promise<Captured>(r => { resolveSend = r })
  const res: any = {
    status (n: number) { statusCode = n; return res },
    json (b: unknown) { resolveSend({ status: statusCode, body: b }); return res }
  }
  let resolveNext: () => void = () => {}
  const nexted = new Promise<'next'>(r => { resolveNext = () => r('next') })
  const req = { path: '/submit', method: 'POST', body: tx.toBEEF(), headers }
  wrapSubmitJson(deps)(req as any, res as any, resolveNext)
  return { txid: tx.id('hex'), res, sent, nexted, raced: Promise.race([nexted, sent]) }
}

// ────────────────────── success path + awaited persistence ──────────────────

describe('/submit success — STEAK + σ_I, record awaited before the response', () => {
  it('signs the tm_mandala entry and records outputsToAdmit (contract §4)', async () => {
    const store = memStore()
    const h = harness({ priv, store })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [1, 0], coinsToRetain: [0] } })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    expect(body.tm_mandala.outputsToAdmit).toEqual([1, 0])
    expect(body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, h.txid, [0, 1]).admissionSignature)
    expect(body.tm_mandala.admissionIdentityKey).toBe(priv.toPublicKey().toString())
    expect(store.admitted).toHaveLength(1)
    expect(store.admitted[0].outputsToAdmit).toEqual([0, 1])
    expect(store.admitted[0].topics).toEqual(['tm_mandala'])
    expect(store.admitted[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('AWAITS the record write before the response is sent (§3.3b)', async () => {
    let released: () => void = () => {}
    const gate = new Promise<void>(r => { released = r })
    const store = memStore()
    let landed = false
    const slow: AdmissionStore = { ...store, putAdmitted: async (rec) => { await gate; landed = true; await store.putAdmitted(rec) } }
    const h = harness({ priv, store: slow })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [0], coinsToRetain: [] } })
    let responded = false
    void h.sent.then(() => { responded = true })
    await new Promise(r => setTimeout(r, 10))
    expect(landed).toBe(false)
    expect(responded).toBe(false) // the client is still waiting — this is the point
    released()
    await h.sent
    expect(landed).toBe(true)
  })

  it('persists the restore snapshot the topic-manager wrapper captured (FIX E)', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    channel.noteRestore(h.txid, { spentOutpoints: ['aa'.repeat(32) + '.0'], tokenRows: [] })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [0], coinsToRetain: [0] } })
    await h.sent
    expect(store.admitted[0].restore?.spentOutpoints).toEqual(['aa'.repeat(32) + '.0'])
  })

  // Parity item 5: the compare-and-swap is a RACE BACKSTOP only.
  it('a CAS spend-mark conflict answers 503 ERR_UNAVAILABLE, never a final 400', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    const coin = 'aa'.repeat(32) + '.0'
    channel.noteRestore(h.txid, { spentOutpoints: [coin], tokenRows: [] })
    channel.noteSpendConflict(coin)
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [0], coinsToRetain: [0] } })
    const { status, body } = await h.sent
    expect(status).toBe(503)
    expect(body.code).toBe('ERR_UNAVAILABLE')
    expect(body.retryable).toBe(true)
    expect(body.message).toBe(body.description)
    // No admission record, so the dupe path cannot later serve a σ_I for it.
    expect(store.admitted).toHaveLength(0)
  })

  it('a CAS conflict on an unrelated coin does not disturb this submission', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    channel.noteRestore(h.txid, { spentOutpoints: ['aa'.repeat(32) + '.0'], tokenRows: [] })
    channel.noteSpendConflict('ff'.repeat(32) + '.7')
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [0], coinsToRetain: [0] } })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    expect(body.tm_mandala.admissionSignature).toBeTypeOf('string')
  })

  // §9.4 — this USED to answer 200: the finalize failure was swallowed and the
  // client banked a σ_I the overlay had no record of issuing, so the very next
  // GET /admin/admission/:txid 404'd and an offline verifier walking the
  // coverage chain refused a payment that had in fact been admitted.
  it('a failed FINALIZE write is 503 ERR_UNAVAILABLE, not a 200 with an unrecorded σ_I', async () => {
    const store: AdmissionStore = {
      get: async () => null,
      putAdmitted: async () => { throw new Error('mongo down') },
      putRefusal: async () => {},
      markEvicted: async () => {}
    }
    const h = harness({ priv, store })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [0], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(503)
    expect(body.code).toBe('ERR_UNAVAILABLE')
    expect(body.retryable).toBe(true)
    expect(body.description).toBe(FINALIZE_FAILED)
    // No σ_I is handed out for an admission that was not recorded.
    expect(body.tm_mandala).toBeUndefined()
  })

  it('leaves a registry-only admission unsigned and unrecorded', async () => {
    const store = memStore()
    const h = harness({ priv, store })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] }, tm_mandala_registry: { outputsToAdmit: [0], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    expect(body.tm_mandala_registry.admissionSignature).toBeUndefined()
    expect(store.admitted).toHaveLength(0)
  })

  it('passes non-/submit requests straight through', () => {
    let called = false
    wrapSubmitJson({ priv })({ path: '/lookup', method: 'POST', body: [], headers: {} } as any, { json: () => {} } as any, () => { called = true })
    expect(called).toBe(true)
  })
})

// ───────────────────────── FIX D — verdict taxonomy ─────────────────────────

describe('/submit refusal — FIX D verdict taxonomy (contract §2)', () => {
  const cases: Array<{ reason: string, status: number, code: string, retryable: boolean, final: boolean }> = [
    { reason: 'conservation violated: outputs exceed authorized inputs/issuance', status: 400, code: 'ERR_CONSERVATION', retryable: false, final: true },
    { reason: 'output 1: MandalaToken-decodable output with no verified linkage', status: 400, code: 'ERR_LINKAGE', retryable: false, final: true },
    { reason: 'token output 0 must carry exactly 1 satoshi', status: 400, code: 'ERR_SATOSHIS', retryable: false, final: true },
    { reason: 'something weird happened in the payload', status: 400, code: 'ERR_SHAPE', retryable: false, final: true },
    { reason: 'control gate rejected the transaction (paused asset or access mode)', status: 409, code: 'ERR_PAUSED', retryable: true, final: false },
    { reason: 'sanctioned party involved in transfer', status: 409, code: 'ERR_MEMBERSHIP', retryable: true, final: false }
  ]

  for (const c of cases) {
    it(`${c.code} → ${c.status} (persisted=${String(c.final)})`, async () => {
      const store = memStore()
      const channel = new SubmitSideChannel()
      const h = harness({ priv, store, channel })
      await h.nexted
      channel.noteReject(h.txid, new Error(c.reason))
      // the pinned engine swallows the reject into a 200 with an empty STEAK
      h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
      const { status, body } = await h.sent
      expect(status).toBe(c.status)
      expect(body).toEqual({
        status: 'error', code: c.code, retryable: c.retryable, description: c.reason, message: c.reason
      })
      expect(store.refusals.length).toBe(c.final ? 1 : 0)
    })
  }

  // Parity item 3: the record is keyed by txid alone, so persisting a
  // registry-only refusal would refuse a later, valid token submit of the same
  // bytes forever.
  it('answers 400 but does NOT persist when tm_mandala was not part of the submission', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel }, 31, { 'x-topics': JSON.stringify(['tm_mandala_registry']) })
    await h.nexted
    channel.noteReject(h.txid, new Error('registry entry is malformed'), 'tm_mandala_registry')
    h.res.json({ tm_mandala_registry: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(400)
    expect(body.code).toBe('ERR_SHAPE')
    expect(store.refusals).toHaveLength(0)
    expect(store.rows[h.txid]).toBeUndefined()
  })

  it('a tm_mandala reject outranks another topic\'s on the same txid', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel }, 31, { 'x-topics': JSON.stringify(['tm_mandala', 'tm_mandala_registry']) })
    await h.nexted
    channel.noteReject(h.txid, new Error('registry entry is malformed'), 'tm_mandala_registry')
    channel.noteReject(h.txid, new Error('conservation violated'), 'tm_mandala')
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] }, tm_mandala_registry: { outputsToAdmit: [], coinsToRetain: [] } })
    const { body } = await h.sent
    expect(body.code).toBe('ERR_CONSERVATION')
    expect(store.refusals).toHaveLength(1)
  })

  it('a non-token topic never overwrites an already-captured tm_mandala reason', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel }, 31, { 'x-topics': JSON.stringify(['tm_mandala', 'tm_mandala_registry']) })
    await h.nexted
    channel.noteReject(h.txid, new Error('conservation violated'), 'tm_mandala')
    channel.noteReject(h.txid, new Error('registry entry is malformed'), 'tm_mandala_registry')
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    expect((await h.sent).body.code).toBe('ERR_CONSERVATION')
  })

  // Parity item 1, second half.
  it('a missing x-topics header is a request-level 400 ERR_SHAPE, not a 503', async () => {
    const h = harness({ priv, store: memStore(), channel: new SubmitSideChannel() }, 31, {})
    await h.nexted
    h.res.json({ status: 'error', message: 'Missing x-topics header' })
    const { status, body } = await h.sent
    expect(status).toBe(400)
    expect(body).toEqual({
      status: 'error', code: 'ERR_SHAPE', retryable: false,
      description: 'Missing x-topics header', message: 'Missing x-topics header'
    })
  })

  it('an undecodable BEEF is a request-level 400 ERR_SHAPE', async () => {
    let statusCode = 200
    let resolve: (c: any) => void = () => {}
    const sent = new Promise<any>(r => { resolve = r })
    const res: any = { status (n: number) { statusCode = n; return res }, json (b: unknown) { resolve({ status: statusCode, body: b }); return res } }
    const req = { path: '/submit', method: 'POST', body: Buffer.from([1, 2, 3]), headers: { 'x-topics': JSON.stringify(['tm_mandala']) } }
    await new Promise<void>(r => { wrapSubmitJson({ priv, store: memStore() })(req as any, res as any, () => r()) })
    res.json({ status: 'error', message: 'Invalid BEEF' })
    const got = await sent
    expect(got.status).toBe(400)
    expect(got.body).toEqual({
      status: 'error', code: 'ERR_SHAPE', retryable: false, description: 'Invalid BEEF', message: 'Invalid BEEF'
    })
  })

  // §9.2 — 400 retryable:false with spendTxid on the wire, and NOTHING written:
  // the competitor can be evicted (contract §7's rescue), and a persisted
  // ERR_INPUT_SPENT would outrank that rescue and kill the coin forever.
  it('ERR_INPUT_SPENT names the competing txid (FIX L) but is NEVER persisted', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    await h.nexted
    channel.noteReject(h.txid, new InputSpentError('aa'.repeat(32) + '.0', 'bb'.repeat(32)))
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(400)
    expect(body.code).toBe('ERR_INPUT_SPENT')
    expect(body.retryable).toBe(false)
    expect(body.spendTxid).toBe('bb'.repeat(32))
    expect(store.refusals).toHaveLength(0)
    expect(store.rows[h.txid]).toBeUndefined()
  })

  it('a liftable 409 is NOT persisted, so an unpause can take effect later', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    await h.nexted
    channel.noteReject(h.txid, new Error('asset is paused'))
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    await h.sent
    expect(store.rows[h.txid]).toBeUndefined()
  })

  it('anything that is NOT a manager verdict becomes 503 ERR_UNAVAILABLE', async () => {
    const h = harness({ priv, store: memStore(), channel: new SubmitSideChannel() })
    await h.nexted
    // the pinned route's own catch-all shape for an engine throw
    h.res.json({ status: 'error', message: 'Unable to verify SPV information.' })
    const { status, body } = await h.sent
    expect(status).toBe(503)
    expect(body).toEqual({
      status: 'error', code: 'ERR_UNAVAILABLE', retryable: true,
      description: 'Unable to verify SPV information.', message: 'Unable to verify SPV information.'
    })
  })

  it('a captured manager reason still wins over an engine-level error body', async () => {
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store: memStore(), channel })
    await h.nexted
    channel.noteReject(h.txid, new Error('conservation violated'))
    h.res.json({ status: 'error', message: 'An unknown error occurred' })
    const { status, body } = await h.sent
    expect(status).toBe(400)
    expect(body.code).toBe('ERR_CONSERVATION')
  })

  it('does NOT 4xx a submission another topic admitted (the engine already broadcast it)', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    await h.nexted
    channel.noteReject(h.txid, new Error('conservation violated'))
    h.res.json({
      tm_mandala: { outputsToAdmit: [], coinsToRetain: [] },
      tm_mandala_registry: { outputsToAdmit: [0], coinsToRetain: [] }
    })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    expect(body.tm_mandala.admissionSignature).toBeUndefined()
    expect(store.refusals).toHaveLength(0)
  })

  it('passes an empty STEAK through untouched when there is no verdict and no dupe', async () => {
    const h = harness({ priv, store: memStore(), applied: applied() })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    expect(body).toEqual({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
  })
})

// ───────────────────── FIX C — idempotent dupe / verdict wins ───────────────

describe('/submit dupe path — FIX C', () => {
  it('re-signs from the admission record and returns 200 with the tm_mandala entry ALONE', async () => {
    const h0 = harness({ priv })
    const store = memStore({ [h0.txid]: { txid: h0.txid, outputsToAdmit: [0, 2], at: '2026-01-01T00:00:00.000Z', admissionSignature: 'x', admissionIdentityKey: 'y' } })
    const h = harness({ priv, store, applied: applied({ applied: [h0.txid] }) })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] }, tm_mandala_registry: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    // Exactly one topic, exactly four keys (parity item 6).
    expect(Object.keys(body)).toEqual(['tm_mandala'])
    expect(body.tm_mandala).toEqual({
      outputsToAdmit: [0, 2],
      coinsToRetain: [],
      admissionSignature: signAdmissionV2Sync(priv, h.txid, [0, 2]).admissionSignature,
      admissionIdentityKey: priv.toPublicKey().toString()
    })
    expect(store.admitted).toHaveLength(0) // no side effects re-run
  })

  it('derives outputsToAdmit from the engine stored outputs when the record is missing', async () => {
    const h0 = harness({ priv })
    const store = memStore()
    const h = harness({ priv, store, applied: applied({ applied: [h0.txid], outputs: { [h0.txid]: [3, 1] } }) })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    expect(body.tm_mandala.outputsToAdmit).toEqual([1, 3])
    expect(body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, h.txid, [1, 3]).admissionSignature)
    // No side effects (contract §2): the dupe path writes no record. A later
    // GET re-derives the same signature from the applied-transaction proof.
    expect(store.admitted).toHaveLength(0)
  })

  it('does not invent an admission when the applied store has never seen the txid', async () => {
    const h = harness({ priv, store: memStore(), applied: applied() })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { body } = await h.sent
    expect(body.tm_mandala.admissionSignature).toBeUndefined()
  })

  it('is idempotent: two submits of the same txid yield the identical signature', async () => {
    const h0 = harness({ priv })
    const deps = { priv, store: memStore(), applied: applied({ applied: [h0.txid], outputs: { [h0.txid]: [0] } }) }
    const a = harness(deps); await a.nexted; a.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const b = harness(deps); await b.nexted; b.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    expect((await a.sent).body.tm_mandala.admissionSignature).toBe((await b.sent).body.tm_mandala.admissionSignature)
  })
})

describe('"verdict wins" — withPersistedVerdict refuses before the engine admits', () => {
  const beefOf = (seed = 31) => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: seed.toString(16).padStart(2, '0').repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(priv.toAddress()) })
    return { beef: tx.toBEEF(), txid: tx.id('hex') }
  }
  const inner = (calls: { n: number }): any => ({
    identifyAdmissibleOutputs: async () => { calls.n++; return { outputsToAdmit: [0], coinsToRetain: [] } },
    getDocumentation: async () => 'doc',
    getMetaData: async () => ({ name: 'tm_mandala', shortDescription: 's' })
  })

  it('throws FinalVerdictError(ERR_EVICTED) so the engine never re-admits the same bytes', async () => {
    const { beef, txid } = beefOf()
    const calls = { n: 0 }
    const tm = withPersistedVerdict(inner(calls), memStore({ [txid]: { txid, evictedAt: '2026-01-02T00:00:00.000Z' } }))
    const err = await tm.identifyAdmissibleOutputs(beef, [0], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FinalVerdictError)
    expect((err as FinalVerdictError).code).toBe('ERR_EVICTED')
    expect((err as FinalVerdictError).description).toBe(EVICTED_DESCRIPTION(txid))
    expect(calls.n).toBe(0)
  })

  it('throws the persisted refusal code when the payload hash matches (§9.1)', async () => {
    const { beef, txid } = beefOf()
    const payload = Utils.toArray('{"outputs":[]}', 'utf8')
    const tm = withPersistedVerdict(inner({ n: 0 }), memStore({
      [txid]: {
        txid,
        refusedCode: 'ERR_CONSERVATION',
        refusedDescription: 'conservation violated',
        refusedAt: 'z',
        refusedPayloadHash: payloadHashOfValues(payload)
      }
    }))
    const err = await tm.identifyAdmissibleOutputs(beef, [0], payload).catch((e: unknown) => e) as FinalVerdictError
    expect(err).toBeInstanceOf(FinalVerdictError)
    expect(err.code).toBe('ERR_CONSERVATION')
  })

  // §9.2 — a record written before the amendment can still carry one; it must
  // not be replayed, or contract §7's eviction rescue can never take effect.
  it('never replays a persisted ERR_INPUT_SPENT, even on an exact payload match', async () => {
    const { beef, txid } = beefOf()
    const calls = { n: 0 }
    const tm = withPersistedVerdict(inner(calls), memStore({
      [txid]: {
        txid,
        refusedCode: 'ERR_INPUT_SPENT',
        refusedDescription: 'input x: already spent by y',
        refusedAt: 'z',
        refusedSpendTxid: 'bb'.repeat(32),
        refusedPayloadHash: payloadHashOfValues()
      }
    }))
    expect((await tm.identifyAdmissibleOutputs(beef, [0], undefined)).outputsToAdmit).toEqual([0])
    expect(calls.n).toBe(1)
  })

  it('delegates when there is no final verdict', async () => {
    const { beef } = beefOf()
    const calls = { n: 0 }
    const tm = withPersistedVerdict(inner(calls), memStore())
    expect((await tm.identifyAdmissibleOutputs(beef, [0], undefined)).outputsToAdmit).toEqual([0])
    expect(calls.n).toBe(1)
  })

  // §9.5 — the previous behaviour SWALLOWED this and delegated, i.e. the guard
  // failed OPEN: an evicted txid was re-admitted and a fresh σ_I minted over
  // restored inputs whenever Mongo blinked. Failing closed is still not a
  // refusal — it is a retryable 503 that is never persisted.
  it('a storage fault fails CLOSED with an InfraError, never a refusal and never open', async () => {
    const { beef } = beefOf()
    const calls = { n: 0 }
    const boom: AdmissionStore = { ...memStore(), get: async () => { throw new Error('mongo down') } }
    const tm = withPersistedVerdict(inner(calls), boom)
    const err = await tm.identifyAdmissibleOutputs(beef, [0], undefined).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(err).not.toBeInstanceOf(FinalVerdictError)
    expect(calls.n).toBe(0)
  })

  it('preserves documentation/metadata through the proxy', async () => {
    const tm = withPersistedVerdict(inner({ n: 0 }), memStore())
    expect(await tm.getDocumentation()).toBe('doc')
    expect(await tm.getMetaData?.()).toEqual({ name: 'tm_mandala', shortDescription: 's' })
  })

  it('/submit replays the structural verdict verbatim, never re-classified', async () => {
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store: memStore(), channel })
    await h.nexted
    channel.noteReject(h.txid, new FinalVerdictError('ERR_EVICTED', EVICTED_DESCRIPTION(h.txid)))
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(410)
    expect(body).toEqual({
      status: 'error', code: 'ERR_EVICTED', retryable: false,
      description: EVICTED_DESCRIPTION(h.txid), message: EVICTED_DESCRIPTION(h.txid)
    })
  })

  it('/submit also replays a persisted verdict reached via the settle path', async () => {
    const h0 = harness({ priv })
    const store = memStore({
      [h0.txid]: {
        txid: h0.txid,
        refusedCode: 'ERR_CONSERVATION',
        refusedDescription: 'conservation violated',
        refusedAt: '2026-01-01T00:00:00.000Z',
        // The harness submits no off-chain values, so this is the payload it
        // presents (§9.1: an absent payload hashes the empty byte string).
        refusedPayloadHash: EMPTY_PAYLOAD_HASH
      }
    })
    const h = harness({ priv, store })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(400)
    expect(body).toEqual({
      status: 'error', code: 'ERR_CONSERVATION', retryable: false,
      description: 'conservation violated', message: 'conservation violated'
    })
  })
})

// ───────────── §9.1 — payload-scoped verdicts (verdict poisoning) ────────────

describe('payloadHash — a refusal is keyed by (txid, payload), never by txid alone', () => {
  const PAYLOAD = Utils.toArray('{"outputs":[{"index":0}]}', 'utf8')

  it('hashes the payload bytes; an absent or empty payload is sha256("")', () => {
    expect(EMPTY_PAYLOAD_HASH).toBe(Utils.toHex(Hash.sha256([])))
    expect(payloadHashOfValues()).toBe(EMPTY_PAYLOAD_HASH)
    expect(payloadHashOfValues([])).toBe(EMPTY_PAYLOAD_HASH)
    expect(payloadHashOfValues(PAYLOAD)).toBe(Utils.toHex(Hash.sha256(PAYLOAD)))
  })

  // The body framing is the pinned overlay-express route's:
  //   varint(beefLength) ++ beef ++ offChainValues
  it('reads the payload out of the raw /submit body exactly as the pinned route frames it', () => {
    const beef = [1, 2, 3, 4]
    const w = new Utils.Writer()
    w.writeVarIntNum(beef.length)
    w.write(beef)
    w.write(PAYLOAD)
    expect(payloadHashOfBody(w.toArray(), true)).toBe(payloadHashOfValues(PAYLOAD))
    // No off-chain header ⇒ no payload, whatever the body happens to contain.
    expect(payloadHashOfBody(w.toArray(), false)).toBe(EMPTY_PAYLOAD_HASH)
    // An unframeable body cannot be keyed to anything a later submit re-presents.
    expect(payloadHashOfBody([0xff], true)).toBe(EMPTY_PAYLOAD_HASH)
  })

  it('a refusal for ANOTHER payload is not replayed — it is re-evaluated', () => {
    const txid = 'ab'.repeat(32)
    const rec: AdmissionRecord = {
      txid,
      refusedCode: 'ERR_LINKAGE',
      refusedDescription: 'output 1: MandalaToken-decodable output with no verified linkage',
      refusedAt: 'z',
      refusedPayloadHash: EMPTY_PAYLOAD_HASH
    }
    expect(finalVerdictOf(txid, rec, EMPTY_PAYLOAD_HASH)?.code).toBe('ERR_LINKAGE')
    expect(finalVerdictOf(txid, rec, payloadHashOfValues(PAYLOAD))).toBeNull()
    // §9.3 — a caller that names no payload is never served a refusal.
    expect(finalVerdictOf(txid, rec)).toBeNull()
  })

  it('a pre-amendment record with no refusedPayloadHash matches nothing', () => {
    const txid = 'ab'.repeat(32)
    const rec: AdmissionRecord = { txid, refusedCode: 'ERR_SHAPE', refusedDescription: 'bad', refusedAt: 'z' }
    expect(finalVerdictOf(txid, rec, EMPTY_PAYLOAD_HASH)).toBeNull()
    expect(finalVerdictOf(txid, rec, payloadHashOfValues(PAYLOAD))).toBeNull()
  })

  it('eviction stays keyed by txid alone — no payload makes the inputs spendable again', () => {
    const txid = 'ab'.repeat(32)
    const rec: AdmissionRecord = { txid, evictedAt: '2026-09-15T00:00:00.000Z' }
    expect(finalVerdictOf(txid, rec)?.code).toBe('ERR_EVICTED')
    expect(finalVerdictOf(txid, rec, payloadHashOfValues(PAYLOAD))?.code).toBe('ERR_EVICTED')
  })

  it('/submit stamps the refusal with the payload THIS request presented', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    await h.nexted
    channel.noteReject(h.txid, new Error('conservation violated'))
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    await h.sent
    expect(store.refusals[0].refusedPayloadHash).toBe(EMPTY_PAYLOAD_HASH)
  })
})

// ────────── a refusal is persisted only from tm_mandala's OWN verdict ───────

describe('persistence is gated on the REFUSING topic, not the x-topics header', () => {
  it('does not persist a registry verdict even when the header names tm_mandala', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    // The header is the submitter's own assertion and costs nothing to write.
    const h = harness({ priv, store, channel }, 31, { 'x-topics': JSON.stringify(['tm_mandala']) })
    await h.nexted
    channel.noteReject(h.txid, new Error('registry entry is malformed'), 'tm_mandala_registry')
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(400)
    expect(body.code).toBe('ERR_SHAPE')
    expect(store.refusals).toHaveLength(0)
    expect(store.rows[h.txid]).toBeUndefined()
  })

  it('does persist when tm_mandala itself refused', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    await h.nexted
    channel.noteReject(h.txid, new Error('conservation violated'), 'tm_mandala')
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    await h.sent
    expect(store.refusals).toHaveLength(1)
    expect(store.refusals[0].refusedCode).toBe('ERR_CONSERVATION')
  })
})

// ──────────────────── §9.5 — infra faults are never final ────────────────────

describe('/submit — an InfraError anywhere in the stack is 503 and is never persisted', () => {
  it('replays a captured InfraError as 503 ERR_UNAVAILABLE with no record written', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    await h.nexted
    channel.noteReject(h.txid, new InfraError('the token row store is unavailable: ECONNREFUSED'))
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(503)
    expect(body).toEqual({
      status: 'error', code: 'ERR_UNAVAILABLE', retryable: true,
      description: 'the token row store is unavailable: ECONNREFUSED',
      message: 'the token row store is unavailable: ECONNREFUSED'
    })
    expect(store.refusals).toHaveLength(0)
    expect(store.rows[h.txid]).toBeUndefined()
  })

  it('does not let the substring table turn a store fault into a final 400', async () => {
    const store = memStore()
    const channel = new SubmitSideChannel()
    const h = harness({ priv, store, channel })
    await h.nexted
    // "…already spent…" would classify as a final 400 ERR_INPUT_SPENT, and
    // "linkage" as ERR_LINKAGE — the structural marker outranks both.
    channel.noteReject(h.txid, new InfraError('linkage store is unavailable: already spent connection'))
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(503)
    expect(body.code).toBe('ERR_UNAVAILABLE')
    expect(store.refusals).toHaveLength(0)
  })
})

// ─────────────── §9.4 — provisional record / dupe-path finalize ──────────────

describe('§9.4 — the dupe path finalizes a record left pending by a crash', () => {
  it('finalizes {pending:true} from the applied proof and answers 200', async () => {
    const h0 = harness({ priv })
    const store = memStore({
      [h0.txid]: {
        txid: h0.txid,
        topics: ['tm_mandala'],
        at: '2026-09-15T00:00:00.000Z',
        pending: true,
        restore: { spentOutpoints: ['aa'.repeat(32) + '.0'], tokenRows: [] }
      }
    })
    const h = harness({ priv, store, applied: applied({ applied: [h0.txid], outputs: { [h0.txid]: [0] } }) })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    const { status, body } = await h.sent
    expect(status).toBe(200)
    expect(body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, h.txid, [0]).admissionSignature)
    // The half-written record is now complete — and keeps its restore snapshot,
    // so a later eviction can still put the inputs back.
    expect(store.admitted).toHaveLength(1)
    expect(store.rows[h.txid].outputsToAdmit).toEqual([0])
    expect(store.rows[h.txid].admissionSignature).toBeTypeOf('string')
    expect(store.rows[h.txid].restore?.spentOutpoints).toEqual(['aa'.repeat(32) + '.0'])
  })

  it('leaves an already-finalized record alone (the dupe path stays side-effect free)', async () => {
    const h0 = harness({ priv })
    const store = memStore({
      [h0.txid]: {
        txid: h0.txid, outputsToAdmit: [0], admissionSignature: 'x', admissionIdentityKey: 'y',
        at: '2026-09-15T00:00:00.000Z', pending: false
      }
    })
    const h = harness({ priv, store, applied: applied({ applied: [h0.txid] }) })
    await h.nexted
    h.res.json({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    expect((await h.sent).status).toBe(200)
    expect(store.admitted).toHaveLength(0)
  })
})

// ─────────── §9.7 — two concurrent /submit of the SAME txid ─────────────────

describe('§9.7 — concurrent submits of one txid each get their own verdict', () => {
  const beefOf = () => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '77'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(priv.toAddress()) })
    return { beef: tx.toBEEF(), txid: tx.id('hex') }
  }

  const framed = (beef: number[], payload: number[]): Buffer => {
    const w = new Utils.Writer()
    w.writeVarIntNum(beef.length)
    w.write(beef)
    w.write(payload)
    return Buffer.from(w.toArray())
  }

  /**
   * The engine runs INSIDE next(), which is where wrapSubmitJson enters the
   * request's capture scope. `beforeRespond` lets a test hold one request's
   * response back so the two interleave in a chosen order.
   */
  const submitInScope = async (
    tm: any, deps: Parameters<typeof wrapSubmitJson>[0], beef: number[], payload: number[],
    beforeRespond?: () => Promise<void>
  ): Promise<Captured> => {
    let statusCode = 200
    let resolveSend: (c: Captured) => void = () => {}
    const sent = new Promise<Captured>(r => { resolveSend = r })
    const res: any = {
      status (n: number) { statusCode = n; return res },
      json (b: unknown) { resolveSend({ status: statusCode, body: b }); return res }
    }
    const req = {
      path: '/submit',
      method: 'POST',
      body: framed(beef, payload),
      headers: { 'x-topics': JSON.stringify(['tm_mandala']), 'x-includes-off-chain-values': 'true' }
    }
    wrapSubmitJson(deps)(req as any, res as any, () => {
      void (async () => {
        let steak: Record<string, unknown>
        try {
          steak = { tm_mandala: await tm.identifyAdmissibleOutputs(beef, [0], payload) }
        } catch {
          steak = { tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } }
        }
        if (beforeRespond != null) await beforeRespond()
        res.json(steak)
      })()
    })
    return await sent
  }

  it('neither sees the other\'s verdict, and a refusal is never an empty-STEAK 200', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const REFUSED = Utils.toArray('{"payload":"stripped"}', 'utf8')
    const CLEAN = Utils.toArray('{"payload":"complete"}', 'utf8')

    // Both managers are held inside the engine until BOTH have arrived, so the
    // two requests genuinely overlap rather than running back to back.
    let arrived = 0
    let release: () => void = () => {}
    const bothInFlight = new Promise<void>(r => { release = () => { r() } })
    const inner: any = {
      identifyAdmissibleOutputs: async (_b: number[], _p: number[], payload?: number[]) => {
        if (++arrived === 2) release()
        await bothInFlight
        if (payloadHashOfValues(payload) === payloadHashOfValues(REFUSED)) {
          throw new Error('conservation violated: outputs exceed authorized inputs/issuance')
        }
        return { outputsToAdmit: [0], coinsToRetain: [] }
      }
    }
    const tm = withVerdictCapture(inner, { channel })
    const { beef, txid } = beefOf()

    // The refused request captures its verdict FIRST but responds LAST — the
    // interleaving a single process-wide map cannot survive: the clean request
    // would consume the refusal on its way out, leaving the refused one with
    // nothing to report but the engine's empty STEAK, i.e. a 200.
    let cleanSettled: () => void = () => {}
    const cleanDone = new Promise<void>(r => { cleanSettled = () => { r() } })
    const refusedPromise = submitInScope(tm, { priv, store, channel }, beef, REFUSED, async () => { await cleanDone })
    const clean = await submitInScope(tm, { priv, store, channel }, beef, CLEAN)
    cleanSettled()
    const refused = await refusedPromise

    expect(clean.status).toBe(200)
    expect(clean.body.tm_mandala.outputsToAdmit).toEqual([0])
    expect(clean.body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, txid, [0]).admissionSignature)
    expect(clean.body.code).toBeUndefined()

    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe('ERR_CONSERVATION')
    expect(refused.body.tm_mandala).toBeUndefined()

    // …and the refusal is stamped with the payload that actually earned it.
    expect(store.refusals).toHaveLength(1)
    expect(store.refusals[0].refusedPayloadHash).toBe(payloadHashOfValues(REFUSED))
  })
})

// ──────────────────────────── §9.9 — boot safety ─────────────────────────────

describe('ensureAdmissionIndexes — §9.9, index failures abort startup', () => {
  it('creates the UNIQUE index on txid', async () => {
    const calls: Array<[Record<string, number>, Record<string, unknown> | undefined]> = []
    await ensureAdmissionIndexes({ createIndex: async (spec, opts) => { calls.push([spec, opts]); return 'ix' } })
    expect(calls).toEqual([[{ txid: 1 }, { unique: true }]])
  })

  it('rethrows as a FATAL error rather than booting without it', async () => {
    const err = await ensureAdmissionIndexes({
      createIndex: async () => { throw new Error('E11000 duplicate key') }
    }).catch((e: unknown) => e) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/FATAL/)
    expect(err.message).toMatch(/mandalaAdmissions/)
    expect(err.message).toMatch(/E11000 duplicate key/)
  })
})

describe('finalVerdictOf', () => {
  const txid = 'ab'.repeat(32)
  it('is null for a plain admission', () => {
    expect(finalVerdictOf(txid, { txid, outputsToAdmit: [0] })).toBeNull()
  })
  it('prefers eviction over a stored refusal', () => {
    expect(finalVerdictOf(txid, { txid, evictedAt: 'now', refusedCode: 'ERR_SHAPE' })?.code).toBe('ERR_EVICTED')
  })
  it('ignores a non-final code that somehow got persisted', () => {
    expect(finalVerdictOf(txid, { txid, refusedCode: 'ERR_PAUSED' })).toBeNull()
  })
  it('is null for a missing record', () => {
    expect(finalVerdictOf(txid, null)).toBeNull()
  })
})
