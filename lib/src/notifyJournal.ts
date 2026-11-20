/**
 * Journal of recipient notifications that must survive a crash.
 *
 * A transfer's tx is committed at overlay-accept, but the recipient only
 * learns about it via a MessageBox message. If the app dies (or the send
 * fails) between commit and sendMessage, the recipient owns an on-chain
 * output they will never internalize. So: journal the notification BEFORE
 * attempting it, clear on success, and retry pending ones from
 * reconcileNotifications. Duplicate delivery is safe — the receive pipeline
 * acknowledges by messageId and treats an already-internalized output as
 * success.
 *
 * Same per-entry layout as txJournal, through the same injected storage
 * adapter (storage.ts): atomic per key, async, no memory mirror.
 *
 * Holder hand-overs (Task 15): a `mandala-color` resend whose txid has a
 * 'signed' txJournal entry promotes it to 'delivered' (the recipient now has
 * the receipt, so the sender may submit). A 'signed' entry older than
 * REDELIVER_AFTER_MS with no pending notification (a crash between sign and
 * deliver) is redelivered with its body rebuilt from the journal.
 *
 * A self-send (receipt sender = recipient) owes no delivery: a 'signed'
 * self entry is promoted to 'delivered' without a send.
 *
 * Issuer receipt intents (plan 04 R6): a payout or reissue journals a
 * `pending: true` entry with its receipt inputs BEFORE its submit (a throwing
 * write, `notifyPutIntent`); it is removed when the submit fails and
 * replaced by the final body after admission. A pending entry is never sent
 * as is. A pass completes one left behind by a crash (issuerIntent.ts
 * `resolveIssuerIntent`): rebuilt from the 'accepted' entry's σ, or after
 * INTENT_TTL_MS only once a color-admission lookup shows the output admitted;
 * dropped when the lookup shows it absent.
 *
 * This module imports txJournal, constants and issuerIntent (plus a type from
 * receipt.ts): receipt.ts and handover.ts import it, so it must not import
 * them back. That is why `handoverBody` lives here.
 */
import { Transaction, Utils } from '@bsv/sdk'
import { getStorage } from './storage.js'
import { MESSAGEBOX, OVERLAY_IDENTITY_KEY, OVERLAY_URL } from './constants.js'
import { journalListHandovers, journalPromoteSigned, type HandoverJournalEntry } from './txJournal.js'
import { tryWithLock } from './webLocks.js'
import { isIssuerReceiptIntent, resolveIssuerIntent, type IssuerReceiptIntent } from './issuerIntent.js'
import type { ReceiptInstruction } from './receipt.js'
import type { Attestation } from './attestation.js'

/** A notification ready to send. */
export interface PendingNotification {
  /** The committed txid — one notification per transfer. */
  txid: string
  recipient: string
  messageBox: string
  body: object
  attempts?: number
  at: number
  pending?: undefined
}

/**
 * An issuer receipt intent (R6): journaled before the submit, never sent as
 * is. `recipient`/`messageBox` say where its completed body will go.
 */
export interface PendingReceiptIntent {
  txid: string
  recipient: string
  messageBox: string
  pending: true
  intent: IssuerReceiptIntent
  attempts?: number
  at: number
}

/** Every entry of the notification journal. */
export type NotifyJournalEntry = PendingNotification | PendingReceiptIntent

const PREFIX = 'mandala.notifyJournal.'

/** Every journaled notification and receipt intent, oldest first. */
export async function notifyList (): Promise<NotifyJournalEntry[]> {
  const store = getStorage()
  const byId = new Map<string, NotifyJournalEntry>()
  for (const key of await store.keys(PREFIX)) {
    try {
      const raw = await store.getItem(key)
      if (raw == null) continue // removed between keys() and getItem
      const entry = JSON.parse(raw) as NotifyJournalEntry
      if (typeof entry?.txid === 'string') byId.set(entry.txid, entry)
    } catch { /* one corrupted entry — skip it, keep the rest */ }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at)
}

/**
 * Journal a notification. Await it BEFORE the sendMessage it protects — that
 * ordering is the whole point of the journal. A store failure is warned, not
 * thrown: the transaction it belongs to is already committed.
 */
