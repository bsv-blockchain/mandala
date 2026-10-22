/**
 * Holder send pipeline (B5, contract §8.1:531-543): sign → deliver → post-ACK
 * settle, with the lib hand-over journal as the only durable store.
 *
 *   1. `send` (sendHandover) builds and signs the noSend hand-over and journals
 *      it 'signed' before resolving. A throw here propagates: nothing durable
 *      exists, or the lib already released the action.
 *   2. Under the app hand-over lock (the drain's lock, waiting for it), either
 *      mark a self-send delivered or deliver on MessageBox; then, once the
 *      recipient holds it, settle with the overlay from the exact bytes.
 *
 * Once `send` resolved, this function never rejects. The hand-over is signed
 * and journaled, so a rejection would roll the UI back and invite the user to
 * pay a second time; every later failure is an outcome instead, and the drain
 * (`drainNow`) finishes the work: `reconcileNotifications` redelivers a
 * 'signed' entry, `reconcileWallet` settles a 'delivered' one.
 *
 * Stability:
 * - Crash after sign: entry 'signed', redelivered by the drain after 60 s.
 * - Crash after deliver: entry 'delivered', settled by the drain.
 * - Concurrent settle: the drain in any tab takes the same lock, so one txid
 *   is never settled by two app paths at once (A16).
 * - Final refusal: the lib releases the inputs once and drops the entry; the
 *   app only reports the code. No loop, no retry, no storage here.
 */
import type { WalletInterface } from '@bsv/sdk'
import type {
  deliverHandover,
  HandoverResult,
  markHandoverDelivered,
  sendHandover,
  settleHandover
} from '@bsv/mandala'
import { withHandoverLock, type Sender } from './handoverDrain'

export interface SendVars {
  assetId: string
  /** Exact base units, 1..2^64-1. */
  amount: bigint
  recipientKey: string
  /** The sender's note; travels with the hand-over to the recipient. */
  note?: string
}

export type SettleVerdict = Awaited<ReturnType<typeof settleHandover>>

export interface SendOutcome {
  txid: string
  /** The recipient holds the hand-over (delivered on MessageBox, or a self-send marked delivered). */
  delivered: boolean
  self: boolean
  /** null: not attempted (undelivered), lock unavailable, or settle threw. */
  settle: SettleVerdict | null
}

export interface SendDeps {
  wallet: WalletInterface
  identityKey: string
  overlayIdentityKey: string
  messageBoxClient: Sender
  send: typeof sendHandover
  deliver: typeof deliverHandover
  markDelivered: typeof markHandoverDelivered
  settle: typeof settleHandover
  withLock?: typeof withHandoverLock
}

function errText (e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Sign, deliver (or mark a self-send), then settle after the ACK (B5). */
export async function sendAndDeliver (deps: SendDeps, vars: SendVars): Promise<SendOutcome> {
  const { wallet, identityKey } = deps
  const { assetId, amount, recipientKey, note } = vars
  // 1. Sign. `blind` is left to the lib default (true; forced false for self).
  const h = await deps.send({ wallet, identityKey, assetId, amount, recipientKey, note })

  const self = recipientKey === identityKey
  const undelivered: SendOutcome = { txid: h.txid, delivered: false, self, settle: null }
  const withLock = deps.withLock ?? withHandoverLock
  try {
    // 2. Deliver and settle under the drain's lock, waiting for it.
    const locked = await withLock(async () => await deliverThenSettle(deps, vars, h, self), { wait: true })
    return locked.ran ? locked.value : undelivered
  } catch (e) {
    // The lock itself failed (e.g. navigator.locks rejected). Signed and
    // journaled: the drain delivers and settles it.
    console.warn('[sendPipeline] hand-over lock unavailable; recovery will finish', h.txid, errText(e))
    return undelivered
  }
}

async function deliverThenSettle (deps: SendDeps, vars: SendVars, h: HandoverResult, self: boolean): Promise<SendOutcome> {
  try {
    if (self) {
      // No MessageBox leg for a send to self (A13).
      await deps.markDelivered(h.txid)
    } else {
      await deps.deliver({ messageBoxClient: deps.messageBoxClient, recipientKey: vars.recipientKey, handover: h, note: vars.note })
    }
  } catch (e) {
    // Entry stays 'signed': reconcileNotifications redelivers it (or the
    // drain marks a self entry) after 60 s.
    console.warn('[sendPipeline] delivery failed; it will retry automatically', h.txid, errText(e))
    return { txid: h.txid, delivered: false, self, settle: null }
  }

  let verdict: SettleVerdict | null = null
  try {
    verdict = await deps.settle({
      wallet: deps.wallet,
      handover: { txid: h.txid, tx: h.tx, offChainValues: h.offChainValues },
      assetId: vars.assetId,
      overlayIdentityKey: deps.overlayIdentityKey
    })
  } catch (e) {
    // Entry stays 'delivered': reconcileWallet settles it from the journal.
    console.warn('[sendPipeline] settle did not run; recovery will settle', h.txid, errText(e))
  }
  return { txid: h.txid, delivered: true, self, settle: verdict }
}

export function describeSettle (o: SendOutcome): { kind: 'success' | 'info' | 'warning' | 'error', text: string } {
  if (!o.delivered) {
    return { kind: 'warning', text: 'Signed, but the recipient could not be reached yet — delivery will retry automatically.' }
  }
  if (o.settle?.status === 'admitted') return { kind: 'success', text: 'Sent and settled.' }
  if (o.settle?.status === 'refused') {
    return { kind: 'error', text: `The overlay refused this send (${o.settle.code}). The tokens were returned to your balance.` }
  }
  return { kind: 'info', text: 'Sent. Settlement with the overlay will complete automatically.' }
}

const NO_PROFILE = 'Your wallet cannot send Mandala assets: it needs the 1Color module with the Mandala issuer profile.'

/** User-facing text for a send that failed before or at signing. */
export function explainSendError (e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'UnsupportedProfileError') return NO_PROFILE
    if (/color-permission-module|issuer-v1 profile/i.test(e.message)) return NO_PROFILE
    if (e.message !== '') return e.message
  }
  return 'Send failed. Please try again.'
}
