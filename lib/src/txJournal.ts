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
 *   'signed'   — a holder hand-over (handover.ts sendHandover) was built and
 *                signed noSend through the color module, and its bytes and
 *                receipt are journaled here, but the recipient has not
 *                acknowledged delivery yet. NEVER submitted, aborted or swept
 *                automatically: the recipient may already hold these bytes,
 *                so releasing the inputs would invalidate a payment in
 *                flight. Recovery = redeliver the receipt
 *                (notifyJournal reconcileNotifications, after 60 s).
 *   'delivered'— the hand-over was acknowledged (MessageBox sendMessage
 *                resolved, or the host's own ACK), or it is a self-send,
 *                which owes no delivery and is journaled 'delivered' at
 *                once. The sender may now submit
 *                the exact journaled bytes (settleHandover / reconcile):
 *                admitted ⇒ 'accepted'; retryable ⇒ attempts+1; final ⇒
 *                abort + drop (B2, B5, D27). 'handed_over' is removed (G3).
 *   'stranded' — parked after a capped number of failed recovery passes,
 *                KEPT, never aborted, never retried automatically and no
 *                longer blocking the bulk sweep. Two kinds, told apart by σ:
 *                - admissionSignature != null: an 'accepted' entry whose
 *                  broadcast failed BROADCAST_RETRY_CAP times. The overlay
 *                  folded it in; recovery = broadcast it (sendWith).
 *                - admissionSignature == null (it carries `submit` and the
 *                  hand-over fields instead): a 'delivered' hand-over the
 *                  overlay never admitted, retried RETRY_CAP times. It must
 *                  NEVER be broadcast (that would put an unadmitted token tx
 *                  on chain); recovery = re-submit its journaled bytes
 *                  (resubmitDelivered), and only an admission may lead to a
 *                  broadcast.
 *                Surfaced by `journalListStranded()` for an operator.
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
  stage: 'intent' | 'accepted' | 'abort' | 'retryable' | 'stranded' | 'signed' | 'delivered'
  /** createAction signableTransaction.reference — needed to retry an abort. */
  reference?: string
  /** Failed recovery attempts so far (reconcile increments; see caps there). */
  attempts?: number
  /** The overlay verdict code that produced a 'retryable' entry (diagnostics). */
  code?: string
  /** Present on 'retryable' / 'signed' / 'delivered' entries whose bytes were journaled (§9.11). */
  submit?: JournalSubmit
  /** The off-chain envelope for THIS txid, hex; written on 'accepted' entries. */
  offChainHex?: string
  /** Hand-over entries ('signed' / 'delivered'): the asset moved. */
  assetId?: string
  /** Hand-over entries: the recipient identity key the receipt is delivered to. */
  recipientKey?: string
  /** Hand-over entries: the recipient output index in the tip. */
  outputIndex?: number
  /** Hand-over entries: the sender's note, carried in the redelivered body. */
  note?: string
  /** Hand-over entries: the BRC-207 receipt instruction, as a JSON string (C§7.1). */
  receipt?: string
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
 * A journaled holder hand-over (C§8.1): 'signed' (not yet acknowledged) or
 * 'delivered' (acknowledged; the sender may submit). Carries everything a
 * redelivery or a resubmit needs: the exact bytes, envelope, topic and the
 * receipt.
 */
export type HandoverJournalEntry = JournalEntry & {
  stage: 'signed' | 'delivered'
  assetId: string
  recipientKey: string
  outputIndex: number
  receipt: string
  reference: string
  submit: { txHex: string, offChainHex: string, topics: string[] }
}

/** True for a well-formed 'signed' / 'delivered' hand-over entry (every field a redelivery or resubmit reads). */
export function isHandoverEntry (e: JournalEntry): e is HandoverJournalEntry {
  return (e.stage === 'signed' || e.stage === 'delivered') &&
    typeof e.assetId === 'string' && typeof e.recipientKey === 'string' &&
    typeof e.outputIndex === 'number' && typeof e.receipt === 'string' &&
    typeof e.reference === 'string' && typeof e.submit?.txHex === 'string' &&
    typeof e.submit.offChainHex === 'string' && Array.isArray(e.submit.topics)
}

/** Every well-formed 'signed' and 'delivered' hand-over entry, oldest first. */
export async function journalListHandovers (): Promise<HandoverJournalEntry[]> {
  return (await journalList()).filter(isHandoverEntry)
}

/**
 * The entry for one txid, or undefined (absent or corrupt). Reads the
 * store directly: never a cached copy. A legacy single-array blob is
 * migrated first so an unmigrated entry is still found.
 */
export async function journalGet (txid: string): Promise<JournalEntry | undefined> {
  const store = getStorage()
  await migrateLegacy(store)
  const raw = await store.getItem(PREFIX + txid)
  if (raw == null) return undefined
  try {
    const entry = JSON.parse(raw) as JournalEntry
    return entry?.txid === txid && typeof entry.stage === 'string' ? entry : undefined
  } catch {
    return undefined
  }
}

/**
 * 'signed' → 'delivered' for one txid (the body of `markHandoverDelivered`,
 * here so notifyJournal's redelivery can promote without importing
 * handover.ts). Idempotent. With no entry or any other stage it resolves
 * without writing: a 'delivered', 'accepted' or 'abort' entry is never
 * moved backwards, and a payout notification (no 'signed' entry) is a no-op.
 */
export async function journalPromoteSigned (txid: string): Promise<void> {
  const entry = await journalGet(txid)
  if (entry?.stage !== 'signed') return
  await journalPut({ ...entry, stage: 'delivered' })
}

/**
 * Every entry parked in 'stranded' (§9.11). Two kinds; check σ before acting:
 *
 * - `admissionSignature != null`: an overlay-accepted transaction whose
 *   broadcast kept failing past BROADCAST_RETRY_CAP. Never aborted, since the
 *   overlay has already folded it in; a host may retry its broadcast
 *   deliberately (`broadcastAcceptedTx`) or escalate.
 * - `admissionSignature == null`: a 'delivered' hand-over the overlay never
 *   admitted (retryable verdicts or transport failures past RETRY_CAP). It
 *   must NEVER be broadcast (`createAction({ sendWith })` would put a token
 *   tx the overlay never admitted on chain). A host may only re-submit it
 *   (`resubmitDelivered`) or escalate; it is never aborted automatically
 *   either, because the recipient already holds its bytes.
 *
 * Neither kind is retried by reconcile any more: an entry that stayed in the
 * retry loop wedged the whole pass (it blocked the bulk sweep forever).
 */
export async function journalListStranded (): Promise<JournalEntry[]> {
  return (await journalList()).filter(e => e.stage === 'stranded')
}

/**
 * Does the journal still hold ANYTHING for this txid, at any stage?
 *
 * The question a HOST must ask before it touches a noSend action of its own
 * accord (its settlement drain, its own sweep): an entry — 'intent',
 * 'accepted', 'retryable', 'signed', 'delivered', 'stranded' or 'abort' alike —
 * means this library still owns the transaction's fate, and aborting the action
 * under it releases inputs the overlay (or a payee) is already counting on.
 *
 * A read failure answers `true`. Fail-safe, exactly like `hasFreshIntent`: not
 * knowing what is live is not a licence to abort.
 */
export async function journalHas (txid: string): Promise<boolean> {
  try {
    const store = getStorage()
    if (await store.getItem(PREFIX + txid) != null) return true
    // Nothing under its own key — only an unmigrated legacy blob could still
    // be hiding it, and that check is one extra read, not a full scan.
    if (await store.getItem(LEGACY_KEY) == null) return false
    return (await journalList()).some(e => e.txid === txid)
  } catch (e) {
    console.warn(`[mandala] txJournal read failed for ${txid}; assuming it is still in flight:`, e)
    return true
  }
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
