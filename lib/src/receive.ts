/**
 * MessageBox receive of Mandala hand-overs (design §9 B7): the recipient host
 * verifies the issuer evidence itself, then internalizes a plain BRC-207
 * receipt.
 *
 * Per message (v4 body, see notifyJournal.ts `HandoverBodyV4`):
 *   1. strict parse; the named output must be a 1-sat value output of the
 *      named asset whose script amount equals the body amount;
 *   2. ONLINE: submit the unadmitted chain (parents first, tip last) to the
 *      Mandala overlay with each transaction's envelope as offChainValues;
 *      every answer's σ is verified under this host's configured K, and the
 *      tip's σ must cover the received output. Record "verified-admitted"
 *      (`settled`) in the host ledger, then `internalizeAction`;
 *   3. OFFLINE (transport failure only; a typed verdict never falls back):
 *      a verified σ of the tip covering the output is enough (`settled`).
 *      Otherwise COVER over `admissions[]` with the S1 hop checks
 *      (bundle.ts): record "verified-offline" (`pending`, with the exact
 *      submit chain) in the host ledger, then `internalizeAction` (the
 *      issuer-v1 handler credits it `color_offline`). `settleReceipts`
 *      submits it later and calls the host's `markSettled`;
 *   4. acknowledge.
 *
 * The ledger is the host's (never an app's): the issuer-v1 handler credits
 * exactly what it records. Without a ledger (an app over BRC-100) only the
 * online path exists, and the wallet's handler re-submits (replay) itself.
 *
 * Retry reasoning (stability mandate):
 * - Crash between ledger write and internalize, or between internalize and
 *   acknowledge: the message replays; submits and the ledger merge are
 *   idempotent, internalize is idempotent (0207 A.83).
 * - A pending record later re-received online is upgraded to `settled` and the
 *   host's `markSettled` runs after the (idempotent) internalize.
 * - Double-click / multi-call: a shared `processed` set is checked and marked
 *   synchronously; the `mandala.receive` web lock keeps two tabs apart.
 * - Retryable verdicts, transport faults and an offline graph COVER cannot
 *   prove yet stay unacknowledged for a later pass. Definitive refusals
 *   (malformed body, contradicting script, final verdict, failed hop check)
 *   are acknowledged so a poisoned message cannot wedge the inbox.
 * - An unreadable body (a string that is not JSON, e.g. the MessageBox
 *   decrypt-failure sentinel) is never acknowledged automatically: it is
 *   retried up to UNREADABLE_BUDGET passes, then skipped and reported with
 *   `exhausted: true` until the host calls `dismissHandover` (deferred-lib
 *   item 4: a hostile sender cannot make every pass re-prompt forever).
 */
import { PublicKey, Transaction, Utils, WalletInterface } from '@bsv/sdk'
import { MESSAGEBOX, OVERLAY_IDENTITY_KEY, OVERLAY_IDENTITY_KEY_UNSET } from './constants.js'
import { assertRemittance, colorBasket, colorTopic } from './naming.js'
import { decodeToken } from './brc162.js'
import { verifyAttestation, type Attestation } from './attestation.js'
import { cover } from './bundle.js'
import { OverlayRefusedError, submitToOverlay } from './overlay.js'
import type { HostLedger, LedgerRecord, LedgerSubmit } from './hostLedger.js'
import type { HandoverBodyV4 } from './notifyJournal.js'
import { receiptOfBody } from './notifyJournal.js'
import type { ReceiptInstruction } from './receipt.js'
import { getStorage } from './storage.js'
import { tryWithLock } from './webLocks.js'

/**
 * The hand-over body is malformed, contradicts its transaction, or its
 * evidence was refused. Acknowledged and dropped, except `code ===
 * ERR_BODY_UNREADABLE` (nothing was judged) and `ERR_NOT_COVERED` (offline,
 * the evidence does not reach σ yet; the overlay may still admit it online).
 */
export class InvalidTransferError extends Error {
  readonly code?: string
  constructor (message: string, code?: string) {
    super(message)
    this.name = 'InvalidTransferError'
    if (code != null) this.code = code
  }
}

