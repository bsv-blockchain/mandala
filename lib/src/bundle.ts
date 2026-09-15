/**
 * The AdmissionBundle and its pure coverage verifier (offline-settlement spec
 * §1.1–§1.6; wire contract v2 §8).
 *
 * A payer who hands a token transaction over while offline cannot make the
 * recipient trust it — so they hand over *evidence* instead: for every token
 * ancestor, either the overlay's own admission signature (σ_I, bound to the
 * exact admitted output set — see admission.ts), or the ancestor's full
 * transaction bytes so the recipient can walk one hop further back under the
 * same rule. `cover()` decides whether that evidence bottoms out everywhere.
 *
 * Everything here is PURE: no SQLite, no network, no storage, no clock. It
 * operates on an in-memory bundle and is safe to run on React Native.
 *
 *   Covered(t, v) := Admitted(t) AND v ∈ admissions[t].outputsToAdmit
 *   Admitted(t)   := verifyAdmission(admissions[t] over t)
 *                    AND admissions[t].signerKey == expectedSignerKey
 *
 * `expectedSignerKey` is the verifier's OWN configured overlay identity key
 * (amendment v2.1 §9.10), passed in by the caller — never read out of the
 * bundle. `bundle.overlayIdentityKey` is payer-supplied data: a bundle that
 * names an attacker's key and carries σ_I self-signed by it verifies perfectly
 * against itself, so trusting it made COVER a rubber stamp for any payer
 * willing to mint their own admissions. The bundle's field must now EQUAL the
 * expected key or COVER fails with `unsafe_asset` before any walking happens.
 *
 * Three rules are load-bearing and each closes a named hole:
 *
 * - FIX A (phantom coin). A token input whose parent IS admitted but whose
 *   vout is NOT in the signed admitted set is an immediate hole — the walk
 *   does not recurse into such a parent. The overlay has already ruled on
 *   that txid; re-submitting it is idempotent and will return the same
 *   admitted set, so that vout can never become admitted. Recursing would
 *   report "just submit the parent" for a coin that is unspendable by
 *   construction, which is exactly the sibling-mint theft three reviews found.
 * - FIX B (mined ≠ admitted). Only a σ_I-covered admission terminates the
 *   walk. An ancestor that is absent, or present only as a txid (a Beef
 *   txid-only entry), is a hole — never a bottom. The walk runs offline by
 *   construction and never fetches more bytes.
 * - FIX K (fee parents). Only inputs whose source output decodes as a
 *   MandalaToken of *this bundle's* assetId are walked. A fresh unconfirmed
 *   BSV change output funding the fee is not a token ancestor: it is neither
 *   walked nor counted as a hole, and the ordinary release/broadcast path
 *   already carries it.
 *
 * Termination is structural, not merely capped: a txid is the hash of its own
 * bytes, so a real spend graph is acyclic, every lookup is verified against
 * the looked-up transaction's own hash (a hostile bundle cannot file bytes
 * under a lying key and steer the walk), and `visited` memoizes each node.
 */
