import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './testkit/engineHarness.js'
import { InputSpentError } from './submitVerdict.js'

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
})
