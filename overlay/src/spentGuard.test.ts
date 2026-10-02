import { describe, it, expect } from 'vitest'
import { Transaction, UnlockingScript, P2PKH, PrivateKey } from '@bsv/sdk'
import {
  conflictingSpend, withSpentInputGuard, spendTxidOf, knexSpentInputStore,
  SELF_HEAL_DESCRIPTION, EVICTED_HEAL_DESCRIPTION, MOVED_DESCRIPTION,
  type SpentInputStore, type SpendState
} from './spentGuard.js'
import { InputSpentError, InfraError, isInfraError, codeOfManagerError } from './submitVerdict.js'

const SRC = 'aa'.repeat(32)
const COMPETITOR = 'cc'.repeat(32)

const spendTx = (): Transaction => {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: SRC, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(new PrivateKey(5).toAddress()) })
  return tx
}

const LIVE: SpendState = { spent: false, spentBy: null, consumedBy: [] }

/** `released` records every releaseSpend(txid, vout, spender) call. */
const store = (opts: {
  row?: SpendState | null
  evicted?: string[]
}): SpentInputStore & { released: Array<[string, number, string]> } => {
  const released: Array<[string, number, string]> = []
  return {
    released,
    spendStateOf: async () => opts.row === undefined ? LIVE : opts.row,
    wasEvicted: async (txid: string) => (opts.evicted ?? []).includes(txid),
    releaseSpend: async (txid, outputIndex, spender) => { released.push([txid, outputIndex, spender]); return 1 }
  }
}

describe('spendTxidOf', () => {
  it('reads the spending txid out of a consumedBy outpoint string', () => {
    expect(spendTxidOf([`${COMPETITOR}.2`])).toBe(COMPETITOR)
  })
  it('reads it out of the engine\'s parsed {txid, outputIndex} shape', () => {
    expect(spendTxidOf([{ txid: COMPETITOR, outputIndex: 2 }])).toBe(COMPETITOR)
  })
  it('returns null for an empty or malformed consumedBy', () => {
    expect(spendTxidOf([])).toBeNull()
    expect(spendTxidOf(['nonsense'])).toBeNull()
    expect(spendTxidOf([{ outputIndex: 0 }])).toBeNull()
  })
})