/** The MessageBox slice receive needs (structural; `MessageBoxClient` fits). */
export interface MessageBoxLike {
  listMessages: (a: { messageBox: string, acceptPayments?: boolean }) => Promise<unknown>
  acknowledgeMessage: (a: { messageIds: string[] }) => Promise<unknown>
}

/** InvalidTransferError code for a body that could not be read at all: retried within a budget, never auto-acknowledged. */
export const ERR_BODY_UNREADABLE = 'ERR_BODY_UNREADABLE'
/** Offline and COVER cannot reach σ: kept for a later (online) pass, not acknowledged. */
export const ERR_NOT_COVERED = 'ERR_NOT_COVERED'
/** Passes an unreadable message is retried before it is skipped (until `dismissHandover`). */
export const UNREADABLE_BUDGET = 10

const MANDALA_ASSET_ID = /^[0-9a-f]{64}_0$/
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/
const TXID = /^[0-9a-f]{64}$/
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_UINT32 = 4294967295
const MAX_UINT64 = (1n << 64n) - 1n
const MAX_EVIDENCE_ROWS = 1000
const BODY_KEYS = new Set([
  'v', 'kind', 'assetId', 'amount', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'senderMode',
  'transaction', 'outputIndex', 'admission', 'admissions', 'linkage', 'note'
])
const OPTIONAL_KEYS = new Set(['admission', 'note'])
const ATTESTATION_KEYS = ['txid', 'outputs', 'signer', 'signature']
const DEFAULT_DESCRIPTION = 'Receive Mandala tokens'
const UNREADABLE_PREFIX = 'mandala.inbox.unreadable.'

function invalid (message: string, code?: string): never {
  throw new InvalidTransferError(`@bsv/mandala: invalid hand-over: ${message}`, code)
}

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v != null && !Array.isArray(v)
}

function checkKey (k: unknown): boolean {
  if (typeof k !== 'string' || !COMPRESSED_KEY.test(k)) return false
  try {
    const pk = PublicKey.fromString(k)
    return pk.validate() && pk.toString() === k
  } catch {
    return false
  }
}

function readAttestation (v: unknown, what: string): Attestation {
  if (!isPlainObject(v)) invalid(`${what} is not an object`)
  const keys = Object.keys(v)
  if (keys.length !== ATTESTATION_KEYS.length || !ATTESTATION_KEYS.every(k => Object.prototype.hasOwnProperty.call(v, k))) {
    invalid(`${what} members must be exactly ${ATTESTATION_KEYS.join(', ')}`)
  }
  if (typeof v.txid !== 'string' || !TXID.test(v.txid)) invalid(`${what}.txid is not a txid`)
  if (!Array.isArray(v.outputs) || v.outputs.length === 0 || v.outputs.some(o => !Number.isInteger(o) || o < 0 || o > MAX_UINT32)) {
    invalid(`${what}.outputs is not a non-empty uint32 list`)
  }
  if (typeof v.signer !== 'string' || !COMPRESSED_KEY.test(v.signer)) invalid(`${what}.signer is not a key`)
  if (typeof v.signature !== 'string' || !EVEN_HEX.test(v.signature)) invalid(`${what}.signature is not hex`)
  return { txid: v.txid, outputs: [...(v.outputs as number[])], signer: v.signer, signature: v.signature }
}

export interface ParsedHandover {
  assetId: string
  amount: bigint
  outputIndex: number
  /** AtomicBEEF of the tip. */
  tx: number[]
  receipt: ReceiptInstruction
  senderMode: 'blinded' | 'identity'
  admission?: Attestation
  admissions: Attestation[]
  /** Envelope per unadmitted txid. */
  linkage: Map<string, number[]>
  note?: string
}

/**
 * Strictly parse a v4 MessageBox hand-over body (a JSON string body is parsed
 * first). Throws InvalidTransferError; a string that is not JSON throws it
 * with code ERR_BODY_UNREADABLE (retried, not acknowledged).
 */
