// Mandala token amounts are uint64 integers (base units) on-chain (BRC-162 1Color).
// An asset's `dec` (precision) metadata says how many fractional places those base
// units represent: dec=0 → each unit is whole; dec=6 → 1_000_000 base units = 1.0.
// These helpers convert at the UI / JSON boundary with string and bigint arithmetic
// only: no Number(), no float, no locale APIs, no 2^53 logic. Per output an amount
// is 0..MAX_UINT64; sums, supply and balances are unbounded exact bigints.

/** Largest per-output token amount: 2^64 - 1. */
export const MAX_UINT64: bigint = (1n << 64n) - 1n

/** Largest supported `dec` (BRC-162 deploy precision). */
const MAX_DECIMALS = 18

function checkDecimals (dec: number): void {
  if (!Number.isInteger(dec) || dec < 0 || dec > MAX_DECIMALS) {
    throw new RangeError(`@bsv/mandala: decimals must be an integer 0..${MAX_DECIMALS}, got ${String(dec)}`)
  }
}

function checkUnits (units: bigint): void {
  if (typeof units !== 'bigint') {
    throw new TypeError(`@bsv/mandala: token amount must be a bigint, got ${typeof units}`)
  }
}

// Split base units into sign, whole digits and trimmed fractional digits.
function toParts (units: bigint, dec: number): { negative: boolean, whole: string, frac: string } {
  checkUnits(units)
  checkDecimals(dec)
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(dec + 1, '0')
  const whole = digits.slice(0, digits.length - dec)
  const frac = digits.slice(digits.length - dec).replace(/0+$/, '')
  return { negative, whole, frac }
}

function join (negative: boolean, whole: string, frac: string): string {
  return `${negative ? '-' : ''}${whole}${frac.length > 0 ? '.' + frac : ''}`
}

/**
 * Exact plain decimal string (no grouping): trailing fractional zeros trimmed,
 * leading `-` for negatives. Throws `RangeError` unless `dec` is an integer 0..18.
 */
export function formatAmount (units: bigint, dec: number): string {
  const { negative, whole, frac } = toParts(units, dec)
  return join(negative, whole, frac)
}

/** Like `formatAmount`, with `,` thousands separators on the whole part. */
export function formatAmountGrouped (units: bigint, dec: number): string {
  const { negative, whole, frac } = toParts(units, dec)
  return join(negative, whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','), frac)
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CHF: 'CHF ' }

export function currencySymbol (ticker?: string): string {
  if (ticker == null || ticker === '') return ''
  return SYMBOLS[ticker.toUpperCase()] ?? `${ticker.toUpperCase()} `
}

export function formatCurrency (units: bigint, dec: number, ticker?: string): string {
  return `${currencySymbol(ticker)}${formatAmountGrouped(units, dec)}`
}

// ASCII digits only (no `u` flag: \d is [0-9]).
const DISPLAY_AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * Parse a user-entered display value into integer base units. Trims the input.
 * Throws `RangeError` on empty or invalid text, more than `dec` fractional
 * digits, a negative value, a value above `MAX_UINT64`, or a `dec` outside 0..18.
 */
export function parseAmount (text: string, dec: number): bigint {
  checkDecimals(dec)
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') throw new RangeError('@bsv/mandala: amount is empty')
  if (!DISPLAY_AMOUNT.test(trimmed)) throw new RangeError(`@bsv/mandala: invalid amount "${trimmed}"`)
  const [whole = '', frac = ''] = trimmed.split('.')
  if (frac.length > dec) {
    throw new RangeError(`@bsv/mandala: amount has more than ${dec} fractional digit${dec === 1 ? '' : 's'}`)
  }
  const units = BigInt(whole + frac.padEnd(dec, '0')) // the regex guarantees at least one digit
  if (units > MAX_UINT64) throw new RangeError('@bsv/mandala: amount exceeds the uint64 token range')
  return units
}

const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/

/**
 * Parse a C§0 JSON amount: a canonical decimal string `0|[1-9][0-9]*`, or with
 * `signed` an optional leading `-` (never `-0`). Unbounded (sums and balances
 * may exceed 2^64). Returns `null` for anything else: JSON numbers, bigints,
 * `'-0'`, `'01'`, `'+1'`, `''`, whitespace, a sign when unsigned.
 */
export function parseDecimalAmount (v: unknown, signed = false): bigint | null {
  if (typeof v !== 'string') return null
  if (!(signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(v)) return null
  return BigInt(v)
}
