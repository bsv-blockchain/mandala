import { describe, it, expect, vi, afterEach } from 'vitest'
import type { MockTransfer } from '@bsv/mandala/banking'
import { MOCK_BANK_KEY, serializeTransfers, deserializeTransfers } from './mockBankStore'

const MAX = 2n ** 64n - 1n
const ID = `${'a'.repeat(64)}_0`
const t: MockTransfer = { id: 'x', assetId: ID, amount: MAX, direction: 'in' as const, originator: 'Q', timestamp: 1 }

/** Minimal in-memory Storage with an optional seed. */
function memStorage (seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    get length () { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('mockBankStore (bigint feed, decimal-string persistence)', () => {
  it('uses the v2 key', () => {
    expect(MOCK_BANK_KEY).toBe('mandala.mockDeposits.v2')
  })

  it('serializeTransfers round-trips MAX_UINT64 as a decimal string', () => {
    const raw = serializeTransfers([t])
    expect(raw).toContain('"amount":"18446744073709551615"')
    expect(deserializeTransfers(raw)).toEqual([t])
  })

  it('deserializeTransfers drops non-canonical or non-string amounts and corrupt JSON', () => {
    expect(deserializeTransfers(JSON.stringify([{ ...t, amount: '01' }, { ...t, amount: 5 }, { ...t, amount: '-1' }]))).toEqual([])
    expect(deserializeTransfers('{')).toEqual([])
    expect(deserializeTransfers(null)).toEqual([])
  })

  it('deserializeTransfers keeps valid rows and drops malformed ones individually', () => {
    const good = { ...t, amount: '7' }
    const raw = JSON.stringify([good, { ...t, amount: '0' }, { ...t, direction: 'sideways', amount: '1' }, { ...t, id: 3, amount: '1' }, null, 'x'])
    expect(deserializeTransfers(raw)).toEqual([{ ...t, amount: 7n }])
    expect(deserializeTransfers(JSON.stringify({ not: 'an array' }))).toEqual([])
  })

  it('the legacy number-amount key is removed, not migrated', async () => {
    const ls = memStorage({ 'mandala.mockDeposits': JSON.stringify([{ id: 'old', assetId: ID, amount: 5, direction: 'in', originator: 'Q', timestamp: 1 }]) })
    vi.stubGlobal('localStorage', ls)
    vi.resetModules()
    const store = await import('./mockBankStore')
    expect(ls.getItem('mandala.mockDeposits')).toBeNull()
    expect(store.loadMockTransfers()).toEqual([])
  })

  it('writes persist as decimal strings and re-read storage first (a second tab is not overwritten)', async () => {
    const ls = memStorage()
    vi.stubGlobal('localStorage', ls)
    vi.resetModules()
    const store = await import('./mockBankStore')
    store.addMockTransfer(t)
    expect(ls.getItem(MOCK_BANK_KEY)).toContain('"amount":"18446744073709551615"')
    // Another tab appends behind this module's in-memory copy.
    const other = { ...t, id: 'y', amount: 3n }
    ls.setItem(MOCK_BANK_KEY, serializeTransfers([other, t]))
    store.addMockTransfer({ ...t, id: 'z', amount: 1n })
    expect(deserializeTransfers(ls.getItem(MOCK_BANK_KEY)).map(r => r.id)).toEqual(['z', 'y', 'x'])
  })

  it('quota (setItem throws, getItem works): earlier in-memory rows are not dropped', async () => {
    const ls = memStorage()
    ls.setItem = () => { throw new Error('QuotaExceededError') }
    vi.stubGlobal('localStorage', ls)
    vi.resetModules()
    const store = await import('./mockBankStore')
    store.addMockTransfer(t)
    store.addMockTransfer({ ...t, id: 'y' })
    expect(store.currentMockTransfers().map(r => r.id)).toEqual(['y', 'x'])
  })

  it('storage unavailable: mutations still apply in memory', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') }
    })
    vi.resetModules()
    const store = await import('./mockBankStore')
    store.addMockTransfer(t)
    store.addMockTransfer({ ...t, id: 'y' })
    store.removeMockTransfer('x')
    expect(store.loadMockTransfers()).toEqual([])
    expect(store.currentMockTransfers().map(r => r.id)).toEqual(['y'])
  })
})
