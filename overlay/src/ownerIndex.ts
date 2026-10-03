import type { HealthCheckDefinition } from '@bsv/overlay-express'
import type { MaintenanceGate } from './maintenanceGate.js'

/** Task 13 — every run refolds (submit gate) then reconciles (reconcile lock); 30 min. */
export const OWNER_INDEX_INTERVAL_MS = 1_800_000
/** F8 — the first retry after a failed run; doubles per consecutive failure, capped at the interval. */
export const OWNER_INDEX_RETRY_BASE_MS = 10_000

export interface OwnerIndexDeps {
  /** The submit gate (shared by /submit): taken exclusive for the refold step only. */
  gate: MaintenanceGate
  /** The reconcile lock (exclusive-only, shared with eviction): held for the reconcile step only. */
  reconcileLock: MaintenanceGate
  lookup: { tokenIdsWithHistory: () => Promise<string[]>, rebuildState: (tokenId: string) => Promise<void> }
  reconcile: (topic: string) => Promise<{ scanned: number, repaired: number, unrepairable: string[] }>
  topics: readonly string[]
  log?: (msg: string) => void
}

/** `lastError` is the public summary (counts and error classes only); the full text is logged. */
export interface OwnerIndexStatus { lastRunAt: string | null, lastError: string | null, unrepairable: string[] }

export interface OwnerIndexHealthResult { status: 'ok' | 'degraded', message?: string, details?: Record<string, unknown> }

const msg = (e: unknown): string => e instanceof Error ? e.message : String(e)

/**
 * The error's class name, for the PUBLIC readiness message (F2). /health/ready
 * is unauthenticated, and a driver's message carries hosts, URLs and at times
 * credentials, so only the class is ever published; the text goes to the log.
 * A name that is not a plain identifier is reported as `Error`.
 */
const errorClass = (e: unknown): string => {
  if (!(e instanceof Error)) return 'non-Error'
  return /^[A-Za-z_$][\w$]{0,63}$/.test(e.name) ? e.name : 'Error'
}

/** At most this many distinct classes are named; the rest are counted (F2: a bounded message). */
const MAX_CLASSES = 5

const classes = (es: readonly unknown[]): string => {
  const all = [...new Set(es.map(errorClass))].sort()
  const shown = all.slice(0, MAX_CLASSES).join(', ')
  return all.length > MAX_CLASSES ? `${shown}, +${all.length - MAX_CLASSES} more` : shown
}

/** Counts and error classes only (F2): what readiness may say in public. */
const summarize = (refoldErrors: readonly unknown[], reconcileErrors: ReadonlyArray<{ topic: string, error: unknown }>): string | null => {
  const parts: string[] = []
  if (refoldErrors.length > 0) parts.push(`refold failed for ${refoldErrors.length} token(s) (${classes(refoldErrors)})`)
  for (const { topic, error } of reconcileErrors) parts.push(`reconcile ${topic} failed (${errorClass(error)})`)
  return parts.length === 0 ? null : parts.join('; ')
}

/**
 * Every run, at boot and on the interval, is two steps (Task 13, revision 1):
 *
 * 1. Refold every token with history (rebuildState) inside the exclusive
 *    SUBMIT GATE. The package README ("Boot refold") requires it at boot and
 *    on the reconciler interval: a lookup error between the history append and
 *    the fold leaves an action unfolded (a freeze or pause that does not take
 *    effect), and only a refold repairs it. rebuildState reads then writes
 *    state, so it must never run beside a live fold. One log line per run
 *    gives the token count and duration.
 * 2. Reconcile both topics under the RECONCILE LOCK only, beside live
 *    submits: the reconciler is designed to run beside spends but not beside
 *    an eviction (the engine notifies outputEvicted before deleteOutput), and
 *    eviction holds this lock.
 *
 * The two steps never nest: the refold holds only the gate, the reconcile only
 * the lock, so no step ever holds the gate while waiting on the lock. Eviction
 * takes the lock, then the gate (`reconcileThenSubmitGate`); with nobody
 * waiting on the lock while holding the gate, no wait-for cycle exists.
 *
 * runOnce never rejects: a Mongo blip or a busy lock is recorded, readiness
 * reports degraded, and the next run retries (Review Focus 5). A failed token
 * listing or a busy gate fails the whole run (no reconcile that time); a
 * per-token refold error is recorded and the reconcile still runs.
 *
 * Scheduling (F8) is a setTimeout chain, not setInterval: the next run is
 * armed only once the previous one has settled, so runs never overlap. After a
 * failed run (the boot run included, which is why start() reads the current
 * state) the next one comes sooner: 10s, doubling per consecutive failure,
 * capped at the interval. A successful run returns to the interval.
 */
export class OwnerIndexMaintenance {
  private current: OwnerIndexStatus = { lastRunAt: null, lastError: null, unrepairable: [] }
  private inFlight: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by stop(): a chain armed under an older generation never re-arms. */
  private generation = 0
  private intervalMs = OWNER_INDEX_INTERVAL_MS
  /** Consecutive runs that ended with lastError set. */
  private failures = 0

