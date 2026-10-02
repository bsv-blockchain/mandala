/**
 * One idempotent graceful shutdown, shared by every signal.
 *
 * The first call runs `close` exactly once; every later call (a second signal,
 * SIGINT after SIGTERM) joins the same run rather than starting another. A
 * deadline armed at the first call force-exits 1 if `close` hangs, so a stuck
 * drain can never outlive the orchestrator's own kill grace period (compose
 * stop_grace_period is 30s; the signal deadline is 25s).
 */
export interface ShutdownDeps {
  close: () => Promise<void>
  exit: (code?: number) => void
  log: (message: string, err?: unknown) => void
  deadlineMs: number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
}

export const createShutdown = (deps: ShutdownDeps): ((signal: string) => Promise<void>) => {
  let running: Promise<void> | undefined
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  return async (signal: string) => {
    running ??= (async () => {
      deps.log(`[mandala] ${signal} received — draining`)
      setTimer(() => { deps.log('[mandala] shutdown deadline exceeded'); deps.exit(1) }, deps.deadlineMs).unref?.()
      try {
        await deps.close()
        deps.exit(0)
      } catch (e) {
        deps.log('[mandala] shutdown failed', e)
        deps.exit(1)
      }
    })()
    return await running
  }
}