describe('conflictingSpend — FIX L (contract §7)', () => {
  it('passes an unspent input', async () => {
    const s = store({ row: LIVE })
    expect(await conflictingSpend(spendTx(), [0], s)).toBeNull()
    expect(s.released).toEqual([])
  })

  // The engine queried previousCoins BEFORE the outer wrappers ran; an
  // eviction's unmarkSpent (outside the engine lock) can flip the coin live in
  // between. Delegating would let the manager judge the spend without it.
  it('refuses retryably a LIVE input the engine did not list in previousCoins (un-spent after its query)', async () => {
    const s = store({ row: LIVE })
    const err = await conflictingSpend(spendTx(), [], s).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect(err).not.toBeInstanceOf(InputSpentError)
    expect((err as Error).message).toBe(MOVED_DESCRIPTION(`${SRC}.0`))
    expect(s.released).toEqual([])
  })

  it('a previousCoins that is not an array lists nothing — a live input fails CLOSED, retryably', async () => {
    const err = await conflictingSpend(spendTx(), undefined as any, store({ row: LIVE })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect((err as Error).message).toBe(MOVED_DESCRIPTION(`${SRC}.0`))
  })

  it('checks previousCoins per input index — only the unlisted live input is named', async () => {
    const tx = spendTx()
    const other = 'bb'.repeat(32)
    tx.addInput({ sourceTXID: other, sourceOutputIndex: 3, unlockingScript: new UnlockingScript() })
    const err = await conflictingSpend(tx, [0], store({ row: LIVE })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect((err as Error).message).toBe(MOVED_DESCRIPTION(`${other}.3`))
    expect(await conflictingSpend(tx, [0, 1], store({ row: LIVE }))).toBeNull()
  })

  it('refuses an input already spent by a different still-admitted tx, naming spentBy', async () => {
    const s = store({ row: { spent: true, spentBy: COMPETITOR, consumedBy: [] } })
    expect(await conflictingSpend(spendTx(), [], s)).toEqual({ outpoint: `${SRC}.0`, spendTxid: COMPETITOR })
    expect(s.released).toEqual([])
  })

  it('names the competitor from consumedBy when spentBy is null (legacy rows)', async () => {
    const s = store({ row: { spent: true, spentBy: null, consumedBy: [`${COMPETITOR}.0`] } })
    expect(await conflictingSpend(spendTx(), [], s)).toEqual({ outpoint: `${SRC}.0`, spendTxid: COMPETITOR })
  })

  it('prefers spentBy over consumedBy when both name a spender', async () => {
    const other = 'dd'.repeat(32)
    const s = store({ row: { spent: true, spentBy: COMPETITOR, consumedBy: [`${other}.0`] } })
    expect(await conflictingSpend(spendTx(), [], s)).toEqual({ outpoint: `${SRC}.0`, spendTxid: COMPETITOR })
  })

  it('treats a missing row as live — an evicted spend deletes the row, and silence is not a conflict', async () => {
    expect(await conflictingSpend(spendTx(), [], store({ row: null }))).toBeNull()
  })

  it('still refuses when the competitor cannot be named (spent, no spentBy, no consumedBy)', async () => {
    // evicted: [''] — an unnamed competitor must never reach the eviction check.
    const s = store({ row: { spent: true, spentBy: null, consumedBy: [] }, evicted: [''] })
    expect(await conflictingSpend(spendTx(), [], s)).toEqual({ outpoint: `${SRC}.0`, spendTxid: '' })
    expect(s.released).toEqual([])
  })

  it('inspects every input, not only the first — the first conflicting one is named', async () => {
    const tx = spendTx()
    const other = 'bb'.repeat(32)
    tx.addInput({ sourceTXID: other, sourceOutputIndex: 3, unlockingScript: new UnlockingScript() })
    const s: SpentInputStore = {
      spendStateOf: async (txid) => txid === other ? { spent: true, spentBy: COMPETITOR, consumedBy: [] } : LIVE,
      wasEvicted: async () => false,
      releaseSpend: async () => 1
    }
    // Input 0 is live and listed; input 1 is spent (so, on >= 2.6, unlisted).
    expect(await conflictingSpend(tx, [0], s)).toEqual({ outpoint: `${other}.3`, spendTxid: COMPETITOR })
  })

  it('self-heals a coin left spent by THIS tx (an interrupted attempt): release, then a retryable InfraError', async () => {
    const tx = spendTx()
    const self = tx.id('hex')
    const s = store({ row: { spent: true, spentBy: self, consumedBy: [] } })
    const err = await conflictingSpend(tx, [], s).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect((err as Error).message).toBe(SELF_HEAL_DESCRIPTION(`${SRC}.0`))
    expect(s.released).toEqual([[SRC, 0, self]])
  })

  it('self-heals a legacy row whose consumedBy names THIS tx too', async () => {
    const tx = spendTx()
    const self = tx.id('hex')
    const s = store({ row: { spent: true, spentBy: null, consumedBy: [`${self}.0`] } })
    const err = await conflictingSpend(tx, [], s).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect(s.released).toEqual([[SRC, 0, self]])
  })

  it('heals a coin still held by an EVICTED competitor: release it, then a retryable InfraError', async () => {
    const s = store({ row: { spent: true, spentBy: COMPETITOR, consumedBy: [] }, evicted: [COMPETITOR] })
    const err = await conflictingSpend(spendTx(), [], s).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect((err as Error).message).toBe(EVICTED_HEAL_DESCRIPTION(`${SRC}.0`, COMPETITOR))
    expect(s.released).toEqual([[SRC, 0, COMPETITOR]])
  })

  it('a throwing releaseSpend is an InfraError too — never a verdict', async () => {
    const tx = spendTx()
    const s: SpentInputStore = {
      spendStateOf: async () => ({ spent: true, spentBy: tx.id('hex'), consumedBy: [] }),
      wasEvicted: async () => false,
      releaseSpend: async () => { throw new Error('SQLITE_BUSY') }
    }
    const err = await conflictingSpend(tx, [], s).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect((err as Error).message).not.toBe(SELF_HEAL_DESCRIPTION(`${SRC}.0`))
  })
})

describe('withSpentInputGuard', () => {
  const inner = (calls: { n: number }): any => ({
    identifyAdmissibleOutputs: async () => { calls.n++; return { outputsToAdmit: [0], coinsToRetain: [0] } },
    getDocumentation: async () => 'doc',
    getMetaData: async () => ({ name: 'tm_mandala', shortDescription: 's' })
  })

  it('throws InputSpentError before delegating', async () => {
    const calls = { n: 0 }
    const tm = withSpentInputGuard(inner(calls), store({ row: { spent: true, spentBy: COMPETITOR, consumedBy: [] } }))
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputSpentError)
    expect((err as InputSpentError).spendTxid).toBe(COMPETITOR)
    expect(codeOfManagerError(err)).toBe('ERR_INPUT_SPENT')
    expect(calls.n).toBe(0)
  })

  it('delegates unchanged when nothing conflicts', async () => {
    const calls = { n: 0 }
    const tm = withSpentInputGuard(inner(calls), store({ row: LIVE }))
    const res = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined)
    expect(res.outputsToAdmit).toEqual([0])
    expect(calls.n).toBe(1)
  })

  // @bsv/overlay >= 2.6 builds previousCoins with findOutput(…, false), so a
  // spent coin is never IN previousCoins — the guard must not rely on it.
  it('inspects every input, even with previousCoins = []', async () => {
    const calls = { n: 0 }
    const tm = withSpentInputGuard(inner(calls), store({ row: { spent: true, spentBy: COMPETITOR, consumedBy: [] } }))
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputSpentError)
    expect((err as InputSpentError).spendTxid).toBe(COMPETITOR)
    expect(calls.n).toBe(0)
  })

  it('a live input missing from previousCoins: retryable InfraError, nothing released; inner never runs', async () => {
    const calls = { n: 0 }
    const s = store({ row: LIVE })
    const tm = withSpentInputGuard(inner(calls), s)
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect(err).not.toBeInstanceOf(InputSpentError)
    expect((err as Error).message).toBe(MOVED_DESCRIPTION(`${SRC}.0`))
    expect(s.released).toEqual([])
    expect(calls.n).toBe(0)
  })

  it('names a legacy competitor from consumedBy when spentBy is null', async () => {
    const calls = { n: 0 }
    const tm = withSpentInputGuard(inner(calls), store({ row: { spent: true, spentBy: null, consumedBy: [`${COMPETITOR}.0`] } }))
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputSpentError)
    expect((err as InputSpentError).spendTxid).toBe(COMPETITOR)
    expect(calls.n).toBe(0)
  })

  it('an evicted competitor: releaseSpend(…, competitor) once and a retryable InfraError; inner never runs', async () => {
    const calls = { n: 0 }
    const s = store({ row: { spent: true, spentBy: COMPETITOR, consumedBy: [] }, evicted: [COMPETITOR] })
    const tm = withSpentInputGuard(inner(calls), s)
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect(err).not.toBeInstanceOf(InputSpentError)
    expect((err as Error).message).toBe(EVICTED_HEAL_DESCRIPTION(`${SRC}.0`, COMPETITOR))
    expect(s.released).toEqual([[SRC, 0, COMPETITOR]])
    expect(calls.n).toBe(0)
  })

  it('spentBy === own txid: releaseSpend(…, self) and a retryable InfraError; inner never runs', async () => {
    const calls = { n: 0 }
    const tx = spendTx()
    const self = tx.id('hex')
    const s = store({ row: { spent: true, spentBy: self, consumedBy: [] } })
    const tm = withSpentInputGuard(inner(calls), s)
    const err = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfraError)
    expect((err as Error).message).toBe(SELF_HEAL_DESCRIPTION(`${SRC}.0`))
    expect(s.released).toEqual([[SRC, 0, self]])
    expect(calls.n).toBe(0)
  })

  it('preserves documentation/metadata through the proxy', async () => {
    const tm = withSpentInputGuard(inner({ n: 0 }), store({}))
    expect(await tm.getDocumentation()).toBe('doc')
    expect(await tm.getMetaData?.()).toEqual({ name: 'tm_mandala', shortDescription: 's' })
  })
})

