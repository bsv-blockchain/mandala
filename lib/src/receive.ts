/**
 * MessageBox receive into BRC-207 receipts (C§7.1, C§7.2).
 *
 * A Mandala hand-over arrives on MESSAGEBOX as a v3 body: the AtomicBEEF tip,
 * the recipient output index and the BRC-207 receipt. The lib never credits
 * value itself: it checks the body strictly, checks that the named output
 * really is a 1-sat value output of the named asset, and hands the receipt
 * verbatim to the wallet's `internalizeAction` (`basket insertion` into
 * `p color <assetTag>`). The color module and the Mandala issuer-v1 profile
 * decide admission (online) or attested offline acceptance (D6/D7).
 *
 * Retry reasoning (stability mandate):
 * - Crash between internalize and acknowledge: the message replays on the next
 *   pass and the module's receipt path is idempotent (0207 A.83), so it is
 *   credited once and then acknowledged.
 * - Double-click / multi-call: a shared `processed` set is checked and marked
 *   synchronously (no await in between), so two concurrent passes in one
 *   session internalize a message once. Across tabs the replay above applies.
 * - Retryable verdicts and transport faults stay unacknowledged and leave
 *   `processed`, so a later pass retries them. Definitive refusals are
 *   acknowledged so a poisoned message cannot wedge the inbox.
 * - An unreadable body (a string that is not JSON) is never a definitive
 *   refusal. `@bsv/message-box-client` substitutes a sentinel string such as
 *   "[Error: Failed to decrypt or parse message]" when decryption fails
 *   transiently (wallet locked, prompt dismissed, HTTP fault). The sender has
 *   already counted the hand-over delivered and may have broadcast it, so
 *   acknowledging would delete the recipient's only receipt for an on-chain
 *   output. It is retried (`ERR_BODY_UNREADABLE`): only a body that parsed and
 *   was judged invalid on its contents is acknowledged. A message that can
 *   never be decrypted stays listed with that code for the host to surface.
 */
import { PublicKey, Transaction, Utils, WalletInterface } from '@bsv/sdk'
import { ATTESTED_PROFILE_ID, MANDALA_PROFILE_ID, MESSAGEBOX } from './constants.js'
import { assertRemittance, colorBasket } from './naming.js'
import { decodeToken } from './brc162.js'
import type { ReceiptInstruction } from './receipt.js'

/**
 * The hand-over body is malformed, or contradicts the transaction it carries.
 * Never retried: the message is acknowledged and dropped. The one exception is
 * `code === 'ERR_BODY_UNREADABLE'` (a string body that is not JSON, e.g. the
 * MessageBox decrypt-failure sentinel): nothing was judged, so it is retried.
 */
