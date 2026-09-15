import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { configureMandala } from './constants.js'
import {
  ADMISSION_PREFIX,
  admissionDigestV2,
  admissionMessageV2,
  verifyAdmission,
  fetchAdmission,
  payloadHash,
  verifyFetchedAdmission
} from './admission.js'

// A known key, so the vectors below are reproducible byte-for-byte.
const PRIV = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000a1')
const KEY = PRIV.toPublicKey().toString()
const TXID = 'a'.repeat(64)
const OTHER_TXID = 'b'.repeat(64)

/** σ_I as both overlays mint it: ECDSA over SHA-256(message), DER hex. */
const sign = (message: string): string => {
  const der = PRIV.sign(Utils.toArray(message, 'utf8')).toDER()
  return typeof der === 'string' ? der : Utils.toHex(der)
}

describe('admissionDigestV2 (wire contract v2 §1)', () => {
  it('is SHA-256 over "mandala-admit:<txid>:<ascending,comma,joined>"', () => {
    expect(admissionMessageV2(TXID, [0, 2, 3])).toBe(`${ADMISSION_PREFIX}${TXID}:0,2,3`)
    expect(admissionDigestV2(TXID, [0, 2, 3]))
      .toEqual(Hash.sha256(Utils.toArray(`${ADMISSION_PREFIX}${TXID}:0,2,3`, 'utf8')))
  })

  it('canonicalizes by sorting ascending, so caller order cannot change the digest', () => {
    expect(admissionDigestV2(TXID, [3, 0, 2])).toEqual(admissionDigestV2(TXID, [0, 2, 3]))
  })

  it('renders a single admitted output without a separator', () => {
    expect(admissionMessageV2(TXID, [0])).toBe(`${ADMISSION_PREFIX}${TXID}:0`)
  })

  it('refuses an empty set — no admitted outputs means no signature exists', () => {
    expect(() => admissionDigestV2(TXID, [])).toThrow(/outputsToAdmit/)
  })

  it('refuses a txid that is not 64 lowercase hex (an uppercase one would silently mis-verify)', () => {
    expect(() => admissionDigestV2(TXID.toUpperCase(), [0])).toThrow(/txid/)
    expect(() => admissionDigestV2('abc', [0])).toThrow(/txid/)
  })

  it('refuses a non-integer or negative output index', () => {
    expect(() => admissionDigestV2(TXID, [0, -1])).toThrow(/outputsToAdmit/)
    expect(() => admissionDigestV2(TXID, [1.5])).toThrow(/outputsToAdmit/)
  })
})

