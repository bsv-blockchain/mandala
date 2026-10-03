import type { HealthCheckDefinition } from '@bsv/overlay-express'
import type { MaintenanceGate } from './maintenanceGate.js'

export const OWNER_INDEX_INTERVAL_MS = 300_000

export interface OwnerIndexDeps {
  gate: MaintenanceGate
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
 * Boot refold + per-topic owner-index reconcile, repeated on an interval. Runs
 * inside the exclusive maintenance gate (refold reads then writes state and
 * must not interleave with a live fold). runOnce never rejects: a Mongo blip
 * or a busy gate is recorded, readiness reports degraded, and the next
 * interval retries (Review Focus 5).
 */
export class OwnerIndexMaintenance {
  private current: OwnerIndexStatus = { lastRunAt: null, lastError: null, unrepairable: [] }
  private inFlight: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

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

  private async run (): Promise<void> {
    const log = this.deps.log ?? (() => {})
    try {
      await this.deps.gate.exclusive(async () => {
        const errors: string[] = []
        const refoldErrors: unknown[] = []
        const reconcileErrors: Array<{ topic: string, error: unknown }> = []
        const unrepairable: string[] = []
        const ids = await this.deps.lookup.tokenIdsWithHistory()
        for (const id of ids) {
          try { await this.deps.lookup.rebuildState(id) } catch (e) { refoldErrors.push(e); errors.push(`refold ${id}: ${errorClass(e)}: ${msg(e)}`) }
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
  }

  start (intervalMs: number): void {
    this.stop()
    this.timer = setInterval(() => { void this.runOnce() }, intervalMs)
    this.timer.unref()
  }

  stop (): void {
    if (this.timer != null) clearInterval(this.timer)
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
