/**
 * Injected persistence for the journals (txJournal, notifyJournal,
 * blindingJournal) — D3c.
 *
 * WHY THIS EXISTS. The journals are the recovery contract: an
 * overlay-accepted-but-not-yet-broadcast transaction is only recoverable
 * because the 'accepted' entry outlives the process that wrote it. On the web
 * that durability came from `localStorage`. On React Native there is no
 * `localStorage`, so the old `typeof localStorage` guard silently fell through
 * to a process-lifetime Map — i.e. the journals died with the process and an
 * interrupted broadcast became unrecoverable. **A React-Native host MUST inject
 * an adapter** (e.g. over `StorageExpoSQLite.getKeyValue`/`setKeyValue`) with
 * `configureStorage(...)` or `configureMandala({ storage })` before any
 * pipeline runs; the built-in fallback below is explicitly not durable there.
 *
 * The interface is async because every durable RN store is. That asyncness is
 * load-bearing, not cosmetic: `journalPut` is awaited at the commit point in
 * `submitAndBroadcast` so the network broadcast provably starts only after the
 * entry has landed.
 *
 * There is deliberately NO in-memory mirror in front of the adapter. The store
 * is the single source of truth, so a second reader (another tab on web, a
 * later read in the same process) can never be served a stale entry that a
 * mirror kept alive after the store moved on.
 */

export interface MandalaStorage {
  /** The stored string, or null when the key is absent. */
  getItem: (key: string) => Promise<string | null>
  /** Insert or replace. Must be atomic per key (journals rely on it). */
  setItem: (key: string, value: string) => Promise<void>
  /** Remove; absent keys are not an error. */
  removeItem: (key: string) => Promise<void>
  /** Every key currently stored whose name starts with `prefix`. */
  keys: (prefix: string) => Promise<string[]>
}

/**
 * An isolated in-memory store. Exported for tests and for hosts that
 * deliberately want a throwaway journal — never durable.
 */
export function memoryStorage (): MandalaStorage {
  const map = new Map<string, string>()
  return {
    getItem: async key => map.get(key) ?? null,
    setItem: async (key, value) => { map.set(key, value) },
    removeItem: async key => { map.delete(key) },
    keys: async prefix => [...map.keys()].filter(key => key.startsWith(prefix))
  }
}

/** The same guard the journals used to carry, in one place. */
function webStorage (): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    // Some embedders throw on the property access itself (blocked cookies).
    return null
  }
}

/**
 * Process-lifetime fallback, used ONLY when there is no localStorage at all
 * (Node tests, SSR, and — unless the host injects an adapter — React Native,
 * where it means the journals are not durable).
 */
const processMemory = memoryStorage()

/**
 * Default adapter: localStorage when the platform has it, otherwise the
 * process-memory fallback. The guard is re-evaluated per call so a host that
 * installs a polyfill after import still gets the durable path.
 */
export const defaultStorage: MandalaStorage = {
  getItem: async key => {
    const ls = webStorage()
    return ls == null ? await processMemory.getItem(key) : ls.getItem(key)
  },
  setItem: async (key, value) => {
    const ls = webStorage()
    if (ls == null) { await processMemory.setItem(key, value); return }
    ls.setItem(key, value)
  },
  removeItem: async key => {
    const ls = webStorage()
    if (ls == null) { await processMemory.removeItem(key); return }
    ls.removeItem(key)
  },
  keys: async prefix => {
    const ls = webStorage()
    if (ls == null) return await processMemory.keys(prefix)
    const out: string[] = []
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i)
      if (key != null && key.startsWith(prefix)) out.push(key)
    }
    return out
  }
}

let adapter: MandalaStorage = defaultStorage

/**
 * Install the host's storage adapter. Pass `null` to go back to the default
 * (what tests do between cases). Takes effect immediately for every journal —
 * nothing is cached from the previous adapter.
 */
export function configureStorage (storage: MandalaStorage | null | undefined): void {
  adapter = storage ?? defaultStorage
}

/** The adapter in force. Read it per operation — never hold on to it. */
export function getStorage (): MandalaStorage {
  return adapter
}
