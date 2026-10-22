// Fee-rate text input for the admin setFeeRate control (RegulatoryControls).
// Register no longer writes a fee rate (B6), so this moved out of
// RegisterAssetStrip unchanged.

export type FeeRateParse = { ok: true, value: number | undefined } | { ok: false, reason: string }

/**
 * Blank = leave issuer-paid fees disabled; otherwise a whole number ≥ 1
 * (token units per KB). The input is type="text", so this is the only gate
 * against a mistyped rate — `/^\d+$/` refuses anything `Number()` would
 * otherwise silently coerce (`'1e3'`, `'0x10'`, `'25-'`) into a rate that
 * looks like "off" was never intended.
 */
export function parseFeeRateInput (raw: string): FeeRateParse {
  const s = raw.trim()
  if (s === '') return { ok: true, value: undefined }
  const n = Number(s)
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1) {
    return { ok: false, reason: 'Fee rate must be a whole number ≥ 1 (units per KB)' }
  }
  return { ok: true, value: n }
}
