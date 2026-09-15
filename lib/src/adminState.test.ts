import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fetch before importing the module under test
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock import.meta.env so constants resolve cleanly in tests
vi.mock('./constants', () => ({
  OVERLAY_URL: 'http://test-overlay'
}))

import { resolveAssetState } from './adminState.js'

const SAMPLE_STATE = {
  assetId: 'abc123.0',
  issuerIdentityKey: '02' + 'a'.repeat(64),
  isPaused: true,
  accessMode: 'denylist' as const,
  blockedIdentities: ['key1'],
  allowedIdentities: [],
  frozenOutpoints: [{ outpoint: 'txid.0', amount: 100, owner: 'key2', reason: 'court order' }],
  evictedOutpoints: ['txid2.1']
}

describe('resolveAssetState', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    // Clear the module-level cache by re-importing would require dynamic import tricks;
    // instead we use a unique assetId per test to avoid cache hits
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns parsed asset state when fetch succeeds (ok response)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_STATE
    })

    const result = await resolveAssetState('abc123.0')

    expect(result).not.toBeNull()
    expect(result?.isPaused).toBe(true)
    expect(result?.accessMode).toBe('denylist')
    expect(result?.frozenOutpoints).toHaveLength(1)
    expect(result?.frozenOutpoints[0].outpoint).toBe('txid.0')
    expect(result?.frozenOutpoints[0].reason).toBe('court order')
    expect(result?.blockedIdentities).toEqual(['key1'])
    expect(result?.evictedOutpoints).toEqual(['txid2.1'])
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-overlay/admin/asset-state/abc123.0'
    )
  })

  it('returns null when fetch returns non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404
    })

    const result = await resolveAssetState('not-found.1')

    expect(result).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'))

    const result = await resolveAssetState('error-asset.0')

    expect(result).toBeNull()
  })

  it('memoises: second call within TTL does not fetch again', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...SAMPLE_STATE, assetId: 'memo-test.0' })
    })

    const r1 = await resolveAssetState('memo-test.0')
    const r2 = await resolveAssetState('memo-test.0')

    expect(r1?.isPaused).toBe(true)
    expect(r2?.isPaused).toBe(true)
    // fetch should only have been called once (second call hits the cache)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('encodes assetId in the URL (handles dot in id correctly)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...SAMPLE_STATE, assetId: 'deadbeef.3' })
    })

    await resolveAssetState('deadbeef.3')

    // encodeURIComponent('deadbeef.3') === 'deadbeef.3' (dots are not encoded)
    // but the function should still call with the assetId
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-overlay/admin/asset-state/deadbeef.3'
    )
  })

  it('force bypasses the memo and refreshes it; a following plain call reads the refreshed value (A18)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ...SAMPLE_STATE, assetId: 'force.0', isPaused: false }) })
    await resolveAssetState('force.0')

    // Overlay state changed (e.g. a freeze just committed) — memo would hide it.
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ...SAMPLE_STATE, assetId: 'force.0', isPaused: true }) })
    const stale = await resolveAssetState('force.0')
    expect(stale?.isPaused).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const fresh = await resolveAssetState('force.0', { force: true })
    expect(fresh?.isPaused).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // The forced fetch re-primed the memo — steady-state load is unchanged.
    const again = await resolveAssetState('force.0')
    expect(again?.isPaused).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('force: false behaves like the plain call (memo applies)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ...SAMPLE_STATE, assetId: 'noforce.0' }) })
    await resolveAssetState('noforce.0')
    await resolveAssetState('noforce.0', { force: false })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
