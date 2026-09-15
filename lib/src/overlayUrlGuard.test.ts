import { describe, it, expect, beforeEach, vi } from 'vitest'
import { configureMandala, OVERLAY_URL_UNSET } from './constants.js'
import { fetchRegistryBeef } from './registryRecover.js'
import { resolveAssetMetadata } from './metadata.js'

// Sites that swallow errors internally must still fail loudly when the
// overlay URL was never configured — otherwise a missing configureMandala
// reads as "no BEEF" / "no metadata" and the caller silently degrades.
describe('unconfigured OVERLAY_URL fails loudly', () => {
  beforeEach(() => {
    configureMandala({ overlayUrl: '' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch must not be called') }))
  })

  it('fetchRegistryBeef throws instead of returning null', async () => {
    await expect(fetchRegistryBeef('aa'.repeat(32), 0)).rejects.toThrow(OVERLAY_URL_UNSET)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resolveAssetMetadata throws instead of returning null', async () => {
    await expect(resolveAssetMetadata('bb'.repeat(32) + '.0')).rejects.toThrow(OVERLAY_URL_UNSET)
  })
})

describe('unconfigured OVERLAY_URL fails loudly (admin reads)', () => {
  beforeEach(() => {
    configureMandala({ overlayUrl: '' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch must not be called') }))
  })
  it('resolveAssetState / resolveAdminHistory / resolveAdminHistoryPage / resolveAdminSummary throw', async () => {
    const { resolveAssetState } = await import('./adminState.js')
    const { resolveAdminHistory, resolveAdminHistoryPage, resolveAdminSummary } = await import('./adminHistory.js')
    const id = 'cc'.repeat(32) + '.0'
    await expect(resolveAssetState(id, { force: true })).rejects.toThrow(OVERLAY_URL_UNSET)
    await expect(resolveAdminHistory(id)).rejects.toThrow(OVERLAY_URL_UNSET)
    await expect(resolveAdminHistoryPage(id, {} as any)).rejects.toThrow(OVERLAY_URL_UNSET)
    await expect(resolveAdminSummary(id)).rejects.toThrow(OVERLAY_URL_UNSET)
    expect(fetch).not.toHaveBeenCalled()
  })
})