export async function notifyPut (entry: PendingNotification): Promise<void> {
  try {
    await getStorage().setItem(PREFIX + entry.txid, JSON.stringify(entry))
  } catch (e) {
    console.warn(`[mandala] notifyJournal write failed for ${entry.txid}; the retry is not durable:`, e)
  }
}

/**
 * Journal an issuer receipt intent for `txid` BEFORE its submit (R6). Throws
 * when the write fails or does not read back: the caller must then release
 * its action and fail before the submit, because without this entry a crash
 * after admission would strand the recipient's output.
 */
export async function notifyPutIntent (txid: string, intent: IssuerReceiptIntent): Promise<void> {
  const entry: PendingReceiptIntent = { txid, recipient: intent.recipientKey, messageBox: MESSAGEBOX, pending: true, intent, at: Date.now() }
  const store = getStorage()
  await store.setItem(PREFIX + txid, JSON.stringify(entry))
  const back = await store.getItem(PREFIX + txid)
  if (back == null || (JSON.parse(back) as { pending?: unknown })?.pending !== true) {
    throw new Error(`@bsv/mandala: the receipt intent for ${txid} was not stored; nothing was submitted`)
  }
}

export async function notifyRemove (txid: string): Promise<void> {
  try {
    await getStorage().removeItem(PREFIX + txid)
  } catch (e) {
    console.warn(`[mandala] notifyJournal remove failed for ${txid}; it will be retried (delivery is idempotent):`, e)
  }
}

/** Test helper. */
export async function notifyClear (): Promise<void> {
  const store = getStorage()
  for (const key of await store.keys(PREFIX)) await store.removeItem(key)
}

interface Sender {
  sendMessage: (args: { recipient: string, messageBox: string, body: object }) => Promise<unknown>
}

/** One σ row on the hand-over wire: the BRC-207 JSON attestation shape (txid, outputs, signer, signature). */
export type WireAdmission = Attestation

/** One envelope row on the hand-over wire: the off-chain values a txid is submitted with, lowercase hex. */
export interface WireLinkage { txid: string, offChainValues: string }

/**
 * The MessageBox hand-over body v4 (design §9 B7): the 0.4.1 body adapted to
 * 1Color. The recipient's receipt customInstructions are derived from it
 * (`receiptOfBody`); the evidence (`admission`, `admissions`, `linkage`) is
 * checked by the recipient host's lib and never travels in customInstructions.
 */
export interface HandoverBodyV4 {
  v: 4
  kind: 'handover'
  assetId: string
  /** Canonical decimal string; the recipient checks it against the script. */
  amount: string
  derivationPrefix: string
  derivationSuffix: string
  /** A, or A′ when blinded: the BRC-42 counterparty the recipient derives with. */
  senderIdentityKey: string
  senderMode: 'blinded' | 'identity'
  /** AtomicBEEF of the tip (every unconfirmed ancestor inside), lowercase hex. */
  transaction: string
  outputIndex: number
  /** σ of the tip itself, when the sender already holds it (issuer payouts and reissues). */
  admission?: WireAdmission
  /** σ per admitted ancestor; terminates the recipient's COVER walk. */
  admissions: WireAdmission[]
  /** Envelope per unadmitted transaction in the chain, the tip included. */
  linkage: WireLinkage[]
  note?: string
}

/** Build a v4 hand-over body. */
export function handoverBody (p: {
  assetId: string
  amount: bigint
  outputIndex: number
  /** AtomicBEEF of the tip. */
  tx: number[]
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
  senderMode: 'blinded' | 'identity'
  admission?: Attestation
  admissions?: Attestation[]
  linkage?: Array<{ txid: string, offChainValues: number[] }>
  note?: string
}): HandoverBodyV4 {
  const att = (a: Attestation): WireAdmission => ({ txid: a.txid, outputs: [...a.outputs], signer: a.signer, signature: a.signature })
  return {
    v: 4,
    kind: 'handover',
    assetId: p.assetId,
    amount: p.amount.toString(),
    derivationPrefix: p.derivationPrefix,
    derivationSuffix: p.derivationSuffix,
    senderIdentityKey: p.senderIdentityKey,
    senderMode: p.senderMode,
    transaction: Utils.toHex(p.tx),
    outputIndex: p.outputIndex,
    ...(p.admission != null ? { admission: att(p.admission) } : {}),
    admissions: (p.admissions ?? []).map(att),
    linkage: (p.linkage ?? []).map(l => ({ txid: l.txid, offChainValues: Utils.toHex(l.offChainValues) })),
    ...(p.note != null ? { note: p.note } : {})
  }
}

