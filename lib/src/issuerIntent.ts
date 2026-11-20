/**
 * Issuer receipts (payouts and reissues) and their crash-safe intents
 * (plan 04 risk R6).
 *
 * An issuer payout or reissue creates a holder `p color` output whose receipt
 * inputs (remittances, A or A′, the deploy, the envelope) exist only in the
 * issuer's memory until the final v3 body is journaled. A crash after the
 * overlay admitted the tx and before that write would leave an output on
 * chain that its recipient can never derive. So the payout journals an
 * INTENT (`notifyPutIntent`, a throwing write) before the submit, and
 * reconcileNotifications completes it after a crash:
 *
 * 1. While a txJournal entry with σ for the txid exists ('accepted', or
 *    'stranded' after admission), the attestation is rebuilt from it.
 * 2. Otherwise, only after INTENT_TTL_MS: a missing 'accepted' entry does
 *    NOT prove the tx was never broadcast (the background broadcast clears it
 *    on success), so admission is confirmed with a side-effect-free
 *    `color-admission` lookup of `<txid>.<outputIndex>` on `ls_color_<id>`
 *    (C§6). Present ⇒ the journaled bytes are re-POSTed (idempotent /submit,
 *    a fresh attestation) and the receipt completed. Absent ⇒ the intent is
 *    dropped (the tx was never admitted, so it was never broadcast) — unless
 *    a 'retryable' txJournal entry still holds the action (an unknown submit
 *    outcome): reconcile may yet admit it, so the intent waits until that
 *    entry becomes 'accepted' (σ, step 1) or is released.
 *    Unknown (lookup or submit failure) ⇒ wait for the next pass.
 *
 * Never re-POSTs blindly: that could admit a tx whose action was aborted.
 *
 * Import rule: notifyJournal.ts imports this module, and receipt.ts imports
 * notifyJournal.ts, so this module must not import either of them (or
 * handover.ts) at runtime. That is why `issuerReceipt` lives here.
 */
import { Utils } from '@bsv/sdk'
import { OVERLAY_IDENTITY_KEY } from './constants.js'
import { type Attestation, attestationFromSteak, verifyAttestation } from './attestation.js'
import { submitToOverlay } from './overlay.js'
import { postLookup } from './overlayLookup.js'
import { colorLookup, colorTopic } from './naming.js'
import { INTENT_TTL_MS, journalGet } from './txJournal.js'
import type { ReceiptInstruction } from './receipt.js'

/** The plain BRC-207 receipt for an issuer-built `p color` output (B7: no profileData). */
export function issuerReceipt (p: {
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}): ReceiptInstruction {
  return {
    version: 1,
    assetId: p.assetId,
    derivationPrefix: p.derivationPrefix,
    derivationSuffix: p.derivationSuffix,
    senderIdentityKey: p.senderIdentityKey
  }
}

/** Everything needed to rebuild an issuer v4 body without the issuer's memory. Hex, not number[] (string KV). */
export interface IssuerReceiptIntent {
  assetId: string
  recipientKey: string
  outputIndex: number
  /** Canonical decimal string of the recipient output amount. */
  amount: string
  derivationPrefix: string
  derivationSuffix: string
  /** A, or A′ when blinded. */
  senderIdentityKey: string
  senderMode: 'blinded' | 'identity'
  note?: string
  /** AtomicBEEF of the tip, exactly as submitted. */
  txHex: string
  /** The tip's Mandala envelope. */
  offChainHex: string
  topics: string[]
}

const HEX = /^(?:[0-9a-f]{2})+$/

/** True when `v` has the shape `notifyPutIntent` writes (a corrupt entry is never acted on). */
export function isIssuerReceiptIntent (v: unknown): v is IssuerReceiptIntent {
  const i = v as Partial<IssuerReceiptIntent> | null
  return i != null && typeof i === 'object' &&
    typeof i.assetId === 'string' && typeof i.recipientKey === 'string' &&
    Number.isInteger(i.outputIndex) && (i.outputIndex as number) >= 0 &&
    typeof i.derivationPrefix === 'string' && typeof i.derivationSuffix === 'string' &&
    typeof i.senderIdentityKey === 'string' && (i.note == null || typeof i.note === 'string') &&
    typeof i.amount === 'string' && /^[1-9][0-9]*$/.test(i.amount) &&
    (i.senderMode === 'blinded' || i.senderMode === 'identity') &&
    typeof i.txHex === 'string' && HEX.test(i.txHex) &&
    typeof i.offChainHex === 'string' && HEX.test(i.offChainHex) &&
    Array.isArray(i.topics) && i.topics.length > 0 && i.topics.every(t => typeof t === 'string')
}

