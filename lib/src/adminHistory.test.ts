import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fetch before importing the module under test
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock import.meta.env so constants resolve cleanly in tests
vi.mock('./constants', () => ({
  OVERLAY_URL: 'http://test-overlay'
}))

import { describeAction, exportAdminHistoryCsv, resolveAdminHistory, resolveAdminSummary } from './adminHistory.js'
import { MAX_UINT64 } from './amount.js'
import type { AdminHistoryRow } from './adminHistory.js'

describe('describeAction', () => {
  it('describes pause in human-readable form', () => {
    expect(describeAction({ kind: 'pause' })).toMatch(/paused/i)
  })

  it('describes unpause in human-readable form', () => {
    expect(describeAction({ kind: 'unpause' })).toMatch(/resum/i)
  })

  it('describes blockIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'blockIdentity', identityKey: '02abcdef' })).toMatch(/block/i)
  })

  it('describes unblockIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'unblockIdentity', identityKey: '02abcdef' })).toMatch(/unblock/i)
  })

  it('describes allowIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'allowIdentity', identityKey: '02abcdef' })).toMatch(/allowlist/i)
  })

  it('describes unallowIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'unallowIdentity', identityKey: '02abcdef' })).toMatch(/allowlist/i)
  })

  it('describes reissue in human-readable form', () => {
    expect(describeAction({ kind: 'reissue', outpoint: 'y.1', recipient: '03cd' })).toMatch(/reissu/i)
  })





  it('describes setFeeRate in human-readable form', () => {
    expect(describeAction({ kind: 'setFeeRate' as any, feeRatePerKb: 25 } as any)).toBe('Fee rate set to 25 units/KB')
  })

  it('describes setFeeRate with a null rate as disabling issuer-paid fees', () => {
    expect(describeAction({ kind: 'setFeeRate' as any, feeRatePerKb: null } as any)).toBe('Issuer-paid fees disabled')
  })

  it('describes issue in human-readable form', () => {
    expect(describeAction({ kind: 'issue' })).toMatch(/issu/i)
  })

  it('renders the committed deposit-record hash (bankRef) for issue, and omits it when absent (A14)', () => {
    const ref = 'f'.repeat(64)
    const withRef = describeAction({ kind: 'issue', bankRef: ref })
    expect(withRef).toMatch(/issu/i)
    expect(withRef).toContain(ref)
    expect(describeAction({ kind: 'issue' })).not.toMatch(/bankRef/)
  })

  it('describes redeem in human-readable form', () => {
    expect(describeAction({ kind: 'redeem' })).toMatch(/redeem/i)
  })

  it('describes a legacy recover record without referencing the removed kind', () => {
    // 'recover' is no longer a valid MandalaActionKind, but legacy on-chain
    // records may still carry it — the describer must handle it gracefully.
    expect(describeAction({ kind: 'recover', recipient: '03ab' } as any)).toMatch(/recover/i)
  })

  it('describes setAccessMode in human-readable form', () => {
    expect(describeAction({ kind: 'setAccessMode', mode: 'allowlist' })).toMatch(/access mode/i)
  })

  it('describes freezeOutput in human-readable form', () => {
    expect(describeAction({ kind: 'freezeOutput', outpoint: 'abc.0' })).toMatch(/froze/i)
  })

  it('describes unfreezeOutput in human-readable form', () => {
    expect(describeAction({ kind: 'unfreezeOutput', outpoint: 'abc.0' })).toMatch(/unfroze/i)
  })
})

describe('exportAdminHistoryCsv', () => {
  const row: AdminHistoryRow = {
    assetId: 'x.0',
    txid: 't1',
    outputIndex: 0,
    height: 100,
    offset: 1,
    actionDetails: { kind: 'pause' },
    detailsHex: '',
    commitment: '',
    delta: 0n
  }

  it('prints a bigint delta exactly', () => {
    const csv = exportAdminHistoryCsv([{ ...row, actionDetails: { kind: 'issue' }, delta: MAX_UINT64 }])
    expect(csv).toContain(',18446744073709551615,')
    expect(csv).toContain('Issued 18446744073709551615 units')
  })







  it('returns just a header row for empty input', () => {
    const csv = exportAdminHistoryCsv([])
    expect(csv.split('\n')).toHaveLength(1)
    expect(csv).toContain('txid')
  })
})

describe('resolveAdminHistory', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })


  const body = (over: Record<string, unknown>): Record<string, unknown> => ({
    tokenId: 'x.0', txid: 't1', outputIndex: 0, kind: 'issue', detailsHex: '', commitment: '', height: 1, offset: 0, delta: '0', ...over
  })

  it('reads delta as an exact signed bigint and drops a non-string delta with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        body({ txid: 'max', delta: '18446744073709551615' }),
        body({ txid: 'neg', kind: 'redeem', delta: '-5' }),
        body({ txid: 'num', delta: 5 }),
        body({ txid: 'neg0', delta: '-0' })
      ]
    })
    const rows = await resolveAdminHistory('x.0')
    expect(rows.map(r => r.txid)).toEqual(['max', 'neg'])
    expect(rows[0].delta).toBe(MAX_UINT64)
    expect(rows[1].delta).toBe(-5n)
    expect(describeAction({ kind: 'redeem' }, rows[1].delta)).toBe('Redeemed (burned) 5 units')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('reads summary totals as exact bigints above 2^64', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ totalIssued: '36893488147419103230', totalRedeemed: '7', actionCount: 3 })
    })
    expect(await resolveAdminSummary('x.0')).toEqual({ totalIssued: 36893488147419103230n, totalRedeemed: 7n, actionCount: 3 })
  })

  it('refuses a summary whose totals are not decimal strings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ totalIssued: 10, totalRedeemed: '7', actionCount: 3 }) })
    expect(await resolveAdminSummary('x.0')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('returns [] on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
    const result = await resolveAdminHistory('x.0')
    expect(result).toEqual([])
  })

  it('returns [] when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'))
    const result = await resolveAdminHistory('x.0')
    expect(result).toEqual([])
  })

  it('encodes assetId in the URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })
    await resolveAdminHistory('asset/with spaces')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-overlay/admin/admin-history/asset%2Fwith%20spaces'
    )
  })
})
