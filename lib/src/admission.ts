/**
 * σ_I — the overlay's admission signature, and its verification (A12 client
 * half; offline-settlement wire contract v2 §1, FIX A).
 *
 * The signature binds the overlay's verdict to the *exact set of outputs it
 * admitted*, not merely to the txid. Signing over the bare txid is what let a
 * hostile, un-linked sibling output ride along on a genuine admission (the
 * phantom-coin hole); a verifier that only checked "this txid was admitted"
 * would credit it. Everything downstream (bundle.ts's COVER walk, receive.ts's
 * incoming check) therefore asks `Covered(txid, vout)`, never `Admitted(txid)`.
 *
 * Wire contract (binding, both overlays and both wallets):
 *
 *   digest = SHA-256("mandala-admit:" + txid + ":" + outputsToAdmit.sort(asc).join(","))
 *
 * `txid` is 64 lowercase hex; `outputsToAdmit` is the `tm_mandala` topic's own
 * admitted output indexes as ascending decimal, comma-joined ("0", "0,2,3"),
 * never empty — no admitted outputs means no signature exists at all. The
 * signature is DER (RFC-6979 deterministic ECDSA) over those digest bytes with
 * the overlay identity key, which is byte-identical on the TS overlay
 * (`priv.sign(utf8(message))`, which hashes with SHA-256 first) and the Go
 * overlay (`priv.Sign(sha256(message))`).
 *
 * Scope cap (A12): verification is against the overlay key *currently*
 * configured, not against the key that was live at the height of the Merkle
 * path. Key rotation (R34/R69) is deliberately out of scope here.
 *
 * Pure and React-Native safe: no storage, no network, no Node built-ins.
 */
import { BigNumber, ECDSA, Hash, PublicKey, Signature, Utils } from '@bsv/sdk'
import { adminAuthHeaders } from './constants.js'

export const ADMISSION_PREFIX = 'mandala-admit:'

/** DER signature bytes, or their hex encoding (what the overlay puts on the wire). */
export type DerSignature = string | number[] | Uint8Array

/**
 * One overlay admission, as carried in an AdmissionBundle / a MessageBox body.
 * `signerKey` MUST equal the session's overlay identity key — a σ_I from any
 * other key proves nothing (see bundle.ts `Admitted`).
 */
export interface AdmissionEntry {
  /** The tm_mandala topic's own admitted output indexes, ascending. */
  outputsToAdmit: number[]
  /** DER ECDSA over admissionDigestV2(txid, outputsToAdmit). */
  signature: DerSignature
  /** 66-hex compressed overlay identity key that produced `signature`. */
  signerKey: string
}

/** What verifyAdmission needs: an AdmissionEntry plus the txid it claims to cover. */
export interface AdmissionCheck extends AdmissionEntry {
  txid: string
}

const TXID_RE = /^[0-9a-f]{64}$/
const COMPRESSED_KEY_RE = /^0[23][0-9a-fA-F]{64}$/

/**
 * Canonical ascending, de-duplicated admitted-output list. Canonicalizing here
 * (rather than trusting caller order) is what makes the digest a function of
 * the admitted *set*: two parties that hold the same set always compute the
 * same message, and a signature minted over an unsorted rendering does not
 * verify against it.
 */
function canonicalOutputs (outputsToAdmit: number[]): number[] {
  if (!Array.isArray(outputsToAdmit) || outputsToAdmit.length === 0) {
    throw new Error('admission: outputsToAdmit must be a non-empty list (no admitted outputs ⇒ no signature)')
  }
  for (const v of outputsToAdmit) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`admission: outputsToAdmit must be non-negative integers, got ${String(v)}`)
    }
  }
  return [...new Set(outputsToAdmit)].sort((a, b) => a - b)
}

/** The exact UTF-8 message both overlays sign. Exported for test vectors. */
export function admissionMessageV2 (txid: string, outputsToAdmit: number[]): string {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) {
    throw new Error('admission: txid must be 64 lowercase hex characters')
  }
  return `${ADMISSION_PREFIX}${txid}:${canonicalOutputs(outputsToAdmit).join(',')}`
}

