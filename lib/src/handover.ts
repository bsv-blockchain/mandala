/**
 * The payer side of an OFFLINE hand-over (offline settlement spec §0.1, §1).
 *
 * The maintainer's rule: *"we shouldn't have to check anything with the issuer
 * when making a payment (we need to be able to do this offline)."* So a
 * hand-over send contacts nothing — it builds and signs the transaction and
 * hands the recipient **evidence** instead of an assurance:
 *
 *   - for every token ancestor the payer can prove was admitted, the overlay's
 *     own σ_I (`admissions`);
 *   - for every token ancestor it cannot, the off-chain linkage bytes so the
 *     recipient (or anyone downstream) can itself POST that ancestor to
 *     `/submit` later (`linkage`), plus the full transaction bytes inside the
 *     AtomicBEEF so the recipient can walk one hop further back.
 *
 * The recipient decides with `cover()` (bundle.ts) — the exact inverse of this
 * walk — and is the party that submits (§0.1 rule 3).
 *
 * Everything here is pure except `journalEvidenceSource`, which reads the
 * lib's own storage adapter. No network, no bundler-only syntax, no Node or
 * browser globals — RN-safe.
 */
import { Transaction, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { AdmissionEntry } from './admission.js'
import { JournalEntry, journalList } from './txJournal.js'

/**
 * Where a hand-over gets its evidence. Injectable because the lib's own
 * journals are only one possible source — a wallet with a real settlement
 * store (or a device that received the coin over the nearby rail) has better
 * ones, and must be able to supply them without this module knowing about it.
 *
 * Both lookups return `undefined` for "I have nothing", never throw-to-signal:
 * missing evidence is a normal state that simply makes the walk go one hop
 * further back (or, at the frontier, produce a bundle the recipient refuses).
 */
export interface EvidenceSource {
  /** The overlay's σ_I for `txid`, if this device holds one. */
  admissionFor: (txid: string) => Promise<AdmissionEntry | undefined>
  /** The exact off-chain linkage payload bytes `txid` was/will be submitted with. */
  linkageFor: (txid: string) => Promise<number[] | undefined>
}

/** What `collectHandoverEvidence` produces — the two maps of an AdmissionBundle. */
export interface HandoverEvidence {
  /** Off-chain linkage payloads for ancestors with no σ_I (keyed by txid). */
  linkage: Map<string, number[]>
  /** Verifiable overlay admissions that terminate the walk (keyed by txid). */
  admissions: Map<string, AdmissionEntry>
}

/**
 * The default evidence source: the lib's own transaction journal.
 *
 * - σ_I comes from an `'accepted'` entry, which carries the overlay's
 *   acceptance proof written at the commit point (txJournal.ts, A12).
 * - linkage comes from `offChainHex` on any entry — an `'accepted'` one (this
 *   device submitted it) or a `'handed_over'` one (this device received or
 *   made an offline payment and is carrying the bytes forward verbatim).
 *
 * The journal is snapshotted once per source instance: a source is created per
 * send, so this is one store read for the whole walk rather than one per
 * ancestor, and it cannot see a half-written journal mid-walk.
 *
 * Known, deliberate limit: an `'accepted'` entry is removed once its broadcast
 * succeeds, so this source only proves admissions it still holds. A host with
 * a durable settlement store should inject its own `EvidenceSource`; that is
 * exactly why the hook exists.
 */
export function journalEvidenceSource (): EvidenceSource {
  let snapshot: Promise<Map<string, JournalEntry>> | undefined
  const load = async (): Promise<Map<string, JournalEntry>> => {
    snapshot ??= journalList().then(entries => new Map(entries.map(e => [e.txid, e])))
    return await snapshot
  }
  return {
    admissionFor: async txid => {
      const e = (await load()).get(txid)
      if (e == null || e.stage !== 'accepted') return undefined
      if (typeof e.admissionSignature !== 'string' || typeof e.admissionIdentityKey !== 'string') return undefined
      if (!Array.isArray(e.outputsToAdmit) || e.outputsToAdmit.length === 0) return undefined
      return {
        outputsToAdmit: e.outputsToAdmit,
        signature: e.admissionSignature,
        signerKey: e.admissionIdentityKey
      }
    },
    linkageFor: async txid => {
      const e = (await load()).get(txid)
      const hex = e?.offChainHex ?? e?.submit?.offChainHex
      if (typeof hex !== 'string' || hex === '') return undefined
      try {
        return Utils.toArray(hex, 'hex')
      } catch {
        return undefined // a corrupted payload is "absent", never a throw
      }
    }
  }
}

/** Does this output decode as a MandalaToken of exactly `assetId`? */
function isTokenOfAsset (out: { lockingScript: any } | undefined, assetId: string): boolean {
  if (out?.lockingScript == null) return false
  try {
    return MandalaToken.decode(out.lockingScript).assetId === assetId
  } catch {
    return false
  }
}

/**
 * Walk `tip`'s token ancestry and collect the evidence a recipient needs
 * (spec §1.2, mirrored: this produces what `cover()` consumes).
 *
 * **FIX K** — only inputs whose source output decodes as a `MandalaToken` of
 * `assetId` are walked. An unconfirmed BSV fee parent is an ordinary
 * broadcast-only ancestor, never a coverage hole, and walking it would make
 * the common case ("the payer just spent their own unconfirmed change")
 * un-payable offline.
 *
 * The walk stops at the first ancestor with a σ_I that covers the spent vout
 * (the bottom, §1.2 `Covered`): everything above it is already proven, so
 * recursing further would only bloat the message.
 *
 * This does NOT verify the signatures it collects — the recipient does, with
 * its own configured overlay key (§9.10). Verifying here would be a
 * self-check, and a payer that lies only hurts itself: the bundle is refused.
 */
export async function collectHandoverEvidence (
  tip: Transaction,
  assetId: string,
  evidence: EvidenceSource
): Promise<HandoverEvidence> {
  const linkage = new Map<string, number[]>()
  const admissions = new Map<string, AdmissionEntry>()
  const seen = new Set<string>()
  const queue: Transaction[] = [tip]

  while (queue.length > 0) {
    const tx = queue.shift() as Transaction
    for (const input of tx.inputs ?? []) {
      const parent = input.sourceTransaction
      const vout = input.sourceOutputIndex
      let ptxid: string | undefined = input.sourceTXID
      if (ptxid == null && parent != null) ptxid = parent.id('hex')
      if (ptxid == null || !Number.isInteger(vout) || vout < 0) continue

      // FIX K. When the source output is visible and is not a token of this
      // asset, it is not walked at all. When it is NOT visible we cannot rule
      // a token out, so we still carry whatever evidence we have — the
      // recipient's `cover()` makes the same conservative call.
      const src = parent?.outputs?.[vout]
      if (parent != null && !isTokenOfAsset(src, assetId)) continue
      if (seen.has(ptxid)) continue
      seen.add(ptxid)

      const admission = await evidence.admissionFor(ptxid)
      if (admission != null && Array.isArray(admission.outputsToAdmit) && admission.outputsToAdmit.includes(vout)) {
        // Bottom: proven admitted, and nobody downstream will ever submit it,
        // so its linkage bytes are dead weight (§1.1 — the two maps are
        // keyed by disjoint sets of txids).
        admissions.set(ptxid, admission)
        continue
      }
      const payload = await evidence.linkageFor(ptxid)
      if (payload != null) linkage.set(ptxid, payload)
      if (parent != null) queue.push(parent)
    }
  }
  return { linkage, admissions }
}

/** One `admissions` row on the v2 wire body — DER hex, never raw bytes. */
export interface WireAdmission {
  txid: string
  outputsToAdmit: number[]
  /** DER hex. */
  signature: string
  /** 66-hex compressed overlay identity key. */
  signerKey: string
}

/** One `linkage` row on the v2 wire body. */
export interface WireLinkage {
  txid: string
  payload: number[]
}

/**
 * The MessageBox hand-over body (wire contract v2 §8; offline settlement §1.1
 * carried over the handle rail instead of a PaymentFrame).
 *
 * `v: 2` + `kind: 'handover'` is the whole version discriminator: a v1 body
 * has neither and takes the legacy path unchanged.
 *
 * The bundle's `overlayIdentityKey` is deliberately NOT on the wire. It is
 * data, never a trust anchor (§9.10) — the recipient supplies its own
 * configured key as `expectedSignerKey`, so a payer-claimed key could only
 * ever be ignored or, worse, believed.
 */
export interface HandoverBody {
  v: 2
  kind: 'handover'
  assetId: string
  amount: number
  /** A′ — the blinded sender key, never the long-term identity. */
  sender: string
  senderMode: 'blinded' | 'identity'
  keyID: string
  protocolID: [0 | 1 | 2, string]
  /** AtomicBEEF of the tip, with every ancestor the walk may need. */
  transaction: number[]
  outputIndex: number
  /** Linkage bytes per UNADMITTED transaction in the chain — the tip included. */
  linkage: WireLinkage[]
  /** σ_I per admitted ancestor. Terminates the recipient's COVER walk. */
  admissions: WireAdmission[]
}

/** DER bytes in any accepted form → the hex the wire carries. */
export function derHex (sig: AdmissionEntry['signature']): string {
  return typeof sig === 'string' ? sig : Utils.toHex(Array.from(sig))
}
