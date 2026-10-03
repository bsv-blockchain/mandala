/**
 * F6 — a reject from a SECOND copy of @bsv/overlay-topics can pass the
 * installed copy's structural check with a code this overlay does not shape
 * (that copy's code set is newer). The installed `isMandalaReject` filters on
 * its own code set, so to exercise the overlay's own second line this file
 * swaps in a permissive check, as such a copy would effectively be.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@bsv/overlay-topics', async (importOriginal) => {
  const real = await importOriginal<typeof import('@bsv/overlay-topics')>()
  return {
    ...real,
    isMandalaReject: (e: unknown): boolean => {
      if (typeof e !== 'object' || e === null) return false
      const { name, code, reason } = e as { name?: unknown, code?: unknown, reason?: unknown }
      return name === 'MandalaReject' && typeof code === 'string' && typeof reason === 'string'
    }
  }
})

const { codeOfManagerError } = await import('./submitVerdict.js')

describe('codeOfManagerError — an unshaped code from another package copy (F6)', () => {
  it('is untyped (so /submit answers 400 ERR_SHAPE, unpersisted), never the foreign code', () => {
    const e = Object.assign(new Error('r'), { name: 'MandalaReject', code: 'ERR_NEW_THING', reason: 'r' })
    expect(codeOfManagerError(e)).toBeUndefined()
  })
  it('still reads a shaped code through the same check', () => {
    const e = Object.assign(new Error('r'), { name: 'MandalaReject', code: 'ERR_FROZEN', reason: 'r' })
    expect(codeOfManagerError(e)).toBe('ERR_FROZEN')
  })
  it('does not read an inherited property name as a code', () => {
    for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const e = Object.assign(new Error('r'), { name: 'MandalaReject', code, reason: 'r' })
      expect(codeOfManagerError(e)).toBeUndefined()
    }
  })
})
