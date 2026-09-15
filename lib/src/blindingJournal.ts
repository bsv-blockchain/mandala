/**
 * Sender-local store of blinding factors r.
 *
 * r must never ride on the recipient output or in the MessageBox body —
 * either would let the recipient open A′ − rG = A. Change customInstructions
 * keep a copy for outputs the sender still holds; this journal is the
 * fallback for exact-amount sends (no change) and for after change is spent.
 *
 * Persisted through the injected storage adapter (storage.ts): async, one key
 * per record, no memory mirror — losing r to process death would strand the
 * sender's own view of the payment.
 */
import { getStorage } from './storage.js'

export interface BlindingRecord {
  txid: string
  r: string
  senderBlinded: string
  recipient: string
  keyID: string
  at: number
}

const PREFIX = 'mandala.blindingJournal.'

export async function blindingPut (entry: BlindingRecord): Promise<void> {
  try {
    await getStorage().setItem(PREFIX + entry.txid, JSON.stringify(entry))
  } catch (e) {
    console.warn(`[mandala] blindingJournal write failed for ${entry.txid}; r is only recoverable from change customInstructions:`, e)
  }
}

export async function blindingGet (txid: string): Promise<BlindingRecord | undefined> {
  const raw = await getStorage().getItem(PREFIX + txid)
  if (raw == null) return undefined
  try {
    return JSON.parse(raw) as BlindingRecord
  } catch {
    return undefined
  }
}

export async function blindingList (): Promise<BlindingRecord[]> {
  const store = getStorage()
  const byId = new Map<string, BlindingRecord>()
  for (const key of await store.keys(PREFIX)) {
    try {
      const raw = await store.getItem(key)
      if (raw == null) continue
      const entry = JSON.parse(raw) as BlindingRecord
      if (typeof entry?.txid === 'string') byId.set(entry.txid, entry)
    } catch { /* skip corrupt */ }
  }
  return [...byId.values()]
}

export async function blindingClear (): Promise<void> {
  const store = getStorage()
  for (const key of await store.keys(PREFIX)) await store.removeItem(key)
}

// ---------------------------------------------------------------------------
// Deferred-commit blinding (nearby-payee rail).
//
// The nearby rail runs lockToPayee — and mints r — BEFORE a txid exists (the
// tx is only built once the payee is in range and has accepted). `blindingPut`
// can't be used yet because it keys on txid; a reservation under `keyID`
// (known up front, since the caller chooses it before signing) holds the
// record until the tx is built, at which point `blindingCommit` promotes it
// to the ordinary txid-keyed record and drops the reservation. An abandoned
// reservation (the payee never accepted, the tab closed) is swept by
// `blindingPruneReserved` so it does not accumulate forever.
// ---------------------------------------------------------------------------

const RESERVE_PREFIX = PREFIX + 'reserve.'

/** A BlindingRecord minus the not-yet-existing txid. */
export type BlindingReservation = Omit<BlindingRecord, 'txid'>

/** Reserve a blinding record under `keyID`, before any txid exists for it. */
export async function blindingReserve (keyID: string, record: BlindingReservation): Promise<void> {
  try {
    await getStorage().setItem(RESERVE_PREFIX + keyID, JSON.stringify({ ...record, keyID }))
  } catch (e) {
    console.warn(`[mandala] blindingJournal reserve failed for keyID ${keyID}; r may be unrecoverable:`, e)
  }
}

/**
 * Promote the reservation under `keyID` to an ordinary txid-keyed record now
 * that the tx exists, and remove the reservation. A missing/corrupt
 * reservation (already committed, pruned, or never made) is a safe no-op —
 * there is nothing left to move.
 */
export async function blindingCommit (keyID: string, txid: string): Promise<void> {
  const store = getStorage()
  const raw = await store.getItem(RESERVE_PREFIX + keyID)
  if (raw != null) {
    try {
      const record = JSON.parse(raw) as BlindingReservation
      await blindingPut({ ...record, keyID, txid })
    } catch (e) {
      console.warn(`[mandala] blindingJournal commit found a corrupt reservation for keyID ${keyID}:`, e)
    }
  }
  await store.removeItem(RESERVE_PREFIX + keyID)
}

/** All outstanding (not yet committed or pruned) reservations. */
export async function blindingListReserved (): Promise<BlindingReservation[]> {
  const store = getStorage()
  const out: BlindingReservation[] = []
  for (const key of await store.keys(RESERVE_PREFIX)) {
    try {
      const raw = await store.getItem(key)
      if (raw == null) continue
      const entry = JSON.parse(raw) as BlindingReservation
      if (typeof entry?.keyID === 'string') out.push(entry)
    } catch { /* skip corrupt */ }
  }
  return out
}

/**
 * Sweep reservations older than `olderThanMs` (measured from each record's
 * `at`) — abandoned lockToPayee attempts that never became a transaction.
 * Returns the number removed.
 */
export async function blindingPruneReserved (olderThanMs: number): Promise<number> {
  const store = getStorage()
  const cutoff = Date.now() - olderThanMs
  let removed = 0
  for (const key of await store.keys(RESERVE_PREFIX)) {
    try {
      const raw = await store.getItem(key)
      if (raw == null) continue
      const entry = JSON.parse(raw) as BlindingReservation
      if (typeof entry?.at === 'number' && entry.at < cutoff) {
        await store.removeItem(key)
        removed++
      }
    } catch { /* skip corrupt */ }
  }
  return removed
}
