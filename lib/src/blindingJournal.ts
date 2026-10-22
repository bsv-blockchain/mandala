/**
 * Sender-local store of blinding factors r (B3, C§8.1).
 *
 * r must never ride on the recipient output, in the receipt or in the
 * MessageBox body: any of those would let the recipient open A′ − rG = A.
 * This journal is the only copy (the holder pipeline no longer writes change
 * customInstructions), so a write failure propagates to the caller.
 *
 * Records are keyed by the OUTPOINT `<txid>.<vout>` of the recipient output.
 * r is minted by `recipientLinkage` before any txid exists, so the caller
 * first reserves it under the derivationSuffix and commits the reservation to
 * the outpoint once the tx is signed.
 *
 * Persisted through the injected storage adapter (storage.ts): async, one key
 * per record, no memory mirror, so a second tab never reads an entry the
 * store no longer has.
 */
import { getStorage } from './storage.js'

export interface BlindingRecord {
  /** `<64 lowercase hex txid>.<canonical vout>` of the recipient output. */
  outpoint: string
  /** Scalar r, 64 lowercase hex. Sender-local only. */
  r: string
  /** A′ = A + rG, compressed hex: what the recipient was shown. */
  senderBlinded: string
  recipient: string
  assetId: string
  at: number
}

/** A BlindingRecord minus the not-yet-existing outpoint. */
export type BlindingReservation = Omit<BlindingRecord, 'outpoint'>

const PREFIX = 'mandala.blindingJournal.'
const RESERVE_PREFIX = PREFIX + 'reserve.'
const OUTPOINT = /^[0-9a-f]{64}\.(0|[1-9][0-9]{0,9})$/

function checkOutpoint (outpoint: string): string {
  // vout is an output index, not a token amount: Number() is exact here.
  if (typeof outpoint !== 'string' || !OUTPOINT.test(outpoint) || Number(outpoint.slice(65)) > 4294967295) {
    throw new TypeError(`@bsv/mandala: invalid outpoint ${JSON.stringify(outpoint)} (expected <64 lowercase hex txid>.<vout>)`)
  }
  return outpoint
}

function checkKey (key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('@bsv/mandala: blinding reservation key must be a non-empty string')
  }
  return key
}

/** Store `entry` under its outpoint. Throws on a malformed outpoint or a failed write. */
export async function blindingPut (entry: BlindingRecord): Promise<void> {
  const outpoint = checkOutpoint(entry?.outpoint)
  const record: BlindingRecord = {
    outpoint,
    r: entry.r,
    senderBlinded: entry.senderBlinded,
    recipient: entry.recipient,
    assetId: entry.assetId,
    at: entry.at
  }
  await getStorage().setItem(PREFIX + outpoint, JSON.stringify(record))
}

export async function blindingGet (outpoint: string): Promise<BlindingRecord | undefined> {
  if (typeof outpoint !== 'string' || !OUTPOINT.test(outpoint)) return undefined
  const raw = await getStorage().getItem(PREFIX + outpoint)
  if (raw == null) return undefined
  try {
    const entry = JSON.parse(raw) as BlindingRecord
    return entry?.outpoint === outpoint ? entry : undefined
  } catch {
    return undefined
  }
}

/** Every committed record (reservations excluded). */
export async function blindingList (): Promise<BlindingRecord[]> {
  const store = getStorage()
  const out: BlindingRecord[] = []
  for (const key of await store.keys(PREFIX)) {
    if (key.startsWith(RESERVE_PREFIX)) continue
    try {
      const raw = await store.getItem(key)
      if (raw == null) continue
      const entry = JSON.parse(raw) as BlindingRecord
      if (typeof entry?.outpoint === 'string' && key === PREFIX + entry.outpoint) out.push(entry)
    } catch { /* skip corrupt */ }
  }
  return out
}

export async function blindingClear (): Promise<void> {
  const store = getStorage()
  for (const key of await store.keys(PREFIX)) await store.removeItem(key)
}

// ---------------------------------------------------------------------------
// Deferred commit. `recipientLinkage` mints r before the tx (and its txid)
// exists. The caller reserves the record under the derivationSuffix before
// signing (a failed write aborts the send before any side effect), then
// `blindingCommit` moves it to the recipient output's outpoint. An abandoned
// reservation (the send never signed, the tab closed) is swept by
// `blindingPruneReserved`.
// ---------------------------------------------------------------------------

/** Reserve a blinding record under `key` (the derivationSuffix). Throws on a failed write. */
export async function blindingReserve (key: string, record: BlindingReservation): Promise<void> {
  checkKey(key)
  const rec: BlindingReservation = {
    r: record.r,
    senderBlinded: record.senderBlinded,
    recipient: record.recipient,
    assetId: record.assetId,
    at: record.at
  }
  await getStorage().setItem(RESERVE_PREFIX + key, JSON.stringify(rec))
}

/**
 * Move the reservation under `key` to `outpoint`, then drop the reservation.
 * A missing reservation (already committed, pruned, never made) is a safe
 * no-op, so a repeated commit is harmless. A malformed outpoint throws and
 * keeps the reservation. A failed write keeps the reservation too (r is not
 * lost; it stays listed by `blindingListReserved`) and only warns, because
 * the caller is already past signing. A corrupt reservation is dropped.
 */
export async function blindingCommit (key: string, outpoint: string): Promise<void> {
  checkKey(key)
  checkOutpoint(outpoint)
  const store = getStorage()
  const raw = await store.getItem(RESERVE_PREFIX + key)
  if (raw == null) return
  let record: BlindingReservation
  try {
    record = JSON.parse(raw) as BlindingReservation
  } catch (e) {
    console.warn(`[mandala] blindingJournal commit found a corrupt reservation for ${key}:`, e)
    await store.removeItem(RESERVE_PREFIX + key)
    return
  }
  try {
    await blindingPut({ ...record, outpoint })
  } catch (e) {
    console.warn(`[mandala] blindingJournal commit of ${key} to ${outpoint} failed; the reservation is kept:`, e)
    return
  }
  await store.removeItem(RESERVE_PREFIX + key)
}

/** All outstanding (not yet committed or pruned) reservations, each with its key. */
export async function blindingListReserved (): Promise<Array<BlindingReservation & { key: string }>> {
  const store = getStorage()
  const out: Array<BlindingReservation & { key: string }> = []
  for (const k of await store.keys(RESERVE_PREFIX)) {
    try {
      const raw = await store.getItem(k)
      if (raw == null) continue
      const entry = JSON.parse(raw) as BlindingReservation
      if (entry == null || typeof entry !== 'object') continue
      out.push({ key: k.slice(RESERVE_PREFIX.length), ...entry })
    } catch { /* skip corrupt */ }
  }
  return out
}

/**
 * Sweep reservations older than `olderThanMs` (from each record's `at`):
 * abandoned sends that never signed. Returns the number removed.
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
