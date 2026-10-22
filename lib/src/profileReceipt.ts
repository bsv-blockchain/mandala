/**
 * issuer-v1 `admitReceipt` (design goal 4, D6, D7, C§2.2, C§7.1; replaces
 * the baseline receipt admission, 0207:126-141 and 0207:1476-1481).
 *
 * The recipient wallet credits a Mandala receipt only after its OWN submit to
 * the overlay configured for K returns a verified attestation by K covering
 * every received output of the tip:
 *
 * - The submit list is `graph.pending` (parents first, tip last), or the tip
 *   alone when `pending` is empty. An already-attested tip is still
 *   resubmitted (idempotent), so a freeze or an eviction since its
 *   attestation is seen (D7).
 * - A typed verdict, retryable or not (ERR_FROZEN, ERR_PAUSED,
 *   ERR_CONSERVATION, ...), is rethrown: no credit and no offline fallback
 *   (D6). Any error that is not a transport `ColorProviderError` is rethrown
 *   the same way; nothing else is ever read as "overlay unreachable".
 * - Only a transport failure (`.transport === true`) stops submitting and
 *   answers `unavailable`, and only after every unanchored hop passes the
 *   local Mandala policy checks (`checkOfflineHops`). The module then applies
 *   attested offline acceptance (consent, `color_offline`).
 *
 * Stability: nothing here writes state. Submits are idempotent on the overlay
 * and carry the exact stored bytes, so a retried internalize, a second tab or
 * a crash mid-run simply submits again. Every check that can refuse without
 * the network (S5 provider, graph asset, C42 offChainValues) runs before the
 * first submit. Errors are classified by `.name` and `.transport`, never by
 * `instanceof` (D22).
 */
import {
  AttestationEvidenceError,
  ProfileDataError,
  type ColorAttestation,
  type ColorOverlayProvider,
  type ProfileAssetContext,
  type ReceiptAdmission,
  type ReceiptGraph
} from '@bsv/color-permission-module'
import { attestationFromSteak, verifyAttestation, type Attestation } from './attestation.js'
import { colorTopic } from './naming.js'
import { issuerKey } from './profileDescriptor.js'
import { checkOfflineHops, type OfflineHop } from './profileHopCheck.js'

const dataError = (reason: string): ProfileDataError =>
  new ProfileDataError(`BRC-207: Mandala issuer-v1 receipt: ${reason}`)

/** A transport failure: the provider's ColorProviderError with no typed verdict (C§2.1, C§6). */
function isTransportFailure (e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false
  const err = e as { name?: unknown, transport?: unknown }
  return err.name === 'ColorProviderError' && err.transport === true
}

const sameAttestation = (x: Attestation, y: Attestation): boolean =>
  x.txid === y.txid && x.signer === y.signer && x.signature === y.signature &&
  x.outputs.length === y.outputs.length && x.outputs.every((v, i) => v === y.outputs[i])

/**
 * Admit a Mandala receipt (C§2.2 `admitReceipt`). `provider(K)` returns the
 * configured provider for the asset's overlay identity key and throws
 * `ProfileParamsError` when none is configured (S5).
 */
export async function admitReceipt (
  ctx: ProfileAssetContext,
  graph: ReceiptGraph,
  provider: (k: string) => ColorOverlayProvider
): Promise<ReceiptAdmission> {
  const K = issuerKey(ctx.descriptor)
  // S5: no endpoint for K ⇒ ProfileParamsError, before anything else.
  const overlay = provider(K)

  if (graph == null || typeof graph !== 'object') throw dataError('the receipt graph is missing')
  if (graph.assetId !== ctx.assetId) throw dataError('the receipt graph names another asset')
  const tip = graph.tip
  if (tip == null || typeof tip !== 'object' || typeof tip.txid !== 'string') throw dataError('the receipt graph has no tip')
  const outputIndexes = graph.outputIndexes
  if (!Array.isArray(outputIndexes) || outputIndexes.length === 0) throw dataError('the receipt names no output of the asset')
  const pending = Array.isArray(graph.pending) ? graph.pending : []
  const submits: OfflineHop[] = pending.length > 0 ? pending : [tip]
  if (submits[submits.length - 1].txid !== tip.txid) throw dataError('the last pending transaction is not the tip')
  // C42: every unattested tx carries non-empty submission data (the envelope).
  for (const entry of submits) {
    if (!Array.isArray(entry.offChainValues) || entry.offChainValues.length === 0) {
      throw dataError(`transaction ${entry.txid} has no submission data`)
    }
  }

  const topic = colorTopic(ctx.assetId)
  const attestations: Attestation[] = []
  for (const entry of submits) {
    let steak: Record<string, any>
    try {
      steak = await overlay.submit([topic], entry.atomicBEEF, entry.offChainValues)
    } catch (e) {
      if (!isTransportFailure(e)) throw e // D6: a typed verdict never falls back offline.
      // Transport only: the module may accept offline, but never a hop the overlay would refuse.
      const seen = new Set<string>()
      const hops = [...pending, tip].filter(h => (seen.has(h.txid) ? false : (seen.add(h.txid), true)))
      checkOfflineHops(ctx, hops, K)
      return { status: 'unavailable' }
    }
    const att = attestationFromSteak(entry.txid, ctx.assetId, steak)
    if (att === undefined || !verifyAttestation(att, ctx.assetId, K)) {
      throw new AttestationEvidenceError('overlay admitted without a verifiable attestation')
    }
    attestations.push(att)
  }

  // The tip's verified attestations (this run's and the receipt's own) must
  // cover every received output.
  const result = [...attestations]
  for (const att of Array.isArray(graph.attestations) ? graph.attestations : []) {
    if (att?.txid !== tip.txid || !verifyAttestation(att, ctx.assetId, K)) continue
    if (!result.some(r => sameAttestation(r, att))) result.push({ txid: att.txid, outputs: [...att.outputs], signer: att.signer, signature: att.signature })
  }
  const covered = new Set(result.filter(a => a.txid === tip.txid).flatMap(a => a.outputs))
  const missing = outputIndexes.filter(i => !covered.has(i))
  if (missing.length > 0) {
    throw new AttestationEvidenceError(`the admission does not cover receipt output(s) ${missing.join(', ')}`)
  }
  return { status: 'admitted', attestations: result as ColorAttestation[] }
}
