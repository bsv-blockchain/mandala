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
import { MandalaAdmin } from '@bsv/templates'

describe('describeAction', () => {
  it('describes pause in human-readable form', () => {
    expect(describeAction({ kind: 'pause', assetId: 'x.0' })).toMatch(/paused/i)
  })

  it('describes unpause in human-readable form', () => {
    expect(describeAction({ kind: 'unpause', assetId: 'x.0' })).toMatch(/resum/i)
  })

  it('describes blockIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'blockIdentity', assetId: 'x.0', identityKey: '02abcdef' })).toMatch(/block/i)
  })

  it('describes unblockIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'unblockIdentity', assetId: 'x.0', identityKey: '02abcdef' })).toMatch(/unblock/i)
  })

  it('describes allowIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'allowIdentity', assetId: 'x.0', identityKey: '02abcdef' })).toMatch(/allowlist/i)
  })

  it('describes unallowIdentity in human-readable form', () => {
    expect(describeAction({ kind: 'unallowIdentity', assetId: 'x.0', identityKey: '02abcdef' })).toMatch(/allowlist/i)
  })

  it('describes reissue in human-readable form', () => {
    expect(describeAction({ kind: 'reissue', assetId: 'x.0', outpoint: 'y.1', amount: 30, recipient: '03cd' })).toMatch(/reissu/i)
  })

  it('describes register using the genesis label/ticker, not assetId', () => {
    const desc = describeAction({ kind: 'register', label: 'Gold Coin', ticker: 'GLD', decimals: 2, issuer: '02ab' })
    expect(desc).toMatch(/register/i)
    expect(desc).toContain('Gold Coin')
    expect(desc).toContain('GLD')
    expect(desc).not.toContain('undefined')
  })

  it('describes register without a ticker by omitting the parenthetical', () => {
    const desc = describeAction({ kind: 'register', label: 'Gold Coin' })
    expect(desc).toBe('Registered asset "Gold Coin"')
  })

  it('describes issue in human-readable form', () => {
    expect(describeAction({ kind: 'issue', assetId: 'x.0', amount: 500 })).toMatch(/issu/i)
  })

  it('renders the committed deposit-record hash (bankRef) for issue, and omits it when absent (A14)', () => {
    const ref = 'f'.repeat(64)
    const withRef = describeAction({ kind: 'issue', assetId: 'x.0', amount: 500, bankRef: ref })
    expect(withRef).toMatch(/issu/i)
    expect(withRef).toContain(ref)
    expect(describeAction({ kind: 'issue', assetId: 'x.0', amount: 500 })).not.toMatch(/bankRef/)
  })

  it('describes redeem in human-readable form', () => {
    expect(describeAction({ kind: 'redeem', assetId: 'x.0', amount: 100 })).toMatch(/redeem/i)
  })

  it('describes a legacy recover record without referencing the removed kind', () => {
    // 'recover' is no longer a valid MandalaActionKind, but legacy on-chain
    // records may still carry it — the describer must handle it gracefully.
    expect(describeAction({ kind: 'recover' as any, assetId: 'x.0', amount: 50, recipient: '03ab' })).toMatch(/recover/i)
  })

  it('describes setAccessMode in human-readable form', () => {
    expect(describeAction({ kind: 'setAccessMode', assetId: 'x.0', mode: 'allowlist' })).toMatch(/access mode/i)
  })

  it('describes freezeOutput in human-readable form', () => {
    expect(describeAction({ kind: 'freezeOutput', assetId: 'x.0', outpoint: 'abc.0' })).toMatch(/froze/i)
  })

  it('describes unfreezeOutput in human-readable form', () => {
    expect(describeAction({ kind: 'unfreezeOutput', assetId: 'x.0', outpoint: 'abc.0' })).toMatch(/unfroze/i)
  })
})

