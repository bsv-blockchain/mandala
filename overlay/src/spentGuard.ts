/**
 * FIX L — the overlay refuses a conflicting second spend itself, instead of
 * leaving it to Arcade's broadcast-time race (contract §7).
 *
 * Since `@bsv/overlay` 2.6 the engine builds `previousCoins` with
 * `storage.findOutput(prevTxid, vout, topic, false)`, which silently DROPS an
 * already-spent coin. A double spend therefore never shows its spent input to
 * the manager at all, and would surface as the manager's conservation reject —
 * a persisted, final ERR_CONSERVATION instead of ERR_INPUT_SPENT naming the
 * competitor. So `withSpentInputGuard` inspects EVERY input of the
 * transaction against the engine's `outputs` table, before delegating, and
 * throws `InputSpentError` (→ 400 ERR_INPUT_SPENT, naming the competitor).
 *
 * The engine's own `KnexStorage.markUTXOAsSpent` is a compare-and-swap on
 * `spent = false` that records the spending txid in `outputs.spentBy`, and a
 * phase-3 storage failure now rethrows out of `Engine.submit` (→ 503
 * ERR_UNAVAILABLE). Submissions are serialized by the engine's own lock, and
 * the STEAK is only produced after storage is durable.
 *
 * Contract §7's rescue clause is honoured in `conflictingSpend`: a coin still
 * marked spent by a transaction whose admission record carries `evictedAt` is
 * released and the submission refused retryably, so a client racing the FIX E
 * restore is never told ERR_INPUT_SPENT for a spend that no longer exists. A
 * coin left spent by an interrupted attempt of the SAME transaction is healed
 * the same way.
 */
import { Transaction } from '@bsv/sdk'
import type { TopicManager } from '@bsv/overlay'
import { InputSpentError, InfraError, infra } from './submitVerdict.js'

/**
 * `@bsv/overlay`'s `Output.consumedBy` is `Array<{txid, outputIndex}>` after
 * `parseOutputRecord`, but a raw knex row carries the same data as a JSON
 * string of `txid.vout` outpoints in some storage backends. Accept both.
 */
export type ConsumedByEntry = string | { txid?: string, outputIndex?: number }

export interface SpendState {
  spent: boolean
  /** The engine's `outputs.spentBy` — the spending txid recorded by the CAS (null on legacy rows). */
  spentBy: string | null
  /** The outputs that consumed this coin — fallback when spentBy is null. */
  consumedBy: ConsumedByEntry[]
}

export interface SpentInputStore {
  /** Live spend state of `txid.outputIndex` on this topic, or null for no row. */
  spendStateOf: (txid: string, outputIndex: number) => Promise<SpendState | null>
  /** True when that spending txid's admission record carries `evictedAt` (FIX E). */
  wasEvicted: (txid: string) => Promise<boolean>
  /**
   * `UPDATE outputs SET spent=false, spentBy=NULL WHERE txid/outputIndex/topic
   * AND spent=true AND (spentBy=spender OR spentBy IS NULL)` → rows affected.
   */
  releaseSpend: (txid: string, outputIndex: number, spender: string) => Promise<number>
}

export const SELF_HEAL_DESCRIPTION = (outpoint: string): string =>
  `input ${outpoint} was left marked spent by an interrupted attempt of this transaction; released, retry`
export const EVICTED_HEAL_DESCRIPTION = (outpoint: string, competitor: string): string =>
  `input ${outpoint} was still marked spent by evicted transaction ${competitor}; released, retry`

/** The spending transaction id behind a `consumedBy` entry list. */
export const spendTxidOf = (consumedBy: ConsumedByEntry[]): string | null => {
  for (const entry of consumedBy ?? []) {
    const candidate = typeof entry === 'string'
      ? entry.slice(0, entry.lastIndexOf('.') === -1 ? entry.length : entry.lastIndexOf('.'))
      : entry?.txid ?? ''
    if (/^[0-9a-f]{64}$/i.test(candidate)) return candidate.toLowerCase()
  }
  return null
}

const outpointOf = (inp: { sourceTXID?: string, sourceTransaction?: Transaction, sourceOutputIndex: number }): { txid: string, vout: number } => ({
  txid: inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? '',
  vout: inp.sourceOutputIndex
})

/**
 * The first input of `tx` that a different, still-admitted transaction has
 * already spent — or null when every input is live.
 *
 * Every input, not `previousCoins`: since @bsv/overlay 2.6 the engine omits
 * spent coins from previousCoins, so the double spend would otherwise surface
 * as the manager's conservation reject (a persisted final ERR_CONSERVATION).
 * An input with no row on this topic (a fee input, a coin never admitted, or
 * one an eviction deleted) is not a conflict this guard can prove.
 * `spendTxid` is '' when the competitor cannot be named (the coin is still
 * spent, so the submission is still refused).
 *
 * Two stale-spend cases are healed, then refused retryably (InfraError → 503),
 * because the engine already built previousCoins without the coin:
 *  - spent by THIS tx: an earlier attempt crashed between mark-spent and
 *    insertAppliedTransaction (the engine's dupe check already proved this tx
 *    is not applied);
 *  - spent by an EVICTED tx whose input restore never ran.
 *
 * §9.5: every store call fails CLOSED through `infra()` — a guard that cannot
 * read (or release) the state it gates on neither admits the unchecked spend
 * nor mints a final 400 out of a storage fault.
 */
