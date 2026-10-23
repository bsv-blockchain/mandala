/**
 * The hand-over evidence bundle and COVER, its pure offline verifier
 * (restored from @bsv/mandala 0.4.1 `bundle.ts`, design §9 B7), hardened
 * against audit finding S1 (COVER accepted value minted from nothing).
 *
 * A payer hands the recipient the tip as AtomicBEEF (every unconfirmed
 * ancestor's bytes inside it) plus evidence: the overlay's σ (attested v1 by
 * K over `tm_color_<assetId>`, txid and the admitted output set) for each
 * admitted ancestor, and the Mandala envelope bytes for each unadmitted
 * transaction including the tip.
 *
 *   Covered(t, v) := σ[t] verifies under K (the verifier's own configured key,
 *                    never one read off the wire) AND v ∈ σ[t].outputs
 *
 * The walk (0.4.1 rules kept):
 * - FIX A: an input whose parent IS admitted but whose vout is not in the
 *   signed set is a hole (that coin can never become admitted).
 * - FIX B: only a verified σ terminates the walk. An ancestor that is
 *   absent from the BEEF, or present only as a txid, is a hole.
 * - FIX K: only token inputs of this asset are walked; fee parents are not.
 *   B7 extends FIX K to authority inputs (they are walked like value inputs)
 *   and to the deploy: a deploy input must be the asset's own deploy
 *   (`<asset txid>.0`) and must itself be σ-covered (deploys are online-only,
 *   never an unanchored hop).
 *
 * S1 (new): every unanchored hop (each walked transaction and the tip) must
 * pass `checkHop` (hopCheck.ts): every input script verifies against the
 * output it spends (a forged spend of someone's admitted coin, or of the
 * issuer's authority, is refused), per-asset conservation unless an
 * authority is spent, a valid authority transition when one is, 1-sat token
 * outputs, one asset, no non-deploy req/ext, and an envelope that covers
 * exactly the token outputs for K. No outpoint may be spent twice anywhere in
 * the graph.
 *
 * Termination is structural: every transaction is identified by the hash of
 * its own bytes, `visited` memoizes, and re-entering a node on the stack is a
 * shape failure (never memoized as covered).
 *
 * Pure: no storage, no network, no clock. React-Native safe.
 */
import type { Transaction } from '@bsv/sdk'
import { verifyAttestation, type Attestation } from './attestation.js'
import { decodeToken } from './brc162.js'
import { checkHop, HopCheckError } from './hopCheck.js'

export interface HandoverEvidence {
  assetId: string
  /** The tip, parsed from its AtomicBEEF (inputs carry their source transactions). */
  tip: Transaction
  /** σ per admitted txid (the tip's own σ may be here too). */
  admissions: Map<string, Attestation>
  /** Envelope bytes per unadmitted txid (the tip included). */
  linkage: Map<string, number[]>
}

export type CoverFailureReason = 'unsafe_asset' | 'shape' | 'uncovered_ancestor' | 'hop' | 'double_spend'

export type CoverResult =
  /** Submit `mustSubmit` in order (parents first, tip last); `txs` holds each one's parsed bytes. */
  | { ok: true, mustSubmit: string[], txs: Map<string, Transaction> }
  | { ok: false, reason: CoverFailureReason, detail?: string }

const KEY_RE = /^0[23][0-9a-f]{64}$/
const TXID_RE = /^[0-9a-f]{64}$/
const ASSET_RE = /^([0-9a-f]{64})_0$/

/**
 * COVER. `expectedSignerKey` is THIS verifier's configured overlay identity
 * key K (§9.10 of the 0.4.1 spec): there is no default.
 */
