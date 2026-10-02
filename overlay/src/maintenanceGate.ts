import type { RequestHandler } from 'express'

/**
 * Quiesces /submit while state maintenance runs (package README "Boot refold",
 * "Eviction"): refold reads then writes asset state and must never interleave
 * with a live fold. Submits share the gate; maintenance is exclusive, waits for
 * in-flight submits to drain, and blocks new ones while it waits (writer
 * preference, so a busy overlay cannot starve the reconciler).
 */
export class MaintenanceGate {
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
    try {
      while (this.exclusiveActive || this.shared > 0) {
        await new Promise<void>(r => this.waiters.push(r))
      }
    } finally {
      this.exclusiveWaiting--
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

/** Holds a shared slot for the life of one /submit response. */
export const gateSubmits = (gate: MaintenanceGate): RequestHandler => (req, res, next) => {
  gate.enter().then(release => {
    res.once('finish', release)
    res.once('close', release)
    next()
  }, next)
}
