/**
 * Journal of in-flight transactions, persisted through the injected storage
 * adapter (storage.ts) so a crash or network failure mid-flow can be
 * reconciled on the next load (see reconcile.ts).
 *
 * Stages:
 *   'intent'   — a pipeline is about to (or did) createAction but the overlay
 *                outcome is not yet journaled. Written BEFORE createAction and
 *                cleared on settle; while a fresh intent exists the reconcile
 *                bulk sweep must not run (it would abort the live action).
 *                A crashed pipeline leaves a stale intent, which expires after
 *                INTENT_TTL_MS so recovery is never blocked forever.
 *   'accepted' — the overlay admitted the tx but the network broadcast hasn't
 *                succeeded yet. MUST NOT be aborted (the overlay already folded
 *                its state); recovery = retry the sendWith broadcast.
 *   'abort'    — the overlay rejected the tx and the abortAction that releases
 *                its inputs failed. Recovery = retry the abort.
 *   'retryable'— the overlay refused with a LIFTABLE condition (pause, freeze,
 *                screening, membership, plain unavailability). The noSend
 *                action is still alive and its inputs are still held — on
 *                purpose, so the identical bytes can be re-submitted — which
 *                means it needs a durable record or a crash leaks the action
 *                forever (amendment v2.1 §9.11). Recovery = re-POST `submit`;
 *                after RETRY_CAP passes reconcile aborts the reference instead.
 *   'stranded' — an 'accepted' entry whose broadcast has failed
 *                BROADCAST_RETRY_CAP times. KEPT (the overlay folded this tx
 *                in; it must never be aborted) but never retried automatically
 *                and no longer blocking the bulk sweep. Surfaced by
 *                `journalListStranded()` for an operator to act on.
 *
 * Storage layout: ONE key PER ENTRY (`mandala.txJournal.<id>`). setItem/
 * removeItem are atomic per key, so concurrent writers can add/remove
 * different entries without the lost-update races a single-array
 * read-modify-write suffers. A corrupted entry is skipped individually
 * instead of wiping the whole journal.
 *
 * Every operation is async (D3c): the store may be SQLite. There is no memory
 * mirror — the store is authoritative on every read, so a second reader can
 * never be served an entry the store no longer has.
 */
import { getStorage, MandalaStorage } from './storage.js'

/**
 * Exactly what a 'retryable' entry needs to re-POST the SAME bytes to
 * `/submit` on a later pass. Hex rather than `number[]` because the store is a
 * string KV: a 4 KB BEEF is 8 KB of hex but ~25 KB as a JSON number array.
 */
export interface JournalSubmit {
  /** The signed transaction, exactly as first submitted. */
  txHex: string
  /** The off-chain linkage payload, when the flow had one. */
  offChainHex?: string
  /** The topics the original submit named (registry flows are not tm_mandala). */
  topics: string[]
}

export interface JournalEntry {
  txid: string
  stage: 'intent' | 'accepted' | 'abort' | 'retryable' | 'stranded'
  /** createAction signableTransaction.reference — needed to retry an abort. */
  reference?: string
  /** Failed recovery attempts so far (reconcile increments; see caps there). */
  attempts?: number
  /** The overlay verdict code that produced a 'retryable' entry (diagnostics). */
  code?: string
  /** Present on 'retryable' entries whose bytes were journaled (§9.11). */
  submit?: JournalSubmit
  /**
   * σ_I, on 'accepted' entries only (A12). The overlay's acceptance proof is
   * written at the commit point, which it already reaches before the
   * broadcast — so this is a durable receipt at no extra I/O, and a second,
   * independent copy of an admission whose server-side record could be lost.
   * The three fields are only meaningful together: the signature commits to
   * `outputsToAdmit`, and `admissionIdentityKey` says which key to verify it
   * against (see admission.ts `verifyAdmission`).
   */
  admissionSignature?: string
  admissionIdentityKey?: string
  outputsToAdmit?: number[]
  at: number
}

const PREFIX = 'mandala.txJournal.'
const LEGACY_KEY = 'mandala.txJournal'

/** Stale-intent expiry — after this a crashed pipeline no longer blocks the sweep. */
export const INTENT_TTL_MS = 5 * 60 * 1000

/**
 * Pure TTL predicate — no I/O, so callers that already hold entries (the
 * reconcile sweep) can test freshness synchronously.
 */
export function isFreshIntent (entry: JournalEntry, now: number = Date.now()): boolean {
  return entry.stage === 'intent' && now - entry.at < INTENT_TTL_MS
}