export const conflictingSpend = async (
  tx: Transaction,
  store: SpentInputStore
): Promise<{ outpoint: string, spendTxid: string } | null> => {
  const self = tx.id('hex')
  for (const inp of tx.inputs) {
    const { txid, vout } = outpointOf(inp)
    if (txid === '') continue
    const state = await infra('the engine output store', async () => await store.spendStateOf(txid, vout))
    if (state == null || !state.spent) continue
    const outpoint = `${txid}.${vout}`
    const competitor = state.spentBy ?? spendTxidOf(state.consumedBy)
    if (competitor === self) {
      await infra('the engine output store', async () => await store.releaseSpend(txid, vout, self))
      throw new InfraError(SELF_HEAL_DESCRIPTION(outpoint))
    }
    if (competitor != null && await infra('the admission record store', async () => await store.wasEvicted(competitor))) {
      await infra('the engine output store', async () => await store.releaseSpend(txid, vout, competitor))
      throw new InfraError(EVICTED_HEAL_DESCRIPTION(outpoint, competitor))
    }
    return { outpoint, spendTxid: competitor ?? '' }
  }
  return null
}

/** Wraps a topic manager so a conflicting spend is refused before delegating. */
export const withSpentInputGuard = (inner: TopicManager, store: SpentInputStore): TopicManager => {
  const guarded: TopicManager = {
    ...inner,
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[], offChainValues?: number[]) => {
      const tx = Transaction.fromBEEF(beef)
      const hit = await conflictingSpend(tx, store)
      if (hit != null) throw new InputSpentError(hit.outpoint, hit.spendTxid)
      return await (inner.identifyAdmissibleOutputs as (
        b: number[], p: number[], o?: number[]
      ) => Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }>)(beef, previousCoins, offChainValues)
    }
  }
  return new Proxy(guarded, {
    get: (target, prop, receiver) =>
      prop === 'identifyAdmissibleOutputs'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}

/** Minimal knex surface the spent-input store needs (a knex instance satisfies it). */
export type KnexLike = (table: string) => any

// §9.5 — a guard that cannot READ the state it gates on fails CLOSED. These two
// decoders are the only place the engine's raw row is interpreted, so each THROWS
// on a shape it does not recognise (`infra()` in `conflictingSpend` re-badges that
// as a retryable 503). Coercing instead is the failure mode: a garbled
// `consumedBy` read as "no competitor" mints a final 400 ERR_INPUT_SPENT out of a
// storage fault, and a garbled `spent` read as false admits a double spend.
// Messages name the column and the type, never the row's contents.

/** `consumedBy` as the engine writes it: a JSON array in a text column (or already an array). NULL/'null' = unconsumed. */
const parseConsumedBy = (raw: unknown): ConsumedByEntry[] => {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch (e) { throw new Error('outputs.consumedBy is not valid JSON', { cause: e }) }
  }
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('outputs.consumedBy is not a JSON array')
  return value as ConsumedByEntry[]
}

/**
 * `spentBy` as the engine's CAS writes it: the spending txid, or NULL (legacy
 * rows, and every unspent row). '' / absent read as NULL. Anything else —
 * a non-string, or a string that is not a txid — would name a competitor out
 * of a storage fault, so it is a fault.
 */
const parseSpentBy = (raw: unknown): string | null => {
  if (raw == null || raw === '') return null
  if (typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase()
  throw new Error(`outputs.spentBy has an unexpected value of type ${typeof raw}`)
}

/** `spent` as the supported backends return a boolean column: a boolean, or integer 0/1. */
const parseSpent = (raw: unknown): boolean => {
  if (typeof raw === 'boolean') return raw
  const n = typeof raw === 'bigint' ? Number(raw) : raw
  if (n === 0 || n === 1) return n === 1
  throw new Error(`outputs.spent has an unexpected value of type ${raw === null ? 'null' : typeof raw}`)
}

/**
 * The production SpentInputStore: reads the engine's `outputs` table directly
 * (KnexStorage.findOutput does not select `spentBy`).
 *
 * `releaseSpend` only ever un-spends a coin held by the named spender (or by
 * an unlabelled legacy spend): a coin another transaction has since spent is
 * never touched, so a stale heal cannot erase a live spend.
 */
export const knexSpentInputStore = (
  knex: KnexLike, topic: string, wasEvicted: (txid: string) => Promise<boolean>
): SpentInputStore => ({
  spendStateOf: async (txid, outputIndex) => {
    const row = await knex('outputs').where({ txid, outputIndex, topic }).first()
    if (row == null) return null
    return {
      spent: parseSpent(row.spent),
      spentBy: parseSpentBy(row.spentBy),
      consumedBy: parseConsumedBy(row.consumedBy)
    }
  },
  wasEvicted,
  releaseSpend: async (txid, outputIndex, spender) =>
    await knex('outputs')
      .where({ txid, outputIndex, topic, spent: true })
      .andWhere((q: any) => q.where('spentBy', spender).orWhereNull('spentBy'))
      .update({ spent: false, spentBy: null })
})
