/**
 * FIX L — the overlay refuses a conflicting second spend itself, instead of
 * leaving it to Arcade's broadcast-time race (contract §7).
 *
 * Two independent holes, both live in the pinned stack:
 *
 *  1. `Engine.submit` builds `previousCoins` with
 *     `storage.findOutput(prevTxid, vout, topic)` and NO `spent` filter, so an
 *     already-spent coin is merged into the manager's input set exactly like a
 *     live one. Two concurrent /submit calls spending the same coin therefore
 *     both pass validation; only Arcade's DOUBLE_SPEND_ATTEMPTED separates
 *     them, and offline settlement cannot wait for that.
 *  2. `KnexStorage.markUTXOAsSpent` is an unconditional
 *     `UPDATE outputs SET spent = true WHERE …` with no rows-affected check,
 *     so the second writer silently "wins" a row it never owned.
 *
 * This module closes both repo-locally:
 *
 *  - `withSpentInputGuard` is the ENFORCING half: it consults the live spend
 *    state of every previously-admitted input BEFORE delegating and throws
 *    `InputSpentError` (→ 400 ERR_INPUT_SPENT, naming the competitor).
 *  - `casMarkUTXOAsSpent` is the DETECTING half: installed over the engine
 *    storage's `markUTXOAsSpent`, it turns the update into a compare-and-swap
 *    on `spent = false` and reports a zero-rows-affected conflict. It cannot
 *    refuse the submission from there — the engine calls it inside its own
 *    swallowing try/catch, after the broadcast — which is exactly why the
 *    pre-delegation guard above is the enforcement point and this half is the
 *    race-narrowing + observability one.
 *
 * Contract §7's rescue clause is honoured in `conflictingSpend`: a coin marked
 * spent by a transaction whose admission record carries `evictedAt` counts as
 * LIVE, so a client racing the FIX E restore is never told ERR_INPUT_SPENT for
 * a spend that no longer exists.
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
  /** The outputs that consumed this coin — their txid is the competitor. */
  consumedBy: ConsumedByEntry[]
}

export interface SpentInputStore {
  /** Live spend state of `txid.outputIndex` on this topic, or null for no row. */
  spendStateOf: (txid: string, outputIndex: number) => Promise<SpendState | null>
  /** True when that spending txid's admission record carries `evictedAt` (FIX E). */
  wasEvicted: (txid: string) => Promise<boolean>
}

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
 * The outpoints of this transaction's PREVIOUSLY ADMITTED inputs — the coins
 * the engine resolved into `previousCoins`, i.e. the token inputs whose spend
 * state this guard has just cleared.
 */
export const tokenInputOutpoints = (tx: Transaction, previousCoins: number[]): string[] => {
  const out: string[] = []
  for (const ci of previousCoins) {
    const inp = tx.inputs[ci]
    if (inp == null) continue
    const { txid, vout } = outpointOf(inp)
    if (txid !== '') out.push(`${txid}.${vout}`)
  }
  return out
}

// ─────────────────────── in-flight outpoints (§9.7) ─────────────────────────

/** Identical on both engines — the wallet keys its retry/backoff branch on it. */
export const IN_FLIGHT_DESCRIPTION = (outpoint: string): string =>
  `input ${outpoint} is being spent by another submission that is still in flight; retry`

/**
 * §9.7 — the in-process hold that closes the window `conflictingSpend` cannot.
 *
 * The spent-input guard reads COMMITTED state: `spent` is set by
 * `markUTXOAsSpent`, which the pinned `Engine.submit` runs in PHASE 3 — AFTER
 * it has broadcast and AFTER `onSteakReady` has already answered the client.
 * Two submissions that arrive inside that window both read `spent = false`,
 * both clear the guard, and both are admitted and broadcast; only one of them
 * can win the compare-and-swap afterwards, and by then both submitters hold a
 * 200 with a valid σ_I over conflicting spends of the same coin. That is the
 * double-spend FIX L was supposed to stop, surviving as a race.
 *
 * So a submission that CLEARS the guard immediately claims its inputs here, and
 * a concurrent submission touching a claimed outpoint gets
 * 503 ERR_UNAVAILABLE — retryable, never persisted, never a σ_I. By the time it
 * retries, the winner's compare-and-swap has run and the ordinary guard answers
 * the authoritative 400 ERR_INPUT_SPENT naming it.
 *
 * Holds are released per-outpoint by the compare-and-swap (`onMarked`) and, as
 * a leak-guard, wholesale when the request settles; the TTL sweep is the last
 * resort for a request that never reaches either (dropped connection).
 */
export class InFlightOutpoints {
  private readonly held = new Map<string, { txid: string, at: number }>()