export class InvalidTransferError extends Error {
  /** Machine-readable reason, surfaced as `code` on the failed row. */
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

const MANDALA_ASSET_ID = /^[0-9a-f]{64}_0$/
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/
const MAX_UINT32 = 4294967295
const BODY_KEYS = new Set(['v', 'kind', 'assetId', 'outputIndex', 'tx', 'receipt', 'note'])
const RECEIPT_KEYS = ['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'profileData']
const DEFAULT_DESCRIPTION = 'Receive Mandala tokens'
/** The view selector that carries the module's `color_offline` state tag (stored tag AND not settled). */
const ASSETS_VIEW_BASKET = 'p color assets'
const OFFLINE_TAG = 'color_offline'
const LIST_LIMIT = 1000
/** InvalidTransferError code for a body that could not be read at all: retried, never acknowledged. */
const BODY_UNREADABLE = 'ERR_BODY_UNREADABLE'

function invalid (message: string, code?: string): never {
  throw new InvalidTransferError(`@bsv/mandala: invalid hand-over: ${message}`, code)
}

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v != null && !Array.isArray(v)
}

function checkKey (k: unknown): boolean {
  if (typeof k !== 'string' || !COMPRESSED_KEY.test(k)) return false
  try {
    // fromString reduces an x ≥ p modulo p, so the canonical round trip is
    // what rejects a non-field x; validate() rejects an off-curve point.
    const pk = PublicKey.fromString(k)
    return pk.validate() && pk.toString() === k
  } catch {
    return false
  }
}

function checkReceipt (r: unknown, assetId: string): ReceiptInstruction {
  if (!isPlainObject(r)) invalid('receipt is not an object')
  const keys = Object.keys(r)
  if (keys.length !== RECEIPT_KEYS.length || !RECEIPT_KEYS.every(k => Object.prototype.hasOwnProperty.call(r, k))) {
    invalid(`receipt members must be exactly ${RECEIPT_KEYS.join(', ')}`)
  }
  if (r.version !== 1) invalid('receipt version must be 1')
  if (r.assetId !== assetId) invalid('receipt assetId differs from the body assetId')
  try {
    assertRemittance(r.derivationPrefix as string, 'derivationPrefix')
    assertRemittance(r.derivationSuffix as string, 'derivationSuffix')
  } catch (e) {
    invalid(e instanceof Error ? e.message : String(e))
  }
  if (!checkKey(r.senderIdentityKey)) invalid('receipt senderIdentityKey is not a valid compressed public key')
  const pd = r.profileData
  if (!isPlainObject(pd)) invalid('receipt profileData is not an object')
  // D2: issuer-v1 defines no receipt leaf; a Mandala leaf is never valid.
  if (Object.prototype.hasOwnProperty.call(pd, MANDALA_PROFILE_ID)) invalid('receipt carries an issuer-v1 profile leaf')
  const attested = pd[ATTESTED_PROFILE_ID]
  if (!isPlainObject(attested) || !isPlainObject(attested[assetId])) invalid('receipt lacks the attested profile leaf for its asset')
  return r as unknown as ReceiptInstruction
}

/**
 * Strictly parse a MessageBox hand-over body (C§7.2). A JSON string body is
 * parsed first. The returned `receipt` is the body's own object (validated,
 * never rebuilt), so `JSON.stringify(receipt)` is what the sender sent.
 * Anything else throws InvalidTransferError; a string body that is not JSON
 * throws it with code `ERR_BODY_UNREADABLE` (retried by receive, not acked).
 */
export function parseHandoverBody (body: unknown): { assetId: string, outputIndex: number, tx: number[], receipt: ReceiptInstruction, note?: string } {
  let b: unknown = body
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b)
    } catch {
      invalid('body is not JSON (undecryptable or unreadable)', BODY_UNREADABLE)
    }
  }
  if (!isPlainObject(b)) invalid('body is not an object')
  for (const k of Object.keys(b)) if (!BODY_KEYS.has(k)) invalid(`unexpected member ${JSON.stringify(k)}`)
  for (const k of BODY_KEYS) if (k !== 'note' && !Object.prototype.hasOwnProperty.call(b, k)) invalid(`missing member ${k}`)
  if (b.v !== 3) invalid(`unsupported body version ${JSON.stringify(b.v)}`)
  if (b.kind !== 'handover') invalid(`unsupported body kind ${JSON.stringify(b.kind)}`)
  const assetId = b.assetId
  if (typeof assetId !== 'string' || !MANDALA_ASSET_ID.test(assetId)) invalid('assetId is not a Mandala asset id (<64 lowercase hex>_0)')
  const outputIndex = b.outputIndex
  if (typeof outputIndex !== 'number' || !Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex > MAX_UINT32) {
    invalid('outputIndex is not a uint32')
  }
  if (typeof b.tx !== 'string' || !EVEN_HEX.test(b.tx)) invalid('tx is not even-length lowercase hex')
  if (b.note !== undefined && typeof b.note !== 'string') invalid('note is not a string')
  const receipt = checkReceipt(b.receipt, assetId)
  return {
    assetId,
    outputIndex,
    tx: Utils.toArray(b.tx, 'hex'),
    receipt,
    ...(b.note !== undefined ? { note: b.note as string } : {})
  }
}

/**
 * Check that output `outputIndex` of the AtomicBEEF tip is a 1-sat value
 * output of `assetId`, and return the tip txid and the script amount.
 */
function checkOutput (tx: number[], outputIndex: number, assetId: string): { txid: string, amount: bigint } {
  let t: Transaction
  try {
    t = Transaction.fromAtomicBEEF(tx)
  } catch (e) {
    invalid(`tx is not AtomicBEEF: ${e instanceof Error ? e.message : String(e)}`)
  }
  const out = t.outputs[outputIndex]
  if (out == null) invalid(`outputIndex ${outputIndex} is out of range`)
  if (out.satoshis !== 1) invalid(`output ${outputIndex} carries ${String(out.satoshis)} satoshis, not 1`)
  const d = decodeToken(out.lockingScript)
  if (d == null || d.role !== 'value') invalid(`output ${outputIndex} is not a 1Color value output`)
  if (d.assetId !== assetId) invalid(`output ${outputIndex} is ${String(d.assetId)}, not ${assetId}`)
  return { txid: t.id('hex'), amount: d.amount }
}

