import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { BASKET, configureMandala } from './constants.js'
import { loadFtCandidates } from './ftCandidates.js'
import { buildAdminActionArgs } from './assets.js'

const DEFAULT_BASKET = 'mandala-tokens'
const CUSTOM_BASKET = 'p mandala'

const asset = {
  assetId: `${'11'.repeat(32)}.0`,
  label: 'Test',
  authOutpoint: `${'22'.repeat(32)}.0`,
  authDetails: { kind: 'register' } as any,
  metadata: undefined
} as any

const mockWallet = (): any => ({
  listOutputs: vi.fn().mockResolvedValue({ outputs: [], BEEF: [] }),
  listActions: vi.fn().mockResolvedValue({ actions: [] })
})

beforeEach(() => {
  // resolveAssetState needs a URL and does a real fetch; stub it out.
  configureMandala({ overlayUrl: 'http://basket-test', basket: DEFAULT_BASKET })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
})

afterAll(() => {
  configureMandala({ basket: DEFAULT_BASKET })
  vi.unstubAllGlobals()
})

describe('D3a — the token basket is configurable', () => {
  it('defaults to mandala-tokens, so an existing wallet keeps its outputs', () => {
    expect(BASKET).toBe(DEFAULT_BASKET)
  })

  it('sends every coin-selection listing to the configured basket', async () => {
    const wallet = mockWallet()
    await loadFtCandidates(wallet, asset.assetId)
    for (const call of wallet.listOutputs.mock.calls) {
      expect(call[0].basket).toBe(DEFAULT_BASKET)
    }

    configureMandala({ basket: CUSTOM_BASKET })
    const reconfigured = mockWallet()
    await loadFtCandidates(reconfigured, asset.assetId)
    expect(reconfigured.listOutputs.mock.calls.length).toBeGreaterThan(0)
    for (const call of reconfigured.listOutputs.mock.calls) {
      expect(call[0].basket).toBe(CUSTOM_BASKET)
    }
  })

  it('tags newly built outputs with the configured basket (live binding, not a load-time capture)', () => {
    expect(buildAdminActionArgs(asset, { kind: 'pause', assetId: asset.assetId } as any, 'aa')
      .outputs[0].basket).toBe(DEFAULT_BASKET)

    configureMandala({ basket: CUSTOM_BASKET })
    expect(buildAdminActionArgs(asset, { kind: 'pause', assetId: asset.assetId } as any, 'aa')
      .outputs[0].basket).toBe(CUSTOM_BASKET)
  })

  it('ignores an empty basket rather than pointing the wallet at ""', () => {
    configureMandala({ basket: CUSTOM_BASKET })
    configureMandala({ basket: '' })
    expect(BASKET).toBe(CUSTOM_BASKET)
  })
})