/** The plain BRC-207 custody receipt a v4 body implies (0207:1431-1440; < 1000 bytes). */
export function receiptOfBody (b: Pick<HandoverBodyV4, 'assetId' | 'derivationPrefix' | 'derivationSuffix' | 'senderIdentityKey'>): ReceiptInstruction {
  return {
    version: 1,
    assetId: b.assetId,
    derivationPrefix: b.derivationPrefix,
    derivationSuffix: b.derivationSuffix,
    senderIdentityKey: b.senderIdentityKey
  }
}

/**
 * How old a 'signed' hand-over must be before reconcileNotifications
 * redelivers it on its own. A live `sendHandover` → `deliverHandover` journals
 * its notification within moments of signing; anything younger is presumed to
 * be that live delivery, not a crash.
 */
export const REDELIVER_AFTER_MS = 60_000

/**
 * The notification a 'signed' entry should have had, rebuilt from the
 * journal, or undefined (with a warning) when its bytes are unusable. Stale
 * cache: the journaled AtomicBEEF must still hash to the entry's txid, or the
 * recipient would be handed bytes the sender can never settle.
 */
function rebuildNotification (entry: HandoverJournalEntry, now: number): PendingNotification | undefined {
  try {
    const body = JSON.parse(entry.body) as HandoverBodyV4
    if (body?.v !== 4 || body.kind !== 'handover' || typeof body.transaction !== 'string') throw new Error('the journaled body is not a v4 hand-over')
    const tx = Utils.toArray(body.transaction, 'hex')
    if (Transaction.fromAtomicBEEF(tx).id('hex') !== entry.txid) throw new Error('the journaled bytes do not hash to the txid')
    return { txid: entry.txid, recipient: entry.recipientKey, messageBox: MESSAGEBOX, body, at: now }
  } catch (e) {
    console.warn(`[mandala] cannot redeliver hand-over ${entry.txid} from its journal entry; left 'signed':`, e)
    return undefined
  }
}

/** A hand-over to the sender's own key (unblinded, so the body shows the recipient as sender). */
function isSelfSend (entry: HandoverJournalEntry): boolean {
  try {
    return (JSON.parse(entry.body) as HandoverBodyV4)?.senderIdentityKey === entry.recipientKey
  } catch {
    return false
  }
}

/**
 * Retry every pending recipient notification, complete every issuer receipt
 * intent left behind by a crash (R6, see above; a pending intent is never
 * sent as is), and redeliver every 'signed' hand-over older than
 * REDELIVER_AFTER_MS that has none (a self-send is promoted, not sent). Success clears the
 * notification (and promotes a 'signed' hand-over to 'delivered'); failure
 * keeps it journaled (attempts++) for the next pass, so a rebuilt one is not
 * rebuilt again. Returns delivered txids.
 *
 * Runs under the `mandala.notify` lock: a concurrent pass (another tab, or
 * init and a send overlapping) returns `[]` instead of sending the same body
 * twice. A duplicate would be harmless anyway (the receipt path is
 * idempotent, 0207 A.83); the lock only saves the round trip.
 */
export async function reconcileNotifications (messageBoxClient: Sender): Promise<string[]> {
  const { acquired, result } = await tryWithLock('mandala.notify', async () => await notifyPass(messageBoxClient))
  return acquired && result != null ? result : []
}

/**
 * Complete a receipt intent left behind (R6), or undefined to keep waiting.
 * Younger than REDELIVER_AFTER_MS it is presumed to be a live payout's.
 */