const utf8Length = (s: string): number => Utils.toArray(s, 'utf8').length

/** The note as the action description when it fits BRC-100's 5..50 bytes, else the default. */
function describe (note: string | undefined): string {
  if (note == null) return DEFAULT_DESCRIPTION
  const n = utf8Length(note)
  return n >= 5 && n <= 50 ? note : DEFAULT_DESCRIPTION
}

/** Overlay verdict codes that never lift: acknowledge (C§7.2 "definitively refused"). */
const FINAL_CODES = new Set(['ERR_CONSERVATION', 'ERR_LINKAGE', 'ERR_SHAPE', 'ERR_SATOSHIS', 'ERR_INPUT_SPENT', 'ERR_EVICTED', 'ERR_AUTHORITY'])
const ACK_NAMES = ['InvalidTransferError', 'AttestationEvidenceError', 'ProfileDataError']
const DECLINED = 'ColorConsentDeclinedError'

type Disposition = 'ack' | 'declined' | 'retry'

/**
 * Classify an internalize (or parse) error. Names may not survive BRC-100
 * substrates, so per D22 / G13: `e.name`, then the `'[ClassName] '` message
 * marker, then the `(ERR_X[, retryable])` code. Exported for tests only.
 */
export function classifyReceiveError (e: unknown): { disposition: Disposition, code?: string } {
  const err = e as { name?: unknown, message?: unknown, code?: unknown, retryable?: unknown } | null | undefined
  const name = typeof err?.name === 'string' ? err.name : ''
  const message = typeof err?.message === 'string' ? err.message : String(e)
  const named = (n: string): boolean => name === n || message.includes(`[${n}] `)
  let code: string | undefined
  let retryable = false
  const m = /\((ERR_[A-Z0-9_]+)(, retryable)?\)/.exec(message)
  if (m != null) {
    code = m[1]
    retryable = m[2] != null
  } else if (typeof err?.code === 'string' && /^ERR_[A-Z0-9_]+$/.test(err.code)) {
    code = err.code
    retryable = err.retryable === true
  }
  if (named('InvalidTransferError')) {
    const c = typeof err?.code === 'string' ? err.code : code
    // Unreadable is not a verdict on the contents: never acknowledge it.
    if (c === BODY_UNREADABLE) return { disposition: 'retry', code: c }
    return { disposition: 'ack', ...(c != null ? { code: c } : {}) }
  }
  if (named(DECLINED)) return { disposition: 'declined', ...(code != null ? { code } : {}) }
  if (ACK_NAMES.some(named)) return { disposition: 'ack', ...(code != null ? { code } : {}) }
  if (code != null && !retryable && FINAL_CODES.has(code)) return { disposition: 'ack', code }
  return { disposition: 'retry', ...(code != null ? { code } : {}) }
}

/** The body's assetId for the optional filter, without validating anything else. */
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

/**
 * Outpoints among `want` that the `p color assets` view tags `color_offline`.
 * One logical read per receive pass; it pages only while some wanted outpoint
 * is still unseen and the page was full.
 */
async function offlineOutpoints (wallet: WalletInterface, want: Set<string>): Promise<Set<string>> {
  const offline = new Set<string>()
  const seen = new Set<string>()
  for (let offset = 0; ; offset += LIST_LIMIT) {
    const r = await wallet.listOutputs({
      basket: ASSETS_VIEW_BASKET,
      includeTags: true,
      include: 'locking scripts',
      limit: LIST_LIMIT,
      ...(offset > 0 ? { offset } : {})
    })
    const outputs = Array.isArray(r?.outputs) ? r.outputs : []
    for (const o of outputs) {
      if (!want.has(o.outpoint)) continue
      seen.add(o.outpoint)
      if (Array.isArray(o.tags) && o.tags.includes(OFFLINE_TAG)) offline.add(o.outpoint)
    }
    if (outputs.length < LIST_LIMIT || seen.size === want.size) break
  }
  return offline
}

export interface ReceiveResult {
  accepted: Array<{ messageId: string, txid: string, assetId: string, amount: bigint, outputIndex: number, offline: boolean }>
  failed: Array<{ messageId: string, error: unknown, code?: string }>
}

