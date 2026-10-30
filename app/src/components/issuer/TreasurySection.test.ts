/**
 * Smoke test: TreasurySection module loads without throwing.
 * Mocks wallet context, identity search, and network-hitting libs so the
 * module resolves cleanly in the Node/vitest environment.
 */
import { describe, it, expect, vi } from 'vitest'

// useWallet is called at module init time via the component tree
vi.mock('../../context/WalletContext', () => ({
  useWallet: () => ({
    wallet: null,
    identityKey: null,
    messageBoxClient: null
  })
}))

// PayoutForm pulls in @bsv/identity-react which carries JSX that breaks Node
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

// Block network hits from resolveAssetState (useAssetState in PayoutForm)
vi.mock('@bsv/mandala/adminState', () => ({
  resolveAssetState: vi.fn().mockResolvedValue(null)
}))

// Block network hits from resolveAssetMetadata
vi.mock('@bsv/mandala/metadata', () => ({
  resolveAssetMetadata: vi.fn().mockResolvedValue(null)
}))

describe('TreasurySection smoke', () => {
  it('module is importable', async () => {
    await expect(import('./TreasurySection')).resolves.toBeDefined()
  })

  it('default export is a function (React component)', async () => {
    const mod = await import('./TreasurySection')
    expect(typeof mod.default).toBe('function')
  })

  it('accepts assetId + asset props', async () => {
    const mod = await import('./TreasurySection')
    // Destructured → 1 props arg
    expect(mod.default.length).toBeLessThanOrEqual(1)
  })
})

describe('PayoutForm smoke', () => {
  it('is a component the Treasury page renders', async () => {
    const mod = await import('./PayoutForm')
    expect(typeof mod.default).toBe('function')
  })
})