async function completeIntent (entry: PendingReceiptIntent, now: number, s5: { warned: boolean }): Promise<PendingNotification | undefined> {
  if (now - entry.at < REDELIVER_AFTER_MS) return undefined
  if (!isIssuerReceiptIntent(entry.intent)) {
    console.warn(`[mandala] the receipt intent for ${entry.txid} is malformed; it is kept, never acted on`)
    return undefined
  }
  if (!COMPRESSED_KEY.test(OVERLAY_IDENTITY_KEY) || OVERLAY_URL === '') {
    // S5, a malformed key or no overlay URL: nothing can be looked up or
    // verified. A configuration fault, not a verdict: the intent waits.
    if (!s5.warned) console.warn('[mandala] receipt intents wait: the overlay identity key or URL is not configured (or the key is malformed)')
    s5.warned = true
    return undefined
  }
  const outcome = await resolveIssuerIntent(entry.txid, entry.intent, now - entry.at)
  if (outcome.status === 'wait') return undefined
  if (outcome.status === 'drop') {
    // Re-read first: a live payout whose submit outlived the TTL may have
    // just replaced the intent with its final body.
    if ((await notifyGet(entry.txid))?.pending === true) {
      console.warn(`[mandala] dropping the receipt intent for ${entry.txid}: ${outcome.reason}`)
      await notifyRemove(entry.txid)
    }
    return undefined
  }
  const { intent } = entry
  const body = handoverBody({
    assetId: intent.assetId,
    amount: BigInt(intent.amount),
    outputIndex: intent.outputIndex,
    tx: Utils.toArray(intent.txHex, 'hex'),
    derivationPrefix: intent.derivationPrefix,
    derivationSuffix: intent.derivationSuffix,
    senderIdentityKey: intent.senderIdentityKey,
    senderMode: intent.senderMode,
    admission: outcome.attestation,
    linkage: [{ txid: entry.txid, offChainValues: Utils.toArray(intent.offChainHex, 'hex') }],
    ...(intent.note != null ? { note: intent.note } : {})
  })
  const done: PendingNotification = { txid: entry.txid, recipient: intent.recipientKey, messageBox: MESSAGEBOX, body, at: now }
  // The final body replaces the intent before the send, exactly like the live path.
  await notifyPut(done)
  return done
}

/** The overlay identity key shape every attestation is verified under (reconcile.ts uses the same check). */
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

async function notifyGet (txid: string): Promise<NotifyJournalEntry | undefined> {
  try {
    const raw = await getStorage().getItem(PREFIX + txid)
    return raw == null ? undefined : JSON.parse(raw) as NotifyJournalEntry
  } catch {
    return undefined
  }
}

async function notifyPass (messageBoxClient: Sender): Promise<string[]> {
  const now = Date.now()
  const journaled = await notifyList()
  const pendingTxids = new Set(journaled.map(n => n.txid))
  const pending: PendingNotification[] = []
  const s5 = { warned: false }
  for (const entry of journaled) {
    if (entry.pending === true) {
      // Never sent as is: completed into a final body, or left.
      const done = await completeIntent(entry, now, s5)
      if (done != null) pending.push(done)
      continue
    }
    pending.push(entry)
  }
  for (const entry of await journalListHandovers()) {
    if (entry.stage !== 'signed' || pendingTxids.has(entry.txid)) continue
    if (now - entry.at < REDELIVER_AFTER_MS) continue
    if (isSelfSend(entry)) {
      // No delivery is owed to ourselves: the sender may submit (B5).
      await journalPromoteSigned(entry.txid)
      continue
    }
    const rebuilt = rebuildNotification(entry, now)
    if (rebuilt != null) pending.push(rebuilt)
  }

  const delivered: string[] = []
  for (const entry of pending) {
    try {
      await messageBoxClient.sendMessage({
        recipient: entry.recipient,
        messageBox: entry.messageBox,
        body: entry.body
      })
    } catch {
      // A rebuilt notification becomes pending here, so the next pass resends
      // these exact bytes instead of rebuilding them.
      await notifyPut({ ...entry, attempts: (entry.attempts ?? 0) + 1 })
      continue
    }
    await notifyRemove(entry.txid)
    // The recipient has the receipt: the sender may now submit (B5).
    if (entry.messageBox === MESSAGEBOX) await journalPromoteSigned(entry.txid)
    delivered.push(entry.txid)
  }
  return delivered
}