export function parseHandoverBody (body: unknown): ParsedHandover {
  let b: unknown = body
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b)
    } catch {
      invalid('body is not JSON (undecryptable or unreadable)', ERR_BODY_UNREADABLE)
    }
  }
  if (!isPlainObject(b)) invalid('body is not an object')
  for (const k of Object.keys(b)) if (!BODY_KEYS.has(k)) invalid(`unexpected member ${JSON.stringify(k)}`)
  for (const k of BODY_KEYS) if (!OPTIONAL_KEYS.has(k) && !Object.prototype.hasOwnProperty.call(b, k)) invalid(`missing member ${k}`)
  if (b.v !== 4) invalid(`unsupported body version ${JSON.stringify(b.v)}`)
  if (b.kind !== 'handover') invalid(`unsupported body kind ${JSON.stringify(b.kind)}`)
  const assetId = b.assetId
  if (typeof assetId !== 'string' || !MANDALA_ASSET_ID.test(assetId)) invalid('assetId is not a Mandala asset id (<64 lowercase hex>_0)')
  if (typeof b.amount !== 'string' || !DECIMAL.test(b.amount)) invalid('amount is not a canonical decimal string')
  const amount = BigInt(b.amount)
  if (amount < 1n || amount > MAX_UINT64) invalid('amount is outside 1..2^64-1')
  try {
    assertRemittance(b.derivationPrefix as string, 'derivationPrefix')
    assertRemittance(b.derivationSuffix as string, 'derivationSuffix')
  } catch (e) {
    invalid(e instanceof Error ? e.message : String(e))
  }
  if (!checkKey(b.senderIdentityKey)) invalid('senderIdentityKey is not a valid compressed public key')
  if (b.senderMode !== 'blinded' && b.senderMode !== 'identity') invalid('senderMode must be blinded or identity')
  if (typeof b.transaction !== 'string' || !EVEN_HEX.test(b.transaction)) invalid('transaction is not even-length lowercase hex')
  const outputIndex = b.outputIndex
  if (typeof outputIndex !== 'number' || !Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex > MAX_UINT32) {
    invalid('outputIndex is not a uint32')
  }
  if (b.note !== undefined && typeof b.note !== 'string') invalid('note is not a string')
  const admission = b.admission !== undefined ? readAttestation(b.admission, 'admission') : undefined
  if (!Array.isArray(b.admissions) || b.admissions.length > MAX_EVIDENCE_ROWS) invalid('admissions is not a list')
  const admissions = (b.admissions as unknown[]).map((a, i) => readAttestation(a, `admissions[${i}]`))
  if (!Array.isArray(b.linkage) || b.linkage.length > MAX_EVIDENCE_ROWS) invalid('linkage is not a list')
  const linkage = new Map<string, number[]>()
  for (const [i, l] of (b.linkage as unknown[]).entries()) {
    if (!isPlainObject(l) || Object.keys(l).length !== 2 || typeof l.txid !== 'string' || !TXID.test(l.txid) ||
      typeof l.offChainValues !== 'string' || !EVEN_HEX.test(l.offChainValues)) {
      invalid(`linkage[${i}] must be exactly {txid, offChainValues: hex}`)
    }
    if (linkage.has(l.txid as string)) invalid(`linkage names ${l.txid as string} twice`)
    linkage.set(l.txid as string, Utils.toArray(l.offChainValues as string, 'hex'))
  }
  const v4 = b as unknown as HandoverBodyV4
  return {
    assetId,
    amount,
    outputIndex,
    tx: Utils.toArray(b.transaction, 'hex'),
    receipt: receiptOfBody(v4),
    senderMode: b.senderMode,
    ...(admission != null ? { admission } : {}),
    admissions,
    linkage,
    ...(b.note !== undefined ? { note: b.note as string } : {})
  }
}

