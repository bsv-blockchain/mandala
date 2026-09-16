/**
 * Incoming-transfer pipeline: list pending MessageBox transfers, internalize
 * each into the wallet basket, acknowledge the message. Pure of any UI — the
 * app layer decides how to surface results.
 *
 * Per-message failure is isolated: one bad transfer never blocks the rest,
 * and a failed message is left un-acknowledged so a later run retries it.
 */
import { AtomicBEEF, Beef, Transaction, WalletInterface } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { MESSAGEBOX, BASKET, OVERLAY_IDENTITY_KEY } from './constants.js'
import { resolveAssetMetadata } from './metadata.js'
import { AdmissionEntry, verifyAdmission } from './admission.js'
import { AdmissionBundle, cover } from './bundle.js'
import { WireAdmission, WireLinkage } from './handover.js'
import { OverlayRefusedError, submitToOverlay } from './overlay.js'

/**
 * The message body contradicts the transaction it carries (or isn't a valid
 * token transfer at all). Never retried — the message is acknowledged and
 * dropped so a malicious or corrupt transfer can't wedge the receive loop.
 */
export class InvalidTransferError extends Error {
  /** Machine-readable reason, surfaced as `refusedCode` on the failed row. */
  readonly code?: string
  constructor (message: string, code?: string) {
    super(message)
    this.name = 'InvalidTransferError'
    this.code = code
  }
}

/**
 * What the recipient still owes the overlay after crediting a hand-over
 * (offline settlement §0.1 rules 3–4): the transactions COVER says are
 * unadmitted, parents first and the tip last.
 *
 * `bytesFor` returns the AtomicBEEF for one of those txids together with the
 * off-chain linkage payload the payer forwarded for it — exactly the pair
 * `/submit` consumes. It returns `undefined` only for a txid the bundle does
 * not contain, which COVER has already ruled out.
 */
export interface SettleArgs {
  /** The tip — the transaction this credit is for. */
  txid: string
  mustSubmit: string[]
  bytesFor: (txid: string) => { beef: number[], offChainValues: number[] } | undefined
}

export type SettleFn = (args: SettleArgs) => Promise<void>

/**
 * The default settlement: submit each txid in order through the overlay.
 *
 * The overlay broadcasts what it admits, so nothing is broadcast here.
 * `/submit` is idempotent (§0.1 rule 6 / FIX C), so re-submitting an ancestor
 * a third party already settled is a no-op that returns the same admission —
 * which is what makes "whoever reconnects first settles the chain" safe.
 *
 * A retryable refusal propagates: the caller leaves the message un-acknowledged
 * so the next inbox pass finishes the job. A FINAL refusal also propagates and
 * the caller records it; nothing is reversed, because the credit was made on
 * evidence the recipient verified for itself.
 */
export const defaultSettle: SettleFn = async ({ mustSubmit, bytesFor }) => {
  for (const id of mustSubmit) {
    const bytes = bytesFor(id)
    if (bytes == null) {
      throw new OverlayRefusedError({
        code: 'ERR_UNAVAILABLE',
        description: `hand-over bundle has no bytes for ${id}`,
        retryable: true
      })
    }
    await submitToOverlay(bytes.beef, bytes.offChainValues.length > 0 ? bytes.offChainValues : undefined)
  }
}

/**
 * The recipient must not trust the sender's message body: verify that the
 * output the body points at actually IS a Mandala token of the claimed asset
 * and amount before internalizing. Without this a hostile sender corrupts the
 * recipient's basket/balances with mislabeled or non-token outputs.
 *
 * Returns whether the message carried a σ_I this device could verify.
 *
 * **FIX H.** A counterparty-supplied signature is never trusted on shape. When
 * `admission` is present it MUST verify — against this session's own overlay
 * identity key, over this transaction's own txid and the exact admitted output
 * set — or it is treated as **absent**: never as a decline, never as proof. A
 * forged σ_I therefore cannot wedge a receive, and a legacy message that
 * carries none is not penalised for it. What the flag buys the caller is the
 * ability to credit immediately instead of waiting to confirm admission
 * itself.
 */