  constructor (private readonly deps: OwnerIndexDeps) {}

  status (): OwnerIndexStatus {
    return { ...this.current, unrepairable: [...this.current.unrepairable] }
  }

  runOnce (): Promise<void> {
    if (this.inFlight != null) return this.inFlight
    const p = this.run().finally(() => { this.inFlight = null })
    this.inFlight = p
    return p
  }

  /** Step 1: every token with history, inside the exclusive submit gate. A listing failure or a busy gate rejects. */
  private async refold (errors: string[], log: (m: string) => void): Promise<unknown[]> {
    return await this.deps.gate.exclusive(async () => {
      const started = Date.now()
      const refoldErrors: unknown[] = []
      const ids = await this.deps.lookup.tokenIdsWithHistory()
      for (const id of ids) {
        try { await this.deps.lookup.rebuildState(id) } catch (e) { refoldErrors.push(e); errors.push(`refold ${id}: ${errorClass(e)}: ${msg(e)}`) }
      }
      log(`[mandala] owner index refold: ${ids.length} token(s) in ${Date.now() - started}ms`)
      return refoldErrors
    })
  }

  private async run (): Promise<void> {
    const log = this.deps.log ?? (() => {})
    // Hoisted: a reconcile step that cannot start must not lose the refold's summary.
    let refoldErrors: unknown[] = []
    try {
      const errors: string[] = []
      // Step 1, submit gate only (released before step 2).
      refoldErrors = await this.refold(errors, log)
      // Logged now, so a reconcile lock that never frees cannot hide them.
      for (const er of errors.splice(0)) log(`[mandala] owner index error: ${er}`)
      // Step 2, reconcile lock only.
      await this.deps.reconcileLock.exclusive(async () => {
        const reconcileErrors: Array<{ topic: string, error: unknown }> = []
        const unrepairable: string[] = []
        for (const topic of this.deps.topics) {
          try {
            const r = await this.deps.reconcile(topic)
            unrepairable.push(...r.unrepairable)
            log(`[mandala] owner index ${topic}: scanned ${r.scanned}, repaired ${r.repaired}, unrepairable ${r.unrepairable.length}`)
          } catch (e) { reconcileErrors.push({ topic, error: e }); errors.push(`reconcile ${topic}: ${errorClass(e)}: ${msg(e)}`) }
        }
        for (const er of errors) log(`[mandala] owner index error: ${er}`)
        for (const o of unrepairable) log(`[mandala] owner index UNREPAIRABLE outpoint ${o}`)
        this.current = { lastRunAt: new Date().toISOString(), lastError: summarize(refoldErrors, reconcileErrors), unrepairable }
      })
    } catch (e) {
      const refold = summarize(refoldErrors, [])
      const failed = `owner index run failed (${errorClass(e)})`
      this.current = { ...this.current, lastError: refold == null ? failed : `${failed}; ${refold}` }
      try { log(`[mandala] owner index run failed: ${msg(e)}`) } catch { /* logging must not throw */ }
    }
    this.failures = this.current.lastError == null ? 0 : this.failures + 1
  }

  /** The delay before the next scheduled run (F8). */
  private nextDelay (): number {
    if (this.failures === 0) return this.intervalMs
    const backoff = OWNER_INDEX_RETRY_BASE_MS * 2 ** Math.min(this.failures - 1, 30)
    return Math.min(backoff, this.intervalMs)
  }

  private arm (generation: number): void {
    if (generation !== this.generation) return
    const timer = setTimeout(() => {
      if (this.timer === timer) this.timer = null
      // runOnce never rejects; both arms re-arm regardless.
      void this.runOnce().then(() => { this.arm(generation) }, () => { this.arm(generation) })
    }, this.nextDelay())
    timer.unref?.()
    this.timer = timer
  }

  start (intervalMs: number): void {
    this.stop()
    this.intervalMs = intervalMs
    this.arm(this.generation)
  }

  stop (): void {
    this.generation++
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = null
  }

  healthCheck (): Omit<HealthCheckDefinition, 'handler'> & { name: 'mandala-owner-index', scope: 'ready', critical: false, handler: () => Promise<OwnerIndexHealthResult> } {
    return {
      name: 'mandala-owner-index',
      scope: 'ready',
      critical: false,
      handler: async () => {
        const s = this.current
        if (s.lastRunAt == null && s.lastError == null) return { status: 'degraded', message: 'owner index not yet reconciled' }
        if (s.lastError != null) return { status: 'degraded', message: s.lastError }
        if (s.unrepairable.length > 0) {
          return { status: 'degraded', message: `${s.unrepairable.length} owner index rows unrepairable`, details: { unrepairable: [...s.unrepairable] } }
        }
        return { status: 'ok' }
      }
    }
  }
}
