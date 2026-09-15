import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureMandala } from './constants.js'
import { fetchRegistry } from './registry.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const rows = [
  { identityKey: '02aa', status: 'admitted', txid: 't', outputIndex: 0, admitSeq: 1, createdAt: '2026-01-01' }
]

describe('fetchRegistry', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    configureMandala({ overlayUrl: 'http://test-overlay', adminApiToken: '' })
  })

  it('GETs /admin/registry anonymously and parses rows', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => rows })
    const out = await fetchRegistry()
    expect(mockFetch).toHaveBeenCalledWith('http://test-overlay/admin/registry', { headers: {} })
    expect(out).toHaveLength(1)
    expect(out[0].identityKey).toBe('02aa')
  })

  it('sends the admin bearer token once configured — the registry is an identity-bearing route', async () => {
    configureMandala({ adminApiToken: 'tok' })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => rows })
    await fetchRegistry()
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-overlay/admin/registry',
      { headers: { Authorization: 'Bearer tok' } }
    )
  })

  it('throws on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(fetchRegistry()).rejects.toThrow('500')
  })

  it('throws before fetching when configureMandala has not set the overlay URL', async () => {
    configureMandala({ overlayUrl: '' })
    await expect(fetchRegistry()).rejects.toThrow(/configureMandala/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