function verifyIncoming (msg: IncomingTransfer): { admissionVerified: boolean } {
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(msg.transaction)
  } catch {
    try {
      tx = Transaction.fromBEEF(msg.transaction as unknown as number[])
    } catch (e) {
      throw new InvalidTransferError(`transaction does not parse: ${String(e)}`)
    }
  }
  const out = tx.outputs[msg.outputIndex]
  if (out == null) {
    throw new InvalidTransferError(`outputIndex ${msg.outputIndex} out of range`)
  }
  let decoded: { assetId: string, amount: number }
  try {
    decoded = MandalaToken.decode(out.lockingScript)
  } catch {
    throw new InvalidTransferError('output is not a Mandala token')
  }
  if (decoded.assetId !== msg.assetId) {
    throw new InvalidTransferError(`asset mismatch: body says ${msg.assetId}, output is ${decoded.assetId}`)
  }
  if (decoded.amount !== Number(msg.amount)) {
    throw new InvalidTransferError(`amount mismatch: body says ${msg.amount}, output is ${decoded.amount}`)
  }
  return { admissionVerified: checkAdmission(tx, msg) }
}

/** FIX H: verify, or treat as absent. Never throws, never declines. */
function checkAdmission (tx: Transaction, msg: IncomingTransfer): boolean {
  const a = msg.admission
  if (a == null) return false
  // Scope cap (A12): the key currently configured, not the key that was live
  // at the height of the Merkle path. Rotation (R34/R69) is out of scope.
  if (OVERLAY_IDENTITY_KEY === '') return false
  if (a.signerKey?.toLowerCase() !== OVERLAY_IDENTITY_KEY.toLowerCase()) return false
  // The signature must name THIS transaction, and the output we are being
  // credited with must be one the overlay actually admitted (FIX A).
  let txid: string
  try {
    txid = tx.id('hex')
  } catch {
    return false
  }
  if (a.txid !== txid) return false
  if (!Array.isArray(a.outputsToAdmit) || !a.outputsToAdmit.includes(msg.outputIndex)) return false
  return verifyAdmission({
    txid,
    outputsToAdmit: a.outputsToAdmit,
    signature: a.signature,
    signerKey: a.signerKey
  })
}

/** Wallet errors meaning this output was internalized by an earlier attempt. */
function isAlreadyInternalized (e: unknown): boolean {
  return /already|duplicate|exists/i.test(String(e))
}

/** Message body shape produced by transferTokens / reissue notification. */
export interface IncomingTransfer {
  id: string
  assetId: string
  amount: string
  sender: string
  /** Present when the remittance is A′ rather than the long-term identity. */
  senderMode?: 'blinded' | 'identity'
  keyID: string
  protocolID: [0 | 1 | 2, string]
  transaction: AtomicBEEF
  /** Where the sender's (randomized) tx put our output; 0 for legacy messages. */
  outputIndex: number
  /**
   * Optional overlay acceptance proof for this very transaction (§4.5). Absent
   * on legacy messages and on any rail whose sender had not submitted yet.
   */
  admission?: {
    txid: string
    outputsToAdmit: number[]
    /** DER hex. */
    signature: string
    /** 66-hex compressed overlay identity key. */
    signerKey: string
  }
  /**
   * Present only on a v2 `kind:'handover'` body — the payer was OFFLINE and
   * never submitted. The recipient runs COVER over this evidence and, on
   * success, is the party that submits (§0.1 rule 3).
   */
  handover?: {
    linkage: WireLinkage[]
    admissions: WireAdmission[]
  }
  /**
   * The sender's own note, when they gave one. Overrides the fixed
   * `Receive ${amount} of ${assetId}` action description. Absent on any
   * message from a sender build that predates this field.
   */
  note?: string
}

export interface ReceivedTransfer extends IncomingTransfer {
  label: string
  decimals: number
  /**
   * True only when the message carried a σ_I that verified against this
   * session's overlay key, this txid and an admitted set containing our
   * output. False means "no usable proof" — which is the normal, legacy case,
   * not a fault (FIX H).
   */
  admissionVerified: boolean
  /** True when this credit came from a v2 offline hand-over body. */
  handedOver: boolean
  /** True when COVER accepted the payer's evidence. Always false for v1. */
  covered: boolean
  /**
   * True when nothing remains to be submitted for this credit: the settle hook
   * completed for a hand-over, or — for a legacy v1 body — the payer had
   * already submitted online before notifying.
   */
  settled: boolean
  /** The overlay's FINAL verdict code when settlement was refused outright. */
  refusedCode?: string
}

/** Minimal MessageBox surface receiveTokens needs (keeps the client mockable). */
export interface MessageBoxLike {
  listMessages: (args: { messageBox: string, acceptPayments?: boolean }) => Promise<unknown>
  acknowledgeMessage: (args: { messageIds: string[] }) => Promise<unknown>
}

