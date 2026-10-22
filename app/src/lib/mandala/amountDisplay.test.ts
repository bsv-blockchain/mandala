import { describe, it, expect } from 'vitest'
import { MAX_UINT64 } from '@bsv/mandala'
import {
  currencySymbol,
  displayAmount,
  formatCurrency,
  plainAmount,
  reserveRatioPct,
  safeParseAmount
} from './amountDisplay'

const MAX = 2n ** 64n - 1n

describe('amountDisplay', () => {
  it('pins MAX_UINT64 from the lib', () => {
    expect(MAX_UINT64).toBe(MAX)
  })

  it('plainAmount trims the fraction and never groups', () => {
    expect(plainAmount(0n, 2)).toBe('0')
    expect(plainAmount(123450n, 3)).toBe('123.45')
    expect(plainAmount(5n, 2)).toBe('0.05')
    expect(plainAmount(-5n, 2)).toBe('-0.05')
    expect(plainAmount(MAX, 0)).toBe('18446744073709551615')
    expect(plainAmount(MAX, 18)).toBe('18.446744073709551615')
  })

  it('displayAmount groups the whole part with commas, locale-independent', () => {
    expect(displayAmount(MAX, 0)).toBe('18,446,744,073,709,551,615')
    expect(displayAmount(123456789n, 2)).toBe('1,234,567.89')
    expect(displayAmount(-100000n, 0)).toBe('-100,000')
    expect(displayAmount(100n, 2)).toBe('1')
  })

  it('formatCurrency prefixes the ticker symbol', () => {
    expect(formatCurrency(150n, 2, 'usd')).toBe('$1.5')
    expect(formatCurrency(1n, 0, 'TUSD')).toBe('TUSD 1')
    expect(formatCurrency(1n, 0)).toBe('1')
    expect(currencySymbol('eur')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('chf')).toBe('CHF ')
    expect(currencySymbol('')).toBe('')
    expect(currencySymbol()).toBe('')
  })

  it('rejects dec outside 0..18', () => {
    expect(() => plainAmount(1n, 19)).toThrow(RangeError)
    expect(() => displayAmount(1n, -1)).toThrow(RangeError)
  })

  it('safeParseAmount returns null instead of throwing', () => {
    expect(safeParseAmount('1.5', 2)).toBe(150n)
    expect(safeParseAmount(' 7 ', 0)).toBe(7n)
    for (const bad of ['', '  ', 'abc', '1.555', '-1', '1e3']) expect(safeParseAmount(bad, 2)).toBeNull()
  })

  it('round-trips MAX_UINT64 at dec 0 and 18', () => {
    for (const d of [0, 2, 18]) for (const x of [0n, 1n, MAX]) expect(safeParseAmount(plainAmount(x, d), d)).toBe(x)
  })

  it('refuses 2^64', () => {
    expect(safeParseAmount('18446744073709551616', 0)).toBeNull()
    expect(safeParseAmount('18.446744073709551616', 18)).toBeNull()
  })

  it('reserveRatioPct uses integer math, clamps to 0..100, null without circulation', () => {
    expect(reserveRatioPct(50n, 100n)).toBe(50)
    expect(reserveRatioPct(1n, 3n)).toBe(33.33)
    expect(reserveRatioPct(200n, 100n)).toBe(100)
    expect(reserveRatioPct(-5n, 100n)).toBe(0)
    expect(reserveRatioPct(5n, 0n)).toBeNull()
    expect(reserveRatioPct(MAX * 3n, MAX * 4n)).toBe(75)
  })
})
