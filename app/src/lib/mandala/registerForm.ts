// Deploy-field validation for the console's "Register a new asset" strip.
//
// The overlay's detLabel rules (overlay-go/internal/mandala/details.go) and
// BRC-162 (0162:246-252) bound the deploy fields: `dec` is an integer 0..18,
// `sym` is 1..32 code points and `label` is 1..64 code points. The lib's
// guardRegisterSubmit does not enforce these (contract gap A11), so the app
// checks them before any wallet work: an over-long field would otherwise be
// signed, then refused by the overlay.

export interface RegisterFormInput { label: string, ticker: string, decimals: string }
export interface RegisterFormValue { label: string, ticker: string, decimals: number }
export type RegisterFormResult = { ok: true, value: RegisterFormValue } | { ok: false, reason: string }

const MAX_LABEL = 64
const MAX_TICKER = 32
const MAX_DEC = 18
// Canonical whole number with no sign, exponent, leading zero or whitespace.
const DEC_RE = /^(0|[1-9][0-9]?)$/

/** Code points, not UTF-16 units: an emoji is one character to the overlay. */
const codePoints = (s: string): number => [...s].length

export function validateRegisterForm (i: RegisterFormInput): RegisterFormResult {
  const label = typeof i.label === 'string' ? i.label.trim() : ''
  const ticker = typeof i.ticker === 'string' ? i.ticker.trim() : ''
  const labelLen = codePoints(label)
  if (labelLen < 1 || labelLen > MAX_LABEL) return { ok: false, reason: 'Label must be 1–64 characters' }
  const tickerLen = codePoints(ticker)
  if (tickerLen < 1 || tickerLen > MAX_TICKER) return { ok: false, reason: 'Ticker must be 1–32 characters' }
  const d = typeof i.decimals === 'string' ? i.decimals : ''
  if (!DEC_RE.test(d)) return { ok: false, reason: 'Decimals must be a whole number from 0 to 18' }
  const decimals = Number(d)
  if (decimals > MAX_DEC) return { ok: false, reason: 'Decimals must be a whole number from 0 to 18' }
  return { ok: true, value: { label, ticker, decimals } }
}
