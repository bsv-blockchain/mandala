/**
 * Smoke test: RegisterAssetStrip module loads and exposes the fee-rate parser.
 */
import { describe, it, expect } from 'vitest'
import { parseFeeRateInput } from './RegisterAssetStrip'

describe('parseFeeRateInput', () => {
  it('maps blank to undefined and whole numbers ≥ 1 to a number', () => {
    expect(parseFeeRateInput('')).toEqual({ ok: true, value: undefined })
    expect(parseFeeRateInput('  ')).toEqual({ ok: true, value: undefined })
    expect(parseFeeRateInput('25')).toEqual({ ok: true, value: 25 })
  })
  it('refuses 0, negatives, fractions and junk', () => {
    for (const s of ['0', '-1', '1.5', 'abc']) {
      expect(parseFeeRateInput(s).ok).toBe(false)
    }
  })
})
