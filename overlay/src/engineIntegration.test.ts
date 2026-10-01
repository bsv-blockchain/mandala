import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './testkit/engineHarness.js'
import { InputSpentError, isInfraError } from './submitVerdict.js'

describe('real engine + spent-input guard', () => {
  let h: Harness
  afterEach(async () => { await h?.close() })

  it('refuses a double spend of an admitted coin with InputSpentError naming the winner', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    const b = await h.spend(800)
    const ra = await h.submit(a)
    expect(ra.refusal).toBeUndefined()
    const rb = await h.submit(b)
    expect(rb.refusal).toBeInstanceOf(InputSpentError)
    expect((rb.refusal as InputSpentError).spendTxid).toBe(a.id('hex'))
    // The refused spend must not re-mark the coin: still spent by A.
    const row = await h.knex('outputs').where({ txid: h.root.id('hex'), outputIndex: 0 }).first()
    expect(Boolean(row.spent)).toBe(true)
    expect(row.spentBy ?? a.id('hex')).toBe(a.id('hex')) // spentBy absent on 2.2.0, set on 2.6.2
  })

  // Unparseable consumedBy JSON is not exercised here: the engine's own
  // findOutput (which builds previousCoins) JSON.parses it first and swallows
  // the throw before the guard runs. spentGuard.test.ts covers that decode.
  it.each([
    ['a non-array consumedBy', { consumedBy: '{}' }],
    ['an unreadable spent flag', { spent: 'garbage' }]
  ])('%s on the engine row is a retryable InfraError, not ERR_INPUT_SPENT and not an admit', async (_label, corruption) => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    expect((await h.submit(a)).refusal).toBeUndefined()
    await h.knex('outputs').where({ txid: h.root.id('hex'), outputIndex: 0 }).update(corruption)
    const b = await h.spend(800)
    const rb = await h.submit(b)
    expect(isInfraError(rb.refusal)).toBe(true)
    expect(rb.refusal).not.toBeInstanceOf(InputSpentError)
  })
})