export function cover (e: HandoverEvidence, opts: { expectedSignerKey: string }): CoverResult {
  const K = opts?.expectedSignerKey
  if (typeof K !== 'string' || !KEY_RE.test(K)) return { ok: false, reason: 'unsafe_asset', detail: 'no configured overlay identity key' }
  const assetMatch = typeof e?.assetId === 'string' ? ASSET_RE.exec(e.assetId) : null
  if (assetMatch == null) return { ok: false, reason: 'unsafe_asset', detail: 'not a Mandala asset id' }
  const assetId = e.assetId
  const assetTxid = assetMatch[1]
  const tip = e.tip
  if (tip == null || typeof tip.id !== 'function') return { ok: false, reason: 'shape', detail: 'no tip' }
  const admissions = e.admissions ?? new Map<string, Attestation>()
  const linkage = e.linkage ?? new Map<string, number[]>()

  const ids = new WeakMap<Transaction, string>()
  const idOf = (tx: Transaction): string | undefined => {
    let v = ids.get(tx)
    if (v === undefined) {
      try { v = tx.id('hex') } catch { return undefined }
      ids.set(tx, v)
    }
    return v
  }

  const admittedMemo = new Map<string, boolean>()
  const isAdmitted = (txid: string): boolean => {
    let ok = admittedMemo.get(txid)
    if (ok === undefined) {
      const a = admissions.get(txid)
      ok = a != null && a.txid === txid && verifyAttestation(a, assetId, K)
      admittedMemo.set(txid, ok)
    }
    return ok
  }
  const covered = (txid: string, vout: number): boolean => isAdmitted(txid) && admissions.get(txid)!.outputs.includes(vout)

  const visited = new Map<string, boolean | 'in-progress'>()
  const walkedTxs = new Map<string, Transaction>()
  const mustSubmit: string[] = [] // post-order: parents before children
  let failure: { reason: CoverFailureReason, detail?: string } | undefined
  const fail = (reason: CoverFailureReason, detail?: string): false => {
    failure ??= { reason, ...(detail != null ? { detail } : {}) }
    return false
  }

  const walk = (tx: Transaction): boolean => {
    const txid = idOf(tx)
    if (txid == null) return fail('shape', 'a transaction does not serialize')
    const memo = visited.get(txid)
    if (memo === 'in-progress') return fail('shape', `cycle at ${txid}`)
    if (typeof memo === 'boolean') return memo
    visited.set(txid, 'in-progress')

    let ok = true
    for (const [i, input] of (tx.inputs ?? []).entries()) {
      const embedded = input?.sourceTransaction
      const ptxid = typeof input?.sourceTXID === 'string' && TXID_RE.test(input.sourceTXID)
        ? input.sourceTXID
        : (embedded != null ? idOf(embedded) : undefined)
      const pvout = input?.sourceOutputIndex
      if (ptxid == null || !Number.isInteger(pvout) || pvout < 0) { ok = fail('shape', `${txid} input ${i} names no outpoint`); break }
      // Bytes are trusted only when they hash to the named txid.
      const parent = embedded != null && idOf(embedded) === ptxid ? embedded : undefined
      const source = parent?.outputs?.[pvout]
      if (source == null) {
        // Unseen output: only a σ covering it is proof (FIX B).
        if (covered(ptxid, pvout)) continue
        ok = fail('uncovered_ancestor', `${txid} input ${i} spends ${ptxid}.${pvout}, which is neither visible nor covered`)
        break
      }
      const token = decodeToken(source.lockingScript, ptxid, pvout)
      // FIX K: a non-token (fee) parent is not our concern. Foreign or
      // undecodable tokens are refused by the hop check of `tx`.
      if (token == null || token.assetId !== assetId) continue
      if (token.role === 'deploy') {
        if (ptxid !== assetTxid || pvout !== 0) { ok = fail('hop', `${txid} input ${i} spends a deploy that is not this asset's`); break }
        if (covered(ptxid, pvout)) continue
        ok = fail('uncovered_ancestor', `${txid} input ${i} spends the deploy, which carries no σ`)
        break
      }
      if (covered(ptxid, pvout)) continue // bottom
      if (isAdmitted(ptxid)) { ok = fail('uncovered_ancestor', `${ptxid}.${pvout} is not in its σ's admitted set`); break } // FIX A
      if (!walk(parent as Transaction)) { ok = false; break }
    }
    if (ok) {
      walkedTxs.set(txid, tx)
      mustSubmit.push(txid)
    }
    visited.set(txid, ok)
    return ok
  }

  const tipTxid = idOf(tip)
  if (tipTxid == null) return { ok: false, reason: 'shape', detail: 'the tip does not serialize' }
  if (!walk(tip)) return { ok: false, ...(failure ?? { reason: 'uncovered_ancestor' }) }

  // S1: every unanchored hop passes the local Mandala checks, and no outpoint
  // is spent twice anywhere in the graph.
  const spent = new Set<string>()
  for (const txid of mustSubmit) {
    const tx = walkedTxs.get(txid) as Transaction
    for (const input of tx.inputs) {
      const op = `${input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? ''}.${input.sourceOutputIndex}`
      if (spent.has(op)) return { ok: false, reason: 'double_spend', detail: `${op} is spent twice in the hand-over graph` }
      spent.add(op)
    }
    const envelope = linkage.get(txid)
    if (envelope == null || envelope.length === 0) {
      return { ok: false, reason: 'uncovered_ancestor', detail: `${txid} is unadmitted and carries no envelope to submit it with` }
    }
    try {
      checkHop(assetId, tx, envelope, K)
    } catch (err) {
      if (err instanceof HopCheckError) return { ok: false, reason: 'hop', detail: `${txid}: ${err.message}` }
      return { ok: false, reason: 'hop', detail: `${txid}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { ok: true, mustSubmit, txs: walkedTxs }
}
