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
 * This module imports txJournal and constants only (plus a type from
 * receipt.ts): receipt.ts and handover.ts import it, so it must not import
 * them back. That is why `handoverBody` lives here.
 */
import { Transaction, Utils } from '@bsv/sdk'
import { getStorage } from './storage.js'
import { MESSAGEBOX } from './constants.js'
import { journalListHandovers, journalPromoteSigned, type HandoverJournalEntry } from './txJournal.js'
import { tryWithLock } from './webLocks.js'
import type { ReceiptInstruction } from './receipt.js'

export interface PendingNotification {
  /** The committed txid — one notification per transfer. */
  txid: string
  recipient: string
  messageBox: string
  body: object
  attempts?: number
  at: number
}

const PREFIX = 'mandala.notifyJournal.'

export async function notifyList (): Promise<PendingNotification[]> {
  const store = getStorage()
  const byId = new Map<string, PendingNotification>()
  for (const key of await store.keys(PREFIX)) {
    try {
      const raw = await store.getItem(key)
      if (raw == null) continue // removed between keys() and getItem
      const entry = JSON.parse(raw) as PendingNotification
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

/** The MessageBox hand-over body (C§7.2). No amount: the recipient reads it from the script. */
export function handoverBody (p: {
  assetId: string
  outputIndex: number
  /** AtomicBEEF of the tip. */
  tx: number[]
  receipt: ReceiptInstruction
  note?: string
}): object {
  return {
    v: 3,
    kind: 'handover',
    assetId: p.assetId,
    outputIndex: p.outputIndex,
    tx: Utils.toHex(p.tx),
    receipt: p.receipt,
    ...(p.note != null ? { note: p.note } : {})
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
    const tx = Utils.toArray(entry.submit.txHex, 'hex')
    if (Transaction.fromAtomicBEEF(tx).id('hex') !== entry.txid) throw new Error('the journaled bytes do not hash to the txid')
    const receipt = JSON.parse(entry.receipt) as ReceiptInstruction
    const body = handoverBody({
      assetId: entry.assetId,
      outputIndex: entry.outputIndex,
      tx,
      receipt,
      ...(entry.note != null ? { note: entry.note } : {})
    })
    return { txid: entry.txid, recipient: entry.recipientKey, messageBox: MESSAGEBOX, body, at: now }
  } catch (e) {
    console.warn(`[mandala] cannot redeliver hand-over ${entry.txid} from its journal entry; left 'signed':`, e)
    return undefined
  }
}

/**
 * Retry every pending recipient notification, and redeliver every 'signed'
 * hand-over older than REDELIVER_AFTER_MS that has none. Success clears the
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

async function notifyPass (messageBoxClient: Sender): Promise<string[]> {
  const now = Date.now()
  const pending = await notifyList()
  const pendingTxids = new Set(pending.map(n => n.txid))
  for (const entry of await journalListHandovers()) {
    if (entry.stage !== 'signed' || pendingTxids.has(entry.txid)) continue
    if (now - entry.at < REDELIVER_AFTER_MS) continue
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