/** The tip and its txid; the named output must match the body exactly. */
function checkOutput (h: ParsedHandover): { tip: Transaction, txid: string } {
  let tip: Transaction
  try {
    tip = Transaction.fromAtomicBEEF(h.tx)
  } catch (e) {
    invalid(`transaction is not AtomicBEEF: ${e instanceof Error ? e.message : String(e)}`)
  }
  const out = tip.outputs[h.outputIndex]
  if (out == null) invalid(`outputIndex ${h.outputIndex} is out of range`)
  if (out.satoshis !== 1) invalid(`output ${h.outputIndex} carries ${String(out.satoshis)} satoshis, not 1`)
  const d = decodeToken(out.lockingScript)
  if (d == null || d.role !== 'value') invalid(`output ${h.outputIndex} is not a 1Color value output`)
  if (d.assetId !== h.assetId) invalid(`output ${h.outputIndex} is ${String(d.assetId)}, not ${h.assetId}`)
  if (d.amount !== h.amount) invalid(`amount mismatch: body says ${h.amount}, output is ${d.amount}`)
  return { tip, txid: tip.id('hex') }
}

const utf8Length = (s: string): number => Utils.toArray(s, 'utf8').length

function describe (note: string | undefined): string {
  if (note == null) return DEFAULT_DESCRIPTION
  const n = utf8Length(note)
  return n >= 5 && n <= 50 ? note : DEFAULT_DESCRIPTION
}

/** A transport failure: no typed overlay verdict (network fault, timeout, 5xx). Only this may fall back offline. */
export function isTransportFailure (e: unknown): boolean {
  const err = e as { name?: unknown, code?: unknown, httpStatus?: unknown } | null
  if (err == null || typeof err !== 'object') return false
  if (!(e instanceof OverlayRefusedError) && err.name !== 'OverlayRefusedError') return false
  const status = typeof err.httpStatus === 'number' ? err.httpStatus : 0
  return err.code === 'ERR_UNAVAILABLE' && (status === 0 || status >= 500)
}

/** Every transaction of the tip's AtomicBEEF tree, by txid (bytes always hash to the key). */
function txTree (tip: Transaction): Map<string, Transaction> {
  const out = new Map<string, Transaction>()
  const stack = [tip]
  while (stack.length > 0) {
    const tx = stack.pop() as Transaction
    const id = tx.id('hex')
    if (out.has(id)) continue
    out.set(id, tx)
    for (const input of tx.inputs) if (input.sourceTransaction != null) stack.push(input.sourceTransaction)
  }
  return out
}

/** Linkage-bearing ancestors of the tip in topological order (parents first), then the tip. */
function onlineOrder (tip: Transaction, tipTxid: string, linkage: Map<string, number[]>): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const visit = (tx: Transaction): void => {
    const id = tx.id('hex')
    if (seen.has(id)) return
    seen.add(id)
    for (const input of tx.inputs) if (input.sourceTransaction != null) visit(input.sourceTransaction)
    if (id !== tipTxid && linkage.has(id)) order.push(id)
  }
  visit(tip)
  order.push(tipTxid)
  return order
}

export interface AcceptOptions {
  wallet: WalletInterface
  /** The host ledger; absent ⇒ online-only (an app over BRC-100). */
  ledger?: HostLedger
  /** Host-only `color.markSettled(txid)`. */
  markSettled?: (txid: string) => Promise<void>
  /** The overlay key σ must verify under; default the configured OVERLAY_IDENTITY_KEY. */
  overlayIdentityKey?: string
}

export interface AcceptedHandover {
  txid: string
  assetId: string
  amount: bigint
  outputIndex: number
  /** True when credited on COVER evidence (pending settlement). */
  offline: boolean
}

/**
 * Verify, record and internalize one parsed hand-over (steps 1-3 above).
 * Throws InvalidTransferError (definitive unless ERR_NOT_COVERED), an
 * OverlayRefusedError (a typed verdict), or any wallet/storage error.
 */
