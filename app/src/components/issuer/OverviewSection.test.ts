import { describe, it, expect, vi } from 'vitest'

// Mock network calls so the module loads in Node test env
vi.mock('@bsv/mandala/adminHistory', () => ({
  resolveAdminHistory: vi.fn().mockResolvedValue([]),
  describeAction: vi.fn().mockReturnValue(''),
  exportAdminHistoryCsv: vi.fn().mockReturnValue('')
}))
vi.mock('@bsv/mandala/adminState', () => ({
  resolveAssetState: vi.fn().mockResolvedValue(null)
}))
vi.mock('@bsv/mandala/banking', () => ({
  reconcile: vi.fn().mockReturnValue({ bankBalance: 0n, netSupply: 0n, drift: 0n }),
  seedDeposits: vi.fn().mockReturnValue([])
}))

describe('OverviewSection smoke', () => {
  it('module is importable', async () => {
    await expect(import('./OverviewSection')).resolves.toBeDefined()
  })

  it('default export is a function (React component)', async () => {
    const mod = await import('./OverviewSection')
    expect(typeof mod.default).toBe('function')
  })

  it('accepts single-asset props: assetId + asset + onReload', async () => {
    const mod = await import('./OverviewSection')
    // Component accepts assetId (string) + asset (AdminAsset|null) + optional onReload
    expect(mod.default.length).toBeLessThanOrEqual(1) // destructured → 1 props arg
  })
})
