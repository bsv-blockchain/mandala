/**
 * parseFeeRateInput (moved from RegisterAssetStrip; used by the admin setFeeRate control).
 */
import { describe, it, expect } from 'vitest'
import { parseFeeRateInput } from './feeRateInput'

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
  it('never silently disables fees on a mistyped rate: exponent, hex and trailing junk are refused, not coerced to a number', () => {
    for (const s of ['1e3', '0x10', '25-']) {
      expect(parseFeeRateInput(s).ok).toBe(false)
    }
  })
  it('trims surrounding whitespace on an otherwise-valid rate', () => {
    expect(parseFeeRateInput(' 7 ')).toEqual({ ok: true, value: 7 })
  })
  it('accepts leading zeros', () => {
    expect(parseFeeRateInput('007')).toEqual({ ok: true, value: 7 })
  })
})
