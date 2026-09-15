/**
 * Smoke test: IssuerDashboard module loads without throwing.
 * @bsv/identity-react is mocked because it pulls in metanet-react-prompt
 * which contains JSX that fails in the node vitest environment.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@bsv/identity-react', () => ({
  useIdentitySearch: () => ({
    inputValue: '',
    identities: [],
    isLoading: false,
    selectedIdentity: null,
    handleInputChange: vi.fn(),
    handleSelect: vi.fn()
  })
}))

// Mock admin history so OverviewSection (embedded) doesn't hit network
vi.mock('@bsv/mandala/adminHistory', () => ({
  resolveAdminHistory: vi.fn().mockResolvedValue([]),
  describeAction: vi.fn().mockReturnValue(''),
  exportAdminHistoryCsv: vi.fn().mockReturnValue('')
}))
vi.mock('@bsv/mandala/adminState', () => ({
  resolveAssetState: vi.fn().mockResolvedValue(null)
}))
vi.mock('@bsv/mandala/banking', () => ({
  reconcile: vi.fn().mockReturnValue({ bankBalance: 0, netSupply: 0, drift: 0 }),
  seedDeposits: vi.fn().mockReturnValue([])
}))
// The asset-auth hook talks to the overlay (GET /admin/asset-auth) and the
// wallet; stub it like the other network-facing modules above.
vi.mock('../../hooks/useAssetAuth', () => ({
  useAssetAuth: () => ({ data: null, isPending: false }),
  useReattachAssetAuth: () => ({ mutate: vi.fn(), isPending: false })
}))

describe('IssuerDashboard smoke', () => {
  it('module is importable', async () => {
    await expect(import('./IssuerDashboard')).resolves.toBeDefined()
  }, 15_000)

  it('default export is a function (React component)', async () => {
    const mod = await import('./IssuerDashboard')
    expect(typeof mod.default).toBe('function')
  })

  it('nav includes Identities (overlay KYC) and no Audit item', async () => {
    const mod = await import('./IssuerDashboard') as any
    expect(mod.default).toBeDefined()
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./IssuerDashboard.tsx', import.meta.url), 'utf8')
    expect(src).toContain("id: 'identities'")
    expect(src).not.toMatch(/id: 'audit'/)
  })

  it('offers to re-attach an asset authority the overlay knows but the basket lost (A10)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./IssuerDashboard.tsx', import.meta.url), 'utf8')
    expect(src).toContain('Re-attach asset authority')
    // The card is gated on the overlay's answer for a URL asset the basket lacks,
    // and the auto-select must not replace that asset while the overlay knows it.
    expect(src).toMatch(/missingFromBasket && \(authQuery\.isPending \|\| authQuery\.data != null\)/)
    expect(src).toContain('useReattachAssetAuth()')
  })
})
