/**
 * Issuer payouts (B4): treasury value coins (Mandala keys, `mandala
 * treasury`) → one holder `p color` output plus treasury change, overlay-first
 * (noSend → /submit → sendWith), then the BRC-207 receipt (attested leaf:
 * attestations = [tip], submissions = [tip]) delivered on MESSAGEBOX (C§7).
 *
 * Stability:
 * - S5: refuses before any wallet call while the overlay key is unset.
 * - Multi-tab / double-click: the whole flow holds the `mandala.payout` web
 *   lock; a concurrent second payout gets BusyError. The intent marker keeps
 *   the reconcile sweep off the live noSend action.
 * - Stale cache: the deploy is fetched (hash-verified) BEFORE any coin is
 *   held, so a bad lookup never leaves a held action behind.
 * - Crash: r is reserved before createAction (a failed write stops the
 *   payout before any side effect) and committed to the recipient outpoint
 *   after signing, before the submit. The receipt inputs are journaled as a
 *   pending intent (notifyPutIntent, throwing) before the submit, so a crash
 *   after admission leaves reconcileNotifications enough to complete and
 *   deliver the receipt (plan 04 risk R6, issuerIntent.ts). The 'accepted'
 *   journal entry is written before the broadcast (submitAndBroadcast) and
 *   the final body replaces the intent before the send. A failure between
 *   createAction and the submit aborts the action so its inputs are
 *   released; a submit failure that released the action also removes the
 *   intent (an unknown outcome keeps both, see below).
 * - Retry: a retryable overlay refusal that proves nothing was applied (a
 *   typed 4xx: pause, freeze) is NOT held for reconcile (holdRetryable
 *   false): the action is aborted, nothing is committed, and re-running the
 *   payout is the retry. A blinded payout's r record then names an outpoint
 *   that never exists (sender-local, harmless).
 * - Unknown outcome (`OverlayRefusedError.outcome === 'unknown'`: a 200 that
 *   admitted outputs without a verifying signature, a transport fault, a
 *   5xx): the overlay may have committed the payout. The action is held
 *   ('retryable' entry) and the receipt intent is kept; the error says the
 *   outcome is unknown and must NOT be answered by re-running the payout.
 *   reconcileWallet settles the action; reconcileNotifications delivers the
 *   receipt if it landed, or drops the intent once the action is released.
 */
