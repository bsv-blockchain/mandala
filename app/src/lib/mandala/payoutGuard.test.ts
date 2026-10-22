import { describe, it, expect } from 'vitest'
import { guardPayout, payoutOutcomeUnknown } from './payoutGuard'

const B = '03' + '11'.repeat(32), MAX = 2n ** 64n - 1n

describe('guardPayout (issuer treasury → holder, B4)', () => {
  it.each([
    [{ amount: null, treasury: 5n, recipientKey: B }, 'Enter an amount'],
    [{ amount: 0n, treasury: 5n, recipientKey: B }, 'Amount must be greater than zero'],
    [{ amount: 6n, treasury: 5n, recipientKey: B }, 'Amount exceeds treasury balance'],
    [{ amount: 1n, treasury: undefined, recipientKey: B }, 'Treasury balance unavailable — refresh'],
    [{ amount: 1n, treasury: 5n, recipientKey: 'nope' }, 'Recipient must be a compressed identity key'],
    [{ amount: 1n, treasury: 5n, recipientKey: B, isPaused: true }, 'Transfers are temporarily disabled by the issuer']
  ])('guardPayout refuses %#', (i, reason) => {
    expect(guardPayout({ isPaused: false, pauseBypass: false, ...i } as any)).toEqual({ ok: false, reason })
  })

  it('guardPayout allows the whole treasury, even at uint64 max', () => {
    expect(guardPayout({ amount: MAX, treasury: MAX, recipientKey: B, isPaused: false, pauseBypass: false })).toEqual({ ok: true })
  })

  it('guardPayout refuses one unit over uint64 even with a larger treasury (sums are unbounded)', () => {
    expect(guardPayout({ amount: MAX + 1n, treasury: MAX * 2n, recipientKey: B, isPaused: false, pauseBypass: false }).ok).toBe(false)
  })

  it('guardPayout refuses an uncompressed (04) key', () => {
    expect(guardPayout({ amount: 1n, treasury: 5n, recipientKey: '04' + '11'.repeat(32), isPaused: false, pauseBypass: false }))
      .toEqual({ ok: false, reason: 'Recipient must be a compressed identity key' })
  })

  it('guardPayout lets dev mode bypass the pause (the overlay enforces it)', () => {
    expect(guardPayout({ amount: 1n, treasury: 5n, recipientKey: B, isPaused: true, pauseBypass: true })).toEqual({ ok: true })
  })
})

describe('payoutOutcomeUnknown', () => {
  it('is true only for a refusal whose overlay outcome is unknown (never re-run that payout)', async () => {
    const { OverlayRefusedError } = await import('@bsv/mandala')
    expect(payoutOutcomeUnknown(new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', retryable: true, outcome: 'unknown' }))).toBe(true)
    expect(payoutOutcomeUnknown(new OverlayRefusedError({ code: 'ERR_PAUSED', retryable: true, httpStatus: 409 }))).toBe(false)
    expect(payoutOutcomeUnknown(new Error('boom'))).toBe(false)
    expect(payoutOutcomeUnknown(undefined)).toBe(false)
  })
})
