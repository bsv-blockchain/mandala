import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, HARNESS_TOPIC, type Harness } from './testkit/engineHarness.js'
import { knexSpentInputStore } from './spentGuard.js'
import { InputSpentError, InfraError, isInfraError } from './submitVerdict.js'

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
    expect(row.spentBy).toBe(a.id('hex'))
  })

  // Since @bsv/overlay 2.6 the engine's own findOutput(…, false) skips the spent
  // row, so even unparseable JSON is no longer pre-empted by the engine: it
  // reaches the guard, whose decoder fails closed.
  it.each([
    ['an unparseable consumedBy', { consumedBy: 'not json' }],
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
    expect(await h.knex('outputs').where({ txid: b.id('hex') })).toHaveLength(0)
  })

  it('self-heals a coin left spent by an interrupted attempt of the SAME tx, then converges', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    // Interrupted attempt: mark-spent ran (spentBy = a), then insertOutput threw.
    const storage = h.storage as any
    const realInsert = storage.insertOutput.bind(storage)
    storage.insertOutput = async () => { throw new Error('simulated crash after mark-spent') }
    const crashed = await h.submit(a)
    expect(crashed.error).toBeDefined()
    storage.insertOutput = realInsert
    const row = await h.knex('outputs').where({ txid: h.root.id('hex'), outputIndex: 0 }).first()
    expect(Boolean(row.spent)).toBe(true)
    expect(row.spentBy).toBe(a.id('hex'))
    // Retry 1: the guard releases its own stale spend and answers retryable.
    const retry1 = await h.submit(a)
    expect(retry1.refusal).toBeInstanceOf(InfraError)
    // Retry 2: the coin is live again and the tx is admitted.
    const retry2 = await h.submit(a)
    expect(retry2.refusal).toBeUndefined()
    expect(JSON.stringify(retry2.steak)).toContain('"outputsToAdmit":[0]')
  })

  it('heals a coin still marked spent by an EVICTED competitor (retryable), then admits the new spend', async () => {
    const evicted = new Set<string>()
    h = await createHarness({ wasEvicted: async (t) => evicted.has(t) })
    await h.submit(h.root)
    const a = await h.spend(900)
    const b = await h.spend(800)
    await h.submit(a)
    evicted.add(a.id('hex')) // eviction recorded, but its input restore never ran
    const r1 = await h.submit(b)
    expect(r1.refusal).toBeInstanceOf(InfraError)
    const r2 = await h.submit(b)
    expect(r2.refusal).toBeUndefined()
    expect(JSON.stringify(r2.steak)).toContain('"outputsToAdmit":[0]')
    const row = await h.knex('outputs').where({ txid: h.root.id('hex'), outputIndex: 0 }).first()
    expect(row.spentBy).toBe(b.id('hex'))
  })
})

describe('knexSpentInputStore.releaseSpend on the real engine schema', () => {
  let h: Harness
  afterEach(async () => { await h?.close() })

  it('only un-spends a coin held by the named spender (or a legacy NULL spentBy), on its own topic', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    await h.submit(a)
    const root = h.root.id('hex')
    const coin = async () => await h.knex('outputs').where({ txid: root, outputIndex: 0, topic: HARNESS_TOPIC }).first()
    const store = knexSpentInputStore(h.knex, HARNESS_TOPIC, async () => false)

    // Another transaction's live spend is never erased by a stale heal…
    expect(await store.releaseSpend(root, 0, 'bb'.repeat(32))).toBe(0)
    // …nor by a release on another topic.
    expect(await knexSpentInputStore(h.knex, 'tm_other', async () => false).releaseSpend(root, 0, a.id('hex'))).toBe(0)
    expect((await coin()).spentBy).toBe(a.id('hex'))

    expect(await store.releaseSpend(root, 0, a.id('hex'))).toBe(1)
    expect(Boolean((await coin()).spent)).toBe(false)
    expect((await coin()).spentBy).toBeNull()
    // Already live: nothing to release.
    expect(await store.releaseSpend(root, 0, a.id('hex'))).toBe(0)

    // A legacy spend (spentBy NULL) is released for whichever spender the
    // guard named from consumedBy.
    await h.knex('outputs').where({ txid: root, outputIndex: 0, topic: HARNESS_TOPIC }).update({ spent: true, spentBy: null })
    expect(await store.releaseSpend(root, 0, 'bb'.repeat(32))).toBe(1)
    expect(Boolean((await coin()).spent)).toBe(false)
  })
})
