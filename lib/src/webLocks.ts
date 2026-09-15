/**
 * Cross-tab mutual exclusion via the Web Locks API, with an in-process
 * fallback for environments without it (Node, tests, very old browsers).
 *
 * The in-process gates (singleFlight, adminAuthGate) stop same-tab re-entry
 * synchronously; these locks extend the same guarantee across tabs of the
 * same origin. Cross-DEVICE races remain — the overlay's admission check and
 * assertSpendablePrior are the backstop there.
 *
 * Lock names in use (one per cross-tab-exclusive pipeline):
 *   'mandala.send'             — holder transfer (transfer.ts)
 *   'mandala.register'         — asset genesis (issuerOps.ts registerAsset);
 *                                registerFlight covers same-tab re-entry only
 *   'mandala.admin.<assetId>'  — per-asset admin-auth spend (adminAuthGate.ts)
 *   'mandala.reconcile'        — the recovery pass (reconcile.ts)
 */

export interface TryLockResult<T> {
  /** False when another holder (tab or in-process caller) owns the lock. */
  acquired: boolean
  result?: T
}

const localHeld = new Set<string>()

interface LocksApi {
  request: (
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>
  ) => Promise<unknown>
}

function locksApi (): LocksApi | null {
  const locks = (globalThis as { navigator?: { locks?: LocksApi } }).navigator?.locks
  return locks?.request != null ? locks : null
}

/**
 * Run `fn` holding the named lock, or report `acquired: false` without
 * queueing when it is already held. Never blocks waiting for the lock —
 * callers decide whether "busy" means skip (reconcile) or reject (pipelines).
 */
export async function tryWithLock<T> (
  name: string,
  fn: () => Promise<T>
): Promise<TryLockResult<T>> {
  const locks = locksApi()
  if (locks != null) {
    return await locks.request(name, { ifAvailable: true }, async lock => {
      if (lock == null) return { acquired: false }
      return { acquired: true, result: await fn() }
    }) as TryLockResult<T>
  }
  if (localHeld.has(name)) return { acquired: false }
  localHeld.add(name)
  try {
    return { acquired: true, result: await fn() }
  } finally {
    localHeld.delete(name)
  }
}