describe('exportAdminHistoryCsv', () => {
  const row: AdminHistoryRow = {
    assetId: 'x.0',
    txid: 't1',
    outputIndex: 0,
    height: 100,
    offset: 1,
    actionDetails: { kind: 'pause', assetId: 'x.0', priorOutpoint: 'p.0' }
  }

  it('CSV header contains all required columns', () => {
    const csv = exportAdminHistoryCsv([row])
    const header = csv.split('\n')[0]
    expect(header).toContain('txid')
    expect(header).toContain('outputIndex')
    expect(header).toContain('priorOutpoint')
    expect(header).toContain('kind')
    expect(header).toContain('canonicalDetailsJson')
    expect(header).toContain('commitment')
    expect(header).toContain('height')
    expect(header).toContain('offset')
    expect(header).toContain('description')
    expect(header).toContain('bankRef')
  })

  it('bankRef column carries the issue deposit hash and is empty for ref-less rows (A14)', () => {
    const ref = 'e'.repeat(64)
    const issued: AdminHistoryRow = { ...row, txid: 'ti', actionDetails: { kind: 'issue', assetId: 'x.0', amount: 5, priorOutpoint: 'p.0', bankRef: ref } }
    const csv = exportAdminHistoryCsv([issued, row])
    const [header, issueLine, pauseLine] = csv.split('\n')
    const col = header.split(',').indexOf('bankRef')
    expect(col).toBeGreaterThan(-1)
    expect(issueLine.split(',')[col]).toBe(`"${ref}"`)
    expect(pauseLine.split(',')[col]).toBe('""')
  })

  it('commitment cell equals MandalaAdmin.commitment(row.actionDetails) — third-party verifiable', () => {
    const csv = exportAdminHistoryCsv([row])
    const expectedCommitment = MandalaAdmin.commitment(row.actionDetails)
    expect(csv).toContain(expectedCommitment)
  })

  it('canonicalDetailsJson cell equals MandalaAdmin.canonicalize(row.actionDetails)', () => {
    const csv = exportAdminHistoryCsv([row])
    const expectedCanonical = MandalaAdmin.canonicalize(row.actionDetails)
    // The canonical JSON is CSV-escaped: inner quotes become "" inside a quoted field.
    // Verify by unescaping: the quoted field "..." with "" → " should recover the original JSON.
    const escapedCanonical = expectedCanonical.replace(/"/g, '""')
    expect(csv).toContain(escapedCanonical)
  })

  it('produces one data row per entry plus header', () => {
    const rows: AdminHistoryRow[] = [
      { ...row, txid: 'tx1' },
      { ...row, txid: 'tx2', outputIndex: 1 }
    ]
    const csv = exportAdminHistoryCsv(rows)
    const lines = csv.split('\n')
    expect(lines).toHaveLength(3) // header + 2 rows
  })

  it('quotes containing double-quotes are properly escaped', () => {
    const rowWithQuote: AdminHistoryRow = {
      assetId: 'x.0',
      txid: 'tx"special',
      outputIndex: 0,
      height: 100,
      offset: 1,
      actionDetails: { kind: 'pause', assetId: 'x.0' }
    }
    const csv = exportAdminHistoryCsv([rowWithQuote])
    expect(csv).toContain('"tx""special"')
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

  it('returns mapped AdminHistoryRow[] when fetch succeeds', async () => {
    const entries = [
      {
        assetId: 'x.0',
        txid: 'abc',
        outputIndex: 0,
        height: 100,
        offset: 1,
        admitSeq: 5,
        actionDetails: { kind: 'pause', assetId: 'x.0' },
        createdAt: '2024-01-01T00:00:00Z'
      }
    ]
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => entries
    })

    const result = await resolveAdminHistory('x.0')

    expect(result).toHaveLength(1)
    expect(result[0].txid).toBe('abc')
    expect(result[0].outputIndex).toBe(0)
    expect(result[0].height).toBe(100)
    expect(result[0].offset).toBe(1)
    expect(result[0].actionDetails.kind).toBe('pause')
    // assetId is mapped from the entry
    expect(result[0].assetId).toBe('x.0')
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
