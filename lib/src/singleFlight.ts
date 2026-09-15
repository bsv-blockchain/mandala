/**
 * Synchronous single-flight latch. Blocks a second activation before React
 * re-renders `isPending` / `disabled`, so double-click / re-entry cannot start
 * two wallet pipelines. Pure and unit-testable outside React.
 */

export class BusyError extends Error {
  readonly code = 'BUSY' as const
  constructor(message = 'Operation already in progress') {
    super(message)
    this.name = 'BusyError'
  }
}

export interface SingleFlight {
  /** True if a pipeline is currently held. */
  isHeld(): boolean
  /**
   * Acquire the latch. Returns true if this caller owns it, false if already
   * held (caller must no-op — do not start work).
   */
  tryAcquire(): boolean
  /** Release after settle (success or failure). Idempotent. */
  release(): void
  /**
   * Run `fn` under the latch. Throws BusyError if already held; always
   * releases in `finally` when this call acquired.
   */
  run<T>(fn: () => Promise<T>): Promise<T>
}

export function createSingleFlight(label = 'operation'): SingleFlight {
  let held = false
  return {
    isHeld: () => held,
    tryAcquire: () => {
      if (held) return false
      held = true
      return true
    },
    release: () => {
      held = false
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (held) throw new BusyError(`${label} already in progress`)
      held = true
      try {
        return await fn()
      } finally {
        held = false
      }
    }
  }
}

/** Process-wide send latch — one holder transfer pipeline at a time. */
export const sendFlight = createSingleFlight('send')

/** Process-wide register latch — one genesis register at a time. */
export const registerFlight = createSingleFlight('register')

/** Overlay-wide identity registry chain — one admit/revoke/open at a time. */
export const registryFlight = createSingleFlight('registry')