describe('verifyAdmission', () => {
  const signature = sign(`${ADMISSION_PREFIX}${TXID}:0,2,3`)

  it('accepts the overlay signature over the exact admitted set', () => {
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 2, 3], signature, signerKey: KEY })).toBe(true)
  })

  it('accepts DER bytes as well as DER hex', () => {
    const bytes = Utils.toArray(signature, 'hex')
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 2, 3], signature: bytes, signerKey: KEY })).toBe(true)
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 2, 3], signature: new Uint8Array(bytes), signerKey: KEY })).toBe(true)
  })

  it('accepts the admitted set in any caller order (it is canonicalized)', () => {
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [3, 2, 0], signature, signerKey: KEY })).toBe(true)
  })

  it('rejects a signature minted over a NON-canonical (unsorted) ordering', () => {
    const wrongOrder = sign(`${ADMISSION_PREFIX}${TXID}:3,2,0`)
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 2, 3], signature: wrongOrder, signerKey: KEY })).toBe(false)
  })

  it('rejects a subset of the signed admitted set (the phantom-coin guard)', () => {
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 2], signature, signerKey: KEY })).toBe(false)
  })

  it('rejects a superset of the signed admitted set', () => {
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 1, 2, 3], signature, signerKey: KEY })).toBe(false)
  })

  it('rejects the same signature replayed against another txid', () => {
    expect(verifyAdmission({ txid: OTHER_TXID, outputsToAdmit: [0, 2, 3], signature, signerKey: KEY })).toBe(false)
  })

  it('rejects a signature from a different key', () => {
    const other = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000b2')
    expect(verifyAdmission({
      txid: TXID, outputsToAdmit: [0, 2, 3], signature, signerKey: other.toPublicKey().toString()
    })).toBe(false)
  })

  it('returns false (never throws) on malformed input', () => {
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 2, 3], signature: 'not-der', signerKey: KEY })).toBe(false)
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [0, 2, 3], signature, signerKey: 'nope' })).toBe(false)
    expect(verifyAdmission({ txid: TXID, outputsToAdmit: [], signature, signerKey: KEY })).toBe(false)
    expect(verifyAdmission({ txid: 'short', outputsToAdmit: [0], signature, signerKey: KEY })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// fetchAdmission — GET /admin/admission/:txid (wire contract v2 §3)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('fetchAdmission', () => {
  const signature = sign(`${ADMISSION_PREFIX}${TXID}:0,2,3`)

  beforeEach(() => {
    mockFetch.mockReset()
    configureMandala({ overlayUrl: 'http://test-overlay', adminApiToken: '' })
  })

  it('GETs /admin/admission/:txid with adminAuthHeaders()', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ txid: TXID, outputsToAdmit: [0, 2, 3], admissionSignature: signature, admissionIdentityKey: KEY, at: 123 })
    })
    await fetchAdmission('http://test-overlay', TXID)
    expect(mockFetch).toHaveBeenCalledWith('http://test-overlay/admin/admission/' + TXID, { headers: {} })
  })

  it('sends the admin bearer token once configured', async () => {
    configureMandala({ adminApiToken: 'tok' })
    mockFetch.mockResolvedValueOnce({ status: 404, ok: false, json: async () => ({}) })
    await fetchAdmission('http://test-overlay', TXID)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-overlay/admin/admission/' + TXID,
      { headers: { Authorization: 'Bearer tok' } }
    )
  })

  it('200 → admitted, carrying signature/signerKey under the AdmissionCheck field names', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ txid: TXID, outputsToAdmit: [0, 2, 3], admissionSignature: signature, admissionIdentityKey: KEY, at: 123 })
    })
    const entry = await fetchAdmission('http://test-overlay', TXID)
    expect(entry).toEqual({
      kind: 'admitted',
      txid: TXID,
      outputsToAdmit: [0, 2, 3],
      signature,
      signerKey: KEY,
      at: 123
    })
  })

  it('410 → evicted', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 410,
      ok: false,
      json: async () => ({ status: 'error', code: 'ERR_EVICTED', retryable: false, description: 'evicted' })
    })
    expect(await fetchAdmission('http://test-overlay', TXID)).toEqual({ kind: 'evicted' })
  })

  it('400 with a final code → refused, forwarding spendTxid when present', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: async () => ({ status: 'error', code: 'ERR_INPUT_SPENT', retryable: false, description: 'spent', spendTxid: OTHER_TXID })
    })
    expect(await fetchAdmission('http://test-overlay', TXID)).toEqual({ kind: 'refused', code: 'ERR_INPUT_SPENT', spendTxid: OTHER_TXID })
  })

  it('400 with a final code and no spendTxid → refused without the field', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: async () => ({ status: 'error', code: 'ERR_CONSERVATION', retryable: false, description: 'nope' })
    })
    const entry = await fetchAdmission('http://test-overlay', TXID)
    expect(entry).toEqual({ kind: 'refused', code: 'ERR_CONSERVATION' })
    expect(entry != null && 'spendTxid' in entry).toBe(false)
  })

  it('404 → undefined (unknown txid)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 404, ok: false, json: async () => ({ status: 'error', message: 'no admission on record for ' + TXID }) })
    expect(await fetchAdmission('http://test-overlay', TXID)).toBeUndefined()
  })

  it('anything else (e.g. 500 / unstructured body) → unavailable, retryable', async () => {
    mockFetch.mockResolvedValueOnce({ status: 500, ok: false, json: async () => { throw new Error('not json') } })
    expect(await fetchAdmission('http://test-overlay', TXID)).toEqual({ kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true })
  })

  it('a network/fetch throw → unavailable, retryable (never throws)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'))
    await expect(fetchAdmission('http://test-overlay', TXID)).resolves.toEqual({ kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true })
  })

  // §9.1/§9.5 — a 200 without σ_I is not a verdict; it must never surface as
  // `admitted` with undefined signature/signerKey fields.
  it.each([
    ['no admissionSignature', { txid: TXID, outputsToAdmit: [0], admissionIdentityKey: KEY }],
    ['no admissionIdentityKey', { txid: TXID, outputsToAdmit: [0], admissionSignature: 'de' }],
    ['a non-string signature', { txid: TXID, outputsToAdmit: [0], admissionSignature: 123, admissionIdentityKey: KEY }],
    ['a non-string identity key', { txid: TXID, outputsToAdmit: [0], admissionSignature: 'de', admissionIdentityKey: { k: 1 } }],
    ['an empty signature', { txid: TXID, outputsToAdmit: [0], admissionSignature: '', admissionIdentityKey: KEY }]
  ])('200 with %s → unavailable, never admitted and never a throw', async (_label, body) => {
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true, json: async () => body })
    await expect(fetchAdmission('http://test-overlay', TXID)).resolves.toEqual({
      kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true
    })
  })

  it('a σ_I-less 200 is safe end to end: verifyFetchedAdmission(…) is false, not a crash', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200, ok: true, json: async () => ({ txid: TXID, outputsToAdmit: [0, 2, 3] })
    })
    const entry = await fetchAdmission('http://test-overlay', TXID)
    expect(verifyFetchedAdmission(entry, KEY)).toBe(false)
  })

  it('sends the payloadHash query when one is supplied (§9.3)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 404, ok: false, json: async () => ({}) })
    const ph = payloadHash([1, 2, 3])
    await fetchAdmission('http://test-overlay', TXID, { payloadHash: ph })
    expect(mockFetch).toHaveBeenCalledWith(
      `http://test-overlay/admin/admission/${TXID}?payloadHash=${ph}`,
      { headers: {} }
    )
  })

  it('omits the query when no payloadHash is given (back-compatible call shape)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 404, ok: false, json: async () => ({}) })
    await fetchAdmission('http://test-overlay', TXID, {})
    expect(mockFetch).toHaveBeenCalledWith('http://test-overlay/admin/admission/' + TXID, { headers: {} })
  })
})

