import { describe, it, expect } from 'vitest'
import { PrivateKey, Utils } from '@bsv/sdk'
import { admissionResponse, admissionHandler } from './admissionRoute.js'
import {
  signAdmissionV2Sync, EVICTED_DESCRIPTION, EMPTY_PAYLOAD_HASH, payloadHashOfValues,
  type AdmissionRecord, type AdmissionStore, type AppliedProof
} from './admission.js'

const priv = PrivateKey.fromRandom()
const TXID = 'ab'.repeat(32)

const store = (rows: Record<string, AdmissionRecord> = {}): AdmissionStore => ({
  get: async (txid) => rows[txid] ?? null,
  putAdmitted: async () => {},
  putRefusal: async () => {},
  markEvicted: async () => {}
})

const applied = (opts: { applied?: string[], outputs?: Record<string, number[]> } = {}): AppliedProof => ({
  wasApplied: async (txid) => (opts.applied ?? []).includes(txid),
  storedOutputs: async (txid) => opts.outputs?.[txid] ?? []
})

describe('GET /admin/admission/:txid — contract §3', () => {
  it('200 with {txid, outputsToAdmit, admissionSignature, admissionIdentityKey, at}', async () => {
    const rec: AdmissionRecord = {
      txid: TXID, topics: ['tm_mandala'], outputsToAdmit: [0, 2],
      admissionSignature: 'deadbeef', admissionIdentityKey: '02' + 'cc'.repeat(32),
      at: '2026-09-14T00:00:00.000Z',
      restore: { spentOutpoints: ['x.0'], tokenRows: [] }
    }
    const out = await admissionResponse(TXID, { store: store({ [TXID]: rec }), applied: applied(), priv })
    expect(out.status).toBe(200)
    // exactly five keys — the internal restore snapshot and topics never leak
    expect(out.body).toEqual({
      txid: TXID,
      outputsToAdmit: [0, 2],
      admissionSignature: 'deadbeef',
      admissionIdentityKey: '02' + 'cc'.repeat(32),
      at: '2026-09-14T00:00:00.000Z'
    })
  })

  it('410 ERR_EVICTED once the record carries evictedAt', async () => {
    const out = await admissionResponse(TXID, {
      store: store({ [TXID]: { txid: TXID, outputsToAdmit: [0], admissionSignature: 'x', admissionIdentityKey: 'y', at: 'z', evictedAt: '2026-09-14T01:00:00.000Z' } }),
      applied: applied({ applied: [TXID], outputs: { [TXID]: [0] } }),
      priv
    })
    expect(out.status).toBe(410)
    expect(out.body).toEqual({
      status: 'error', code: 'ERR_EVICTED', retryable: false,
      description: EVICTED_DESCRIPTION(TXID), message: EVICTED_DESCRIPTION(TXID)
    })
  })

  // §9.3 — a persisted refusal is served ONLY to a caller that names the
  // payload it is about.
  const REFUSED = 'output 1: MandalaToken-decodable output with no verified linkage'
  const refusedRec = (hash: string): AdmissionRecord => ({
    txid: TXID, refusedCode: 'ERR_LINKAGE', refusedDescription: REFUSED, refusedAt: 'z', refusedPayloadHash: hash
  })

  it('400 with the persisted final refusal code when ?payloadHash matches', async () => {
    const out = await admissionResponse(
      TXID,
      { store: store({ [TXID]: refusedRec(EMPTY_PAYLOAD_HASH) }), applied: applied(), priv },
      EMPTY_PAYLOAD_HASH
    )
    expect(out.status).toBe(400)
    expect(out.body).toEqual({
      status: 'error', code: 'ERR_LINKAGE', retryable: false,
      description: REFUSED, message: REFUSED
    })
  })

  // The poisoning route: one unauthenticated submit with the payload stripped
  // would otherwise make this 400 the public answer for the txid, for everyone.
  it('404 — never 400 — when no payloadHash is given', async () => {
    const out = await admissionResponse(TXID, {
      store: store({ [TXID]: refusedRec(EMPTY_PAYLOAD_HASH) }), applied: applied(), priv
    })
    expect(out.status).toBe(404)
    expect(out.body).toEqual({ status: 'error', message: `no admission on record for ${TXID}` })
  })

  it('404 when ?payloadHash names a different payload', async () => {
    const other = payloadHashOfValues(Utils.toArray('{"outputs":[]}', 'utf8'))
    const out = await admissionResponse(
      TXID, { store: store({ [TXID]: refusedRec(EMPTY_PAYLOAD_HASH) }), applied: applied(), priv }, other
    )
    expect(out.status).toBe(404)
  })

  // …and a matching-payload refusal still falls through to the applied proof
  // when the transaction was in fact admitted afterwards.
  it('a refusal that does not match still falls through to the applied proof', async () => {
    const out = await admissionResponse(TXID, {
      store: store({ [TXID]: refusedRec(EMPTY_PAYLOAD_HASH) }),
      applied: applied({ applied: [TXID], outputs: { [TXID]: [0] } }),
      priv
    })
    expect(out.status).toBe(200)
    expect((out.body as any).outputsToAdmit).toEqual([0])
  })

  // §9.2 — nothing writes one any more, and an old row is not replayed.
  it('a legacy persisted ERR_INPUT_SPENT is never served, even with a matching payloadHash', async () => {
    const out = await admissionResponse(
      TXID,
      {
        store: store({
          [TXID]: {
            txid: TXID, refusedCode: 'ERR_INPUT_SPENT', refusedDescription: 'already spent', refusedAt: 'z',
            refusedSpendTxid: 'cd'.repeat(32), refusedPayloadHash: EMPTY_PAYLOAD_HASH
          }
        }),
        applied: applied(), priv
      },
      EMPTY_PAYLOAD_HASH
    )
    expect(out.status).toBe(404)
  })

  // §9.3 — σ_I is a signature over a NON-EMPTY set, so an empty stored set
  // proves nothing was admitted and must never come back as a 200.
  it('404 for a stored record whose admitted set is empty, never a 200 over nothing', async () => {
    const out = await admissionResponse(TXID, {
      store: store({ [TXID]: { txid: TXID, outputsToAdmit: [], admissionSignature: 's', admissionIdentityKey: 'k', at: 't' } }),
      applied: applied({ applied: [TXID], outputs: { [TXID]: [] } }),
      priv
    })
    expect(out.status).toBe(404)
  })

  it('404 with the existing TS shape when the txid is unknown', async () => {
    const out = await admissionResponse(TXID, { store: store(), applied: applied(), priv })
    expect(out.status).toBe(404)
    expect(out.body).toEqual({ status: 'error', message: `no admission on record for ${TXID}` })
  })

  it('400 for a malformed txid, without touching the store', async () => {
    let touched = false
    const s: AdmissionStore = { ...store(), get: async () => { touched = true; return null } }
    const out = await admissionResponse('not-a-txid', { store: s, applied: applied(), priv })
    expect(out.status).toBe(400)
    // Request-level 400: full shape, `message` retained for the old contract.
    expect(out.body).toEqual({
      status: 'error', code: 'ERR_SHAPE', retryable: false,
      description: 'txid must be 64 hex characters', message: 'txid must be 64 hex characters'
    })
    expect(touched).toBe(false)
  })

  it('FIX C: re-signs from the applied-transaction proof when the record is missing', async () => {
    const out = await admissionResponse(TXID, {
      store: store(),
      applied: applied({ applied: [TXID], outputs: { [TXID]: [2, 0] } }),
      priv
    })
    expect(out.status).toBe(200)
    const body = out.body as any
    expect(body.outputsToAdmit).toEqual([0, 2])
    expect(body.admissionSignature).toBe(signAdmissionV2Sync(priv, TXID, [0, 2]).admissionSignature)
    expect(body.admissionIdentityKey).toBe(priv.toPublicKey().toString())
    expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('FIX C also covers a legacy record with no outputsToAdmit', async () => {
    const out = await admissionResponse(TXID, {
      store: store({ [TXID]: { txid: TXID, topics: ['tm_mandala'], admissionSignature: 'old', admissionIdentityKey: 'k', at: '2026-01-01T00:00:00.000Z' } }),
      applied: applied({ applied: [TXID], outputs: { [TXID]: [0] } }),
      priv
    })
    expect(out.status).toBe(200)
    const body = out.body as any
    expect(body.outputsToAdmit).toEqual([0])
    expect(body.admissionSignature).toBe(signAdmissionV2Sync(priv, TXID, [0]).admissionSignature)
    expect(body.at).toBe('2026-01-01T00:00:00.000Z') // keeps the original admission time
  })

  it('404 when the applied store proves nothing and stores no outputs', async () => {
    const out = await admissionResponse(TXID, { store: store(), applied: applied({ applied: [TXID], outputs: {} }), priv })
    expect(out.status).toBe(404)
  })

  it('uppercase txids are normalised to lowercase', async () => {
    const out = await admissionResponse(TXID.toUpperCase(), {
      store: store({ [TXID]: { txid: TXID, outputsToAdmit: [0], admissionSignature: 's', admissionIdentityKey: 'k', at: 't' } }),
      applied: applied(), priv
    })
    expect(out.status).toBe(200)
    expect((out.body as any).txid).toBe(TXID)
  })
})

describe('admissionHandler (express glue)', () => {
  const run = async (txid: string, deps: Parameters<typeof admissionHandler>[0], query?: Record<string, unknown>) => {
    let status = 200
    let body: unknown
    const res: any = { status (n: number) { status = n; return res }, json (b: unknown) { body = b; return res } }
    admissionHandler(deps)({ params: { txid }, query } as any, res)
    await new Promise(r => setTimeout(r, 5))
    return { status, body }
  }

  // §9.3 — the query parameter is what unlocks a persisted refusal.
  it('passes ?payloadHash through, case-insensitively', async () => {
    const rec: AdmissionRecord = {
      txid: TXID, refusedCode: 'ERR_CONSERVATION', refusedDescription: 'conservation violated',
      refusedAt: 'z', refusedPayloadHash: EMPTY_PAYLOAD_HASH
    }
    const deps = { store: store({ [TXID]: rec }), applied: applied(), priv }
    expect((await run(TXID, deps, { payloadHash: EMPTY_PAYLOAD_HASH.toUpperCase() })).status).toBe(400)
    expect((await run(TXID, deps, { payloadHash: '' })).status).toBe(404)
    expect((await run(TXID, deps)).status).toBe(404)
  })

  it('maps the response onto res.status/res.json', async () => {
    const got = await run(TXID, { store: store(), applied: applied(), priv })
    expect(got.status).toBe(404)
    expect(got.body).toEqual({ status: 'error', message: `no admission on record for ${TXID}` })
  })

  it('a store fault is ERR_UNAVAILABLE, never a 404 that reads as a denial', async () => {
    const boom: AdmissionStore = { ...store(), get: async () => { throw new Error('mongo down') } }
    const got = await run(TXID, { store: boom, applied: applied(), priv })
    expect(got.status).toBe(503)
    expect((got.body as any).code).toBe('ERR_UNAVAILABLE')
  })
})
