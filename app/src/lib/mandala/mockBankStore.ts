/**
 * Shared store of the demo bank transfer feed (see banking.ts), scoped per
 * asset — switching assets must switch the bank balance, transaction
 * history, and reconciliation with it. A module-level store rather than
 * component state so the Banking page (which adds transfers) and the
 * Overview reserve-ratio KPI (which reads them) stay honestly in sync — the
 * KPI must reflect real added transfers, not a second, disconnected copy of
 * mock data. Same useSyncExternalStore idiom as devMode.ts.
 *
 * Demo-only persistence in localStorage so the feed survives a reload; the
 * Banking page offers per-row delete and an explicit "clear all" (scoped to
 * the active asset only). Starts empty and is never pre-seeded: this is a
 * sandbox feed standing in for a real bank connection, not a source of
 * fabricated reserve numbers.
 *
 * Amounts are exact `bigint` in memory and canonical decimal strings on disk
 * (contract §0): a `bigint` never reaches `JSON.stringify`. The pre-1Color key
 * (`mandala.mockDeposits`, number amounts) is deleted on load, not migrated.
 *
 * Robustness: every storage access is in try/catch (private mode, quota,
 * blocked storage) and the in-memory copy keeps working without it. Corrupt
 * or hand-edited rows are dropped one by one, never crash the page. Each
 * mutation re-reads storage first and the `storage` event refreshes this tab,
 * so two open tabs do not overwrite each other's transfers.
 */
import { useSyncExternalStore } from 'react'
import { parseDecimalAmount } from '@bsv/mandala'
import type { MockTransfer } from '@bsv/mandala/banking'

export const MOCK_BANK_KEY = 'mandala.mockDeposits.v2'
const LEGACY_KEY = 'mandala.mockDeposits'

/** JSON form of the feed; `amount` is a canonical decimal string. */
export function serializeTransfers (ts: MockTransfer[]): string {
  return JSON.stringify(ts.map(t => ({
    id: t.id,
    assetId: t.assetId,
    amount: t.amount.toString(),
    direction: t.direction,
    originator: t.originator,
    timestamp: t.timestamp
  })))
}

function toTransfer (v: unknown): MockTransfer | null {
  if (v === null || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const amount = parseDecimalAmount(r.amount)
  if (amount === null || amount <= 0n) return null
  if (typeof r.id !== 'string' || typeof r.assetId !== 'string' || typeof r.originator !== 'string') return null
  if (r.direction !== 'in' && r.direction !== 'out') return null
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return null
  return { id: r.id, assetId: r.assetId, amount, direction: r.direction, originator: r.originator, timestamp: r.timestamp }
}

/** Parse a persisted feed; corrupt JSON gives `[]`, malformed rows are dropped. */
export function deserializeTransfers (raw: string | null): MockTransfer[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: MockTransfer[] = []
  for (const v of parsed) {
    const t = toTransfer(v)
    if (t !== null) out.push(t)
  }
  return out
}

/** The persisted feed, or `null` when storage is unavailable (caller keeps its in-memory copy). */
function readStored (): MockTransfer[] | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return deserializeTransfers(localStorage.getItem(MOCK_BANK_KEY))
  } catch {
    return null
  }
}

/** Load the persisted feed (removing the legacy number-amount key); `[]` without storage. */
export function loadMockTransfers (): MockTransfer[] {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_KEY)
  } catch { /* unavailable — nothing to clean up */ }
  return readStored() ?? []
}

let transfers: MockTransfer[] = loadMockTransfers()
const listeners = new Set<() => void>()

function notify (): void {
  listeners.forEach(l => l())
}

/** Read-modify-write against the freshest copy (another tab may have written since). */
function update (fn: (current: MockTransfer[]) => MockTransfer[]): void {
  const next = fn(readStored() ?? transfers)
  transfers = next
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MOCK_BANK_KEY, serializeTransfers(next))
  } catch { /* quota/unavailable — in-memory copy still holds */ }
  notify()
}

// Another tab changed the feed: adopt its copy (`key === null` is a storage clear).
try {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== MOCK_BANK_KEY && e.key !== null) return
      transfers = deserializeTransfers(e.key === null ? null : e.newValue)
      notify()
    })
  }
} catch { /* no window events — single-tab behaviour */ }

export function addMockTransfer (t: MockTransfer): void {
  update(cur => [t, ...cur.filter(x => x.id !== t.id)])
}

/** Remove a single transfer (per-row delete on the Banking page). */
export function removeMockTransfer (id: string): void {
  update(cur => cur.filter(t => t.id !== id))
}

/** Wipe the demo feed for one asset only (manual "clear all" on the Banking page). */
export function clearMockTransfers (assetId: string): void {
  update(cur => cur.filter(t => t.assetId !== assetId))
}

/** Current in-memory feed (all assets). */
export function currentMockTransfers (): MockTransfer[] {
  return transfers
}

function subscribe (cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

const EMPTY: MockTransfer[] = []

/** Reactive read of the demo transfer feed for one asset. */
export function useMockTransfers (assetId: string): MockTransfer[] {
  const all = useSyncExternalStore(subscribe, currentMockTransfers, currentMockTransfers)
  return assetId === '' ? EMPTY : all.filter(t => t.assetId === assetId)
}
