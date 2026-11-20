import { describe, it, expect, vi } from 'vitest'
import { OverlayRefusedError, ReceiptUnavailableError } from '@bsv/mandala'
import { BusyError, createSingleFlight } from '@bsv/mandala/singleFlight'
import {
  describePayoutOutcome, outcomeLocksForm, payoutFailed, payoutSucceeded, runPayout, type PayoutOutcome
} from './payoutFlow'

const TXID = 'ab'.repeat(32)
const ok = (notified = true) => ({ txid: TXID, notified })

/** A payout whose promise the test settles by hand. */
function deferred<T> () {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const NOTHING_COMMITTED = /nothing was committed/i
const everyText = (o: PayoutOutcome): string => { const v = describePayoutOutcome(o); return `${v.title} ${v.detail}` }

describe('treasury payout flow (B8)', () => {
  it('success: admitted and delivered', async () => {
    const payout = vi.fn(async () => ok(true))
    const o = await runPayout({ flight: createSingleFlight('t'), payout }, { amount: 5n })
    expect(o).toEqual({ kind: 'delivered', txid: TXID })
    expect(payout).toHaveBeenCalledWith({ amount: 5n })
    expect(describePayoutOutcome(o).tone).toBe('success')
    expect(outcomeLocksForm(o)).toBe(true) // done: "New payout" starts the next one
  })

  it('success with an undelivered receipt: delivery pending, never "nothing committed"', async () => {
    const o = await runPayout({ flight: createSingleFlight('t'), payout: async () => ok(false) }, {})
    expect(o).toEqual({ kind: 'delivery-pending', txid: TXID })
    expect(describePayoutOutcome(o).tone).toBe('warning')
    expect(everyText(o)).toMatch(/do not pay again/i)
    expect(everyText(o)).not.toMatch(NOTHING_COMMITTED)
    expect(outcomeLocksForm(o)).toBe(true)
  })

  it('refused by the overlay (typed 4xx): the only outcome that says nothing was committed; form re-submittable', async () => {
    const e = new OverlayRefusedError({ code: 'ERR_PAUSED', description: 'asset paused', httpStatus: 409 })
    expect(e.outcome).toBe('refused')
    const o = await runPayout({ flight: createSingleFlight('t'), payout: async () => { throw e } }, {})
    expect(o).toMatchObject({ kind: 'refused', code: 'ERR_PAUSED' })
    expect(describePayoutOutcome(o).title).toMatch(NOTHING_COMMITTED)
    expect(outcomeLocksForm(o)).toBe(false)
  })

  it('outcome unknown (transport fault / 5xx): held, locked, never "nothing committed"', async () => {
    for (const e of [
      new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', retryable: true, outcome: 'unknown' }),
      new OverlayRefusedError({ code: 'ERR_INTERNAL', httpStatus: 503 }),
      new OverlayRefusedError({ code: 'ERR_NETWORK', httpStatus: 0 })
    ]) {
      const o = await runPayout({ flight: createSingleFlight('t'), payout: async () => { throw e } }, {})
      expect(o.kind).toBe('unknown')
      expect(outcomeLocksForm(o)).toBe(true)
      expect(describePayoutOutcome(o).title).toMatch(/unknown/i)
      expect(everyText(o)).toMatch(/do not pay again/i)
      expect(everyText(o)).not.toMatch(NOTHING_COMMITTED)
    }
  })

  it('admitted without an attestation (ReceiptUnavailableError): committed, locked, never "nothing committed"', async () => {
    const o = await runPayout({ flight: createSingleFlight('t'), payout: async () => { throw new ReceiptUnavailableError(TXID, 0) } }, {})
    expect(o).toMatchObject({ kind: 'committed-no-receipt', txid: TXID })
    expect(outcomeLocksForm(o)).toBe(true)
    expect(everyText(o)).not.toMatch(NOTHING_COMMITTED)
  })

  it('any other failure makes no claim about what was committed', async () => {
    const o = await runPayout({ flight: createSingleFlight('t'), payout: async () => { throw new Error('insufficient treasury') } }, {})
    expect(o).toEqual({ kind: 'failed', message: 'insufficient treasury' })
    expect(everyText(o)).not.toMatch(NOTHING_COMMITTED)
    expect(outcomeLocksForm(o)).toBe(false)
  })

  it('double submit: a second call while one is in flight is busy and never reaches the wallet', async () => {
    const flight = createSingleFlight('t')
    const d = deferred<{ txid: string, notified: boolean }>()
    const payout = vi.fn(async () => await d.promise)
    const first = runPayout({ flight, payout }, 1)
    const second = runPayout({ flight, payout }, 2) // same tick: the latch is already held
    expect(await second).toMatchObject({ kind: 'busy' })
    expect(payout).toHaveBeenCalledTimes(1)
    expect(flight.isHeld()).toBe(true) // the loser must not release the winner's latch
    d.resolve(ok(true))
    expect(await first).toMatchObject({ kind: 'delivered' })
    expect(flight.isHeld()).toBe(false)
    // Released after the winner settles (also on failure): the next payout runs.
    expect((await runPayout({ flight, payout: async () => { throw new Error('x') } }, 3)).kind).toBe('failed')
    expect(flight.isHeld()).toBe(false)
  })

  it("another tab's payout (lib web lock BusyError) maps to busy", () => {
    expect(payoutFailed(new BusyError('Payout already in progress in another tab')).kind).toBe('busy')
    expect(outcomeLocksForm({ kind: 'busy', message: '' })).toBe(false)
  })

  it('classifies structurally, so a second lib copy cannot hide an unknown outcome', () => {
    expect(payoutFailed({ name: 'OverlayRefusedError', outcome: 'unknown', message: 'm' }).kind).toBe('unknown')
    expect(payoutFailed({ committed: true, txid: TXID, message: 'm' }).kind).toBe('committed-no-receipt')
    // 'refused' needs the overlay error shape; a bare object claiming it does not get the "nothing committed" text.
    expect(payoutFailed({ outcome: 'refused', message: 'm' }).kind).toBe('failed')
    expect(payoutFailed(undefined).kind).toBe('failed')
    expect(payoutSucceeded({ txid: TXID, notified: true }).kind).toBe('delivered')
  })
})
