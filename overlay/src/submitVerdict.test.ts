import { describe, it, expect } from 'vitest'
import { MandalaReject } from '@bsv/overlay-topics'
import {
  codeOfManagerError, verdictFor, errorBody, requestErrorBody, InputSpentError,
  InfraError, isInfraError, infra, FINAL_CODES, type VerdictCode
} from './submitVerdict.js'

describe('verdictFor — HTTP status / retryable / persistence', () => {
  // The last column is PERSISTENCE, not wire finality: §9.2 makes
  // ERR_INPUT_SPENT the one code that is final on the wire (400, retryable
  // false) yet never written to the admission record.
  const EXPECTED: Array<[VerdictCode, number, boolean, boolean]> = [
    ['ERR_CONSERVATION', 400, false, true],
    ['ERR_LINKAGE', 400, false, true],
    ['ERR_SHAPE', 400, false, true],
    ['ERR_SATOSHIS', 400, false, true],
    ['ERR_INPUT_SPENT', 400, false, false],
    ['ERR_PAUSED', 409, true, false],
    ['ERR_FROZEN', 409, true, false],
    ['ERR_SANCTIONED', 409, true, false],
    ['ERR_ACCESS', 409, true, false],
    ['ERR_MEMBERSHIP', 409, true, false],
    ['ERR_EVICTED', 410, false, true],
    ['ERR_UNAVAILABLE', 503, true, false]
  ]
  for (const [code, status, retryable, persisted] of EXPECTED) {
    it(`${code} → ${status}, retryable=${String(retryable)}, persisted=${String(persisted)}`, () => {
      const v = verdictFor(code)
      expect(v.httpStatus).toBe(status)
      expect(v.retryable).toBe(retryable)
      expect(FINAL_CODES.has(code)).toBe(persisted)
    })
  }

  // §9.2, stated on its own so a future edit cannot re-add it by accident.
  it('ERR_INPUT_SPENT is 400/false on the wire but is NEVER in the persisted set', () => {
    expect(verdictFor('ERR_INPUT_SPENT')).toEqual({ httpStatus: 400, retryable: false })
    expect(FINAL_CODES.has('ERR_INPUT_SPENT')).toBe(false)
  })
})

describe('InfraError — §9.5, infra faults are never final', () => {
  it('is recognised structurally, including across realms', () => {
    expect(isInfraError(new InfraError('mongo down'))).toBe(true)
    expect(isInfraError(new Error('mongo down'))).toBe(false)
    const crossRealm = new Error('mongo down')
    crossRealm.name = 'InfraError'
    expect(isInfraError(crossRealm)).toBe(true)
  })

  it('is NOT a persistable code, and 503 is not classifiable from a reason', () => {
    expect(FINAL_CODES.has('ERR_UNAVAILABLE')).toBe(false)
  })

  it('infra() re-badges any store fault, and passes an InfraError through unchanged', async () => {
    const wrapped = await infra('the token row store', async () => { throw new Error('ECONNREFUSED') })
      .catch((e: unknown) => e)
    expect(isInfraError(wrapped)).toBe(true)
    expect((wrapped as InfraError).message).toBe('the token row store is unavailable: ECONNREFUSED')

    const original = new InfraError('already badged')
    expect(await infra('x', async () => { throw original }).catch((e: unknown) => e)).toBe(original)
  })

  it('infra() is transparent on the happy path', async () => {
    expect(await infra('x', async () => 7)).toBe(7)
  })
})

describe('errorBody', () => {
  it('emits exactly {status, code, retryable, description, message}', () => {
    const text = 'output 1: MandalaToken-decodable output with no verified linkage'
    expect(errorBody('ERR_LINKAGE', text)).toEqual({
      status: 'error',
      code: 'ERR_LINKAGE',
      retryable: false,
      description: text,
      message: text
    })
  })

  it('always carries message === description (overlay-go parity)', () => {
    for (const code of ['ERR_SHAPE', 'ERR_PAUSED', 'ERR_EVICTED', 'ERR_UNAVAILABLE'] as VerdictCode[]) {
      const body = errorBody(code, `why ${code}`)
      expect(body.message).toBe(body.description)
    }
  })

  it('adds spendTxid only for ERR_INPUT_SPENT', () => {
    const spend = 'cd'.repeat(32)
    expect(errorBody('ERR_INPUT_SPENT', 'x', spend)).toEqual({
      status: 'error', code: 'ERR_INPUT_SPENT', retryable: false, description: 'x', message: 'x', spendTxid: spend
    })
    expect(errorBody('ERR_SHAPE', 'x')).not.toHaveProperty('spendTxid')
  })

  it('marks a 409 body retryable', () => {
    expect(errorBody('ERR_PAUSED', 'asset is paused').retryable).toBe(true)
  })
})

describe('requestErrorBody — request-level 400s (X-Topics, framing, payload)', () => {
  it('is a full ERR_SHAPE body, never a bare {status, message}', () => {
    expect(requestErrorBody('Missing x-topics header')).toEqual({
      status: 'error',
      code: 'ERR_SHAPE',
      retryable: false,
      description: 'Missing x-topics header',
      message: 'Missing x-topics header'
    })
  })
})

describe('InputSpentError', () => {
  it('carries the competing txid and reads as a spent reason', () => {
    const e = new InputSpentError('ab'.repeat(32) + '.0', 'cd'.repeat(32))
    expect(e.spendTxid).toBe('cd'.repeat(32))
    expect(codeOfManagerError(e)).toBe('ERR_INPUT_SPENT')
  })
})

describe('typed manager codes (spec §6.3)', () => {
  it('reads .code from a MandalaReject', () => {
    expect(codeOfManagerError(new MandalaReject('ERR_AUTHORITY', 'output 0: deploy signature is missing or invalid'))).toBe('ERR_AUTHORITY')
    expect(codeOfManagerError(new MandalaReject('ERR_UNTRUSTED', 'x'))).toBe('ERR_UNTRUSTED')
  })
  it('accepts a structurally-equal reject from a second package copy', () => {
    const e = Object.assign(new Error('r'), { name: 'MandalaReject', code: 'ERR_FROZEN', reason: 'r' })
    expect(codeOfManagerError(e)).toBe('ERR_FROZEN')
  })
  it('maps InputSpentError structurally', () => {
    expect(codeOfManagerError(new InputSpentError('a'.repeat(64) + '.0', 'b'.repeat(64)))).toBe('ERR_INPUT_SPENT')
  })
  it('leaves untyped errors and infra errors untyped', () => {
    expect(codeOfManagerError(new Error('conservation violated'))).toBeUndefined()
    expect(codeOfManagerError(new TypeError('x is undefined'))).toBeUndefined()
    expect(codeOfManagerError(new InfraError('store', new Error('down')))).toBeUndefined()
  })
  it('shapes the two new codes', () => {
    expect(verdictFor('ERR_AUTHORITY')).toEqual({ httpStatus: 400, retryable: false })
    expect(verdictFor('ERR_UNTRUSTED')).toEqual({ httpStatus: 409, retryable: true })
    expect(FINAL_CODES.has('ERR_AUTHORITY')).toBe(true)
    expect(FINAL_CODES.has('ERR_UNTRUSTED')).toBe(false)
    expect(FINAL_CODES.has('ERR_UNAVAILABLE')).toBe(false)
  })
})
