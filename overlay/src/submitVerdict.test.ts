import { describe, it, expect } from 'vitest'
import {
  classifyManagerReason, verdictFor, errorBody, requestErrorBody, InputSpentError,
  InfraError, isInfraError, infra, FINAL_CODES, type VerdictCode
} from './submitVerdict.js'

// Table-driven, per wire-contract v2 §2. Every row is a substring the shared
// table must recognise; the "real string" column is the literal message the
// producing layer emits today, so a reword upstream shows up here first.
const CASES: Array<{ reason: string, code: VerdictCode, why: string }> = [
  // ── 400, final ────────────────────────────────────────────────────────────
  { reason: 'conservation violated: outputs exceed authorized inputs/issuance', code: 'ERR_CONSERVATION', why: 'pinned MandalaTopicManager' },
  { reason: 'output 1: MandalaToken-decodable output with no verified linkage', code: 'ERR_LINKAGE', why: 'FIX A wrapper (contract §6)' },
  { reason: 'missing linkage for output 3', code: 'ERR_LINKAGE', why: 'bare "linkage" substring' },
  { reason: 'token output 1 must carry exactly 1 satoshi', code: 'ERR_SATOSHIS', why: 'pinned manager 1-sat rule' },
  { reason: 'admin output 0 must carry exactly 1 satoshi', code: 'ERR_SATOSHIS', why: 'pinned manager 1-sat rule' },
  { reason: 'input ab.0: already spent by ' + 'cd'.repeat(32), code: 'ERR_INPUT_SPENT', why: 'FIX L guard' },
  { reason: 'unknown admin kind: wibble', code: 'ERR_SHAPE', why: 'default row' },
  { reason: '', code: 'ERR_SHAPE', why: 'empty reason still deterministic' },
  // The repo-local admin-chain refusal contains the word "spent" incidentally
  // ("…spent by this transaction"). Contract §2 files a bad admin chain under
  // ERR_SHAPE, so it must be pre-empted ahead of the generic "spent" row.
  {
    reason: 'tm_mandala: admin action is not anchored to the asset admin chain ' +
      '(priorOutpoint must be a previously admitted admin output of this asset, spent by this transaction)',
    code: 'ERR_SHAPE',
    why: 'adminChainGuard.ts — pre-empt over "spent"'
  },
  { reason: 'tm_mandala: freezeOutput targets an outpoint with no token row: ab.0', code: 'ERR_SHAPE', why: 'adminChainGuard A16' },
  // ── 409, liftable ─────────────────────────────────────────────────────────
  { reason: 'control gate rejected the transaction (paused asset or access mode)', code: 'ERR_PAUSED', why: 'pinned manager control gate' },
  { reason: 'asset is paused', code: 'ERR_PAUSED', why: 'bare "paused"' },
  { reason: 'input coin is frozen', code: 'ERR_FROZEN', why: 'bare "frozen"' },
  { reason: 'sanctions provider flagged this identity', code: 'ERR_SANCTIONED', why: 'bare "sanction"' },
  { reason: 'access mode refused the transfer', code: 'ERR_ACCESS', why: 'bare "access mode"' },
  { reason: 'identity is not on the allowlist', code: 'ERR_ACCESS', why: 'allowlist' },
  { reason: 'identity is on the denylist', code: 'ERR_ACCESS', why: 'denylist' },
  // Contract §2 note: the TS upstream membership string is "sanctioned party
  // involved in transfer" and maps to ERR_MEMBERSHIP, NOT ERR_SANCTIONED —
  // so the membership row must be tested before the "sanction" row.
  { reason: 'sanctioned party involved in transfer', code: 'ERR_MEMBERSHIP', why: 'pinned manager membership gate' },
  { reason: 'identity not admitted to the registry', code: 'ERR_MEMBERSHIP', why: '"not admitted"' },
  { reason: 'registry membership required', code: 'ERR_MEMBERSHIP', why: '"membership"' }
]

describe('classifyManagerReason — shared substring table (contract §2)', () => {
  for (const c of CASES) {
    it(`${JSON.stringify(c.reason.slice(0, 56))} → ${c.code} (${c.why})`, () => {
      expect(classifyManagerReason(c.reason)).toBe(c.code)
    })
  }

  it('is case-insensitive', () => {
    expect(classifyManagerReason('CONSERVATION VIOLATED')).toBe('ERR_CONSERVATION')
  })
})

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
    // The substring table would happily read a store fault as a final 400 —
    // which is exactly why the marker travels structurally instead.
    expect(classifyManagerReason('the admission record store is unavailable: ECONNREFUSED')).toBe('ERR_SHAPE')
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
    expect(classifyManagerReason(e.message)).toBe('ERR_INPUT_SPENT')
  })
})