/** SHA-256 digest bytes the overlay signature is taken over (wire contract §1). */
export function admissionDigestV2 (txid: string, outputsToAdmit: number[]): number[] {
  return Hash.sha256(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8'))
}

/**
 * `payloadHash` — sha256 of the off-chain payload **exactly as submitted**,
 * lowercase hex (amendment v2.1 §9.1/§9.3).
 *
 * A persisted final refusal is keyed by `(txid, payloadHash)`, not by txid
 * alone: the txid does not commit to the off-chain linkage payload, so a
 * txid-keyed refusal let any BEEF holder poison a transaction by submitting it
 * with a garbage payload. Callers pass this to `fetchAdmission` so the overlay
 * only applies a refusal that was recorded for the payload they actually hold.
 *
 * An absent/empty payload hashes the empty byte string
 * (`e3b0c442…b855`) — the same convention both engines use.
 */
export function payloadHash (bytes: number[] | Uint8Array): string {
  const arr = bytes == null ? [] : Array.from(bytes)
  return Utils.toHex(Hash.sha256(arr))
}

function toSignature (sig: DerSignature): Signature {
  if (typeof sig === 'string') return Signature.fromDER(sig, 'hex')
  return Signature.fromDER(Array.from(sig))
}

/**
 * True iff `signature` is a valid overlay signature, by `signerKey`, over the
 * admission of exactly `outputsToAdmit` for `txid`.
 *
 * Never throws: an unparseable signature, a malformed key, a bad txid or an
 * empty admitted set are all simply "not verified". FIX H depends on that —
 * an unverifiable σ_I is treated as *absent*, never as a decline, so a
 * caller can always branch on a plain boolean.
 *
 * Note this says nothing about *which* overlay signed; the caller must still
 * compare `signerKey` against the overlay identity key it trusts.
 */
export function verifyAdmission (a: AdmissionCheck): boolean {
  try {
    if (typeof a?.signerKey !== 'string' || !COMPRESSED_KEY_RE.test(a.signerKey)) return false
    const digest = admissionDigestV2(a.txid, a.outputsToAdmit)
    return ECDSA.verify(new BigNumber(digest, 16), toSignature(a.signature), PublicKey.fromString(a.signerKey))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// fetchAdmission — GET /admin/admission/:txid (wire contract v2 §3)
// ---------------------------------------------------------------------------

/** The overlay has admitted `txid`; shaped like AdmissionCheck so it feeds verifyAdmission directly. */
export interface FetchedAdmissionAdmitted extends AdmissionCheck {
  kind: 'admitted'
  at: number
}
/** `txid` was admitted, then evicted (e.g. its funding tx never confirmed). */
export interface FetchedAdmissionEvicted { kind: 'evicted' }
/** A persisted FINAL refusal (never retryable — see overlay.ts's RETRYABLE_BY_CODE). */
export interface FetchedAdmissionRefused { kind: 'refused', code: string, spendTxid?: string }
/** Not a manager verdict at all — network fault, malformed body, or any other HTTP status. */
export interface FetchedAdmissionUnavailable { kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true }

export type FetchedAdmission =
  | FetchedAdmissionAdmitted
  | FetchedAdmissionEvicted
  | FetchedAdmissionRefused
  | FetchedAdmissionUnavailable

export interface FetchAdmissionOptions {
  /**
   * `payloadHash(offChainValues)` — amendment v2.1 §9.3. A persisted refusal is
   * served (400) only when this matches the `refusedPayloadHash` the overlay
   * recorded; without it the route falls through to the applied-proof check and
   * then 404, so a refusal recorded against somebody else's payload can never
   * be read as a verdict on ours.
   */
  payloadHash?: string
}

/**
 * GET `${overlayUrl}/admin/admission/${txid}` (wire contract v2 §3, amendment
 * §9.3) — the out-of-band way to learn an admission a payer never received on
 * the wire (e.g. after being offline, or when the sender's own submit
 * round-trip dropped the response). Identity-bearing (A13): sends
 * adminAuthHeaders().
 *
 * NEVER throws — a network fault, timeout, or any response the contract does
 * not define collapses to `{kind:'unavailable', retryable:true}` rather than
 * rejecting, so callers can always branch on the returned discriminant. That
 * explicitly includes a 200 whose body is missing `admissionSignature` or
 * `admissionIdentityKey` (or carries a non-string in either): an admission
 * without σ_I proves nothing, and reporting it as `admitted` would hand
 * `verifyFetchedAdmission` an entry whose `signerKey` is undefined.
 */
export async function fetchAdmission (
  overlayUrl: string,
  txid: string,
  opts: FetchAdmissionOptions = {}
): Promise<FetchedAdmission | undefined> {
  try {
    const query = typeof opts?.payloadHash === 'string' && opts.payloadHash !== ''
      ? `?payloadHash=${encodeURIComponent(opts.payloadHash)}`
      : ''
    const res = await fetch(`${overlayUrl}/admin/admission/${txid}${query}`, { headers: adminAuthHeaders() })
    if (res.status === 404) return undefined
    if (res.status === 410) return { kind: 'evicted' }

    let body: any
    try {
      body = await res.json()
    } catch {
      body = undefined
    }

    if (res.status === 400 && body?.status === 'error' && typeof body.code === 'string' && body.code !== '') {
      return {
        kind: 'refused',
        code: body.code,
        ...(typeof body.spendTxid === 'string' ? { spendTxid: body.spendTxid } : {})
      }
    }

    if (res.ok && typeof body?.txid === 'string' && Array.isArray(body.outputsToAdmit)) {
      const signature = body.admissionSignature
      const signerKey = body.admissionIdentityKey
      // σ_I-less "admissions" are not verdicts. Treat the body as a fault
      // (retryable) rather than fabricating an entry with undefined fields.
      if (typeof signature !== 'string' || signature === '' ||
          typeof signerKey !== 'string' || signerKey === '') {
        return { kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true }
      }
      return {
        kind: 'admitted',
        txid: body.txid,
        outputsToAdmit: body.outputsToAdmit,
        signature,
        signerKey,
        at: body.at
      }
    }

    // Any other status/shape is not a defined verdict — retryable, never a decline.
    return { kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true }
  } catch {
    return { kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true }
  }
}

/**
 * Convenience wrapper: true iff `entry` is an 'admitted' verdict from exactly
 * `expectedSignerKey` whose σ_I verifies over its own txid/outputsToAdmit.
 * Every other kind (evicted/refused/unavailable/undefined) is false — never throws.
 */
export function verifyFetchedAdmission (entry: FetchedAdmission | undefined, expectedSignerKey: string): boolean {
  if (entry == null || entry.kind !== 'admitted') return false
  // A hand-built entry (or an older overlay's body) can carry a non-string
  // signerKey; `.toLowerCase()` on it would throw, and this function is
  // contractually total.
  if (typeof expectedSignerKey !== 'string' || typeof entry.signerKey !== 'string') return false
  if (entry.signerKey.toLowerCase() !== expectedSignerKey.toLowerCase()) return false
  return verifyAdmission({
    txid: entry.txid,
    outputsToAdmit: entry.outputsToAdmit,
    signature: entry.signature,
    signerKey: entry.signerKey
  })
}
