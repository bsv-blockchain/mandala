import type { RequestHandler } from 'express'

/**
 * Quiesces /submit while state maintenance runs (package README "Boot refold",
 * "Eviction"): refold reads then writes asset state and must never interleave
 * with a live fold. Submits share the gate; maintenance is exclusive, waits for
 * in-flight submits to drain, and blocks new ones while it waits (writer
 * preference, so a busy overlay cannot starve the reconciler).
 *
 * NOT re-entrant: never call enter()/exclusive() from inside an exclusive fn,
 * and never call exclusive() while holding a shared slot (deadlock until the
 * drain timeout rejects it). /arc-ingest must not be mounted behind
 * gateSubmits.
 *
 * An exclusive that cannot acquire within drainTimeoutMs stops waiting and
 * rejects with MaintenanceBusyError (fn is not run).
 *
 * A second, exclusive-only instance is the RECONCILE LOCK (Task 13): the
 * owner-index reconciler runs beside live submits but never beside an
 * eviction (the engine notifies outputEvicted before deleteOutput). Lock order
 * is fixed everywhere: the reconcile lock first, then this submit gate. Never
 * take the reconcile lock from inside a submit-gate exclusive or while holding
 * a shared slot; submits never take it at all.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000

export class MaintenanceBusyError extends Error {
  constructor (inFlight: number) {
    super(`maintenance gate busy: ${inFlight} in-flight submit(s) did not drain`)
    this.name = 'MaintenanceBusyError'
  }
}

export class MaintenanceGate {
  private readonly drainTimeoutMs: number
  constructor (opts: { drainTimeoutMs?: number } = {}) {
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  }

  private shared = 0
  private exclusiveActive = false
  private exclusiveWaiting = 0
  private readonly waiters: Array<() => void> = []

  get busy (): boolean { return this.shared > 0 || this.exclusiveActive }

  private wake (): void {
    const ws = this.waiters.splice(0)
    for (const w of ws) w()
  }

  async enter (): Promise<() => void> {
    while (this.exclusiveActive || this.exclusiveWaiting > 0) {
      await new Promise<void>(r => this.waiters.push(r))
    }
    this.shared++
    let released = false
    return () => {
      if (released) return
      released = true
      this.shared--
      if (this.shared === 0) this.wake()
    }
  }

  async exclusive<T> (fn: () => Promise<T>): Promise<T> {
    this.exclusiveWaiting++
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; this.wake() }, this.drainTimeoutMs)
    timer.unref()
    try {
      while (this.exclusiveActive || this.shared > 0) {
        if (timedOut) throw new MaintenanceBusyError(this.shared)
        await new Promise<void>(r => this.waiters.push(r))
      }
    } finally {
      clearTimeout(timer)
      this.exclusiveWaiting--
      if (timedOut) this.wake()
    }
    this.exclusiveActive = true
    try {
      return await fn()
    } finally {
      this.exclusiveActive = false
      this.wake()
    }
  }
}

/**
 * Holds a shared slot until the response's end() is INVOKED (not on
 * finish/close): the route only calls res.json -> res.end after engine.submit
 * and the settle returned, and Express invokes end even on a destroyed socket,
 * so the slot spans the whole fold regardless of client abort.
 */
export const gateSubmits = (gate: MaintenanceGate): RequestHandler => (req, res, next) => {
  gate.enter().then(release => {
    const end = res.end
    res.end = function (this: unknown, ...args: unknown[]) {
      release()
      return (end as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof res.end
    next()
  }, next)
}

/**
 * Holds the reconcile lock, then the submit gate's exclusive, around fn: the
 * eviction quiesce (and the only order either lock is ever nested in). Each
 * wait is bounded by its instance's drain timeout, so the whole acquisition
 * gives up within the sum of the two with MaintenanceBusyError and fn not run.
 */
export const reconcileThenSubmitGate = (reconcileLock: MaintenanceGate, submitGate: MaintenanceGate) =>
  async <T>(fn: () => Promise<T>): Promise<T> =>
    await reconcileLock.exclusive(async () => await submitGate.exclusive(fn))
