/**
 * FIX D, repo-local capture half — see submitVerdict.ts for why it is needed.
 *
 * `Engine.submit` wraps each topic's `identifyAdmissibleOutputs` in a try/catch
 * that records the topic in `failedTopics`, logs, and substitutes
 * `{outputsToAdmit: [], coinsToRetain: []}`. The reject reason — the argument
 * to the manager's own `throw` — is lost before the /submit route ever sees it,
 * and the route answers 200 with an empty STEAK. The wrapper here runs INSIDE
 * this repo's process (only the engine's handling of the return value is
 * pinned), so it can stash the reason, keyed by the submitted txid, in a side
 * channel that this repo's own /submit middleware reads instead of trusting the
 * collapsed 200. No `Engine.js` patch and no ts-stack PR are required.
 *
 * The same wrapper takes the FIX E restore snapshot on the way in: the
 * pre-spend token rows and the outpoints this transaction is about to consume,
 * captured before the engine mutates anything. The pre-Submit compensation path
 * already captures this data in a closure; persisting it on the admission
 * record is what makes it still available at eviction time, long after that
 * closure is gone.
 *
 * Entries are consumed exactly once (`take`) and pruned by TTL, so a dropped
 * connection or a submission that never reaches the JSON interceptor cannot
 * leak memory.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Transaction } from '@bsv/sdk'
import type { TopicManager } from '@bsv/overlay'
import { InputSpentError, FinalVerdictError, InfraError, isInfraError, type VerdictCode } from './submitVerdict.js'

/** Pre-spend snapshot of one token row, as persisted on the admission record. */
export interface AdmissionTokenRow {
  txid: string
  outputIndex: number
  assetId: string
  amount: number
  identityKey: string
  createdAt?: string
}

export interface AdmissionRestore {
  /** `txid.vout` of every input this transaction marks spent. */
  spentOutpoints: string[]
  /** The token rows as they stood BEFORE the spend. */
  tokenRows: AdmissionTokenRow[]
}

export interface ManagerOutcome {
  /** The topic manager's own reject reason, verbatim. */
  reason?: string
  /** Competing txid, when the reject was FIX L's InputSpentError. */
  spendTxid?: string
  /**
   * A structurally-carried verdict, set when the wrapper refused from an
   * already-persisted final verdict. Takes precedence over classifying
   * `reason` through the substring table.
   */
  verdict?: { code: VerdictCode, description: string, spendTxid?: string }
  /** Which topic manager produced `reason` — tm_mandala's takes precedence. */
  topic?: string
  restore?: AdmissionRestore
  at: number
}

/** The token topic; its verdict outranks any other topic's on the same txid. */
export const TOKEN_TOPIC = 'tm_mandala'

// ───────────────────────── request-scoped captures (§9.7) ────────────────────

/**
 * §9.7 — "per-request verdict capture must be request-scoped".
 *
 * The side channel was originally one process-wide map keyed by txid, which is
 * only sound while at most one submission of a given txid is in flight. Two
 * concurrent /submit of the SAME txid — the ordinary case for an offline
 * payment the payer and the payee both push — share that key: whichever manager
 * rejects first writes the entry, `take()` consumes it exactly once, and the
 * two requests then get each other's answers. The clean submission is refused
 * with a verdict it never earned, and the refused one gets the clean 200 with
 * an empty STEAK and no σ_I — the "empty-STEAK-200 for a refusal" case.
 *
 * Every capture therefore lands in a per-request `SubmitScope` that
 * `wrapSubmitJson` creates and enters around `next()`, so the whole engine call
 * — managers included — runs inside it. The wrapper also keeps the scope object
 * in its own closure and reads captures from THAT, rather than from the ambient
 * store: `res.json` is invoked by the pinned route, and nothing guarantees the
 * async context is still the request's by then.
 *
 * The process-wide maps survive as a FALLBACK for captures made outside any
 * request (GASP re-sync calling a manager directly, and unit tests that drive
 * the channel by hand). Reads consult the scope first and the fallback second,
 * so an out-of-scope capture is still visible, but a scoped one is private.
 */
