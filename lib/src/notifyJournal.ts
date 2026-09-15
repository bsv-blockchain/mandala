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
 */
import { getStorage } from './storage.js'

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

/**
 * Retry every pending recipient notification. Success clears the entry;
 * failure keeps it (attempts++) for the next pass. Returns delivered txids.
 */
export async function reconcileNotifications (messageBoxClient: Sender): Promise<string[]> {
  const delivered: string[] = []
  for (const entry of await notifyList()) {
    try {
      await messageBoxClient.sendMessage({
        recipient: entry.recipient,
        messageBox: entry.messageBox,
        body: entry.body
      })
      await notifyRemove(entry.txid)
      delivered.push(entry.txid)
    } catch {
      await notifyPut({ ...entry, attempts: (entry.attempts ?? 0) + 1 })
    }
  }
  return delivered
}
