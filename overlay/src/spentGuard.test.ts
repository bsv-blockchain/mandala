import { describe, it, expect } from 'vitest'
import { Transaction, UnlockingScript, P2PKH, PrivateKey } from '@bsv/sdk'
import {
  conflictingSpend, withSpentInputGuard, casMarkUTXOAsSpent, spendTxidOf,
  InFlightOutpoints, IN_FLIGHT_DESCRIPTION, tokenInputOutpoints,
  type SpentInputStore, type ConsumedByEntry
} from './spentGuard.js'
import { InputSpentError, InfraError, isInfraError, classifyManagerReason } from './submitVerdict.js'

const SRC = 'aa'.repeat(32)
const COMPETITOR = 'cc'.repeat(32)

const spendTx = (): Transaction => {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: SRC, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(new PrivateKey(5).toAddress()) })
  return tx
}

const store = (opts: {
  row?: { spent: boolean, consumedBy: ConsumedByEntry[] } | null
  evicted?: string[]
}): SpentInputStore => ({
  spendStateOf: async () => opts.row === undefined ? { spent: false, consumedBy: [] } : opts.row,
  wasEvicted: async (txid: string) => (opts.evicted ?? []).includes(txid)
})

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
    expect(await conflictingSpend(spendTx(), [0], store({ row: { spent: false, consumedBy: [] } }))).toBeNull()
  })

  it('refuses an input already spent by a different still-admitted tx, naming the competitor', async () => {
    const hit = await conflictingSpend(spendTx(), [0], store({ row: { spent: true, consumedBy: [`${COMPETITOR}.0`] } }))
    expect(hit).toEqual({ outpoint: `${SRC}.0`, spendTxid: COMPETITOR })
  })

  it('treats an input spent by a tx whose admission record carries evictedAt as LIVE', async () => {
    const hit = await conflictingSpend(
      spendTx(), [0],
      store({ row: { spent: true, consumedBy: [`${COMPETITOR}.0`] }, evicted: [COMPETITOR] })
    )
    expect(hit).toBeNull()
  })

  it('treats a missing row as live — an evicted spend deletes the row, and silence is not a conflict', async () => {
    expect(await conflictingSpend(spendTx(), [0], store({ row: null }))).toBeNull()
  })

  it('still refuses when the competitor cannot be named (spent, no consumedBy)', async () => {
    const hit = await conflictingSpend(spendTx(), [0], store({ row: { spent: true, consumedBy: [] } }))
    expect(hit).toEqual({ outpoint: `${SRC}.0`, spendTxid: '' })
  })

  it('does not treat the submitting transaction itself as a competitor', async () => {
    const tx = spendTx()
    const self = tx.id('hex')
    expect(await conflictingSpend(tx, [0], store({ row: { spent: true, consumedBy: [`${self}.0`] } }))).toBeNull()
  })

  it('only inspects inputs this topic previously admitted (previousCoins)', async () => {
    let looked = 0
    const s: SpentInputStore = {
      spendStateOf: async () => { looked++; return { spent: false, consumedBy: [] } },
      wasEvicted: async () => false
    }
    await conflictingSpend(spendTx(), [], s)
    expect(looked).toBe(0)
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
    const tm = withSpentInputGuard(inner(calls), store({ row: { spent: true, consumedBy: [`${COMPETITOR}.0`] } }))
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputSpentError)
    expect((err as InputSpentError).spendTxid).toBe(COMPETITOR)
    expect(classifyManagerReason((err as Error).message)).toBe('ERR_INPUT_SPENT')
    expect(calls.n).toBe(0)
  })

  it('delegates unchanged when nothing conflicts', async () => {
    const calls = { n: 0 }
    const tm = withSpentInputGuard(inner(calls), store({ row: { spent: false, consumedBy: [] } }))
    const res = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined)
    expect(res.outputsToAdmit).toEqual([0])
    expect(calls.n).toBe(1)
  })

  it('preserves documentation/metadata through the proxy', async () => {
    const tm = withSpentInputGuard(inner({ n: 0 }), store({}))
    expect(await tm.getDocumentation()).toBe('doc')
    expect(await tm.getMetaData?.()).toEqual({ name: 'tm_mandala', shortDescription: 's' })
  })
})

describe('casMarkUTXOAsSpent — compare-and-swap on spent=false', () => {
  it('marks an unspent row and reports no conflict', async () => {
    const seen: string[] = []
    const mark = casMarkUTXOAsSpent({
      markSpentIfUnspent: async (txid, vout, topic) => { seen.push(`${txid}.${vout}@${topic}`); return 1 },
      onConflict: () => { throw new Error('should not fire') }
    })
    await mark(SRC, 0, 'tm_mandala')
    expect(seen).toEqual([`${SRC}.0@tm_mandala`])
  })

  it('reports a conflict when the CAS affects zero rows (someone else already spent it)', async () => {
    const conflicts: string[] = []
    const mark = casMarkUTXOAsSpent({
      markSpentIfUnspent: async () => 0,
      onConflict: (txid, vout, topic) => { conflicts.push(`${txid}.${vout}@${topic}`) }
    })
    await mark(SRC, 0, 'tm_mandala')
    expect(conflicts).toEqual([`${SRC}.0@tm_mandala`])
  })

  it('never throws out of the engine mutation phase, even if the update fails', async () => {
    const mark = casMarkUTXOAsSpent({
      markSpentIfUnspent: async () => { throw new Error('sqlite locked') },
      onConflict: () => {}
    })
    await expect(mark(SRC, 0, 'tm_mandala')).resolves.toBeUndefined()
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
      wasEvicted: async () => false
    })
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(err).not.toBeInstanceOf(InputSpentError)
    // Fails CLOSED: the pinned manager never ran on state we could not read.
    expect(calls.n).toBe(0)
  })

  it('a throwing wasEvicted is infrastructure too — the §7 rescue cannot be guessed at', async () => {
    const tm = withSpentInputGuard(inner({ n: 0 }), {
      spendStateOf: async () => ({ spent: true, consumedBy: [{ txid: COMPETITOR, outputIndex: 0 }] }),
      wasEvicted: async () => { throw new Error('mongo down') }
    })
    const err = await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
  })

  it('an InfraError message is NEVER re-classified into a final 400 by the table', async () => {
    // The table reads "spent" as ERR_INPUT_SPENT; only the structural marker
    // keeps a store fault out of the persisted set.
    expect(classifyManagerReason('the engine output store is unavailable: already spent')).toBe('ERR_INPUT_SPENT')
    expect(isInfraError(new InfraError('the engine output store is unavailable: already spent'))).toBe(true)
  })
})