import { Hash, LockingScript, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { AdmissionEntry, DerSignature, verifyAdmission } from './admission.js'

/**
 * Minimal structural subset of @bsv/sdk's TransactionOutput/TransactionInput/
 * Transaction — only the members `cover` actually reads. A consumer app that
 * carries its own (nested, duplicated) copy of @bsv/sdk in node_modules has a
 * Transaction class that is a different nominal type from this package's, even
 * though it is byte-for-byte the same library; typing `cover`'s inputs
 * structurally means such a consumer's real Transaction/Beef objects satisfy
 * these types on their own, with no `as any` cast at the call site. Runtime
 * behavior is unchanged — this is a type-only relaxation.
 */
export interface TransactionOutputLike {
  lockingScript: LockingScript
  satoshis?: number
}

export interface TransactionInputLike {
  sourceTransaction?: TransactionLike
  sourceTXID?: string
  sourceOutputIndex: number
}

export interface TransactionLike {
  /** Only the hex form is ever called by `cover` (the real Transaction also has a no-arg `number[]` overload). */
  id: (enc: 'hex') => string
  inputs?: TransactionInputLike[]
  outputs?: TransactionOutputLike[]
}

/**
 * Transaction bytes the walk may recurse into, keyed by txid. A `Beef` (the
 * wallet's own AtomicBEEF/Beef parse) and a plain Map are both accepted; only
 * `findTxid` is used, so any structural equivalent works across duplicated
 * @bsv/sdk copies in node_modules.
 */
export type BundleBeef =
  | Map<string, TransactionLike>
  | { findTxid: (txid: string) => { tx?: TransactionLike } | undefined }

/**
 * Everything the payer hands over with a token payment (spec §1.1).
 *
 * `linkage` and `admissions` are keyed by disjoint sets of txids in a
 * well-formed bundle: a txid the payer has σ_I for needs no linkage payload
 * forwarded (nobody will submit it); a txid the payer does NOT have σ_I for
 * needs its linkage bytes carried verbatim so a downstream submitter can
 * rebuild the /submit body, and its own inputs are walked further.
 */
export interface AdmissionBundle {
  /** The asset whose ancestry is being proven; other assets are not walked. */
  assetId: string
  /**
   * 66-hex compressed overlay identity key the payer claims to have submitted
   * under. **Data, never a trust anchor** (§9.10): `cover()` compares it
   * against the caller's own `expectedSignerKey` and refuses on any mismatch.
   */
  overlayIdentityKey: string
  /** The payer's new transaction. */
  tip: TransactionLike
  /** Full bytes for every unadmitted ancestor the recipient may need to submit. */
  beef: BundleBeef
  /** Off-chain linkage payloads (opaque bytes) per unadmitted chain transaction. */
  linkage: Map<string, number[]>
  /** Overlay admissions, per txid. */
  admissions: Map<string, AdmissionEntry>
}

export type CoverFailureReason = 'uncovered_ancestor' | 'unsafe_asset' | 'shape'

export type CoverResult =
  /** Every token ancestor bottoms out; submit `mustSubmit` in order, tip last. */
  | { ok: true, mustSubmit: string[] }
  | { ok: false, reason: CoverFailureReason }

export interface CoverOptions {
  /**
   * The overlay identity key THIS verifier is configured to trust — its own
   * session/wallet configuration, never anything read off the wire (§9.10).
   * Required: there is no safe default, because the only other candidate is
   * the payer's own claim.
   */
  expectedSignerKey: string
}

const TXID_RE = /^[0-9a-f]{64}$/
const COMPRESSED_KEY_RE = /^0[23][0-9a-fA-F]{64}$/

function derBytes (sig: DerSignature): number[] {
  return typeof sig === 'string' ? Utils.toArray(sig, 'hex') : Array.from(sig)
}

function hexBytes (hex: string): number[] {
  return Utils.toArray(hex, 'hex')
}

/**
 * Canonical, deterministic serialization of a bundle (spec §1.1).
 *
 * **Never a wire field** — the bundle carries no self-referential hash, per
 * the simplest-token principle. This exists so a wallet and a test harness can
 * pin the pure verifier with vectors that do not depend on the outer
 * PaymentFrame byte layout.
 *
 *   SHA-256( 0x01 ‖ overlayIdentityKey ‖ tipTxid
 *            ‖ varint(|linkage|)    ‖ (txid ‖ varint(len) ‖ payload)*        sorted by txid
 *            ‖ varint(|admissions|) ‖ (txid ‖ varint(n) ‖ varint(vout)*
 *                                      ‖ varint(len) ‖ sig ‖ signerKey)*    sorted by txid )
 */
export function canonicalBundleId (bundle: AdmissionBundle): string {
  const w = new Utils.Writer()
  w.write([0x01])
  w.write(hexBytes(bundle.overlayIdentityKey))
  w.write(hexBytes(bundle.tip.id('hex')))

  const linkage = [...(bundle.linkage ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  w.writeVarIntNum(linkage.length)
  for (const [txid, payload] of linkage) {
    w.write(hexBytes(txid))
    w.writeVarIntNum(payload.length)
    w.write([...payload])
  }

  const admissions = [...(bundle.admissions ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  w.writeVarIntNum(admissions.length)
  for (const [txid, entry] of admissions) {
    w.write(hexBytes(txid))
    const outs = [...entry.outputsToAdmit].sort((a, b) => a - b)
    w.writeVarIntNum(outs.length)
    for (const v of outs) w.writeVarIntNum(v)
    const sig = derBytes(entry.signature)
    w.writeVarIntNum(sig.length)
    w.write(sig)
    w.write(hexBytes(entry.signerKey))
  }
  return Utils.toHex(Hash.sha256(w.toArray()))
}

/**
 * COVER (spec §1.2). Decides whether `tip` may be credited offline, and — when
 * it may — which transactions have to be submitted to the overlay, in
 * topological order (parents first, `tip` last).
 *
 * Failure reasons:
 * - `unsafe_asset`  — the bundle names no asset, the caller supplied no usable
 *                     `expectedSignerKey`, or the bundle's own
 *                     `overlayIdentityKey` is malformed or is not the expected
 *                     key (§9.10) — so nothing could be verified against
 *                     anything this verifier actually trusts.
 * - `shape`         — the transaction graph itself is malformed (an input that
 *                     names neither a source txid nor a source transaction).
 * - `uncovered_ancestor` — some token ancestor has neither a verifiable σ_I
 *                     covering the spent vout nor bytes to walk into.
 */
export function cover (tip: TransactionLike, bundle: AdmissionBundle, opts: CoverOptions): CoverResult {
  if (tip == null || typeof tip.id !== 'function') return { ok: false, reason: 'shape' }
  if (typeof bundle?.assetId !== 'string' || bundle.assetId === '') return { ok: false, reason: 'unsafe_asset' }
  // The trust anchor is the caller's configuration, checked before the bundle's
  // claim so a missing/garbage expectation can never be "satisfied" by whatever
  // the payer wrote.
  const expected = opts?.expectedSignerKey
  if (typeof expected !== 'string' || !COMPRESSED_KEY_RE.test(expected)) return { ok: false, reason: 'unsafe_asset' }
  const trustedKey = expected.toLowerCase()
  if (typeof bundle.overlayIdentityKey !== 'string' || !COMPRESSED_KEY_RE.test(bundle.overlayIdentityKey)) {
    return { ok: false, reason: 'unsafe_asset' }
  }
  if (bundle.overlayIdentityKey.toLowerCase() !== trustedKey) return { ok: false, reason: 'unsafe_asset' }
  const admissions = bundle.admissions ?? new Map<string, AdmissionEntry>()

  // --- memoized helpers -----------------------------------------------------

  const ids = new WeakMap<TransactionLike, string>()
  /** undefined when the object cannot even be serialized — a shape error. */
  const idOf = (tx: TransactionLike): string | undefined => {
    let v = ids.get(tx)
    if (v === undefined) {
      try {
        v = tx.id('hex')
      } catch {
        return undefined
      }
      ids.set(tx, v)
    }
    return v
  }

  /**
   * Bytes for `txid`, or undefined. A hostile bundle may file any bytes under
   * any key, so the looked-up transaction is verified against its own hash —
   * this is what makes a fabricated cycle impossible rather than merely
   * memoized away.
   */
  const lookup = (txid: string): TransactionLike | undefined => {
    const b: any = bundle.beef
    let tx: TransactionLike | undefined
    if (b == null) return undefined
    if (typeof b.findTxid === 'function') tx = b.findTxid(txid)?.tx
    else if (typeof b.get === 'function') tx = b.get(txid)
    if (tx == null || typeof tx.id !== 'function') return undefined
    return idOf(tx) === txid ? tx : undefined
  }

  const admittedMemo = new Map<string, boolean>()
  const isAdmitted = (txid: string): boolean => {
    const memo = admittedMemo.get(txid)
    if (memo !== undefined) return memo
    const entry = admissions.get(txid)
    const ok = entry != null &&
      typeof entry.signerKey === 'string' &&
      entry.signerKey.toLowerCase() === trustedKey &&
      verifyAdmission({ txid, outputsToAdmit: entry.outputsToAdmit, signature: entry.signature, signerKey: entry.signerKey })
    admittedMemo.set(txid, ok)
    return ok
  }

  const covered = (txid: string, vout: number): boolean =>
    isAdmitted(txid) && admissions.get(txid)!.outputsToAdmit.includes(vout)

  const isTokenOfAsset = (out: TransactionOutputLike | undefined): boolean => {
    if (out?.lockingScript == null) return false
    try {
      return MandalaToken.decode(out.lockingScript).assetId === bundle.assetId
    } catch {
      return false // not a Mandala token at all
    }
  }

  /** The parent txid an input names, preferring the explicit field. */
  const parentTxid = (input: TransactionInputLike): string | undefined => {
    if (typeof input?.sourceTXID === 'string' && TXID_RE.test(input.sourceTXID)) return input.sourceTXID
    if (input?.sourceTransaction != null) return idOf(input.sourceTransaction)
    return undefined
  }

  /** Marks a node currently on the recursion stack; re-entering it means a cycle. */
  const IN_PROGRESS = 'in-progress'

  /** The parent transaction bytes, from the input itself or from the bundle. */
  const parentTx = (input: TransactionInputLike, ptxid: string): TransactionLike | undefined => {
    const embedded = input.sourceTransaction
    if (embedded != null && idOf(embedded) === ptxid) return embedded
    return lookup(ptxid)
  }

  // --- the walk -------------------------------------------------------------

  const visited = new Map<string, boolean | typeof IN_PROGRESS>()
  const mustSubmit = new Set<string>()
  let malformed = false

  const walk = (tx: TransactionLike): boolean => {
    const txid = idOf(tx)
    if (txid == null) {
      malformed = true
      return false
    }
    const memo = visited.get(txid)
    if (memo === IN_PROGRESS) {
      // Re-entering a node still on the stack. A txid is the hash of its own
      // bytes, so this is unreachable for a real spend graph — only malformed
      // or hostile input gets here, and refusing is the safe direction (the
      // spec's own §1.2 sketch memoizes `true` here, which would make a
      // fabricated cycle read as covered).
      malformed = true
      return false
    }
    if (typeof memo === 'boolean') return memo
    visited.set(txid, IN_PROGRESS)

    let ok = true
    for (const input of tx.inputs ?? []) {
      const ptxid = parentTxid(input)
      const pvout = input?.sourceOutputIndex
      if (ptxid == null || !Number.isInteger(pvout) || pvout < 0) {
        malformed = true
        ok = false
        break
      }
      const parent = parentTx(input, ptxid)
      const sourceOutput = parent?.outputs?.[pvout]

      if (sourceOutput == null) {
        // We cannot see the spent output, so we cannot rule out that it is a
        // token of this asset. A verified σ_I covering it is still proof;
        // anything else is a hole (FIX B).
        if (covered(ptxid, pvout)) continue
        ok = false
        break
      }
      if (!isTokenOfAsset(sourceOutput)) continue // FIX K — not our concern
      if (covered(ptxid, pvout)) continue // bottom: proven admitted

      if (isAdmitted(ptxid)) {
        // FIX A: the overlay already ruled on this txid and did NOT admit this
        // output. Re-submitting the parent is idempotent and would return the
        // same set, so the coin can never become admitted — a hole, not a hop.
        ok = false
        break
      }
      if (parent == null || !walk(parent)) {
        ok = false
        break
      }
      mustSubmit.add(ptxid)
    }
    visited.set(txid, ok)
    return ok
  }

  if (!walk(tip)) {
    return { ok: false, reason: malformed ? 'shape' : 'uncovered_ancestor' }
  }

  // --- topological order, parents first, tip last ---------------------------

  const tipTxid = idOf(tip)
  if (tipTxid == null) return { ok: false, reason: 'shape' }
  const order: string[] = []
  const emitted = new Set<string>([tipTxid])
  const emit = (txid: string): void => {
    if (emitted.has(txid)) return
    emitted.add(txid)
    const tx = lookup(txid)
    for (const input of tx?.inputs ?? []) {
      const p = parentTxid(input)
      if (p != null && p !== txid && mustSubmit.has(p)) emit(p)
    }
    order.push(txid)
  }
  for (const txid of mustSubmit) emit(txid)
  order.push(tipTxid)
  return { ok: true, mustSubmit: order }
}
