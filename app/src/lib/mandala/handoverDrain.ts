/**
 * Hand-over drain: the app's scheduler over the lib's own hand-over recovery
 * (B5, contract §8.1:537-541, A1).
 *
 * The lib journal is the ONLY durable store for a holder hand-over: it holds
 * stage 'signed' before the send resolves and 'delivered' once the recipient
 * acknowledged. This module persists nothing and keeps no copy of an entry.
 * It never delivers, settles, resubmits or aborts a journal entry itself and
 * never touches browser storage. Each pass, in order, under one lock:
 *
 *   1. mark crashed self-sends delivered (A13): a self-send has no MessageBox
 *      leg, so a 'signed' self entry older than SELF_GRACE_MS can only be one
 *      whose tab died before marking it;
 *   2. the lib's notification pass, the single redelivery path (payout and
 *      reissue notifications too, which is why it runs even when no hand-over
 *      is waiting) — it promotes a redelivered 'signed' entry to 'delivered';
 *   3. the lib's wallet reconcile with `{ sweep: false }`, the single
 *      settle-recovery path: it resubmits every 'delivered' entry from the
 *      journaled bytes, so an entry promoted in step 2 settles this pass;
 *   4. re-read the journal for the "awaiting" count and the backoff.
 *
 * Stability:
 * - Crash: nothing here is durable; the next load re-reads the journal.
 * - Double-submit / multi-tab: one pass per tab (in-flight marker set before
 *   the first await) and one across tabs (web lock HANDOVER_LOCK, taken
 *   without waiting). The immediate send leg takes the same lock waiting.
 * - Stale cache: every pass lists the journal afresh.
 * - Retry: in-memory interval backoff (15 s doubling to 15 min) so a short
 *   outage does not burn the lib's RETRY_CAP; an idle app makes one slow
 *   pass every IDLE_MS. A reload resets it (at most one early pass).
 */
import type { WalletInterface } from '@bsv/sdk'
import type {
  journalListHandovers,
  markHandoverDelivered,
  MessageBoxSender,
  ReconcileResult,
  reconcileWallet
} from '@bsv/mandala'
import type { reconcileNotifications } from '@bsv/mandala/notifyJournal'

export type Sender = MessageBoxSender
/** Fields read: `txid`, `stage`, `recipientKey`, `at` (A15). */
export type JournalHandover = Awaited<ReturnType<typeof journalListHandovers>>[number]

/** Web lock shared by the drain (no wait) and the immediate send leg (wait). */
export const HANDOVER_LOCK = 'mandala.app.handovers'
/** Mirrors the lib's REDELIVER_AFTER_MS: a younger self entry may still be finishing in its own tab. */
export const SELF_GRACE_MS = 60_000
/** Delay before the next unforced pass when nothing is waiting. */
export const IDLE_MS = 300_000

const BACKOFF_BASE_MS = 15_000
const BACKOFF_CAP_MS = 900_000

/** 15 s · 2^(n-1), capped at 15 min; 0 for n ≤ 0. */
export function backoffMs (failures: number): number {
  if (!(failures >= 1)) return 0
  // Cap the exponent too, so a huge count never computes Infinity first.
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16), BACKOFF_CAP_MS)
}

/** In memory, per tab. */
export interface DrainState { failures: number, nextAt: number }

export type LockOutcome<T> = { ran: true, value: T } | { ran: false }

// Same-tab fallback when the Web Locks API is absent: a promise chain, plus a
// count of holders AND queued waiters, bumped synchronously on entry, so a
// no-wait caller cannot slip in between a waiter queueing and running.
let chain: Promise<void> = Promise.resolve()
let occupants = 0

/**
 * Run `fn` under HANDOVER_LOCK. `wait: false` returns `{ ran: false }` when
 * the lock is held (or requested) by anyone; `wait: true` queues for it.
 * Uses `navigator.locks` (cross-tab) when available, else a same-tab chain.
 */
export async function withHandoverLock<T> (fn: () => Promise<T>, o: { wait: boolean }): Promise<LockOutcome<T>> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks != null && typeof locks.request === 'function') {
    let out: LockOutcome<T> = { ran: false }
    await locks.request(HANDOVER_LOCK, { ifAvailable: !o.wait }, async (lock) => {
      if (lock == null) return
      out = { ran: true, value: await fn() }
    })
    return out
  }
  if (!o.wait && occupants > 0) return { ran: false }
  occupants++
  const prev = chain
  let done!: () => void
  chain = new Promise<void>(resolve => { done = resolve })
  try {
    await prev
    return { ran: true, value: await fn() }
  } finally {
    occupants--
    done()
  }
}

