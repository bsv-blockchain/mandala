import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureMandala } from './constants.js'
import { fetchOverlayActivity, flattenActivityPages, describeActivity, ActivityEntry } from './overlayActivity.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  txid: 't1',
  when: '2026-07-07T00:00:00.000Z',
  assetId: 'a.0',
  kind: 'transfer',
  from: 'alice',
  to: 'bob',
  amount: 30n,
  proofs: [],
  ...over
})

const emptyPage = () => ({ ok: true, json: async () => ({ entries: [], nextCursor: null }) })

describe('fetchOverlayActivity', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    configureMandala({ overlayUrl: 'http://test-overlay', adminApiToken: '' })
  })

  it('requests a bounded page and no assetId filter when none given', async () => {
    mockFetch.mockResolvedValueOnce(emptyPage())
    await fetchOverlayActivity()
    expect(mockFetch).toHaveBeenCalledWith('http://test-overlay/admin/activity?limit=100', { headers: {} })
  })

  it('encodes assetId, limit, and the cursor into the query string', async () => {
    mockFetch.mockResolvedValueOnce(emptyPage())
    await fetchOverlayActivity('tx id.0', { limit: 50, before: '2026-07-07T00:00:00.000Z' })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-overlay/admin/activity?assetId=tx+id.0&limit=50&before=2026-07-07T00%3A00%3A00.000Z',
      { headers: {} }
    )
  })

  it('sends the admin bearer token once configured (identity-bearing route)', async () => {
    configureMandala({ adminApiToken: 'tok' })
    mockFetch.mockResolvedValueOnce(emptyPage())
    await fetchOverlayActivity('a.0')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-overlay/admin/activity?assetId=a.0&limit=100',
      { headers: { Authorization: 'Bearer tok' } }
    )
  })

  it('throws before fetching when configureMandala has not set the overlay URL', async () => {
    configureMandala({ overlayUrl: '' })
    await expect(fetchOverlayActivity('a.0')).rejects.toThrow(/configureMandala/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns parsed page with cursor', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [{ ...entry({}), amount: '30' }], nextCursor: 'c1' }) })
    const page = await fetchOverlayActivity('a.0')
    expect(page.entries).toHaveLength(1)
    expect(page.nextCursor).toBe('c1')
  })

  it('reads entry amounts as exact bigints, accepts the wire tokenId, and drops a non-string amount with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wire = (over: Record<string, unknown>): Record<string, unknown> =>
      ({ txid: 't', when: 'w', tokenId: 'a.0', kind: 'transfer', from: null, to: null, proofs: [], ...over })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [wire({ txid: 'ok', amount: '7' }), wire({ txid: 'num', amount: 7 }), wire({ txid: 'max', amount: '18446744073709551615' })],
        nextCursor: null
      })
    })
    const page = await fetchOverlayActivity('a.0')
    expect(page.entries.map(e => e.txid)).toEqual(['ok', 'max'])
    expect(page.entries[0].amount).toBe(7n)
    expect(page.entries[0].assetId).toBe('a.0')
    expect(page.entries[1].amount).toBe(18446744073709551615n)
    expect(describeActivity(page.entries[0])).toBe('Transferred 7 units')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('throws on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(fetchOverlayActivity('a.0')).rejects.toThrow('500')
  })

  it('returns an empty page for a malformed body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nope: true }) })
    expect(await fetchOverlayActivity('a.0')).toEqual({ entries: [], nextCursor: null })
  })
})

describe('flattenActivityPages', () => {
  it('concatenates pages preserving order', () => {
    const out = flattenActivityPages([
      { entries: [entry({ txid: 'a' }), entry({ txid: 'b' })], nextCursor: 'c' },
      { entries: [entry({ txid: 'c' })], nextCursor: null }
    ])
    expect(out.map(e => e.txid)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes a boundary tx re-served by the inclusive cursor (first occurrence wins)', () => {
    const newer = entry({ txid: 'dup', amount: 99n })
    const older = entry({ txid: 'dup', amount: 1n })
    const out = flattenActivityPages([
      { entries: [entry({ txid: 'a' }), newer], nextCursor: 'c' },
      { entries: [older, entry({ txid: 'b' })], nextCursor: null }
    ])
    expect(out.map(e => e.txid)).toEqual(['a', 'dup', 'b'])
    expect(out.find(e => e.txid === 'dup')?.amount).toBe(99n)
  })
})

describe('describeActivity', () => {
  it('describes each kind', () => {
    expect(describeActivity(entry({ kind: 'issue', amount: 100n }))).toBe('Issued 100 units')
    expect(describeActivity(entry({ kind: 'transfer', amount: 30n }))).toBe('Transferred 30 units')
    expect(describeActivity(entry({ kind: 'self', amount: 0n }))).toBe('Transferred 0 units to self')
    expect(describeActivity(entry({ kind: 'redeem', amount: 25n }))).toBe('Redeemed (burned) 25 units')
  })
})
