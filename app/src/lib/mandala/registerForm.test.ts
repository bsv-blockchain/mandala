import { describe, it, expect } from 'vitest'
import { validateRegisterForm } from './registerForm'

describe('validateRegisterForm', () => {
  it('accepts the deploy-field limits (0162:246-252, overlay detLabel)', () => {
    expect(validateRegisterForm({ label: ' Test Dollar ', ticker: 'TUSD', decimals: '18' })).toEqual({ ok: true, value: { label: 'Test Dollar', ticker: 'TUSD', decimals: 18 } })
    expect(validateRegisterForm({ label: '🪙'.repeat(64), ticker: '€'.repeat(32), decimals: '0' }).ok).toBe(true)
  })

  it.each([
    [{ label: '', ticker: 'T', decimals: '2' }, 'Label must be 1–64 characters'],
    [{ label: 'x'.repeat(65), ticker: 'T', decimals: '2' }, 'Label must be 1–64 characters'],
    [{ label: 'L', ticker: '', decimals: '2' }, 'Ticker must be 1–32 characters'],
    [{ label: 'L', ticker: 'x'.repeat(33), decimals: '2' }, 'Ticker must be 1–32 characters'],
    [{ label: 'L', ticker: 'T', decimals: '19' }, 'Decimals must be a whole number from 0 to 18'],
    [{ label: 'L', ticker: 'T', decimals: '1.5' }, 'Decimals must be a whole number from 0 to 18'],
    [{ label: 'L', ticker: 'T', decimals: '02' }, 'Decimals must be a whole number from 0 to 18']
  ])('refuses %#', (i, reason) => { expect(validateRegisterForm(i)).toEqual({ ok: false, reason }) })

  it('counts code points, not UTF-16 units, and trims before counting', () => {
    // 65 astral code points are 130 UTF-16 units: refused on the code-point count.
    expect(validateRegisterForm({ label: '🪙'.repeat(65), ticker: 'T', decimals: '0' }).ok).toBe(false)
    expect(validateRegisterForm({ label: '   ', ticker: 'T', decimals: '0' })).toEqual({ ok: false, reason: 'Label must be 1–64 characters' })
    expect(validateRegisterForm({ label: 'L', ticker: ' ' + 'x'.repeat(32) + ' ', decimals: '0' }).ok).toBe(true)
  })

  it('refuses exponent, sign and blank decimals instead of coercing them', () => {
    for (const d of ['', ' ', '1e1', '-0', '+2', '0x2', '١']) {
      expect(validateRegisterForm({ label: 'L', ticker: 'T', decimals: d }).ok).toBe(false)
    }
  })
})
