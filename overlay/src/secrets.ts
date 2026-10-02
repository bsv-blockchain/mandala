import { createHash, timingSafeEqual } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'

/** Ported from overlay-express 2.7.3 assertSharedSecret (OverlayExpress.ts:308-326), naming the env var. */
export const MIN_SHARED_SECRET_BYTES = 32
export const MAX_SHARED_SECRET_BYTES = 16 * 1024

export function assertSharedSecret (value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new TypeError(`${label} must not contain leading or trailing whitespace`)
  }
  const byteLength = new TextEncoder().encode(value).byteLength
  if (byteLength < MIN_SHARED_SECRET_BYTES || byteLength > MAX_SHARED_SECRET_BYTES) {
    throw new TypeError(`${label} must contain between ${MIN_SHARED_SECRET_BYTES} and ${MAX_SHARED_SECRET_BYTES} UTF-8 bytes`)
  }
  if (Array.from(value).some(ch => { const cp = ch.codePointAt(0) ?? 0; return cp <= 0x1f || cp === 0x7f })) {
    throw new TypeError(`${label} must not contain control characters`)
  }
}

/** '' when unset/empty (the caller decides what unset means); throws when set but weak. */
export function readOptionalSecretEnv (env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') return ''
  assertSharedSecret(value, name)
  return value
}

/**
 * Constant-time string compare. Both sides are hashed to a fixed-length digest
 * first so neither a length mismatch nor a byte mismatch in `timingSafeEqual`
 * (which requires equal-length buffers) can leak anything about the configured
 * secret's length. Equal inputs compare equal, including two empty strings, so
 * a caller whose configured secret may be empty must reject that case itself.
 */
export function constantTimeEqual (a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/** Verbatim from ts-stack infra/overlay-server securityConfig.ts. */
export const readBooleanEnv = (env: Record<string, string | undefined>, name: string, defaultValue: boolean): boolean => {
  const value = env[name]
  if (value === undefined || value === '') return defaultValue
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  throw new TypeError(`${name} must be one of true, false, 1, 0, yes, or no`)
}

/**
 * Adapted from upstream securityConfig.ts canonicalPrivateKey (no key-independence check: one overlay key).
 *
 * Adds a range check upstream lacks: the SDK reduces a scalar >= the curve order
 * modulo n (and accepts zero, whose public key is the point at infinity) instead
 * of throwing, so `fromHex(...).toHex()` alone would boot the overlay under a
 * silently different or unusable identity key.
 */
export const canonicalPrivateKey = (value: string, name: string): string => {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${name} must be an exact 32-byte hexadecimal private key`)
  try {
    const canonical = PrivateKey.fromHex(value).toHex()
    if (canonical !== value.toLowerCase() || /^0+$/.test(canonical)) throw new RangeError('scalar out of range')
    return canonical
  } catch {
    throw new TypeError(`${name} must be a valid secp256k1 private key`)
  }
}
