import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fetch before importing the module under test
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock import.meta.env so constants resolve cleanly in tests
vi.mock('./constants', () => ({
  OVERLAY_URL: 'http://test-overlay'
}))

import { describeAction, exportAdminHistoryCsv, resolveAdminHistory } from './adminHistory.js'
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
    delta: 0
  }







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