import { Utils, WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { ADMIN_PROTOCOL, OVERLAY_IDENTITY_KEY, OVERLAY_IDENTITY_KEY_UNSET, TREASURY_BASKET } from './constants.js'
import { lockIssuerToken } from './brc162.js'
import { colorTopic } from './naming.js'
import { encodeEnvelope } from './encoding.js'
import { AdmissionReceipt, admissionReceipt, isOutcomeUnknown, submitAndBroadcast } from './overlay.js'
import { loadTreasuryCandidates } from './treasury/candidates.js'
import { selectTreasuryInputs } from './treasury/select.js'
import { revealIssuerLinkage } from './treasury/linkage.js'
import { signTreasurySpends } from './authority.js'
import { recipientLinkage } from './linkage.js'
import { blindingCommit, blindingReserve } from './blindingJournal.js'
import { guardPositiveAmount } from './submitGuards.js'
import { journalPut, withIntent } from './txJournal.js'
import { notifyPutIntent, notifyRemove } from './notifyJournal.js'
import { tryWithLock } from './webLocks.js'
import { BusyError } from './singleFlight.js'
import type { AdminAsset } from './assets.js'
import { actionDescription } from './assets.js'
import {
  checkRecipient, deliverIssuerReceipt, handoverBody, issuerReceipt, MessageBoxSender, newRemittance,
  ReceiptInstruction, requireAttestedOutput
} from './receipt.js'

/** Contract gap G4 (closed): a payout spends no authority, so no nextAuth* fields. */
export interface PayoutResult extends AdmissionReceipt {
  txid: string
  receipt: ReceiptInstruction
  outputIndex: 0
  /** False when the payout committed but the MessageBox send failed (journaled; reconcileNotifications retries). */
  notified: boolean
}

export interface PayoutParams {
  wallet: WalletInterface
  identityKey: string
  asset: AdminAsset
  /** Exact base units, 1..2^64-1. */
  amount: bigint
  recipientKey: string
  /** Default false: the receipt shows the issuer key. */
  blind?: boolean
  messageBoxClient: MessageBoxSender
  note?: string
}

export async function payoutTokens (p: PayoutParams): Promise<PayoutResult> {
  // (1) S5 and argument checks: before any wallet call, lock or journal write.
  if (OVERLAY_IDENTITY_KEY === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  const gate = guardPositiveAmount(p.amount)
  if (!gate.ok) throw new Error(gate.reason)
  checkRecipient(p)
  if (p.blind != null && typeof p.blind !== 'boolean') throw new TypeError('@bsv/mandala: blind must be a boolean')

  const { acquired, result } = await tryWithLock('mandala.payout', async () =>
    await withIntent(async () => await payoutPipeline(p))
  )
  if (!acquired || result == null) throw new BusyError('Payout already in progress in another tab')
  return result
}

async function payoutPipeline (p: PayoutParams): Promise<PayoutResult> {
  const { wallet, identityKey, asset, amount, recipientKey } = p
  const assetId = asset.assetId
  const overlayIdentityKey = OVERLAY_IDENTITY_KEY
  const blind = p.blind === true

  // (3) Treasury coins.
  const { candidates, beef } = await loadTreasuryCandidates(wallet, assetId)
  const { selected, total } = selectTreasuryInputs(candidates, amount) // throws if insufficient
  const change = total - amount

  // (4) Remittances, recipient key and linkage; r reserved before the action exists.
  const derivationPrefix = newRemittance()
  const derivationSuffix = newRemittance()
  const recipient = await recipientLinkage(wallet, {
    identityKey, recipientKey, assetId, derivationPrefix, derivationSuffix, overlayIdentityKey, blind
  })
  if (recipient.r != null) {
    await blindingReserve(derivationSuffix, {
      r: recipient.r, senderBlinded: recipient.senderIdentityKey, recipient: recipientKey, assetId, at: Date.now()
    })
  }

  // (5) The action: output 0 = recipient, output 1 = treasury change.
  const keyIDChange = 'pchg-' + Date.now()
  const outputs: any[] = [{
    satoshis: 1,
    lockingScript: new OneColor().lock(assetId, amount, recipient.pubKeyHash).toHex(),
    outputDescription: 'token payout'
  }]
  if (change > 0n) {
    const script = await lockIssuerToken(wallet, assetId, change, keyIDChange, identityKey)
    outputs.push({
      satoshis: 1,
      lockingScript: script.toHex(),
      outputDescription: 'treasury change',
      basket: TREASURY_BASKET,
      customInstructions: JSON.stringify({ protocolID: ADMIN_PROTOCOL, keyID: keyIDChange, counterparty: identityKey })
    })
  }
  const spendPlan = selected.map(s => ({ outpoint: s.outpoint, keyID: s.keyID, counterparty: s.counterparty }))
  const created = await wallet.createAction({
    description: actionDescription(`Payout ${amount} ${asset.label}`),
    labels: ['mandala', 'payout'],
    inputBEEF: beef,
    inputs: spendPlan.map(s => ({ outpoint: s.outpoint, unlockingScriptLength: 108, inputDescription: 'spend treasury coin' })),
    outputs,
    options: { noSend: true, randomizeOutputs: false }
  })
  const reference = created.signableTransaction?.reference
  if (created.signableTransaction == null || reference == null) throw new Error('payout: createAction returned no signableTransaction')

  // (6)-(7) Sign (noSend) and build the envelope; any failure here releases the held inputs.
  let signed: { tx: number[], txid: string }
  let env: number[]
  try {
    const spends = await signTreasurySpends(wallet, created.signableTransaction.tx as number[], spendPlan)
    const res = await wallet.signAction({ reference, spends, options: { noSend: true } })
    if (res.tx == null || res.txid == null) throw new Error('payout: signAction returned no tx')
    signed = { tx: res.tx as number[], txid: res.txid }
    env = encodeEnvelope({
      outputs: [
        { index: 0, linkage: recipient.linkage },
        ...(change > 0n ? [{ index: 1, linkage: await revealIssuerLinkage(wallet, keyIDChange, identityKey, overlayIdentityKey) }] : [])
      ]
    })
  } catch (e) {
    await releaseAction(wallet, reference)
    throw e
  }

  // (8) r now belongs to the recipient outpoint (before the submit: a crash
  //     after admission must not lose it).
  if (recipient.r != null) await blindingCommit(derivationSuffix, `${signed.txid}.0`)

  // (9) R6: the receipt inputs are durable before the submit. A failed write
  //     fails the payout here, inputs released, nothing submitted.
  const topics = [colorTopic(assetId)]
  try {
    await notifyPutIntent(signed.txid, {
      assetId,
      recipientKey,
      outputIndex: 0,
      amount: amount.toString(),
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey: recipient.senderIdentityKey,
      senderMode: blind ? 'blinded' : 'identity',
      ...(p.note != null ? { note: p.note } : {}),
      txHex: Utils.toHex(signed.tx),
      offChainHex: Utils.toHex(env),
      topics
    })
  } catch (e) {
    await notifyRemove(signed.txid)
    await releaseAction(wallet, reference)
    throw e
  }

  // (10) Overlay-first submit, then the background broadcast (journaled commit point).
  //     holdRetryable false: a refusal that PROVES nothing was applied (a
  //     typed 4xx verdict: pause, freeze) aborts like a final one. Holding it
  //     would let reconcile broadcast this tx later while the operator, told
  //     "retry later", re-runs the payout and pays twice. Released and
  //     uncommitted, re-running the payout IS the retry, and the intent goes.
  //     An UNKNOWN outcome (a 200 that admitted output 0 without a verifying
  //     signature, a transport fault, a 5xx) is different: the overlay may
  //     have folded and broadcast the tx. submitAndBroadcast keeps the action
  //     (journaled 'retryable'), so the intent stays too: reconcile settles
  //     the action, and reconcileNotifications completes the receipt from the
  //     'accepted' σ or a color-admission lookup, or drops it once absent.
  let admitted
  try {
    admitted = await submitAndBroadcast(wallet, signed, env, reference, undefined, topics, { holdRetryable: false })
  } catch (e) {
    if (!isOutcomeUnknown(e)) await notifyRemove(signed.txid)
    throw e
  }

  // (11) The receipt (plain custody JSON) and the tip's σ for the v4 body.
  const attestation = requireAttestedOutput(admitted, 0, signed.txid)
  const receipt = issuerReceipt({ assetId, derivationPrefix, derivationSuffix, senderIdentityKey: recipient.senderIdentityKey })

  // (12) Journal (replacing the intent), send, clear. A ReceiptUnavailableError
  //      above keeps the intent (the tx is committed): after INTENT_TTL_MS a
  //      reconcile pass completes it only if the color-admission lookup shows
  //      the recipient output admitted, and drops it when it is absent.
  const notified = await deliverIssuerReceipt({
    messageBoxClient: p.messageBoxClient,
    recipientKey,
    txid: signed.txid,
    body: handoverBody({
      assetId,
      amount,
      outputIndex: 0,
      tx: signed.tx,
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey: recipient.senderIdentityKey,
      senderMode: blind ? 'blinded' : 'identity',
      admission: attestation,
      linkage: [{ txid: signed.txid, offChainValues: env }],
      ...(p.note != null ? { note: p.note } : {})
    })
  })
  return { txid: signed.txid, receipt, outputIndex: 0, notified, ...admissionReceipt(admitted) }
}

/** Best-effort abort of a held noSend action; a failed abort is journaled for reconcile. */
async function releaseAction (wallet: WalletInterface, reference: string): Promise<void> {
  try {
    await wallet.abortAction({ reference })
  } catch {
    await journalPut({ txid: `abort:${reference}`, stage: 'abort', reference, at: Date.now() })
  }
}