export type IntentOutcome =
  | { status: 'wait' }
  | { status: 'drop', reason: string }
  | { status: 'ready', attestation: Attestation }

function ready (_txid: string, _intent: IssuerReceiptIntent, attestation: Attestation): IntentOutcome {
  return { status: 'ready', attestation }
}

/** A verified attestation by `signer` for `txid` that covers `outputIndex`. */
function covers (a: Attestation | undefined, txid: string, intent: IssuerReceiptIntent, signer: string): a is Attestation {
  return a != null && a.txid === txid && a.outputs.includes(intent.outputIndex) &&
    verifyAttestation(a, intent.assetId, signer)
}

/**
 * Decide what to do with an intent journaled `ageMs` ago. The caller has
 * already left intents younger than its live-delivery window alone and
 * checked S5 (`signer` is the configured overlay identity key). Never throws.
 */
export async function resolveIssuerIntent (txid: string, intent: IssuerReceiptIntent, ageMs: number, signer: string = OVERLAY_IDENTITY_KEY): Promise<IntentOutcome> {
  const { assetId, outputIndex } = intent
  try {
    // (1) σ from the journal, while the commit-point entry still exists.
    const entry = await journalGet(txid)
    if (entry?.admissionSignature != null && entry.outputsToAdmit != null) {
      const a = attestationFromSteak(txid, assetId, { [colorTopic(assetId)]: entry })
      if (covers(a, txid, intent, signer)) return ready(txid, intent, a)
    }
    // (2) No usable σ: wait until no live payout could still be submitting.
    if (ageMs < INTENT_TTL_MS) return { status: 'wait' }

    const outpoint = `${txid}.${outputIndex}`
    const answer = await postLookup(colorLookup(assetId), {
      type: 'color-admission',
      version: 1,
      assetId,
      topic: colorTopic(assetId),
      outpoints: [outpoint]
    })
    if (!answer.outputs.some(r => r.txid === txid && r.outputIndex === outputIndex)) {
      // Absent now, but a 'retryable' entry still holds the action (an
      // unknown submit outcome, overlay.ts): reconcile may yet admit and
      // broadcast it, so dropping the receipt inputs could strand the output.
      // Re-read: the entry may have moved on since step (1).
      //
      // Deferred-lib item 1: reconcileWallet (lock 'mandala.reconcile') may
      // re-POST the held entry while this pass (lock 'mandala.notify') looks
      // it up, so an entry that was 'retryable' at step (1) may now be
      // 'accepted' (σ) or gone because its broadcast already succeeded. Wait
      // whenever the entry was retryable at step (1) or any entry other than
      // 'abort' exists now; complete at once if it now carries σ.
      const again = await journalGet(txid)
      if (again?.admissionSignature != null && again.outputsToAdmit != null) {
        const a2 = attestationFromSteak(txid, assetId, { [colorTopic(assetId)]: again })
        if (covers(a2, txid, intent, signer)) return ready(txid, intent, a2)
      }
      if (entry?.stage === 'retryable' || (again != null && again.stage !== 'abort')) return { status: 'wait' }
      return { status: 'drop', reason: `${outpoint} is not admitted on ${colorTopic(assetId)}` }
    }
    // Admitted: re-POST the exact bytes for a fresh attestation (idempotent).
    const admitted = await submitToOverlay(
      Utils.toArray(intent.txHex, 'hex'), Utils.toArray(intent.offChainHex, 'hex'), undefined, intent.topics, signer
    )
    if (covers(admitted.attestation, txid, intent, signer)) return ready(txid, intent, admitted.attestation)
    console.warn(`[mandala] ${outpoint} is admitted but the overlay's attestation does not cover it; the receipt intent is kept`)
    return { status: 'wait' }
  } catch (e) {
    console.warn(`[mandala] cannot complete the receipt intent for ${txid} yet; it is kept for the next pass:`, e)
    return { status: 'wait' }
  }
}