/** One-time migration of the legacy single-array key into per-entry keys. */
async function migrateLegacy (store: MandalaStorage): Promise<void> {
  const raw = await store.getItem(LEGACY_KEY)
  if (raw == null) return
  try {
    for (const e of JSON.parse(raw) as JournalEntry[]) {
      if (await store.getItem(PREFIX + e.txid) == null) {
        await store.setItem(PREFIX + e.txid, JSON.stringify(e))
      }
    }
  } catch { /* corrupted legacy blob — nothing recoverable */ }
  await store.removeItem(LEGACY_KEY)
}

export async function journalList (): Promise<JournalEntry[]> {
  const store = getStorage()
  await migrateLegacy(store)
  const byId = new Map<string, JournalEntry>()
  for (const key of await store.keys(PREFIX)) {
    try {
      const raw = await store.getItem(key)
      if (raw == null) continue // removed between keys() and getItem
      const entry = JSON.parse(raw) as JournalEntry
      if (typeof entry?.txid === 'string' && typeof entry.stage === 'string') {
        byId.set(entry.txid, entry)
      }
    } catch { /* one corrupted entry — skip it, keep the rest */ }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at)
}

/**
 * Every entry parked in 'stranded' — overlay-accepted transactions whose
 * broadcast kept failing past BROADCAST_RETRY_CAP (§9.11).
 *
 * These are deliberately NOT retried by reconcile any more: an unbroadcastable
 * accepted tx that stayed in the retry loop wedged the whole pass (it blocked
 * the bulk sweep forever). They are kept — never aborted, since the overlay has
 * already folded them in — and surfaced here so a host can show them, retry one
 * deliberately (`broadcastAcceptedTx`), or escalate.
 */
export async function journalListStranded (): Promise<JournalEntry[]> {
  return (await journalList()).filter(e => e.stage === 'stranded')
}

/**
 * Insert or replace the entry for a txid. Atomic per entry. Resolves once the
 * store has it — callers that rely on the ordering guarantee (overlay.ts's
 * 'accepted' write before the broadcast) MUST await it.
 *
 * A store failure is warned, never thrown: at the commit point the overlay has
 * already folded the tx in, so turning a storage error into a rejection would
 * report a committed transaction as failed.
 */
export async function journalPut (entry: JournalEntry): Promise<void> {
  try {
    await getStorage().setItem(PREFIX + entry.txid, JSON.stringify(entry))
  } catch (e) {
    console.warn(`[mandala] txJournal write failed for ${entry.txid}; recovery of this entry is not durable:`, e)
  }
}

export async function journalRemove (txid: string): Promise<void> {
  try {
    await getStorage().removeItem(PREFIX + txid)
  } catch (e) {
    console.warn(`[mandala] txJournal remove failed for ${txid}; it will be retried on the next pass:`, e)
  }
}

/**
 * Mark a pipeline as in flight BEFORE createAction. The returned id keys the
 * entry (the real txid is unknown until signAction); clear it with
 * journalIntentEnd once the outcome is journaled ('accepted'/'abort') or the
 * pipeline settled cleanly. Await it: the marker must exist before the
 * createAction it protects.
 */
export async function journalIntentBegin (): Promise<string> {
  const id = 'intent:' + (globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await journalPut({ txid: id, stage: 'intent', at: Date.now() })
  return id
}

export async function journalIntentEnd (id: string): Promise<void> {
  await journalRemove(id)
}

/**
 * Run a wallet pipeline under an intent marker: while it runs (and until its
 * overlay outcome is journaled), the reconcile bulk sweep stays away from the
 * live noSend action — including sweeps from other tabs.
 */
export async function withIntent<T> (fn: () => Promise<T>): Promise<T> {
  const id = await journalIntentBegin()
  try {
    return await fn()
  } finally {
    await journalIntentEnd(id)
  }
}

/**
 * True while any pipeline's intent entry is younger than INTENT_TTL_MS.
 * A read failure answers `true` — fail-safe, because the only consumer is the
 * bulk sweep and "block the sweep" is the harmless direction to be wrong in.
 */
export async function hasFreshIntent (now: number = Date.now()): Promise<boolean> {
  try {
    return (await journalList()).some(e => isFreshIntent(e, now))
  } catch (e) {
    console.warn('[mandala] txJournal read failed; assuming a pipeline is in flight:', e)
    return true
  }
}

/** Test helper. */
export async function journalClear (): Promise<void> {
  const store = getStorage()
  for (const key of [...await store.keys(PREFIX), LEGACY_KEY]) {
    await store.removeItem(key)
  }
}
