/**
 * What an issuer payout (B4/B8) actually did, for the Treasury page.
 *
 * The one rule: only a refusal that PROVES the overlay applied nothing
 * (`OverlayRefusedError.outcome === 'refused'`; the lib then aborts the action)
 * may say "nothing was committed". Everything else either committed, may have
 * committed, or failed somewhere we do not assert about.
 *
 * Classification is structural (`name`, `code`, `outcome`, `committed`), not
 * `instanceof`, so a second copy of the lib cannot hide an unknown outcome.
 */
import type { PayoutResult } from '@bsv/mandala'
import type { SingleFlight } from '@bsv/mandala/singleFlight'

export type PayoutOutcome =
  /** Admitted by the overlay, receipt delivered on MessageBox. */
  | { kind: 'delivered', txid: string }
  /** Admitted; the MessageBox send failed. Journaled, the drain redelivers. */
  | { kind: 'delivery-pending', txid: string }
  /** Admitted without an attestation covering the recipient output: committed, no receipt can be built yet. */
  | { kind: 'committed-no-receipt', txid?: string, message: string }
  /** The overlay may have committed it (transport fault, 5xx, unverifiable 200). Held for reconcile. */
  | { kind: 'unknown', message: string }
  /** A typed overlay refusal (pause, freeze, …): the action was aborted, nothing committed. */
  | { kind: 'refused', code?: string, message: string }
  /** Another payout holds the latch (this tab or another): this one never started. */
  | { kind: 'busy', message: string }
  /** Any other failure. No claim either way about what was committed. */
  | { kind: 'failed', message: string }

export function payoutSucceeded (r: Pick<PayoutResult, 'txid' | 'notified'>): PayoutOutcome {
  return r.notified === false ? { kind: 'delivery-pending', txid: r.txid } : { kind: 'delivered', txid: r.txid }
}

const field = (e: unknown, k: string): unknown =>
  typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[k] : undefined

const messageOf = (e: unknown): string => {
  const m = field(e, 'message')
  return typeof m === 'string' && m !== '' ? m : String(e)
}

export function payoutFailed (e: unknown): PayoutOutcome {
  const message = messageOf(e)
  if (field(e, 'name') === 'BusyError' || field(e, 'code') === 'BUSY') return { kind: 'busy', message }
  // ReceiptUnavailableError: committed (do not retry), carries no `outcome`.
  if (field(e, 'committed') === true) {
    const txid = field(e, 'txid')
    return { kind: 'committed-no-receipt', ...(typeof txid === 'string' ? { txid } : {}), message }
  }
  const outcome = field(e, 'outcome')
  if (outcome === 'unknown') return { kind: 'unknown', message }
  if (outcome === 'refused' && field(e, 'name') === 'OverlayRefusedError') {
    const code = field(e, 'code')
    return { kind: 'refused', ...(typeof code === 'string' ? { code } : {}), message }
  }
  return { kind: 'failed', message }
}

/**
 * True when this payout's form must not be submitted again as-is: it
 * committed or may have committed (re-running could pay twice), or it is done.
 * Only `refused`, `busy` and `failed` leave the reviewed form re-submittable.
 */
export function outcomeLocksForm (o: PayoutOutcome): boolean {
  return o.kind !== 'refused' && o.kind !== 'busy' && o.kind !== 'failed'
}

export interface OutcomeView {
  tone: 'success' | 'warning' | 'error'
  title: string
  detail: string
}

const short = (txid: string): string => `${txid.slice(0, 10)}…${txid.slice(-6)}`

export function describePayoutOutcome (o: PayoutOutcome): OutcomeView {
  switch (o.kind) {
    case 'delivered':
      return { tone: 'success', title: 'Paid out and delivered', detail: `Admitted by the overlay and the receipt was delivered to the recipient · ${short(o.txid)}` }
    case 'delivery-pending':
      return { tone: 'warning', title: 'Paid out — delivery pending', detail: `Admitted by the overlay (${short(o.txid)}), but the receipt could not be delivered yet. It is saved and will be re-sent automatically. Do not pay again.` }
    case 'committed-no-receipt':
      return { tone: 'warning', title: 'Paid out — receipt held', detail: `The overlay admitted the payout${o.txid != null ? ` (${short(o.txid)})` : ''} but returned no attestation for the recipient output. It is committed: do not pay again. The receipt is completed automatically once the admission can be confirmed.` }
    case 'unknown':
      return { tone: 'warning', title: 'Outcome unknown — held', detail: `The overlay did not give a definite answer, so the payout may have gone through. It is held and will be settled or released automatically. Do not pay again; check the treasury balance and Activity first. (${o.message})` }
    case 'refused':
      return { tone: 'error', title: 'Refused by the overlay — nothing was committed', detail: o.message }
    case 'busy':
      return { tone: 'error', title: 'Another payout is in progress', detail: 'Wait for it to finish, then try again.' }
    case 'failed':
      return { tone: 'error', title: 'Payout did not complete', detail: `${o.message} — check the treasury balance before trying again.` }
  }
}

/**
 * One payout under the process-wide latch. Never throws: every path ends in a
 * PayoutOutcome.
 *
 * - Double submit: the latch is taken synchronously, before any await, so a
 *   second call in the same tick (another click, another mounted form) gets
 *   `busy` and never reaches `payout`. Other tabs are covered by the lib's
 *   `mandala.payout` web lock (its BusyError also maps to `busy`).
 * - The latch is released only by the call that took it, in `finally`.
 */
export async function runPayout<V> (
  deps: { flight: SingleFlight, payout: (vars: V) => Promise<Pick<PayoutResult, 'txid' | 'notified'>> },
  vars: V
): Promise<PayoutOutcome> {
  if (!deps.flight.tryAcquire()) return { kind: 'busy', message: 'Payout already in progress' }
  try {
    return payoutSucceeded(await deps.payout(vars))
  } catch (e) {
    return payoutFailed(e)
  } finally {
    deps.flight.release()
  }
}