  constructor (
    private readonly ttlMs: number = 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  private prune (): void {
    const cutoff = this.now() - this.ttlMs
    for (const [outpoint, entry] of this.held) {
      if (entry.at < cutoff) this.held.delete(outpoint)
    }
  }

  /**
   * Claims every outpoint for `txid`, all-or-nothing. Throws `InfraError`
   * naming the first outpoint another transaction already holds — so a partial
   * claim never strands coins the caller was refused.
   */
  hold (txid: string, outpoints: string[]): void {
    this.prune()
    for (const outpoint of outpoints) {
      const owner = this.held.get(outpoint)
      if (owner != null && owner.txid !== txid) throw new InfraError(IN_FLIGHT_DESCRIPTION(outpoint))
    }
    const at = this.now()
    for (const outpoint of outpoints) this.held.set(outpoint, { txid, at })
  }

  /** Released by the compare-and-swap mark-spent, which names the COIN. */
  releaseOutpoint (outpoint: string): void {
    this.held.delete(outpoint)
  }

  releaseAll (txid: string): void {
    for (const [outpoint, entry] of this.held) {
      if (entry.txid === txid) this.held.delete(outpoint)
    }
  }

  /** Test/observability only. */
  outpoints (): string[] {
    this.prune()
    return [...this.held.keys()]
  }
}

/**
 * The first input of `tx` that a different, still-admitted transaction has
 * already spent — or null when every previously-admitted input is live.
 * `spendTxid` is '' when the competitor cannot be named from `consumedBy`
 * (the coin is still spent, so the submission is still refused).
 */
export const conflictingSpend = async (
  tx: Transaction,
  previousCoins: number[],
  store: SpentInputStore
): Promise<{ outpoint: string, spendTxid: string } | null> => {
  const self = tx.id('hex')
  for (const ci of previousCoins) {
    const inp = tx.inputs[ci]
    if (inp == null) continue
    const { txid, vout } = outpointOf(inp)
    if (txid === '') continue
    // §9.5: a guard that cannot READ the state it gates on fails closed with a
    // retryable 503 — it must neither admit the unchecked spend (fail open) nor
    // mint a final 400 out of a storage fault.
    const state = await infra('the engine output store', async () => await store.spendStateOf(txid, vout))
    // No row at all: either never indexed, or deleted by an eviction that
    // restored this coin. Either way there is no conflict we can prove.
    if (state == null || !state.spent) continue
    const competitor = spendTxidOf(state.consumedBy)
    if (competitor === self) continue
    if (competitor != null && await infra('the admission record store', async () => await store.wasEvicted(competitor))) continue
    return { outpoint: `${txid}.${vout}`, spendTxid: competitor ?? '' }
  }
  return null
}

/**
 * Wraps a topic manager so a conflicting spend is refused before delegating,
 * and so the inputs this submission just cleared are claimed in `inFlight`
 * until its spend-mark lands (§9.7).
 */
export const withSpentInputGuard = (
  inner: TopicManager, store: SpentInputStore, inFlight?: InFlightOutpoints
): TopicManager => {
  const guarded: TopicManager = {
    ...inner,
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[], offChainValues?: number[]) => {
      const tx = Transaction.fromBEEF(beef)
      const hit = await conflictingSpend(tx, previousCoins, store)
      if (hit != null) throw new InputSpentError(hit.outpoint, hit.spendTxid)
      const txid = tx.id('hex')
      inFlight?.hold(txid, tokenInputOutpoints(tx, previousCoins))
      try {
        return await (inner.identifyAdmissibleOutputs as (
          b: number[], p: number[], o?: number[]
        ) => Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }>)(beef, previousCoins, offChainValues)
      } catch (e) {
        // A refused submission spends nothing, so its claim ends here rather
        // than waiting for the request to settle.
        inFlight?.releaseAll(txid)
        throw e
      }
    }
  }
  return new Proxy(guarded, {
    get: (target, prop, receiver) =>
      prop === 'identifyAdmissibleOutputs'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}

export interface CasMarkSpentDeps {
  /**
   * `UPDATE outputs SET spent = true WHERE txid = ? AND outputIndex = ? AND
   * topic = ? AND spent = false` — resolving to the number of rows affected.
   */
  markSpentIfUnspent: (txid: string, outputIndex: number, topic: string) => Promise<number>
  /** Fired when the CAS affected zero rows (already spent, or row gone). */
  onConflict?: (txid: string, outputIndex: number, topic: string) => void
  /**
   * Fired once the coin's spend state is settled either way — the committed
   * `spent = true` is now visible to `conflictingSpend`, so the §9.7 in-flight
   * claim on this outpoint has done its job and is released.
   */
  onMarked?: (txid: string, outputIndex: number, topic: string) => void
}

/**
 * A drop-in replacement for `KnexStorage.markUTXOAsSpent` that is a
 * compare-and-swap. Deliberately total: the engine calls this inside a
 * try/catch that only logs, after the transaction has already been broadcast,
 * so throwing here would change nothing except the log line.
 */
export const casMarkUTXOAsSpent = (deps: CasMarkSpentDeps) =>
  async (txid: string, outputIndex: number, topic: string): Promise<void> => {
    try {
      const affected = await deps.markSpentIfUnspent(txid, outputIndex, topic)
      if (affected === 0) deps.onConflict?.(txid, outputIndex, topic)
    } catch (e) {
      console.warn(`[mandala] compare-and-swap mark-spent failed for ${txid}.${outputIndex}@${topic}:`, e)
    } finally {
      deps.onMarked?.(txid, outputIndex, topic)
    }
  }