// ───────────────── §9.7 — the in-flight outpoint claim ──────────────────────

describe('InFlightOutpoints', () => {
  const A = `${SRC}.0`
  const B = `${SRC}.1`
  const TX1 = '11'.repeat(32)
  const TX2 = '22'.repeat(32)

  it('lets one transaction claim a coin and refuses the next with an InfraError', () => {
    const set = new InFlightOutpoints()
    set.hold(TX1, [A])
    expect(() => set.hold(TX2, [A])).toThrow(IN_FLIGHT_DESCRIPTION(A))
    expect(isInfraError(((): unknown => { try { set.hold(TX2, [A]) } catch (e) { return e } })())).toBe(true)
  })

  it('is idempotent for the same transaction (a retry of its own claim)', () => {
    const set = new InFlightOutpoints()
    set.hold(TX1, [A, B])
    expect(() => set.hold(TX1, [A, B])).not.toThrow()
  })

  it('claims all-or-nothing, so a refused claim strands nothing', () => {
    const set = new InFlightOutpoints()
    set.hold(TX1, [B])
    expect(() => set.hold(TX2, [A, B])).toThrow()
    // A was never claimed by TX2, so a third transaction can still take it.
    expect(() => set.hold('33'.repeat(32), [A])).not.toThrow()
  })

  it('releases per-outpoint (the compare-and-swap) and wholesale (the request)', () => {
    const set = new InFlightOutpoints()
    set.hold(TX1, [A, B])
    set.releaseOutpoint(A)
    expect(set.outpoints()).toEqual([B])
    set.releaseAll(TX1)
    expect(set.outpoints()).toEqual([])
    expect(() => set.hold(TX2, [A, B])).not.toThrow()
  })

  it('releaseAll only frees the named transaction\'s own claims', () => {
    const set = new InFlightOutpoints()
    set.hold(TX1, [A])
    set.hold(TX2, [B])
    set.releaseAll(TX1)
    expect(set.outpoints()).toEqual([B])
  })

  it('expires a claim whose request never released it (a dropped connection)', () => {
    let now = 1000
    const set = new InFlightOutpoints(100, () => now)
    set.hold(TX1, [A])
    expect(() => set.hold(TX2, [A])).toThrow()
    now = 1101
    expect(() => set.hold(TX2, [A])).not.toThrow()
  })

  it('the guard claims the previously-admitted inputs once the spend check passes', async () => {
    const set = new InFlightOutpoints()
    const tm = withSpentInputGuard(
      { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [0], coinsToRetain: [] }) } as any,
      store({}),
      set
    )
    await tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined)
    expect(set.outpoints()).toEqual([`${SRC}.0`])
  })

  it('claims nothing for a submission the manager beneath refuses', async () => {
    const set = new InFlightOutpoints()
    const tm = withSpentInputGuard(
      { identifyAdmissibleOutputs: async () => { throw new Error('conservation violated') } } as any,
      store({}),
      set
    )
    await expect(tm.identifyAdmissibleOutputs(spendTx().toBEEF(), [0], undefined)).rejects.toThrow()
    expect(set.outpoints()).toEqual([])
  })

  it('onMarked fires whether the compare-and-swap won or lost', async () => {
    const released: string[] = []
    const won = casMarkUTXOAsSpent({ markSpentIfUnspent: async () => 1, onMarked: (t, v) => released.push(`${t}.${v}`) })
    await won(SRC, 0, 'tm_mandala')
    const lost = casMarkUTXOAsSpent({ markSpentIfUnspent: async () => 0, onMarked: (t, v) => released.push(`${t}.${v}`) })
    await lost(SRC, 1, 'tm_mandala')
    const threw = casMarkUTXOAsSpent({
      markSpentIfUnspent: async () => { throw new Error('sqlite locked') },
      onMarked: (t, v) => released.push(`${t}.${v}`)
    })
    await threw(SRC, 2, 'tm_mandala')
    expect(released).toEqual([`${SRC}.0`, `${SRC}.1`, `${SRC}.2`])
  })
})

describe('tokenInputOutpoints', () => {
  it('names only the inputs the engine resolved into previousCoins', () => {
    const tx = spendTx()
    tx.addInput({ sourceTXID: 'bb'.repeat(32), sourceOutputIndex: 3, unlockingScript: new UnlockingScript() })
    expect(tokenInputOutpoints(tx, [0])).toEqual([`${SRC}.0`])
    expect(tokenInputOutpoints(tx, [0, 1])).toEqual([`${SRC}.0`, `${'bb'.repeat(32)}.3`])
    expect(tokenInputOutpoints(tx, [])).toEqual([])
    // An index the transaction does not have is simply not a coin.
    expect(tokenInputOutpoints(tx, [9])).toEqual([])
  })
})
