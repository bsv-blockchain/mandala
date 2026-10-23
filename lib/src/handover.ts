/**
 * Holder hand-over from a wallet HOST that runs `@bsv/color-permission-module`
 * with the Mandala issuer-v1 profile (C§8.1, B2, B5, design §9 B7).
 *
 *   sendHandover    build + sign plain noSend (the module adds inputs and
 *                   token change), build the envelope from the host's own
 *                   custody, walk the evidence (σ / envelopes), record the
 *                   hand-over 'pending' in the host ledger, journal 'signed'
 *                   ('delivered' for a self-send: no delivery is owed)
 *   deliverHandover journal the notification, send the v4 body on MESSAGEBOX,
 *                   mark 'delivered'
 *   settleHandover  post-ACK: submit the exact bytes on `tm_color_<assetId>`,
 *                   verify the attestation, journal 'accepted', sendWith
 *
 * Hand-over first, submit second: `sendHandover` never submits. Only the
 * caller (after the recipient's ACK) or reconcile (on a 'delivered' entry)
 * calls `settleHandover` / `resubmitDelivered`.
 *
 * Stability:
 * - Double-click / multi-tab: the `mandala.send` web lock (BusyError on a
 *   concurrent second send). The lock is taken with no await before it, so
 *   the in-process fallback is exclusive too. `settleHandover` keeps one
 *   in-flight promise per txid, so concurrent settles submit once.
 * - Crash before the 'signed' journalPut: the intent marker protects the live
 *   noSend action while the pipeline runs; after INTENT_TTL_MS the sweep may
 *   abort it, which is safe because nobody has the bytes yet.
 * - Crash after the 'signed' journalPut: the entry is never submitted,
 *   aborted or swept, and is redelivered by reconcileNotifications (Task 15).
 *   A self-send owes no delivery: it is journaled 'delivered' directly, so
 *   reconcile re-submits it and nothing is ever redelivered to the sender.
 *   The journal write and the blinding commit are both awaited before
 *   `sendHandover` resolves, so a caller never holds bytes the journal lacks.
 * - Stale cache: `settleHandover` checks that the bytes it submits hash to the
 *   txid it journals against.
 * - Retry: the same journaled bytes are re-POSTed (idempotent /submit). A
 *   retryable verdict never aborts; only a final verdict releases the inputs.
 */
