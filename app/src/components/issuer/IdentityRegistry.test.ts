/**
 * Smoke test: IdentityRegistry module loads without throwing.
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

describe('IdentityRegistry smoke', () => {
  it('module is importable', async () => {
    await expect(import('./IdentityRegistry')).resolves.toBeDefined()
  }, 15_000)

  it('default export is a function (React component)', async () => {
    const mod = await import('./IdentityRegistry')
    expect(typeof mod.default).toBe('function')
  })
})
