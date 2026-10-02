import { describe, expect, it } from 'vitest'
import {
  assertSharedSecret, canonicalPrivateKey, constantTimeEqual, readOptionalSecretEnv, readBooleanEnv
} from './secrets.js'

const S32 = 'a'.repeat(32)
describe('secrets', () => {
  it('accepts a 32-byte secret', () => { expect(() => assertSharedSecret(S32, 'X')).not.toThrow() })
  it('rejects 31 bytes', () => { expect(() => assertSharedSecret('a'.repeat(31), 'X')).toThrow(/X must contain between 32 and 16384 UTF-8 bytes/) })
  it('rejects surrounding whitespace', () => { expect(() => assertSharedSecret(S32 + '\n', 'X')).toThrow(/whitespace/) })
  it('rejects control characters', () => { expect(() => assertSharedSecret('a'.repeat(31) + '\u0007', 'X')).toThrow(/control/) })
  it('unset optional secret is empty', () => { expect(readOptionalSecretEnv({}, 'T')).toBe('') })
  it('set-but-weak optional secret throws naming the env var', () => { expect(() => readOptionalSecretEnv({ T: 'short' }, 'T')).toThrow(/^T must/) })
  it('constant-time equal', () => { expect(constantTimeEqual(S32, S32)).toBe(true); expect(constantTimeEqual(S32, 'b'.repeat(32))).toBe(false) })
  it('booleans', () => {
    expect(readBooleanEnv({}, 'B', false)).toBe(false)
    expect(readBooleanEnv({ B: 'true' }, 'B', false)).toBe(true)
    expect(() => readBooleanEnv({ B: 'maybe' }, 'B', false)).toThrow(/B must be one of/)
  })
})

describe('secrets — edges the boot path relies on', () => {
  it('counts UTF-8 bytes, not characters', () => {
    // 11 x 3-byte characters is 33 bytes but only 11 code points.
    expect(() => assertSharedSecret('€'.repeat(11), 'X')).not.toThrow()
    expect(() => assertSharedSecret('€'.repeat(10), 'X')).toThrow(/between 32 and 16384/)
  })
  it('enforces the 16 KiB ceiling', () => {
    expect(() => assertSharedSecret('a'.repeat(16384), 'X')).not.toThrow()
    expect(() => assertSharedSecret('a'.repeat(16385), 'X')).toThrow(/between 32 and 16384/)
  })
  it('rejects a non-string', () => {
    expect(() => assertSharedSecret(undefined, 'X')).toThrow(/whitespace/)
    expect(() => assertSharedSecret(32, 'X')).toThrow(/whitespace/)
  })
  it('rejects a leading-whitespace secret that is otherwise long enough', () => {
    expect(() => assertSharedSecret(' ' + S32, 'X')).toThrow(/whitespace/)
  })
  it('an empty optional secret is unset, not weak', () => { expect(readOptionalSecretEnv({ T: '' }, 'T')).toBe('') })
  it('a whitespace-only optional secret is set-but-invalid (never silently open)', () => {
    expect(() => readOptionalSecretEnv({ T: '   ' }, 'T')).toThrow(/^T must/)
  })
  it('accepts the documented boolean spellings', () => {
    for (const v of ['true', '1', 'yes']) expect(readBooleanEnv({ B: v }, 'B', false)).toBe(true)
    for (const v of ['false', '0', 'no']) expect(readBooleanEnv({ B: v }, 'B', true)).toBe(false)
    expect(readBooleanEnv({ B: '' }, 'B', true)).toBe(true)
  })
})

describe('canonicalPrivateKey', () => {
  it('lowercases an upper-case hex key', () => {
    expect(canonicalPrivateKey('AB'.repeat(32), 'K')).toBe('ab'.repeat(32))
  })
  it('keeps a leading zero byte (64 hex characters out)', () => {
    const k = '00' + 'ab'.repeat(31)
    expect(canonicalPrivateKey(k, 'K')).toBe(k)
  })
  it('rejects anything that is not exactly 64 hex characters, naming the variable', () => {
    for (const bad of ['', 'xyz', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' ' + 'a'.repeat(63), '0x' + 'a'.repeat(62)]) {
      expect(() => canonicalPrivateKey(bad, 'SERVER_PRIVATE_KEY')).toThrow(/^SERVER_PRIVATE_KEY must be an exact 32-byte hexadecimal private key/)
    }
  })
  it('rejects a 64-hex value that is not a valid secp256k1 key', () => {
    expect(() => canonicalPrivateKey('0'.repeat(64), 'K')).toThrow(/^K must be a valid secp256k1 private key/)
    expect(() => canonicalPrivateKey('f'.repeat(64), 'K')).toThrow(/^K must be a valid secp256k1 private key/)
  })
  // The SDK reduces a scalar >= n modulo n instead of throwing, so the curve
  // order itself would come back as zero and n + 1 as 1.
  it('rejects the curve order and everything above it, accepts n - 1', () => {
    const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
    const NM1 = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
    expect(() => canonicalPrivateKey(N, 'K')).toThrow(/^K must be a valid secp256k1 private key/)
    expect(() => canonicalPrivateKey(N.slice(0, -1) + '2', 'K')).toThrow(/^K must be a valid secp256k1 private key/)
    expect(canonicalPrivateKey(NM1.toUpperCase(), 'K')).toBe(NM1)
  })
})