/**
 * Receive every pending Mandala hand-over on MESSAGEBOX into BRC-207
 * receipts. Per message: strict parse, output check, `internalizeAction`
 * with the receipt verbatim, then acknowledge.
 *
 * - Acknowledged: credited; InvalidTransferError; AttestationEvidenceError or
 *   ProfileDataError; a final overlay code (ERR_CONSERVATION, ERR_LINKAGE,
 *   ERR_SHAPE, ERR_SATOSHIS, ERR_INPUT_SPENT, ERR_EVICTED, ERR_AUTHORITY).
 * - ColorConsentDeclinedError: not acknowledged and the id stays in
 *   `processed`, so this session does not prompt again (G17).
 * - Everything else (retryable verdicts, transport, UnsupportedProfileError,
 *   ProfileParamsError, an unreadable body `ERR_BODY_UNREADABLE` such as the
 *   MessageBox decrypt-failure sentinel): not acknowledged and removed from
 *   `processed`.
 *
 * `offline` is read once per pass from the `p color assets` view (its
 * `color_offline` tag is the module's view tag: stored and not settled); a
 * direct `colorBasket` listing would report a settled output as offline.
 * `assetId` limits the pass to that asset; other messages are left untouched.
 */
export async function receiveHandovers (p: {
  wallet: WalletInterface
  messageBoxClient: MessageBoxLike
  assetId?: string
  processed?: Set<string>
}): Promise<ReceiveResult> {
  const { wallet, messageBoxClient, assetId, processed } = p
  const credited: Array<Omit<ReceiveResult['accepted'][number], 'offline'>> = []
  const failed: ReceiveResult['failed'] = []

  const listed = await messageBoxClient.listMessages({ messageBox: MESSAGEBOX, acceptPayments: false })
  const messages = Array.isArray(listed) ? listed as Array<{ messageId?: unknown, body?: unknown }> : []

  for (const raw of messages) {
    const messageId = raw?.messageId
    if (typeof messageId !== 'string' || messageId === '') continue
    if (assetId != null && peekAssetId(raw.body) !== assetId) continue
    // Check and mark with no await in between: concurrent passes sharing the set skip it.
    if (processed?.has(messageId) === true) continue
    processed?.add(messageId)

    let row: Omit<ReceiveResult['accepted'][number], 'offline'>
    try {
      const h = parseHandoverBody(raw.body)
      const { txid, amount } = checkOutput(h.tx, h.outputIndex, h.assetId)
      await wallet.internalizeAction({
        tx: h.tx,
        description: describe(h.note),
        labels: ['mandala', 'receive'],
        outputs: [{
          outputIndex: h.outputIndex,
          protocol: 'basket insertion',
          insertionRemittance: { basket: colorBasket(h.assetId), customInstructions: JSON.stringify(h.receipt) }
        }]
      })
      row = { messageId, txid, assetId: h.assetId, amount, outputIndex: h.outputIndex }
    } catch (error) {
      const c = classifyReceiveError(error)
      failed.push({ messageId, error, ...(c.code != null ? { code: c.code } : {}) })
      if (c.disposition === 'ack') {
        try {
          await messageBoxClient.acknowledgeMessage({ messageIds: [messageId] })
        } catch {
          processed?.delete(messageId) // a later pass drops it
        }
      } else if (c.disposition === 'retry') {
        processed?.delete(messageId)
      }
      // 'declined': stays in processed, not acknowledged (G17).
      continue
    }

    // Credited: an acknowledge failure is not a receive failure. The id is
    // freed so a later pass replays the (idempotent) internalize and acks.
    credited.push(row)
    try {
      await messageBoxClient.acknowledgeMessage({ messageIds: [messageId] })
    } catch (e) {
      processed?.delete(messageId)
      console.warn(`[mandala] credited hand-over ${row.txid} but the MessageBox acknowledge failed; a later receive re-acknowledges it:`, e)
    }
  }

  let offline = new Set<string>()
  if (credited.length > 0) {
    try {
      offline = await offlineOutpoints(wallet, new Set(credited.map(r => `${r.txid}.${r.outputIndex}`)))
    } catch (e) {
      console.warn('[mandala] could not read the p color assets view; offline state of received hand-overs is unknown:', e)
    }
  }
  return {
    accepted: credited.map(r => ({ ...r, offline: offline.has(`${r.txid}.${r.outputIndex}`) })),
    failed
  }
}