describe('payloadHash (§9.1)', () => {
  it('is sha256 of the bytes, lowercase hex', () => {
    expect(payloadHash([1, 2, 3])).toBe(Utils.toHex(Hash.sha256([1, 2, 3])))
    expect(payloadHash([1, 2, 3])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts a Uint8Array and a number[] interchangeably', () => {
    expect(payloadHash(new Uint8Array([1, 2, 3]))).toBe(payloadHash([1, 2, 3]))
  })

  it('hashes an absent/empty payload to sha256("") — the both-engines convention', () => {
    const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(payloadHash([])).toBe(EMPTY)
    expect(payloadHash(new Uint8Array(0))).toBe(EMPTY)
    expect(payloadHash(undefined as unknown as number[])).toBe(EMPTY)
  })
})

describe('verifyFetchedAdmission', () => {
  const signature = sign(`${ADMISSION_PREFIX}${TXID}:0,2,3`)
  const admitted = { kind: 'admitted' as const, txid: TXID, outputsToAdmit: [0, 2, 3], signature, signerKey: KEY, at: 1 }

  it('true for a valid admitted entry from the expected signer', () => {
    expect(verifyFetchedAdmission(admitted, KEY)).toBe(true)
  })

  it('false when the signer key does not match the expected one', () => {
    const other = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000b2').toPublicKey().toString()
    expect(verifyFetchedAdmission(admitted, other)).toBe(false)
  })

  it('false for a non-admitted entry (evicted/refused/unavailable/undefined)', () => {
    expect(verifyFetchedAdmission({ kind: 'evicted' }, KEY)).toBe(false)
    expect(verifyFetchedAdmission({ kind: 'refused', code: 'ERR_SHAPE' }, KEY)).toBe(false)
    expect(verifyFetchedAdmission({ kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true }, KEY)).toBe(false)
    expect(verifyFetchedAdmission(undefined, KEY)).toBe(false)
  })

  it('false when the signature does not verify (tampered admitted set)', () => {
    expect(verifyFetchedAdmission({ ...admitted, outputsToAdmit: [0, 2] }, KEY)).toBe(false)
  })

  it('false — never a throw — when the entry carries no usable signerKey', () => {
    expect(verifyFetchedAdmission({ ...admitted, signerKey: undefined as unknown as string }, KEY)).toBe(false)
    expect(verifyFetchedAdmission({ ...admitted, signerKey: 7 as unknown as string }, KEY)).toBe(false)
    expect(verifyFetchedAdmission(admitted, undefined as unknown as string)).toBe(false)
  })
})
