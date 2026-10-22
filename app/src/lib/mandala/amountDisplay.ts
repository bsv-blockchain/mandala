// Exact bigint amount display and parse helpers for the console.
//
// Token amounts are uint64 base units (BRC-162 1Color); `dec` (0..18) says how many
// fractional places they represent. Everything here is string/bigint arithmetic:
// no Number(), no float, no locale APIs. The only Number conversion is the final
// percentage in `reserveRatioPct`, taken on an already-clamped 0..10000 bigint.
//
// The formatting and parsing rules are the lib's (contract §8.1:493-494); this
// module only adapts them to UI call sites (null instead of throw on input).
import {
  currencySymbol as libCurrencySymbol,
  formatAmount,
  formatAmountGrouped,
  formatCurrency as libFormatCurrency,
  parseAmount
} from '@bsv/mandala'

/** `$`, `€`, `£`, `CHF ` for known tickers, otherwise `TICKER ` (uppercased); `''` without one. */
export function currencySymbol (ticker?: string): string {
  return libCurrencySymbol(ticker)
}

/** Exact plain decimal: trailing fractional zeros trimmed, no grouping. RangeError if dec ∉ 0..18. */
export function plainAmount (units: bigint, dec: number): string {
  return formatAmount(units, dec)
}

/** Like `plainAmount`, with `,` every three digits of the whole part (locale-independent). */
export function displayAmount (units: bigint, dec: number): string {
  return formatAmountGrouped(units, dec)
}

/** `displayAmount` prefixed by the ticker's currency symbol. */
export function formatCurrency (units: bigint, dec: number, ticker?: string): string {
  return libFormatCurrency(units, dec, ticker)
}

/**
 * Parse user-entered text into base units, or `null` when it is empty, malformed,
 * negative, has more than `dec` fractional digits, or exceeds MAX_UINT64. Never
 * rounds or wraps: one unit over the uint64 range is refused.
 */
export function safeParseAmount (text: string, dec: number): bigint | null {
  const t = typeof text === 'string' ? text.trim() : ''
  if (t === '') return null
  try {
    return parseAmount(t, dec)
  } catch {
    return null
  }
}

/**
 * Bank reserve as a percentage of circulation, to two decimals, clamped to 0..100.
 * Integer basis-point math on bigints; `null` when there is no circulation.
 */
export function reserveRatioPct (bank: bigint, circulation: bigint): number | null {
  if (circulation <= 0n) return null
  const reserve = bank > 0n ? bank : 0n
  let basisPoints = (reserve * 10000n) / circulation
  if (basisPoints > 10000n) basisPoints = 10000n
  return Number(basisPoints) / 100
}