import { PublicKey, Transaction, Utils, WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import {
  MANDALA_PROFILE_ID, MESSAGEBOX, OVERLAY_IDENTITY_KEY, OVERLAY_IDENTITY_KEY_UNSET,
  OVERLAY_URL, OVERLAY_URL_UNSET
} from './constants.js'
import { assertRemittance, colorProtocolID, colorTopic } from './naming.js'
import { planLabels, type ColorPlanV1 } from './plan.js'
import { recipientLinkage } from './linkage.js'
import { outputPubKeyHash } from './blinding.js'
import { blindingCommit, blindingReserve } from './blindingJournal.js'
import { guardPositiveAmount } from './submitGuards.js'
import { decodeToken } from './brc162.js'
import {
  admissionReceipt, broadcastAcceptedTx, isAlreadyBroadcast, OverlayRefusedError, submitToOverlay
} from './overlay.js'
import type { Attestation } from './attestation.js'
import {
  HandoverJournalEntry, JournalEntry, journalGet, journalIntentBegin, journalIntentEnd, journalPromoteSigned, journalPut,
  journalRemove
} from './txJournal.js'
import { notifyPut, notifyRemove } from './notifyJournal.js'
import { handoverBody, MessageBoxSender, newRemittance, ReceiptInstruction, receiptOfBody, type HandoverBodyV4 } from './receipt.js'
import type { HostLedger } from './hostLedger.js'
import { buildHandoverEnvelope } from './hostEnvelope.js'
import type { SpecificLinkage } from './encoding.js'
import { collectHandoverEvidence, defaultEvidenceSource, type EvidenceSource } from './evidence.js'
import { tryWithLock } from './webLocks.js'
import { BusyError } from './singleFlight.js'

export interface HandoverResult {
  txid: string
  /** AtomicBEEF of the signed tip. */
  tx: number[]
  /** The noSend action's reference (abort handle). */
  reference: string
  outputIndex: number
  /** The plain BRC-207 receipt the recipient internalizes with. */
  receipt: ReceiptInstruction
  /** The v4 MessageBox body (receipt fields + σ / envelope evidence), as delivered. */
  body: HandoverBodyV4
  /** The tip's submission data (the Mandala envelope the issuer-v1 handler built). */
  offChainValues: number[]
}

export interface SendHandoverParams {
  wallet: WalletInterface
  identityKey: string
  assetId: string
  /** Exact base units, 1..2^64-1. */
  amount: bigint
  recipientKey: string
  /** Default true; forced false for a send to self. */
  blind?: boolean
  note?: string
  /** Both or neither; each ≤ 48 UTF-8 bytes, no whitespace; used verbatim. */
  derivationPrefix?: string
  derivationSuffix?: string
  /**
   * Default true. `false` writes no txJournal key at all (no intent marker, no
   * 'signed' entry): the caller owns durability. **Precondition:** a host that
   * passes `false` must run `reconcileWallet` with `{ sweep: false }`, because
   * without an intent or 'signed' entry the sweep cannot tell this live
   * noSend action from an abandoned one. The lock and the blinding
   * reserve/commit still run; a reused caller suffix overwrites a stale
   * blinding reservation under the same key (a retry of the same payment).
   */
  journal?: boolean
  /**
   * The host ledger shared with the Mandala issuer-v1 handler (B7). The
   * hand-over is recorded there `pending` (its change becomes spendable
   * offline through the Mandala provider), and the evidence walk reads σ and
   * envelopes of received coins from it.
   */
  ledger: HostLedger
  /**
   * The host's UNDERLYING wallet (not the permissions manager): the change
   * custody and its linkage come from it, because the B7 module neither calls
   * `submissionData` for a plain hand-over nor returns the envelope. Only a
   * wallet host runtime has it; a BRC-100 app cannot send a Mandala hand-over.
   */
  hostWallet: WalletInterface
  /** Where the ancestry evidence comes from; default the ledger plus the lib journal. */
  evidence?: EvidenceSource
}

export type SettleResult =
  | { status: 'admitted', attestation: Attestation }
  | { status: 'retry' | 'refused', code: string }

const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/
const MANDALA_ASSET_ID = /^[0-9a-f]{64}_0$/
const TXID = /^[0-9a-f]{64}$/
const COLOR_KEY_ID = 'color'
const DEFAULT_DESCRIPTION = 'Send Mandala tokens'

function checkKey (key: unknown, name: string): string {
  if (typeof key !== 'string' || !COMPRESSED_KEY.test(key)) {
    throw new TypeError(`@bsv/mandala: ${name} must be a 66-hex compressed lowercase public key`)
  }
  return key
}

function checkMandalaAsset (assetId: unknown): string {
  if (typeof assetId !== 'string' || !MANDALA_ASSET_ID.test(assetId)) {
    throw new TypeError(`@bsv/mandala: invalid Mandala asset id ${JSON.stringify(assetId)} (expected <64 lowercase hex>_0)`)
  }
  return assetId
}

const utf8Length = (s: string): number => Utils.toArray(s, 'utf8').length

/** The note as the action description when it fits BRC-100's 5..50 bytes, else the default. */
function describe (note: string | undefined): string {
  if (note == null) return DEFAULT_DESCRIPTION
  const n = utf8Length(note)
  return n >= 5 && n <= 50 ? note : DEFAULT_DESCRIPTION
}

interface CheckedSend {
  wallet: WalletInterface
  identityKey: string
  assetId: string
  amount: bigint
  recipientKey: string
  self: boolean
  blind: boolean
  note?: string
  derivationPrefix: string
  derivationSuffix: string
  journal: boolean
  overlayIdentityKey: string
  ledger: HostLedger
  hostWallet: WalletInterface
  evidence?: EvidenceSource
}

/** Every argument check, synchronous, before the lock and any wallet call. */
function checkSend (p: SendHandoverParams): CheckedSend {
  if (p == null || typeof p !== 'object') throw new TypeError('@bsv/mandala: sendHandover arguments are required')
  if (p.wallet == null) throw new TypeError('@bsv/mandala: sendHandover needs a wallet')
  const identityKey = checkKey(p.identityKey, 'identityKey')
  const recipientKey = checkKey(p.recipientKey, 'recipientKey')
  const assetId = checkMandalaAsset(p.assetId)
  const gate = guardPositiveAmount(p.amount)
  if (!gate.ok) throw new TypeError(`@bsv/mandala: ${gate.reason ?? 'invalid amount'}`)
  if (p.blind != null && typeof p.blind !== 'boolean') throw new TypeError('@bsv/mandala: blind must be a boolean')
  if (p.journal != null && typeof p.journal !== 'boolean') throw new TypeError('@bsv/mandala: journal must be a boolean')
  if (p.note != null && typeof p.note !== 'string') throw new TypeError('@bsv/mandala: note must be a string')
  if (p.ledger == null || typeof p.ledger.put !== 'function') {
    throw new TypeError('@bsv/mandala: sendHandover needs the host ledger shared with the Mandala profile handler')
  }
  if (p.hostWallet == null || typeof p.hostWallet.revealSpecificKeyLinkage !== 'function') {
    throw new TypeError('@bsv/mandala: sendHandover needs the host\'s underlying wallet (hostWallet)')
  }
  const hasPrefix = p.derivationPrefix !== undefined
  const hasSuffix = p.derivationSuffix !== undefined
  if (hasPrefix !== hasSuffix) {
    throw new TypeError('@bsv/mandala: derivationPrefix and derivationSuffix must be given together')
  }
  const derivationPrefix = hasPrefix ? assertRemittance(p.derivationPrefix as string, 'derivationPrefix') : newRemittance()
  const derivationSuffix = hasSuffix ? assertRemittance(p.derivationSuffix as string, 'derivationSuffix') : newRemittance()
  const self = recipientKey === identityKey
  // S5: a send to another key needs the overlay key for its linkage; refuse
  // before the lock, the journal and any wallet call.
  if (OVERLAY_IDENTITY_KEY === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  return {
    wallet: p.wallet,
    identityKey,
    assetId,
    amount: p.amount,
    recipientKey,
    self,
    blind: self ? false : p.blind !== false,
    ...(p.note != null ? { note: p.note } : {}),
    derivationPrefix,
    derivationSuffix,
    journal: p.journal !== false,
    overlayIdentityKey: OVERLAY_IDENTITY_KEY,
    ledger: p.ledger,
    hostWallet: p.hostWallet,
    ...(p.evidence != null ? { evidence: p.evidence } : {})
  }
}

/**
 * Build, sign (noSend) and journal a holder hand-over of `amount` of
 * `assetId` to `recipientKey` (C§8.1). Never submits: delivery comes first
 * (`deliverHandover`), then the post-ACK `settleHandover`.
 *
 * Throws `TypeError` on invalid arguments and `Error(OVERLAY_IDENTITY_KEY_UNSET)`
 * (S5) before any wallet call, `BusyError` while another send holds the
 * `mandala.send` lock, and (after aborting the action) any failure to build
 * the envelope (no host custody for an owned output) or to record the
 * hand-over in the host ledger.
 */
export async function sendHandover (p: SendHandoverParams): Promise<HandoverResult> {
  const c = checkSend(p)
  // No await between the checks and the lock request: the in-process lock
  // fallback must be taken synchronously for a concurrent second call to see it.
  const { acquired, result } = await tryWithLock('mandala.send', async () => {
    if (!c.journal) return await sendPipeline(c)
    // The intent marker must exist before createAction (the sweep stays off
    // the live action), and is cleared once the outcome is journaled.
    const intent = await journalIntentBegin()
    try {
      return await sendPipeline(c)
    } finally {
      await journalIntentEnd(intent)
    }
  })
  if (!acquired || result == null) throw new BusyError('A token send is already in progress in another tab')
  return result
}

async function sendPipeline (c: CheckedSend): Promise<HandoverResult> {
  const { wallet, identityKey, assetId, amount, recipientKey, derivationPrefix, derivationSuffix } = c
  const protocolID = colorProtocolID(assetId, derivationPrefix, derivationSuffix)

  // The recipient output key and, for another recipient, its overlay linkage.
  let pubKeyHash: number[]
  let senderIdentityKey = identityKey
  let r: string | undefined
  let plan: ColorPlanV1
  let recipientEntry: { index: number, linkage: SpecificLinkage } | undefined
  const base = {
    version: 1 as const,
    assets: [assetId],
    operations: [{ assetId, operation: 'transfer' }],
    inputPositions: [] as [],
    changePositions: [] as [],
    sighashTypes: [] as []
  }
  if (c.self) {
    // A self-send is an owned output: the module derives it as the recipient.
    const { publicKey: walletIdentity } = await wallet.getPublicKey({ identityKey: true })
    if (walletIdentity !== identityKey) throw new TypeError('@bsv/mandala: identityKey is not this wallet\'s identity key')
    const { publicKey } = await wallet.getPublicKey({ protocolID, keyID: COLOR_KEY_ID, counterparty: identityKey, forSelf: true })
    pubKeyHash = outputPubKeyHash(PublicKey.fromString(publicKey))
    plan = {
      ...base,
      ownedOutputs: [{ outputIndex: 0, assetId, derivationPrefix, derivationSuffix, senderIdentityKey: identityKey }]
    }
  } else {
    const rl = await recipientLinkage(wallet, {
      identityKey, recipientKey, assetId, derivationPrefix, derivationSuffix,
      overlayIdentityKey: c.overlayIdentityKey, blind: c.blind
    })
    pubKeyHash = rl.pubKeyHash
    senderIdentityKey = rl.senderIdentityKey
    r = rl.r
    plan = {
      ...base,
      ownedOutputs: [],
      profileData: { [MANDALA_PROFILE_ID]: { [assetId]: { outputs: [{ index: 0, linkage: rl.linkage }] } } }
    }
    recipientEntry = { index: 0, linkage: rl.linkage }
  }
  // r is reserved before the action exists: a failed write stops the send
  // before any side effect. Throws on failure (the only copy of r).
  if (r != null) {
    await blindingReserve(derivationSuffix, { r, senderBlinded: senderIdentityKey, recipient: recipientKey, assetId, at: Date.now() })
  }

  const created = await wallet.createAction({
    description: describe(c.note),
    labels: [...planLabels(plan), 'mandala', 'transfer'],
    outputs: [{
      lockingScript: new OneColor().lock(assetId, amount, pubKeyHash).toHex(),
      satoshis: 1,
      outputDescription: 'Mandala token payment'
    }],
    // signAndProcess false: a WalletPermissionsManager otherwise signs a
    // caller-input-free action inside createAction (BRC-100 isSignAction is
    // false) and returns no reference, so the held action could not be
    // released on a later failure. Two-phase keeps the reference in hand.
    options: { noSend: true, randomizeOutputs: false, signAndProcess: false }
  })
  const reference = created.signableTransaction?.reference
  if (reference == null || reference === '') throw new Error('sendHandover: createAction returned no signableTransaction')

  // From here a failure must release the held action: nobody has the bytes.
  let txid: string
  let tx: number[]
  let offChainValues: number[]
  let body: HandoverBodyV4
  try {
    const signed = await wallet.signAction({ reference, spends: {} })
    if (signed?.tx == null || typeof signed.txid !== 'string' || !TXID.test(signed.txid)) {
      throw new Error('sendHandover: signAction returned no tx')
    }
    txid = signed.txid
    tx = Array.from(signed.tx)
    const tipTx = Transaction.fromAtomicBEEF(tx)
    if (tipTx.id('hex') !== txid) throw new Error('sendHandover: signAction returned bytes that do not hash to its txid')
    // B7: the module neither calls submissionData for a plain hand-over nor
    // returns an envelope, so the host builds it from its own custody.
    offChainValues = await buildHandoverEnvelope({
      hostWallet: c.hostWallet,
      identityKey,
      overlayIdentityKey: c.overlayIdentityKey,
      assetId,
      tx: tipTx,
      ...(recipientEntry != null ? { recipient: recipientEntry } : {})
    })
    // The ancestry evidence: σ per admitted ancestor, envelope per unadmitted one.
    const { admissions, linkage } = await collectHandoverEvidence(tipTx, assetId, c.evidence ?? defaultEvidenceSource(assetId, c.ledger))
    body = handoverBody({
      assetId,
      amount,
      outputIndex: 0,
      tx,
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey,
      senderMode: senderIdentityKey === identityKey ? 'identity' : 'blinded',
      admissions: [...admissions.values()],
      linkage: [...[...linkage].map(([t, b]) => ({ txid: t, offChainValues: b })), { txid, offChainValues }],
      ...(c.note != null ? { note: c.note } : {})
    })
  } catch (e) {
    await releaseAction(wallet, reference)
    throw e
  }
  const receipt = receiptOfBody(body)

  // Durable before resolving: r moves to the recipient outpoint, then the
  // 'signed' entry (bytes, envelope, receipt) lands. Never aborted, swept or
  // submitted from here until the recipient acknowledges.
  if (r != null) await blindingCommit(derivationSuffix, `${txid}.0`)
  // B7: the host records its own hand-over pending (exact bytes, envelope and
  // the outputs it keeps), so the Mandala provider can vouch for the change
  // while the overlay has not admitted it, and the evidence walk can forward
  // the envelope. Nobody has the bytes yet: a failed write releases and fails.
  try {
    const tipTx = Transaction.fromAtomicBEEF(tx)
    const kept: number[] = []
    tipTx.outputs.forEach((o, i) => {
      const d = decodeToken(o.lockingScript, txid, i)
      if (d != null && d.assetId === assetId && (c.self || i !== 0)) kept.push(i)
    })
    const beefHex = Utils.toHex(tx)
    await c.ledger.put({
      v: 1, txid, assetId, state: 'pending', own: true, outputs: kept, beefHex,
      submits: [{ txid, beefHex, offChainHex: Utils.toHex(offChainValues) }], at: Date.now()
    })
  } catch (e) {
    await releaseAction(wallet, reference)
    throw e
  }
  if (c.journal) {
    try {
      await writeSigned()
    } catch (e) {
      // journalPut only warns on a failed write. Without the entry, nothing
      // protects this action from the sweep once the intent ends, and nothing
      // can redeliver it. Nobody has the bytes yet, so release and fail.
      await releaseAction(wallet, reference)
      throw e
    }
  }
  return { txid, tx, reference, outputIndex: 0, receipt, body, offChainValues }

  async function writeSigned (): Promise<void> {
    // A self-send owes no delivery (and never goes through deliverHandover):
    // it is journaled 'delivered' at once, so reconcile re-submits it like any
    // acknowledged hand-over instead of holding its inputs as 'signed'.
    const stage = c.self ? 'delivered' : 'signed'
    await journalPut({
      txid,
      stage,
      reference,
      at: Date.now(),
      assetId,
      recipientKey,
      outputIndex: 0,
      ...(c.note != null ? { note: c.note } : {}),
      body: JSON.stringify(body),
      submit: { txHex: Utils.toHex(tx), offChainHex: Utils.toHex(offChainValues), topics: [colorTopic(assetId)] }
    })
    // Read back from the store: the entry must be durable before we resolve.
    if ((await journalGet(txid))?.stage !== stage) {
      throw new Error(`sendHandover: the '${stage}' journal entry for ${txid} was not stored; the hand-over was released`)
    }
  }
}

/** Best-effort abort of a held noSend action; a failed abort is journaled for reconcile. */
async function releaseAction (wallet: WalletInterface, reference: string): Promise<void> {
  try {
    await wallet.abortAction({ reference })
  } catch {
    await journalPut({ txid: `abort:${reference}`, stage: 'abort', reference, at: Date.now() })
  }
}

/**
 * Deliver a signed hand-over on MESSAGEBOX (C§7.2): journal the notification,
 * send it, clear it, then mark the journal entry 'delivered'. A send failure
 * rethrows; the notification stays journaled (reconcileNotifications retries
 * it) and the entry stays 'signed'. Duplicate delivery is harmless: the
 * receipt path is idempotent (0207 A.83).
 */
export async function deliverHandover (p: {
  messageBoxClient: MessageBoxSender
  recipientKey: string
  handover: Pick<HandoverResult, 'txid' | 'body'>
}): Promise<void> {
  if (p?.messageBoxClient == null || typeof p.messageBoxClient.sendMessage !== 'function') {
    throw new TypeError('@bsv/mandala: deliverHandover needs a messageBoxClient')
  }
  const recipientKey = checkKey(p.recipientKey, 'recipientKey')
  const { txid, body } = p.handover ?? ({} as any)
  if (typeof txid !== 'string' || !TXID.test(txid)) throw new TypeError('@bsv/mandala: handover.txid must be 64 lowercase hex')
  if (body == null || typeof body !== 'object' || body.v !== 4 || body.kind !== 'handover') {
    throw new TypeError('@bsv/mandala: handover.body must be the v4 hand-over body')
  }
  checkMandalaAsset(body.assetId)
  if (subjectTxid(Utils.toArray(body.transaction, 'hex')) !== txid) {
    throw new TypeError(`@bsv/mandala: handover.body does not carry the AtomicBEEF of ${txid}`)
  }
  await notifyPut({ txid, recipient: recipientKey, messageBox: MESSAGEBOX, body, at: Date.now() })
  await p.messageBoxClient.sendMessage({ recipient: recipientKey, messageBox: MESSAGEBOX, body })
  await notifyRemove(txid)
  await markHandoverDelivered(txid)
}

/**
 * 'signed' → 'delivered'. Idempotent. With no entry (a `journal: false`
 * send) or any other stage it resolves without writing.
 */
export async function markHandoverDelivered (txid: string): Promise<void> {
  await journalPromoteSigned(txid)
}

// ---------------------------------------------------------------------------
// Settle (post-ACK sender submit)
// ---------------------------------------------------------------------------

/** One in-flight settle per txid in this process (double-click, settle vs reconcile). */
const inFlight = new Map<string, Promise<SettleResult>>()

/** The subject txid of AtomicBEEF bytes, or undefined when unreadable. */
function subjectTxid (tx: number[]): string | undefined {
  try {
    return Transaction.fromAtomicBEEF(tx).id('hex')
  } catch {
    return undefined
  }
}

/**
 * Submit an acknowledged hand-over (C§8.1, B5, D24). The caller asserts the
 * recipient has acknowledged it. Throws only when the overlay identity key
 * (S5) or URL is not configured, or on malformed arguments (including bytes
 * that do not hash to `txid`); every overlay outcome is a result:
 *
 * - admitted: the verified attestation; the entry becomes 'accepted' (with
 *   σ fields) BEFORE the background `sendWith` broadcast, which clears it only
 *   on a proven post or an already-broadcast error (a resolved result whose
 *   row for this txid is 'failed' keeps it for reconcile).
 * - retry: a retryable verdict or any transport failure; `attempts` + 1 on
 *   the existing entry; never aborts.
 * - refused: a final verdict; the journaled reference is aborted (a failed
 *   abort leaves an 'abort' entry) and the entry is dropped.
 */
export async function settleHandover (p: SettleParams): Promise<SettleResult> {
  return await settleChecked(p, true)
}

export interface SettleParams {
  wallet: WalletInterface
  handover: Pick<HandoverResult, 'txid' | 'tx' | 'offChainValues'>
  assetId: string
  overlayIdentityKey: string
  /** Host ledger: records the verified σ (onward hand-overs walk to it). */
  ledger?: HostLedger
  /** Host-only `color.markSettled(txid)`: clears `color_offline` on the hand-over's own change once admitted. */
  markSettled?: (txid: string) => Promise<void>
}

async function settleChecked (p: SettleParams, broadcast: boolean): Promise<SettleResult> {
  if (p?.overlayIdentityKey === '' || p?.overlayIdentityKey == null) throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  checkKey(p.overlayIdentityKey, 'overlayIdentityKey')
  const assetId = checkMandalaAsset(p.assetId)
  const { txid, tx, offChainValues } = p.handover ?? ({} as any)
  if (typeof txid !== 'string' || !TXID.test(txid)) throw new TypeError('@bsv/mandala: handover.txid must be 64 lowercase hex')
  if (!Array.isArray(tx) || subjectTxid(tx) !== txid) {
    throw new TypeError(`@bsv/mandala: handover.tx is not the AtomicBEEF of ${txid}`)
  }
  if (!Array.isArray(offChainValues) || offChainValues.length === 0) {
    throw new TypeError('@bsv/mandala: handover.offChainValues must be the non-empty envelope bytes')
  }
  return await settleOnce(p.wallet, {
    txid, tx, offChainValues, assetId, overlayIdentityKey: p.overlayIdentityKey, broadcast,
    ...(p.ledger != null ? { ledger: p.ledger } : {}),
    ...(p.markSettled != null ? { markSettled: p.markSettled } : {})
  })
}

/**
 * The journal-driven core of `settleHandover` (C§8.1, G8): re-POST the exact
 * journaled `submit.txHex` / `offChainHex` on `[colorTopic(assetId)]`,
 * verified against `overlayIdentityKey`, with the same verdict handling.
 * Reused by reconcile (Task 15).
 *
 * `opts.broadcast` (default true) starts the background `sendWith` after an
 * admission, exactly as `settleHandover` does. Reconcile passes `false`: it
 * broadcasts the 'accepted' entry itself, so its attempt counting, stranding
 * and `ReconcileOptions.broadcast: false` (a host drain owns the broadcast)
 * all hold. Throws exactly where `settleHandover` throws (S5, malformed or
 * stale bytes).
 */
export async function resubmitDelivered (
  wallet: WalletInterface,
  entry: HandoverJournalEntry,
  overlayIdentityKey: string,
  opts: { broadcast?: boolean, ledger?: HostLedger, markSettled?: (txid: string) => Promise<void> } = {}
): Promise<SettleResult> {
  return await settleChecked({
    wallet,
    handover: {
      txid: entry.txid,
      tx: Utils.toArray(entry.submit.txHex, 'hex'),
      offChainValues: Utils.toArray(entry.submit.offChainHex, 'hex')
    },
    assetId: entry.assetId,
    overlayIdentityKey,
    ...(opts.ledger != null ? { ledger: opts.ledger } : {}),
    ...(opts.markSettled != null ? { markSettled: opts.markSettled } : {})
  }, opts.broadcast !== false)
}

interface SettleArgs {
  txid: string
  tx: number[]
  offChainValues: number[]
  assetId: string
  overlayIdentityKey: string
  /** Start the background sendWith after an admission (false: the caller broadcasts). */
  broadcast: boolean
  ledger?: HostLedger
  markSettled?: (txid: string) => Promise<void>
}

function settleOnce (wallet: WalletInterface, a: SettleArgs): Promise<SettleResult> {
  const running = inFlight.get(a.txid)
  if (running != null) return running
  const run = settlePipeline(wallet, a).finally(() => { inFlight.delete(a.txid) })
  inFlight.set(a.txid, run)
  return run
}

async function settlePipeline (wallet: WalletInterface, a: SettleArgs): Promise<SettleResult> {
  const topics = [colorTopic(a.assetId)]
  let admitted
  try {
    admitted = await submitToOverlay(a.tx, a.offChainValues, undefined, topics, a.overlayIdentityKey)
  } catch (e) {
    const refusal = e instanceof OverlayRefusedError || (e as { name?: unknown })?.name === 'OverlayRefusedError'
      ? e as OverlayRefusedError
      : undefined
    if (refusal == null || refusal.retryable) {
      // Retryable verdict or anything that is not a verdict (transport, an
      // empty admission): the bytes may still be admitted. Never abort.
      const code = refusal?.code ?? 'ERR_UNAVAILABLE'
      const entry = await journalGet(a.txid)
      if (entry != null) await journalPut({ ...entry, attempts: (entry.attempts ?? 0) + 1, code })
      return { status: 'retry', code }
    }
    await releaseRefused(wallet, a.txid, refusal.code)
    if (a.ledger != null) {
      try {
        const rec = await a.ledger.get(a.txid)
        if (rec != null) await a.ledger.put({ ...rec, state: 'refused', code: refusal.code, at: Date.now() })
      } catch (e) {
        console.warn(`[mandala] hand-over ${a.txid} was refused but the host ledger could not record it:`, e)
      }
    }
    return { status: 'refused', code: refusal.code }
  }
  const attestation = admitted.attestation
  if (attestation == null) {
    // Unreachable: submitToOverlay verifies an attestation on every color topic.
    return { status: 'retry', code: 'ERR_NO_ADMISSION' }
  }

  // THE COMMIT POINT: the overlay folded this tx in. 'accepted' (with σ) is
  // durable before the broadcast starts; it is never aborted from here.
  const entry = await journalGet(a.txid)
  await journalPut({
    txid: a.txid,
    stage: 'accepted',
    at: Date.now(),
    ...(entry?.reference != null ? { reference: entry.reference } : {}),
    offChainHex: Utils.toHex(a.offChainValues),
    ...admissionReceipt(admitted)
  })
  await recordOwnSettled(a, attestation)
  if (!a.broadcast) return { status: 'admitted', attestation }
  void broadcastAcceptedTx(wallet, a.txid)
    .then(async posted => {
      if (posted) {
        await journalRemove(a.txid)
        return
      }
      console.warn(`[mandala] overlay admitted hand-over ${a.txid} but the wallet did not report it as posted; keeping the 'accepted' entry for reconcile`)
    })
    .catch(async e => {
      if (isAlreadyBroadcast(e)) {
        await journalRemove(a.txid)
        return
      }
      console.warn(`[mandala] overlay admitted hand-over ${a.txid} but the broadcast failed; reconcile retries it:`, e)
    })
  return { status: 'admitted', attestation }
}

/**
 * B7: after a verified admission of an own hand-over, the host ledger keeps
 * its σ (so onward hand-overs of its change stop the walk here) and the host's
 * `markSettled` clears `color_offline` on that change. Neither failure undoes
 * the admission: the record is rewritten and `markSettled` re-run by the next
 * settle of the same txid (idempotent), so both are warned, never thrown.
 */
async function recordOwnSettled (a: SettleArgs, attestation: Attestation): Promise<void> {
  try {
    if (a.ledger != null) {
      await a.ledger.put({ v: 1, txid: a.txid, assetId: a.assetId, state: 'settled', outputs: [], attestation, marked: a.markSettled == null, at: Date.now() })
    }
    if (a.markSettled != null) {
      await a.markSettled(a.txid)
      if (a.ledger != null) await a.ledger.put({ v: 1, txid: a.txid, assetId: a.assetId, state: 'settled', outputs: [], attestation, marked: true, at: Date.now() })
    }
  } catch (e) {
    console.warn(`[mandala] hand-over ${a.txid} is admitted but recording it as settled failed; the next settle retries:`, e)
  }
}

/**
 * A final verdict: release the held action from the journaled reference and
 * drop the entry. Only a hand-over or retryable entry is aborted; an
 * 'accepted' or 'stranded' entry is never aborted (the overlay already folded
 * it). Without an entry (a `journal: false` send) there is nothing to abort
 * with; the caller owns the action.
 */
async function releaseRefused (wallet: WalletInterface, txid: string, code: string): Promise<void> {
  const entry: JournalEntry | undefined = await journalGet(txid)
  if (entry == null) return
  if (entry.stage !== 'signed' && entry.stage !== 'delivered' && entry.stage !== 'retryable') return
  if (entry.reference == null || entry.reference === '') {
    await journalRemove(txid)
    return
  }
  try {
    await wallet.abortAction({ reference: entry.reference })
    await journalRemove(txid)
  } catch {
    // Inputs still held by the dead action: reconcile retries the abort.
    await journalPut({ txid, stage: 'abort', reference: entry.reference, code, at: Date.now() })
  }
}