// ──────────────────── §9.5 — the guard fails CLOSED, retryably ───────────────

describe('withSpentInputGuard — a store fault is an InfraError, never a verdict', () => {
  const inner = (calls: { n: number }): any => ({
    identifyAdmissibleOutputs: async () => { calls.n++; return { outputsToAdmit: [0], coinsToRetain: [] } }
  })

  it('a throwing spendStateOf refuses retryably instead of admitting the unchecked spend', async () => {
    const calls = { n: 0 }
    const tm = withSpentInputGuard(inner(calls), {
      spendStateOf: async () => { throw new Error('ECONNREFUSED') },
      wasEvicted: async () => false,
      releaseSpend: async () => 1
    })
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(err).not.toBeInstanceOf(InputSpentError)
    // Fails CLOSED: the pinned manager never ran on state we could not read.
    expect(calls.n).toBe(0)
  })

  it('a throwing wasEvicted is infrastructure too — the §7 rescue cannot be guessed at', async () => {
    const tm = withSpentInputGuard(inner({ n: 0 }), {
      spendStateOf: async () => ({ spent: true, spentBy: COMPETITOR, consumedBy: [] }),
      wasEvicted: async () => { throw new Error('mongo down') },
      releaseSpend: async () => 1
    })
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
  })
})

// ───────── §9.5 — the production reader decodes the engine row fail-CLOSED ─────────

/** A knex stand-in answering `knex('outputs').where(...).first()` with `row`. */
const rowKnex = (row: Record<string, unknown> | undefined): any =>
  () => ({ where: () => ({ first: async () => row }) })

const COMPETITOR_ENTRY = JSON.stringify([{ txid: COMPETITOR, outputIndex: 0 }])