export interface ReceiveParams {
  wallet: WalletInterface
  messageBoxClient: MessageBoxLike
  /** Only accept transfers of this asset; others are left pending. */
  assetId?: string
  /**
   * Cross-call dedup set of messageIds currently being processed. Callers that
   * poll should pass a long-lived Set so a slow run and a refresh never
   * double-internalize the same message. Failed ids are removed for retry.
   */
  processed?: Set<string>
  /**
   * How a credited hand-over is settled with the overlay. Defaults to
   * `defaultSettle` (submit each txid in order), which is what the online web
   * console wants. Inject one to defer settlement to a host-owned drain, or to
   * a device that is still offline at credit time.
   */
  settle?: SettleFn
}

export interface ReceiveResult {
  accepted: ReceivedTransfer[]
  failed: Array<{ messageId: string, error: unknown, refusedCode?: string }>
}

/**
 * Rebuild the AdmissionBundle from a v2 body and run COVER over it.
 *
 * Nothing here trusts the payer: the BEEF is re-derived from the transaction
 * bytes (so a txid can only map to bytes that hash to it), the admissions are
 * verified against THIS device's configured overlay key — never one named on
 * the wire (§9.10) — and a refusal is a refusal, not a retry.
 */
function coverHandover (msg: IncomingTransfer): { tip: Transaction, beef: Beef, mustSubmit: string[], linkage: Map<string, number[]> } {
  const handover = msg.handover as { linkage: WireLinkage[], admissions: WireAdmission[] }
  let tip: Transaction
  try {
    tip = Transaction.fromAtomicBEEF(msg.transaction)
  } catch (e) {
    throw new InvalidTransferError(`hand-over transaction does not parse: ${String(e)}`, 'shape')
  }
  const beef = new Beef()
  try {
    beef.mergeTransaction(tip)
  } catch (e) {
    throw new InvalidTransferError(`hand-over BEEF is incomplete: ${String(e)}`, 'shape')
  }
  const linkage = new Map<string, number[]>()
  for (const l of handover.linkage ?? []) {
    if (typeof l?.txid === 'string' && Array.isArray(l.payload)) linkage.set(l.txid, l.payload)
  }
  const admissions = new Map<string, AdmissionEntry>()
  for (const a of handover.admissions ?? []) {
    if (typeof a?.txid !== 'string') continue
    admissions.set(a.txid, { outputsToAdmit: a.outputsToAdmit, signature: a.signature, signerKey: a.signerKey })
  }
  const bundle: AdmissionBundle = {
    assetId: msg.assetId,
    // Our own configuration is the trust anchor; the bundle field exists only
    // so cover() can assert the two agree.
    overlayIdentityKey: OVERLAY_IDENTITY_KEY,
    tip,
    beef,
    linkage,
    admissions
  }
  const result = cover(tip, bundle, { expectedSignerKey: OVERLAY_IDENTITY_KEY })
  if (!result.ok) {
    throw new InvalidTransferError(`hand-over evidence does not cover the payment (${result.reason})`, 'not_covered')
  }
  return { tip, beef, mustSubmit: result.mustSubmit, linkage }
}

