/**
 * The payer side of the hand-over evidence (restored from @bsv/mandala 0.4.1
 * `handover.ts collectHandoverEvidence`, design §9 B7): walk the tip's token
 * ancestry and collect, per ancestor, either the overlay's σ (which ends the
 * walk) or the envelope bytes a downstream submitter needs. The recipient's
 * COVER (bundle.ts) is the exact inverse.
 *
 * Sources, in order: the host ledger (σ of settled receipts and own settled
 * hand-overs; envelopes of offline-received chains) and the lib's own
 * transaction journal ('accepted' σ; envelopes of 'signed', 'delivered',
 * 'retryable' and 'accepted' entries). Both lookups answer `undefined` for
 * "nothing here", never throw-to-signal.
 *
 * The walk does not verify what it collects (the recipient does, under its own
 * configured key): a payer that lies only gets its payment refused.
 */
import { Transaction, Utils } from '@bsv/sdk'
import type { Attestation } from './attestation.js'
import { attestationFromSteak } from './attestation.js'
import { decodeToken } from './brc162.js'
import type { HostLedger } from './hostLedger.js'
import { colorTopic } from './naming.js'
import { type JournalEntry, journalList } from './txJournal.js'

export interface EvidenceSource {
  admissionFor: (txid: string) => Promise<Attestation | undefined>
  linkageFor: (txid: string) => Promise<number[] | undefined>
}

const HEX = /^(?:[0-9a-f]{2})+$/

/** The default evidence source for `assetId`: the host ledger (when given) and the lib journal, snapshotted once. */
export function defaultEvidenceSource (assetId: string, ledger?: HostLedger): EvidenceSource {
  interface Snapshot { journal: Map<string, JournalEntry>, pendingLinkage: Map<string, string>, carried: Map<string, Attestation> }
  let snapshot: Promise<Snapshot> | undefined
  const load = async (): Promise<Snapshot> => {
    snapshot ??= (async () => {
      const journal = new Map((await journalList()).map(e => [e.txid, e]))
      const pendingLinkage = new Map<string, string>()
      const carried = new Map<string, Attestation>()
      if (ledger != null) {
        for (const r of await ledger.list()) {
          if (r.assetId !== assetId) continue
          for (const s of r.submits ?? []) if (!pendingLinkage.has(s.txid)) pendingLinkage.set(s.txid, s.offChainHex)
          for (const a of r.evidence ?? []) if (!carried.has(a.txid)) carried.set(a.txid, a)
        }
      }
      return { journal, pendingLinkage, carried }
    })()
    return await snapshot
  }
  return {
    admissionFor: async txid => {
      const rec = ledger != null ? await ledger.get(txid) : undefined
      if (rec?.state === 'settled' && rec.assetId === assetId && rec.attestation != null) return rec.attestation
      const snap = await load()
      const carried = snap.carried.get(txid)
      if (carried != null) return carried
      const e = snap.journal.get(txid)
      if (e == null || e.stage !== 'accepted' || e.admissionSignature == null || e.outputsToAdmit == null) return undefined
      return attestationFromSteak(txid, assetId, { [colorTopic(assetId)]: e })
    },
    linkageFor: async txid => {
      const { journal, pendingLinkage } = await load()
      const e = journal.get(txid)
      const hex = pendingLinkage.get(txid) ?? e?.submit?.offChainHex ?? e?.offChainHex
      return typeof hex === 'string' && HEX.test(hex) ? Utils.toArray(hex, 'hex') : undefined
    }
  }
}

/**
 * Walk `tip`'s ancestry for `assetId` (value, authority and deploy inputs;
 * FIX K: fee parents are skipped). Stops at the first σ that covers the spent
 * vout. Every unadmitted ancestor's envelope is collected when known; the tip's
 * own envelope is the caller's to add.
 */
export async function collectHandoverEvidence (
  tip: Transaction,
  assetId: string,
  source: EvidenceSource
): Promise<{ admissions: Map<string, Attestation>, linkage: Map<string, number[]> }> {
  const admissions = new Map<string, Attestation>()
  const linkage = new Map<string, number[]>()
  const seen = new Set<string>()
  const queue: Transaction[] = [tip]
  while (queue.length > 0) {
    const tx = queue.shift() as Transaction
    for (const input of tx.inputs ?? []) {
      const parent = input.sourceTransaction
      const vout = input.sourceOutputIndex
      const ptxid = input.sourceTXID ?? parent?.id('hex')
      if (ptxid == null || !Number.isInteger(vout) || vout < 0) continue
      const src = parent?.outputs?.[vout]
      if (parent != null) {
        const token = src != null ? decodeToken(src.lockingScript, ptxid, vout) : null
        if (token == null || token.assetId !== assetId) continue
      }
      const a = admissions.get(ptxid) ?? await source.admissionFor(ptxid)
      if (a != null && a.outputs.includes(vout)) {
        admissions.set(ptxid, a)
        continue
      }
      if (seen.has(ptxid)) continue
      seen.add(ptxid)
      const bytes = await source.linkageFor(ptxid)
      if (bytes != null) linkage.set(ptxid, bytes)
      if (parent != null) queue.push(parent)
    }
  }
  return { admissions, linkage }
}