describe('knexSpentInputStore — decodes the engine row, failing CLOSED on anything unreadable', () => {
  const read = async (row: Record<string, unknown> | undefined) =>
    await knexSpentInputStore(rowKnex(row), 'tm_x', async () => false).spendStateOf(SRC, 0)

  it('decodes the shapes the engine writes (0/1 or boolean, JSON-string or array consumedBy)', async () => {
    expect(await read(undefined)).toBeNull()
    expect(await read({ spent: 1, spentBy: COMPETITOR, consumedBy: COMPETITOR_ENTRY }))
      .toEqual({ spent: true, spentBy: COMPETITOR, consumedBy: [{ txid: COMPETITOR, outputIndex: 0 }] })
    expect(await read({ spent: true, spentBy: null, consumedBy: [`${COMPETITOR}.0`] }))
      .toEqual({ spent: true, spentBy: null, consumedBy: [`${COMPETITOR}.0`] })
    expect(await read({ spent: 0, spentBy: null, consumedBy: '[]' })).toEqual({ spent: false, spentBy: null, consumedBy: [] })
    expect(await read({ spent: false, spentBy: null, consumedBy: [] })).toEqual({ spent: false, spentBy: null, consumedBy: [] })
    expect(await read({ spent: 1n, spentBy: null, consumedBy: '[]' })).toEqual({ spent: true, spentBy: null, consumedBy: [] })
  })

  it('a nullable consumedBy is "nothing consumed it" — the same as the engine\'s own parse', async () => {
    expect(await read({ spent: 0, consumedBy: null })).toEqual({ spent: false, spentBy: null, consumedBy: [] })
    expect(await read({ spent: 0, consumedBy: 'null' })).toEqual({ spent: false, spentBy: null, consumedBy: [] })
  })

  it('spentBy: the engine\'s spending txid, lower-cased; null/absent/empty is a legacy row (null)', async () => {
    expect((await read({ spent: 1, spentBy: COMPETITOR.toUpperCase(), consumedBy: '[]' }))?.spentBy).toBe(COMPETITOR)
    expect((await read({ spent: 1, spentBy: null, consumedBy: '[]' }))?.spentBy).toBeNull()
    expect((await read({ spent: 1, consumedBy: '[]' }))?.spentBy).toBeNull()
    expect((await read({ spent: 1, spentBy: '', consumedBy: '[]' }))?.spentBy).toBeNull()
  })

  it.each([
    ['a number', 5],
    ['a Buffer', Buffer.from('cc', 'hex')],
    ['a non-txid string', 'not-a-txid']
  ])('a spentBy that is %s is a fault — never a competitor name, never a legacy null', async (_label, spentBy) => {
    await expect(read({ spent: 1, spentBy, consumedBy: '[]' })).rejects.toThrow(/spentBy/)
  })

  it.each([
    ['unparseable JSON', 'not json'],
    ['an empty string', ''],
    ['a JSON object', '{}'],
    ['a JSON string', '"abc"'],
    ['a JSON number', '7'],
    ['a non-string, non-array value', 5]
  ])('a consumedBy that is %s is a fault, not an empty list', async (_label, consumedBy) => {
    await expect(read({ spent: 1, consumedBy })).rejects.toThrow(/consumedBy/)
  })

  it.each([
    ['the string "1"', '1'],
    ['the string "0"', '0'],
    ['a number other than 0/1', 2],
    ['a Buffer', Buffer.from([1])],
    ['null', null],
    ['undefined', undefined]
  ])('a spent flag that is %s is a fault — never read as unspent', async (_label, spent) => {
    await expect(read({ spent, consumedBy: '[]' })).rejects.toThrow(/spent/)
  })

  const inner = (calls: { n: number }): any => ({
    identifyAdmissibleOutputs: async () => { calls.n++; return { outputsToAdmit: [0], coinsToRetain: [] } }
  })

  it.each([
    ['a malformed consumedBy', { spent: 1, consumedBy: 'not json' }],
    ['a non-array consumedBy', { spent: 1, consumedBy: '{}' }],
    ['an unreadable spent flag', { spent: '1', consumedBy: COMPETITOR_ENTRY }],
    ['an unreadable spentBy', { spent: 1, spentBy: 7, consumedBy: COMPETITOR_ENTRY }]
  ])('%s refuses the spend retryably (InfraError), never a final ERR_INPUT_SPENT and never admits', async (_label, row) => {
    const calls = { n: 0 }
    // wasEvicted(true) must not matter: the competitor cannot be named, so the
    // §7 rescue cannot be evaluated and the guard must not guess either way.
    const tm = withSpentInputGuard(inner(calls),
      knexSpentInputStore(rowKnex(row), 'tm_x', async () => true))
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    // The DECODE refused — not a heal attempt the evicted flag would trigger.
    expect((err as Error).message).toMatch(/outputs\.(consumedBy|spent|spentBy) /)
    expect(err).not.toBeInstanceOf(InputSpentError)
    expect(calls.n).toBe(0)
  })
})