export async function acceptHandover (h: ParsedHandover, o: AcceptOptions): Promise<AcceptedHandover> {
  const K = o.overlayIdentityKey ?? OVERLAY_IDENTITY_KEY
  if (typeof K !== 'string' || !COMPRESSED_KEY.test(K)) throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  const { tip, txid } = checkOutput(h)
  const topic = colorTopic(h.assetId)
  const covers = (a: Attestation | undefined): a is Attestation =>
    a != null && a.txid === txid && a.outputs.includes(h.outputIndex) && verifyAttestation(a, h.assetId, K)
  const tipEvidence = [h.admission, ...h.admissions.filter(a => a.txid === txid)].find(a => covers(a))

  const prev = o.ledger != null ? await o.ledger.get(txid) : undefined
  if (prev != null && prev.assetId !== h.assetId) invalid(`the host already holds ${txid} for another asset`)
  if (prev?.state === 'refused') invalid(`the overlay already refused ${txid} for good (${prev.code ?? 'final'})`, prev.code)

  const beefHex = Utils.toHex(h.tx)
  let record: LedgerRecord
  try {
    // ONLINE: submit the chain, tip last; every σ verified under K by submitToOverlay.
    const tree = txTree(tip)
    let tipAttestation: Attestation | undefined
    for (const id of onlineOrder(tip, txid, h.linkage)) {
      const tx = tree.get(id) as Transaction
      const envelope = h.linkage.get(id)
      const admitted = await submitToOverlay(tx.toAtomicBEEF(), envelope != null && envelope.length > 0 ? envelope : undefined, undefined, [topic], K)
      if (id === txid) tipAttestation = admitted.attestation
    }
    if (!covers(tipAttestation)) {
      invalid(`the overlay admitted ${txid} without output ${h.outputIndex}`, 'ERR_NOT_ADMITTED')
    }
    record = { v: 1, txid, assetId: h.assetId, state: 'settled', outputs: [h.outputIndex], attestation: tipAttestation, beefHex, at: Date.now() }
  } catch (e) {
    if (!isTransportFailure(e)) throw e // a typed verdict never falls back offline
    // OFFLINE.
    if (tipEvidence != null) {
      record = { v: 1, txid, assetId: h.assetId, state: 'settled', outputs: [h.outputIndex], attestation: tipEvidence, beefHex, at: Date.now() }
    } else {
      if (o.ledger == null) throw e // an app without the host ledger cannot credit offline: retry later
      const admissions = new Map<string, Attestation>()
      for (const a of [...(h.admission != null ? [h.admission] : []), ...h.admissions]) if (!admissions.has(a.txid)) admissions.set(a.txid, a)
      const result = cover({ assetId: h.assetId, tip, admissions, linkage: h.linkage }, { expectedSignerKey: K })
      if (!result.ok) {
        const detail = `${result.reason}${result.detail != null ? `: ${result.detail}` : ''}`
        if (result.reason === 'uncovered_ancestor') invalid(`offline, and the evidence does not reach σ (${detail})`, ERR_NOT_COVERED)
        if (result.reason === 'unsafe_asset') throw new Error(`@bsv/mandala: cannot verify offline (${detail})`)
        invalid(`the hand-over evidence is refused (${detail})`, 'ERR_EVIDENCE')
      }
      const submits: LedgerSubmit[] = result.mustSubmit.map(id => ({
        txid: id,
        beefHex: Utils.toHex((result.txs.get(id) as Transaction).toAtomicBEEF()),
        offChainHex: Utils.toHex(h.linkage.get(id) as number[])
      }))
      // Keep the verified ancestor σ so an onward hand-over of this coin can forward it.
      const evidence = [...admissions.values()].filter(a => verifyAttestation(a, h.assetId, K))
      record = { v: 1, txid, assetId: h.assetId, state: 'pending', outputs: [h.outputIndex], submits, beefHex, evidence, at: Date.now() }
    }
  }

  // Verified first, recorded second, credited third: the handler credits
  // exactly what the ledger holds. A failed ledger write throws (no credit).
  const upgraded = prev?.state === 'pending' && record.state === 'settled'
  if (o.ledger != null) {
    if (upgraded) record.marked = false
    record = await o.ledger.put(record)
  }
  try {
    await o.wallet.internalizeAction({
      tx: h.tx,
      description: describe(h.note),
      labels: ['mandala', 'receive'],
      outputs: [{
        outputIndex: h.outputIndex,
        protocol: 'basket insertion',
        insertionRemittance: { basket: colorBasket(h.assetId), customInstructions: JSON.stringify(h.receipt) }
      }]
    })
  } catch (e) {
    // An earlier attempt internalized and crashed before acknowledging.
    if (!/already|duplicate|exists/i.test(String((e as Error)?.message ?? e))) throw e
  }
  // A coin first credited offline is now settled: clear color_offline.
  if (o.ledger != null && record.state === 'settled' && record.marked === false && o.markSettled != null) {
    try {
      await o.markSettled(txid)
      await o.ledger.put({ ...record, marked: true, at: Date.now() })
    } catch (e) {
      console.warn(`[mandala] ${txid} is settled but markSettled failed; settleReceipts retries it:`, e)
    }
  }
  return { txid, assetId: h.assetId, amount: h.amount, outputIndex: h.outputIndex, offline: record.state === 'pending' }
}

