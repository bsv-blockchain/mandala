import { describe, it, expect } from 'vitest'
import * as amountModule from './amount.js'
import {
  MAX_UINT64,
  formatAmount,
  formatAmountGrouped,
  formatCurrency,
  currencySymbol,
  parseAmount,
  parseDecimalAmount
} from './amount.js'

describe('MAX_UINT64', () => {
  it('is 2^64 - 1', () => {
    expect(MAX_UINT64).toBe((1n << 64n) - 1n)
    expect(MAX_UINT64.toString()).toBe('18446744073709551615')
  })
})

describe('parseAmount boundary', () => {
  it('accepts exactly MAX_UINT64 and rejects 2^64', () => {
    expect(parseAmount('18446744073709551615', 0)).toBe(MAX_UINT64)
    expect(() => parseAmount('18446744073709551616', 0)).toThrow(RangeError)
    expect(parseAmount('18.446744073709551615', 18)).toBe(MAX_UINT64)
    expect(() => parseAmount('18.446744073709551616', 18)).toThrow(RangeError)
  })

  it('parses display values into exact base units', () => {
    expect(parseAmount('0.5', 2)).toBe(50n)
    expect(parseAmount('10.5', 2)).toBe(1050n)
    expect(parseAmount('1', 6)).toBe(1000000n)
    expect(parseAmount('1.234567', 6)).toBe(1234567n)
    expect(parseAmount('100', 0)).toBe(100n)
    expect(parseAmount('  7  ', 0)).toBe(7n)
    expect(parseAmount('10.', 2)).toBe(1000n)
    expect(parseAmount('.5', 2)).toBe(50n)
    expect(parseAmount('0', 2)).toBe(0n)
    // 2^53 + 1 is exact (no float rounding anywhere)
    expect(parseAmount('9007199254740993', 0)).toBe(9007199254740993n)
  })

  it('throws RangeError on empty, invalid, negative or over-precise text', () => {
    for (const bad of ['', '  ', '-1', '1.234', 'abc', '1e3', '.', '+1', '10.20.30', '1,000', '0x10', '١']) {
      expect(() => parseAmount(bad, 2), bad).toThrow(RangeError)
    }
    expect(() => parseAmount('0.5', 0)).toThrow(RangeError)
  })

  it('throws RangeError for a decimals value outside 0..18', () => {
    for (const dec of [-1, 19, 1.5, NaN]) expect(() => parseAmount('1', dec)).toThrow(RangeError)
  })

  it('round-trips format -> parse at every precision, including MAX_UINT64', () => {
    for (const [units, dec] of [[1050n, 2], [1000000n, 6], [1234567n, 6], [42n, 0], [MAX_UINT64, 0], [MAX_UINT64, 18], [1n, 18]] as const) {
      expect(parseAmount(formatAmount(units, dec), dec)).toBe(units)
    }
  })
})

describe('formatAmount (exact, plain)', () => {
  it('formats exact plain decimals with trailing fractional zeros trimmed', () => {
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001')
    expect(formatAmount(MAX_UINT64, 18)).toBe('18.446744073709551615')
    expect(formatAmount(MAX_UINT64, 0)).toBe('18446744073709551615')
    expect(formatAmount(150n, 2)).toBe('1.5')
    expect(formatAmount(100n, 2)).toBe('1')
    expect(formatAmount(-250n, 2)).toBe('-2.5')
    expect(formatAmount(1234567n, 0)).toBe('1234567')
    expect(formatAmount(1234567n, 6)).toBe('1.234567')
    expect(formatAmount(50n, 2)).toBe('0.5')
    expect(formatAmount(0n, 2)).toBe('0')
    expect(formatAmount(-1n, 2)).toBe('-0.01')
  })

  it('formats sums above 2^64 exactly (sums are unbounded)', () => {
    expect(formatAmount(MAX_UINT64 * 3n, 0)).toBe('55340232221128654845')
    expect(formatAmount(MAX_UINT64 + 1n, 2)).toBe('184467440737095516.16')
  })

  it('throws RangeError when decimals is not an integer 0..18', () => {
    expect(() => formatAmount(1n, 19)).toThrow(RangeError)
    expect(() => formatAmount(1n, -1)).toThrow(RangeError)
    expect(() => formatAmount(1n, 1.5)).toThrow(RangeError)
  })

  it('refuses a non-bigint amount instead of formatting it lossily', () => {
    expect(() => formatAmount(5 as unknown as bigint, 0)).toThrow(TypeError)
  })

  it('formatAmountPlain is removed', () => {
    expect('formatAmountPlain' in amountModule).toBe(false)
  })
})

describe('formatAmount trailing-zero trim', () => {
  it('trims only trailing fractional zeros, including all-zero fractions', () => {
    expect(formatAmount(1000000000000000000n, 18)).toBe('1')
    expect(formatAmount(1000000000000000001n, 18)).toBe('1.000000000000000001')
    expect(formatAmount(1010000n, 6)).toBe('1.01')
    expect(formatAmount(0n, 18)).toBe('0')
    expect(formatAmount(MAX_UINT64, 18)).toBe('18.446744073709551615')
  })
})

describe('formatAmountGrouped', () => {
  it('groups the whole part with commas, no locale APIs', () => {
    expect(formatAmountGrouped(123456789n, 2)).toBe('1,234,567.89')
    expect(formatAmountGrouped(1234567n, 0)).toBe('1,234,567')
    expect(formatAmountGrouped(999n, 0)).toBe('999')
    expect(formatAmountGrouped(1000n, 0)).toBe('1,000')
    expect(formatAmountGrouped(-123456789n, 2)).toBe('-1,234,567.89')
    expect(formatAmountGrouped(MAX_UINT64, 0)).toBe('18,446,744,073,709,551,615')
    expect(formatAmountGrouped(50n, 2)).toBe('0.5')
  })
})

describe('currency', () => {
  it('maps known tickers to symbols and falls back to the ticker', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('CHF')).toBe('CHF ')
    expect(currencySymbol('XYZ')).toBe('XYZ ')
    expect(currencySymbol(undefined)).toBe('')
  })

  it('formats base units with the symbol and grouping', () => {
    expect(formatCurrency(100n, 2, 'usd')).toBe('$1')
    expect(formatCurrency(124575n, 2, 'USD')).toBe('$1,245.75')
    expect(formatCurrency(5n, 0, undefined)).toBe('5')
  })
})

describe('parseDecimalAmount (C§0 JSON decimal strings)', () => {
  it('parses canonical unsigned decimal strings exactly, unbounded', () => {
    expect(parseDecimalAmount('18446744073709551615')).toBe(MAX_UINT64)
    expect(parseDecimalAmount('0')).toBe(0n)
    expect(parseDecimalAmount('18446744073709551616')).toBe(MAX_UINT64 + 1n)
  })

  it('parses signed values only when signed is set', () => {
    expect(parseDecimalAmount('-5', true)).toBe(-5n)
    expect(parseDecimalAmount('5', true)).toBe(5n)
    expect(parseDecimalAmount('0', true)).toBe(0n)
    expect(parseDecimalAmount('-0', true)).toBeNull()
    expect(parseDecimalAmount('-05', true)).toBeNull()
  })

  it('returns null for anything that is not a canonical decimal string', () => {
    for (const bad of [5, '-0', '01', '+1', '', '-5', ' 5', '5 ', '1.0', '1e3', null, undefined, 5n, {}, '١']) {
      expect(parseDecimalAmount(bad)).toBeNull()
    }
  })
})