export interface SubmitScope {
  readonly entries: Map<string, ManagerOutcome>
  /** Outpoint → when its compare-and-swap mark-spent lost, for THIS request. */
  readonly conflicts: Map<string, number>
}

export const newSubmitScope = (): SubmitScope => ({ entries: new Map(), conflicts: new Map() })

const scopeStorage = new AsyncLocalStorage<SubmitScope>()

/** Runs `fn` — and everything it awaits — inside `scope`. */
export const runInSubmitScope = <T>(scope: SubmitScope, fn: () => T): T => scopeStorage.run(scope, fn)

export const currentSubmitScope = (): SubmitScope | undefined => scopeStorage.getStore()

export interface SideChannelOptions {
  ttlMs?: number
  now?: () => number
}

export class SubmitSideChannel {
  /** Process-wide fallback for captures made outside any request scope. */
  private readonly global: SubmitScope = newSubmitScope()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor (opts: SideChannelOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  /** Where a capture goes: the ambient request scope, else the fallback. */
  private target (): SubmitScope {
    return currentSubmitScope() ?? this.global
  }

  /** Where a capture is looked for, in precedence order. */
  private sources (scope?: SubmitScope): SubmitScope[] {
    const own = scope ?? currentSubmitScope()
    return own != null ? [own, this.global] : [this.global]
  }

  private prune (): void {
    const cutoff = this.now() - this.ttlMs
    for (const [txid, entry] of this.global.entries) {
      if (entry.at < cutoff) this.global.entries.delete(txid)
    }
    for (const [outpoint, at] of this.global.conflicts) {
      if (at < cutoff) this.global.conflicts.delete(outpoint)
    }
  }

  private upsert (txid: string, patch: Partial<ManagerOutcome>): void {
    this.prune()
    const at = this.now()
    const into = this.target()
    into.entries.set(txid, { ...(into.entries.get(txid) ?? { at }), ...patch, at })
  }

  /**
   * `topic` decides precedence when a submission carries more than one topic
   * and several reject: tm_mandala's verdict always wins, because it is the
   * only one that can mint a token σ_I or a persisted final verdict. A
   * non-token topic's reason is recorded only when nothing is recorded yet.
   */
  noteReject (txid: string, error: unknown, topic: string = TOKEN_TOPIC): void {
    const existing = this.target().entries.get(txid)
    if (topic !== TOKEN_TOPIC && existing?.reason != null) return
    if (topic !== TOKEN_TOPIC && existing?.topic === TOKEN_TOPIC) return
    const reason = error instanceof Error ? error.message : String(error)
    const spendTxid = error instanceof InputSpentError && error.spendTxid !== ''
      ? error.spendTxid
      : error instanceof FinalVerdictError ? error.spendTxid : undefined
    // Both markers travel STRUCTURALLY, so neither code depends on wording:
    // a FinalVerdictError because ERR_EVICTED has no reason string to classify,
    // and an InfraError (§9.5) because the substring table would otherwise read
    // "…store is unavailable: connection refused" as a final 400 ERR_SHAPE and
    // the /submit wrapper would persist it.
    const verdict = error instanceof FinalVerdictError
      ? { code: error.code, description: error.description, spendTxid: error.spendTxid }
      : isInfraError(error)
        ? { code: 'ERR_UNAVAILABLE' as VerdictCode, description: error.message }
        : undefined
    this.upsert(txid, { reason, spendTxid, verdict, topic })
  }

  /**
   * FIX L, storage half. Recorded by the compare-and-swap mark-spent when its
   * UPDATE affects zero rows. Keyed by the COIN's outpoint, not by the spending
   * txid — `markUTXOAsSpent(txid, outputIndex, topic)` names the coin being
   * spent, and the spending transaction is not one of its arguments.
   */
  noteSpendConflict (outpoint: string): void {
    this.prune()
    this.target().conflicts.set(outpoint, this.now())
  }

  /**
   * True when any of these outpoints lost a compare-and-swap recently. Scoped
   * like the verdicts: of two requests racing for one coin the LOSER records the
   * conflict, so a process-wide map would make the winner 503 on its own rival's
   * failure.
   */
  hadSpendConflict (outpoints: string[], scope?: SubmitScope): boolean {
    this.prune()
    const sources = this.sources(scope)
    return (outpoints ?? []).some(o => sources.some(s => s.conflicts.has(o)))
  }

  noteRestore (txid: string, restore: AdmissionRestore): void {
    this.upsert(txid, { restore })
  }

  /**
   * Read and consume the outcome for `txid`. `scope` is the capture scope
   * `wrapSubmitJson` created for THIS request; pass it explicitly, because by
   * the time the pinned route calls `res.json` the ambient async context is no
   * longer guaranteed to be the request's.
   */
  take (txid: string, scope?: SubmitScope): ManagerOutcome | undefined {
    this.prune()
    for (const source of this.sources(scope)) {
      const entry = source.entries.get(txid)
      if (entry != null) {
        source.entries.delete(txid)
        return entry
      }
    }
    return undefined
  }
}

/** §9.4 — the provisional record, written before the engine can broadcast. */
export interface AdmissionPending {
  txid: string
  topics: string[]
  restore?: AdmissionRestore
  at: string
}

export const PENDING_WRITE_FAILED =
  'the admission store could not record this submission before broadcast; retry'

export interface VerdictCaptureDeps {
  channel: SubmitSideChannel
  /** Which topic this manager serves. Defaults to tm_mandala. */
  topic?: string
  /**
   * Captures the pre-spend state this submission is about to consume, called
   * before delegating. A failure here is logged and ignored — bookkeeping must
   * never refuse a submission.
   */
  snapshotRestore?: (tx: Transaction, previousCoins: number[]) => Promise<AdmissionRestore>
  /**
   * §9.4 — writes `{txid, topics, restore, at, pending: true}` BEFORE
   * delegating, i.e. before the engine can broadcast or mutate anything.
   *
   * Without it the restore snapshot only becomes durable on the way OUT, after
   * the engine has already broadcast and marked inputs spent: a crash in that
   * window leaves coins marked spent with no record of what to put back, which
   * is precisely the liveness fatal FIX E exists to prevent. Writing it here
   * costs one upsert and makes the snapshot durable strictly before the state
   * it describes can change.
   *
   * A failure is an `InfraError` — 503, retryable, never persisted — because a
   * submission whose compensation data is not durable must not proceed.
   */
  putPending?: (rec: AdmissionPending) => Promise<void>
}

/**
 * Outermost `tm_mandala` wrapper: snapshots restore state on the way in, makes
 * that snapshot durable, and records the reject reason of anything beneath it
 * on the way out, then rethrows untouched so the engine behaves exactly as
 * before.
 */
export const withVerdictCapture = (inner: TopicManager, deps: VerdictCaptureDeps): TopicManager => {
  const topic = deps.topic ?? TOKEN_TOPIC
  const guarded: TopicManager = {
    ...inner,
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[], offChainValues?: number[]) => {
      let txid: string | null = null
      let restore: AdmissionRestore | undefined
      try {
        const tx = Transaction.fromBEEF(beef)
        txid = tx.id('hex')
        if (deps.snapshotRestore != null) {
          try {
            restore = await deps.snapshotRestore(tx, previousCoins)
            deps.channel.noteRestore(txid, restore)
          } catch (e) {
            console.warn(`[mandala] restore snapshot failed for ${txid}:`, e)
          }
        }
      } catch {
        // Un-parseable BEEF: the engine rejects it on its own; nothing to key on.
      }

      if (txid != null && deps.putPending != null) {
        try {
          await deps.putPending({ txid, topics: [topic], restore, at: new Date().toISOString() })
        } catch (e) {
          const fault = new InfraError(PENDING_WRITE_FAILED, e)
          deps.channel.noteReject(txid, fault, topic)
          throw fault
        }
      }

      try {
        return await (inner.identifyAdmissibleOutputs as (
          b: number[], p: number[], o?: number[]
        ) => Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }>)(beef, previousCoins, offChainValues)
      } catch (error) {
        if (txid != null) deps.channel.noteReject(txid, error, topic)
        throw error
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