export interface DrainDeps {
  wallet: WalletInterface
  identityKey: string
  /** The full MessageBox client; `Sender` is only what a delivery needs. */
  messageBoxClient: Parameters<typeof reconcileNotifications>[0]
  now: () => number
  state: DrainState
  list: typeof journalListHandovers
  markDelivered: typeof markHandoverDelivered
  redeliver: typeof reconcileNotifications
  reconcile: typeof reconcileWallet
  withLock?: typeof withHandoverLock
}

export interface DrainReport {
  skipped: 'busy' | 'backoff' | null
  markedSelf: string[]
  redeliverError?: string
  reconcile?: ReconcileResult
  reconcileError?: string
  /** -1 when unknown (skipped, or the journal could not be read). */
  awaiting: { signed: number, delivered: number }
}

const UNKNOWN = { signed: -1, delivered: -1 } as const

function errText (e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Same-tab single flight. Set synchronously on entry, before any await.
let inFlight = false

/**
 * One recovery pass over the lib journal (see the module comment). Returns
 * `skipped: 'busy'` when a pass is already running in this tab or another
 * tab holds the lock, and `skipped: 'backoff'` before `state.nextAt` unless
 * forced. A skipped pass calls nothing and leaves `state` unchanged.
 */
export async function drainHandovers (deps: DrainDeps, o: { force?: boolean } = {}): Promise<DrainReport> {
  if (inFlight) return { skipped: 'busy', markedSelf: [], awaiting: { ...UNKNOWN } }
  if (o.force !== true && deps.now() < deps.state.nextAt) return { skipped: 'backoff', markedSelf: [], awaiting: { ...UNKNOWN } }
  inFlight = true
  try {
    const withLock = deps.withLock ?? withHandoverLock
    const locked = await withLock(async () => await pass(deps), { wait: false })
    return locked.ran ? locked.value : { skipped: 'busy', markedSelf: [], awaiting: { ...UNKNOWN } }
  } finally {
    inFlight = false
  }
}

async function pass (deps: DrainDeps): Promise<DrainReport> {
  const report: DrainReport = { skipped: null, markedSelf: [], awaiting: { ...UNKNOWN } }
  let threw = false

  // 1. Crashed self-sends (A13). A list() failure skips this step only.
  let entries: JournalHandover[] | null = null
  try {
    entries = await deps.list()
  } catch (e) {
    threw = true
    console.warn('[handoverDrain] journal unavailable:', errText(e))
  }
  if (entries != null) {
    const now = deps.now()
    for (const e of entries) {
      if (e.stage !== 'signed' || e.recipientKey !== deps.identityKey) continue
      if (!(now - e.at >= SELF_GRACE_MS)) continue
      try {
        await deps.markDelivered(e.txid)
        report.markedSelf.push(e.txid)
      } catch (err) {
        // Stays 'signed': the re-list below sees it and the pass backs off.
        console.warn('[handoverDrain] could not mark self-send delivered:', e.txid, errText(err))
      }
    }
  }

  // 2. The single redelivery path.
  try {
    await deps.redeliver(deps.messageBoxClient)
  } catch (e) {
    threw = true
    report.redeliverError = errText(e)
  }

  // 3. The single settle-recovery path; never the bulk sweep from here (A9).
  try {
    report.reconcile = await deps.reconcile(deps.wallet, { sweep: false })
  } catch (e) {
    threw = true
    report.reconcileError = errText(e)
  }

  // 4. What is still waiting.
  try {
    const left = await deps.list()
    report.awaiting = {
      signed: left.filter(e => e.stage === 'signed').length,
      delivered: left.filter(e => e.stage === 'delivered').length
    }
  } catch (e) {
    threw = true
    console.warn('[handoverDrain] journal unavailable after reconcile:', errText(e))
  }

  if (report.reconcile != null && (report.reconcile.stranded.length > 0 || report.reconcile.aborted.length > 0)) {
    // No per-txid refusal verdict on the recovery path (A14): log the result.
    console.info('[handoverDrain] reconcile', report.reconcile)
  }

  const waiting = report.awaiting.signed + report.awaiting.delivered > 0
  if (threw || waiting) {
    deps.state.failures += 1
    deps.state.nextAt = deps.now() + backoffMs(deps.state.failures)
  } else {
    deps.state.failures = 0
    deps.state.nextAt = deps.now() + IDLE_MS
  }
  return report
}