/** Overlay verdict codes that never lift: acknowledge. */
const FINAL_CODES = new Set(['ERR_CONSERVATION', 'ERR_LINKAGE', 'ERR_SHAPE', 'ERR_SATOSHIS', 'ERR_INPUT_SPENT', 'ERR_EVICTED', 'ERR_AUTHORITY'])
const ACK_NAMES = ['InvalidTransferError', 'ProfileDataError']
const DECLINED = 'ColorConsentDeclinedError'
const RETRY_CODES = new Set([ERR_BODY_UNREADABLE, ERR_NOT_COVERED])

type Disposition = 'ack' | 'declined' | 'retry'

/**
 * Classify a receive error. Names may not survive BRC-100 substrates, so:
 * `e.name`, then the `'[ClassName] '` message marker, then the
 * `(ERR_X[, retryable])` code. Exported for tests only.
 */
export function classifyReceiveError (e: unknown): { disposition: Disposition, code?: string } {
  const err = e as { name?: unknown, message?: unknown, code?: unknown, retryable?: unknown } | null | undefined
  const name = typeof err?.name === 'string' ? err.name : ''
  const message = typeof err?.message === 'string' ? err.message : String(e)
  const named = (n: string): boolean => name === n || message.includes(`[${n}] `)
  let code: string | undefined
  let retryable = false
  if (typeof err?.code === 'string' && /^ERR_[A-Z0-9_]+$/.test(err.code)) {
    code = err.code
    retryable = err.retryable === true
  } else {
    const m = /\((ERR_[A-Z0-9_]+)(, retryable)?\)/.exec(message)
    if (m != null) {
      code = m[1]
      retryable = m[2] != null
    }
  }
  if (named('InvalidTransferError')) {
    if (code != null && RETRY_CODES.has(code)) return { disposition: 'retry', code }
    return { disposition: 'ack', ...(code != null ? { code } : {}) }
  }
  if (named(DECLINED)) return { disposition: 'declined', ...(code != null ? { code } : {}) }
  if (ACK_NAMES.some(named)) return { disposition: 'ack', ...(code != null ? { code } : {}) }
  if (code != null && !retryable && FINAL_CODES.has(code)) return { disposition: 'ack', code }
  return { disposition: 'retry', ...(code != null ? { code } : {}) }
}

function peekAssetId (body: unknown): unknown {
  if (typeof body === 'string') {
    try {
      return (JSON.parse(body) as { assetId?: unknown })?.assetId
    } catch {
      return undefined
    }
  }
  return isPlainObject(body) ? body.assetId : undefined
}

