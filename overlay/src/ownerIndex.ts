import type { HealthCheckDefinition } from '@bsv/overlay-express'
import type { MaintenanceGate } from './maintenanceGate.js'

/** Task 13 — the interval run reconciles only, beside live submits; 30 min. */
export const OWNER_INDEX_INTERVAL_MS = 1_800_000
/** F8 — the first retry after a failed run; doubles per consecutive failure, capped at the interval. */
export const OWNER_INDEX_RETRY_BASE_MS = 10_000

export interface OwnerIndexDeps {
  /** The submit gate (shared by /submit): taken exclusive only for a refold. */
  gate: MaintenanceGate
  /** The reconcile lock (exclusive-only, shared with eviction): held for every run. */
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

const classes = (es: readonly unknown[]): string => [...new Set(es.map(errorClass))].sort().join(', ')

/** Counts and error classes only (F2): what readiness may say in public. */
const summarize = (refoldErrors: readonly unknown[], reconcileErrors: ReadonlyArray<{ topic: string, error: unknown }>): string | null => {
  const parts: string[] = []
  if (refoldErrors.length > 0) parts.push(`refold failed for ${refoldErrors.length} token(s) (${classes(refoldErrors)})`)
  for (const { topic, error } of reconcileErrors) parts.push(`reconcile ${topic} failed (${errorClass(error)})`)
  return parts.length === 0 ? null : parts.join('; ')
}

/**
 * Boot refold + per-topic owner-index reconcile; the reconcile alone repeats on
 * an interval (Task 13). runOnce never rejects: a Mongo blip or a busy lock is
 * recorded, readiness reports degraded, and the next run retries (Review
 * Focus 5).
 *
 * Every run holds the RECONCILE LOCK, which only eviction shares: the
 * reconciler is designed to run beside spends but not beside an eviction (the
 * engine notifies outputEvicted before deleteOutput). The refold
 * (rebuildState) reads then writes state and must never interleave with a live
 * fold, so it runs inside the exclusive SUBMIT GATE, taken inside the
 * reconcile lock (fixed order: reconcile lock, then submit gate; eviction uses
 * the same). The gate is released before the reconcile, so /submit only ever
 * waits for a refold.
 *
 * The refold is a boot duty (README "Boot refold"): the first run refolds, and
 * every later run refolds too until one pass has refolded every token without
 * error (a failed listing or a busy gate also leaves it pending). After that,
 * runs are reconcile-only. Eviction refolds the tokens it touches itself.
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
  /** True until one refold pass covered every token without error. */
  private refoldPending = true

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

  /** Every token with history, inside the exclusive submit gate. A listing failure or a busy gate rejects. */
  private async refold (errors: string[]): Promise<unknown[]> {
    return await this.deps.gate.exclusive(async () => {
      const refoldErrors: unknown[] = []
      const ids = await this.deps.lookup.tokenIdsWithHistory()
      for (const id of ids) {
        try { await this.deps.lookup.rebuildState(id) } catch (e) { refoldErrors.push(e); errors.push(`refold ${id}: ${errorClass(e)}: ${msg(e)}`) }
      }
      return refoldErrors
    })
  }

  private async run (): Promise<void> {
    const log = this.deps.log ?? (() => {})
    try {
      await this.deps.reconcileLock.exclusive(async () => {
        const errors: string[] = []
        const reconcileErrors: Array<{ topic: string, error: unknown }> = []
        const unrepairable: string[] = []
        let refoldErrors: unknown[] = []
        if (this.refoldPending) {
          refoldErrors = await this.refold(errors)
          if (refoldErrors.length === 0) this.refoldPending = false
        }
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
      this.current = { ...this.current, lastError: `owner index run failed (${errorClass(e)})` }
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
