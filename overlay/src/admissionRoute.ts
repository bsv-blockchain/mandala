/**
 * GET /admin/admission/:txid — wire contract v2 §3.
 *
 * A wallet settling offline attaches σ_I for each input txid it spends (and,
 * when one is missing, σ_I for that transaction's own inputs), so it must be
 * able to fetch signatures for transactions it never submitted itself. The
 * endpoint therefore has to answer long after the submit that produced the
 * admission, and has to give the SAME verdict every caller's /submit got —
 * that is what lets two independent submitters converge.
 *
 *   200 { txid, outputsToAdmit, admissionSignature, admissionIdentityKey, at }
 *   410 { status:'error', code:'ERR_EVICTED',   retryable:false, description }
 *   400 { status:'error', code:<final code>,    retryable:false, description }
 *   400 { status:'error', message:'txid must be 64 hex characters' }
 *   404 { status:'error', message:'no admission on record for <txid>' }
 *
 * FIX C: when the `mandalaAdmissions` row is missing or predates the
 * outputsToAdmit field, but the engine's own applied-transaction store proves
 * the txid went through tm_mandala, the signature is re-derived from the
 * engine's stored outputs. σ_I is deterministic, so a re-signature is
 * byte-identical to the original — the record is a convenience, never the
 * authority. This is what stops coins admitted before this feature existed
 * being permanently unspendable offline.
 *
 * Stays behind the same adminGate (bearer auth + narrowed CORS) as
 * /admin/registry: the response is identity-bearing.
 */
import type { PrivateKey } from '@bsv/sdk'
import { errorBody, requestErrorBody, verdictFor } from './submitVerdict.js'
import {
  finalVerdictOf, signAdmissionV2Sync,
  type AdmissionStore, type AppliedProof
} from './admission.js'

export interface AdmissionRouteDeps {
  store: AdmissionStore
  applied: AppliedProof
  priv: PrivateKey
}

export interface RouteResult { status: number, body: unknown }

/**
 * `payloadHash` is §9.3's `?payloadHash=<hex>` query parameter: a persisted
 * refusal is served ONLY to a caller that names the payload it is about.
 * Without it the route falls through to the applied-proof check and then 404 —
 * because the refusal says nothing about any other submission of this txid, and
 * serving it unqualified is how a poisoned record reaches every wallet.
 */
export const admissionResponse = async (
  rawTxid: string, deps: AdmissionRouteDeps, payloadHash?: string
): Promise<RouteResult> => {
  const txid = String(rawTxid ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    // §9.3 request-level 400: full code/retryable/description shape, with
    // `message` kept so the pre-existing client contract still reads.
    return { status: 400, body: requestErrorBody('txid must be 64 hex characters') }
  }
  const rec = await deps.store.get(txid)

  const verdict = finalVerdictOf(txid, rec, payloadHash)
  if (verdict != null) {
    return {
      status: verdictFor(verdict.code).httpStatus,
      body: errorBody(verdict.code, verdict.description, verdict.spendTxid)
    }
  }

  // §9.3: an empty stored set is never a 200. σ_I is a signature over a
  // NON-EMPTY admitted set (contract §1), so a record whose set is empty proves
  // nothing was admitted — answering 200 with `outputsToAdmit: []` would hand a
  // verifier an attestation over nothing. Fall through to the applied proof,
  // then 404.
  const outputsToAdmit = rec?.outputsToAdmit ?? []
  if (rec?.admissionSignature != null && rec.admissionIdentityKey != null && outputsToAdmit.length > 0) {
    return {
      status: 200,
      body: {
        txid,
        outputsToAdmit: [...outputsToAdmit].sort((a, b) => a - b),
        admissionSignature: rec.admissionSignature,
        admissionIdentityKey: rec.admissionIdentityKey,
        at: rec.at ?? new Date().toISOString()
      }
    }
  }

  if (await deps.applied.wasApplied(txid)) {
    const stored = await deps.applied.storedOutputs(txid)
    if (stored.length > 0) {
      const set = [...stored].sort((a, b) => a - b)
      return {
        status: 200,
        body: { txid, outputsToAdmit: set, ...signAdmissionV2Sync(deps.priv, txid, set), at: rec?.at ?? new Date().toISOString() }
      }
    }
  }

  // Silence is not a denial: this overlay may simply never have seen it.
  return { status: 404, body: { status: 'error', message: `no admission on record for ${txid}` } }
}

interface ReqLike { params: { txid: string }, query?: Record<string, unknown> }
interface ResLike { status: (code: number) => ResLike, json: (b: unknown) => unknown }

export const admissionHandler = (deps: AdmissionRouteDeps) =>
  (req: ReqLike, res: ResLike): void => {
    void (async () => {
      try {
        const raw = req.query?.payloadHash
        const payloadHash = typeof raw === 'string' && raw !== '' ? raw.toLowerCase() : undefined
        const out = await admissionResponse(String(req.params?.txid ?? ''), deps, payloadHash)
        res.status(out.status).json(out.body)
      } catch (e) {
        // A storage fault must never read as "this overlay denies the
        // admission" — that is the false-permanent case EB-3.5 names.
        console.warn('[mandala] admission lookup failed:', e)
        res.status(503).json(errorBody('ERR_UNAVAILABLE', String(e)))
      }
    })()
  }
