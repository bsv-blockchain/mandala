import { PublicKey } from '@bsv/sdk'

const COMPRESSED_KEY_ANY_CASE = /^0[23][0-9a-fA-F]{64}$/

/**
 * Accept a valid compressed secp256k1 public key in either hex case and return
 * it lowercase (the one form every derivation, receipt and MessageBox address
 * uses). Anything else is a TypeError naming `name`.
 */
export function normalizeKey (key: unknown, name: string): string {
  if (typeof key !== 'string' || !COMPRESSED_KEY_ANY_CASE.test(key)) {
    throw new TypeError(`@bsv/mandala: ${name} must be a 66-hex compressed public key (02/03 prefix)`)
  }
  const lower = key.toLowerCase()
  let ok = false
  try { ok = PublicKey.fromString(lower).validate() } catch { /* not on the curve */ }
  if (!ok) throw new TypeError(`@bsv/mandala: ${name} is not a point on secp256k1`)
  return lower
}