async function acceptOne (
  wallet: WalletInterface,
  messageBoxClient: MessageBoxLike,
  msg: IncomingTransfer,
  settle: SettleFn
): Promise<ReceivedTransfer> {
  // A hand-over is decided on evidence BEFORE anything else: an uncovered
  // bundle is refused exactly like a body that contradicts its transaction
  // (ack + drop) — retrying cannot make missing proof appear.
  const handedOver = msg.handover != null
  const covering = handedOver ? coverHandover(msg) : undefined

  // Trust the transaction, not the body — reject mismatches before any
  // wallet work (throws InvalidTransferError; caller acks + drops).
  const { admissionVerified } = verifyIncoming(msg)

  const meta = await resolveAssetMetadata(msg.assetId)
  const label = meta?.label ?? `${msg.assetId.slice(0, 20)}…`
  const decimals = Number(meta?.decimals) || 0

  try {
    await wallet.internalizeAction({
      tx: msg.transaction,
      // Sender key as an action label — survives the output being spent,
      // unlike customInstructions (see history.ts counterparty resolution).
      labels: ['mandala', 'receive', `from-${msg.sender.toLowerCase()}`],
      outputs: [{
        outputIndex: msg.outputIndex,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: BASKET,
          customInstructions: JSON.stringify({
            protocolID: msg.protocolID,
            keyID: msg.keyID,
            counterparty: msg.sender,
            label
          }),
          tags: ['mandala', 'received', msg.assetId]
        }
      }],
      description: (typeof msg.note === 'string' && msg.note.trim()) || `Receive ${msg.amount} of ${msg.assetId}`
    })
  } catch (e) {
    // Internalize + acknowledge are not atomic: an earlier attempt may have
    // internalized this output and crashed before acknowledging. Treat
    // "already internalized" as success so the acknowledge below completes
    // the transfer instead of the message replaying forever.
    if (!isAlreadyInternalized(e)) throw e
  }

  // Settlement runs BEFORE the acknowledge, so a retryable refusal leaves the
  // message in the box for the next inbox pass instead of stranding the
  // obligation. Re-crediting on that pass is harmless — internalizeAction is
  // idempotent above and /submit is idempotent by contract.
  let settled = !handedOver
  let refusedCode: string | undefined
  if (covering != null) {
    const { tip, beef, mustSubmit, linkage } = covering
    try {
      await settle({
        txid: tip.id('hex'),
        mustSubmit,
        bytesFor: id => {
          const tx = beef.findAtomicTransaction(id)
          if (tx == null) return undefined
          return { beef: tx.toAtomicBEEF(true), offChainValues: linkage.get(id) ?? [] }
        }
      })
      settled = true
    } catch (e) {
      // A FINAL verdict will never lift: reverse nothing (the credit was made
      // on evidence this device verified itself), report it, and let the
      // message be acknowledged so it does not replay forever.
      if (e instanceof OverlayRefusedError && !e.retryable) refusedCode = e.code
      else throw e
    }
  }
  await messageBoxClient.acknowledgeMessage({ messageIds: [msg.id] })
  return {
    ...msg,
    label,
    decimals,
    admissionVerified,
    handedOver,
    covered: covering != null,
    settled,
    ...(refusedCode != null ? { refusedCode } : {})
  }
}

/**
 * Accept every pending incoming transfer. Returns what was internalized and
 * what failed (failed messages stay un-acknowledged for a later retry).
 */
export async function receiveTokens (p: ReceiveParams): Promise<ReceiveResult> {
  const { wallet, messageBoxClient, assetId, processed } = p
  const settle = p.settle ?? defaultSettle
  const accepted: ReceivedTransfer[] = []
  const failed: Array<{ messageId: string, error: unknown }> = []

  const messages = await messageBoxClient.listMessages({ messageBox: MESSAGEBOX, acceptPayments: false })
  for (const raw of messages as Array<{ messageId: string, body: any }>) {
    if (assetId != null && raw.body?.assetId !== assetId) continue
    if (processed?.has(raw.messageId) === true) continue
    processed?.add(raw.messageId)
    try {
      // v2 + kind:'handover' is the whole version discriminator; a v1 body has
      // neither and takes the legacy path byte-for-byte unchanged.
      const isHandover = raw.body?.v === 2 && raw.body?.kind === 'handover'
      accepted.push(await acceptOne(wallet, messageBoxClient, {
        id: raw.messageId,
        assetId: raw.body.assetId,
        amount: raw.body.amount,
        sender: raw.body.sender,
        senderMode: raw.body.senderMode,
        keyID: raw.body.keyID,
        protocolID: raw.body.protocolID,
        transaction: raw.body.transaction,
        // Senders now randomize output order and say where our output
        // landed; older messages predate the field (recipient was always 0).
        outputIndex: typeof raw.body.outputIndex === 'number' ? raw.body.outputIndex : 0,
        admission: raw.body.admission,
        ...(typeof raw.body.note === 'string' ? { note: raw.body.note } : {}),
        ...(isHandover
          ? {
              handover: {
                linkage: Array.isArray(raw.body.linkage) ? raw.body.linkage : [],
                admissions: Array.isArray(raw.body.admissions) ? raw.body.admissions : []
              }
            }
          : {})
      }, settle))
    } catch (error) {
      if (error instanceof InvalidTransferError) {
        // Poisoned message (body contradicts its transaction): acknowledge so
        // it never replays, report once. Retrying can't make it valid.
        try {
          await messageBoxClient.acknowledgeMessage({ messageIds: [raw.messageId] })
        } catch {
          processed?.delete(raw.messageId) // ack failed — let a later run drop it
        }
        failed.push({
          messageId: raw.messageId,
          error,
          ...(error.code != null ? { refusedCode: error.code } : {})
        })
        continue
      }
      // Transient (network/wallet) — one bad transfer shouldn't block the
      // rest; leave un-acknowledged for a later retry.
      processed?.delete(raw.messageId)
      failed.push({ messageId: raw.messageId, error })
    }
  }
  return { accepted, failed }
}