async function unreadableAttempts (messageId: string): Promise<number> {
  try {
    const raw = await getStorage().getItem(UNREADABLE_PREFIX + messageId)
    const n = raw == null ? 0 : Number(JSON.parse(raw)?.attempts)
    return Number.isInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

async function bumpUnreadable (messageId: string, attempts: number): Promise<void> {
  try {
    await getStorage().setItem(UNREADABLE_PREFIX + messageId, JSON.stringify({ attempts, at: Date.now() }))
  } catch { /* the budget is best effort; a failed write only means another retry */ }
}

/**
 * Acknowledge (drop) a message the host decided to give up on, typically one
 * reported `exhausted` (unreadable past its budget). Clears its budget entry.
 */
export async function dismissHandover (p: { messageBoxClient: MessageBoxLike, messageId: string }): Promise<void> {
  await p.messageBoxClient.acknowledgeMessage({ messageIds: [p.messageId] })
  try { await getStorage().removeItem(UNREADABLE_PREFIX + p.messageId) } catch { /* best effort */ }
}

export interface ReceiveResult {
  accepted: Array<{ messageId: string } & AcceptedHandover>
  failed: Array<{ messageId: string, error: unknown, code?: string, exhausted?: true }>
}

export interface ReceiveParams {
  wallet: WalletInterface
  messageBoxClient: MessageBoxLike
  assetId?: string
  processed?: Set<string>
  ledger?: HostLedger
  markSettled?: (txid: string) => Promise<void>
}

/**
 * Receive every pending Mandala hand-over on MESSAGEBOX (see module doc).
 * `assetId` limits the pass to that asset. A concurrent pass in another tab
 * returns an empty result (the `mandala.receive` lock).
 */
export async function receiveHandovers (p: ReceiveParams): Promise<ReceiveResult> {
  const { acquired, result } = await tryWithLock('mandala.receive', async () => await receivePass(p))
  return acquired && result != null ? result : { accepted: [], failed: [] }
}

async function receivePass (p: ReceiveParams): Promise<ReceiveResult> {
  const { wallet, messageBoxClient, assetId, processed } = p
  const accepted: ReceiveResult['accepted'] = []
  const failed: ReceiveResult['failed'] = []

  const listed = await messageBoxClient.listMessages({ messageBox: MESSAGEBOX, acceptPayments: false })
  const messages = Array.isArray(listed) ? listed as Array<{ messageId?: unknown, body?: unknown }> : []

  for (const raw of messages) {
    const messageId = raw?.messageId
    if (typeof messageId !== 'string' || messageId === '') continue
    if (assetId != null && peekAssetId(raw.body) !== assetId) continue
    if (processed?.has(messageId) === true) continue
    processed?.add(messageId)

    const budgetUsed = typeof raw.body === 'string' ? await unreadableAttempts(messageId) : 0
    if (budgetUsed >= UNREADABLE_BUDGET) {
      processed?.delete(messageId)
      failed.push({
        messageId,
        error: new InvalidTransferError('@bsv/mandala: hand-over body unreadable past its retry budget', ERR_BODY_UNREADABLE),
        code: ERR_BODY_UNREADABLE,
        exhausted: true
      })
      continue
    }

    let row: AcceptedHandover
    try {
      const h = parseHandoverBody(raw.body)
      row = await acceptHandover(h, {
        wallet,
        ...(p.ledger != null ? { ledger: p.ledger } : {}),
        ...(p.markSettled != null ? { markSettled: p.markSettled } : {})
      })
    } catch (error) {
      const c = classifyReceiveError(error)
      failed.push({ messageId, error, ...(c.code != null ? { code: c.code } : {}) })
      if (c.code === ERR_BODY_UNREADABLE) await bumpUnreadable(messageId, budgetUsed + 1)
      if (c.disposition === 'ack') {
        try {
          await messageBoxClient.acknowledgeMessage({ messageIds: [messageId] })
        } catch {
          processed?.delete(messageId)
        }
      } else if (c.disposition === 'retry') {
        processed?.delete(messageId)
      }
      continue
    }

    accepted.push({ messageId, ...row })
    try {
      await messageBoxClient.acknowledgeMessage({ messageIds: [messageId] })
    } catch (e) {
      processed?.delete(messageId)
      console.warn(`[mandala] credited hand-over ${row.txid} but the MessageBox acknowledge failed; a later receive re-acknowledges it:`, e)
    }
  }
  return { accepted, failed }
}
