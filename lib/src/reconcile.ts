/**
 * Wallet/overlay reconciliation for half-failed flows.
 *
 * Failure being fixed: an admin action spends the current admin-auth UTXO but
 * something breaks mid-flight (overlay reject with a failed abort, broadcast
 * failure, crash). The old auth output sits held by a stuck 'nosend' action, no
 * spendable admin output remains, and the asset vanishes from the issuer view
 * (listAdminAssets is "spendable basket outputs with mandala-admin CI").
 *
 * Recovery, in order:
 *   1. Journal 'accepted' entries — overlay admitted, broadcast pending: retry
 *      the sendWith broadcast. Never aborted (the overlay already folded state).
 *      A broadcast error meaning "already known" clears the entry as success.
 *      After BROADCAST_RETRY_CAP failed passes the entry moves to 'stranded'
 *      (§9.11): still kept and still never aborted, but no longer retried and
 *      no longer blocking the sweep — otherwise one permanently unbroadcastable
 *      tx wedges every other recovery forever. `journalListStranded()` surfaces
 *      them.
 *   2. Journal 'retryable' entries — the overlay refused with a liftable
 *      condition and the noSend action is still alive with its inputs held
 *      (§9.11). Re-POST the journaled bytes; on acceptance the entry becomes
 *      'accepted' and is broadcast exactly as the live path would. A final
 *      verdict on the retry, or RETRY_CAP fruitless passes, aborts the
 *      reference and drops the entry so the inputs are not held forever.
 *   2b. Journal 'handed_over' entries — an OFFLINE hand-over the payee owns
 *      the submission of (§0.1 rule 3). When this device is online it may
 *      submit too (rule 6, so its change becomes spendable promptly); the
 *      overlay's idempotent /submit makes the order between the two
 *      irrelevant. Treated exactly like 'retryable'.
 *   3. Journal 'abort' entries — overlay rejected, abort pending: retry the
 *      abortAction that releases the held inputs. Kept (attempts++) on failure
 *      so a transient error never orphans the only durable record; handed to
 *      the bulk sweep only after ABORT_RETRY_CAP failures.
 *   4. Bulk sweep — release the inputs of stuck nosend mandala actions that
 *      crashed before they ever journaled. Opt-out (`{ sweep: false }`) for a
 *      host that drains its own noSend actions. Skipped while an 'accepted' or
 *      'retryable' entry is pending (an overlay-admitted tx must not be swept
 *      before its broadcast retry, and a retryable one is deliberately still
 *      holding its inputs) and while any pipeline's fresh 'intent' entry exists
 *      (the sweep cannot tell a live noSend action from an abandoned one — the
 *      intent journal can). Per action it then requires a reported age past
 *      SWEEP_MIN_AGE_MS and no journal entry seen this pass, of any stage —
 *      see `sweepStuckNoSendActions` for what the 2026-09-15 incident taught.
 *
 * Whole pass runs under a cross-tab web lock: concurrent reconciles (two tabs,
 * init + settle overlap) skip instead of double-broadcasting / double-aborting.
 *
 * Aborting a stuck action releases the old auth output → the asset reappears.
 */
import { Utils, WalletInterface } from '@bsv/sdk'
import {
  admissionReceipt, broadcastAcceptedTx, isAlreadyBroadcast, OverlayRefusedError, submitToOverlay
} from './overlay.js'
import { JournalEntry, journalList, journalPut, journalRemove, INTENT_TTL_MS } from './txJournal.js'
import { tryWithLock } from './webLocks.js'

/**
 * wallet-toolbox listActions spec-op: intercepts this "label" to list actions
 * with status 'nosend'; adding the 'abort' label bulk-aborts them (skipping any
 * the chain already knows). Values are defined in @bsv/wallet-toolbox sdk/types.
 */
export const SPEC_OP_NOSEND_ACTIONS = 'ac6b20a3bb320adafecd637b25c84b792ad828d3aa510d05dc841481f664277d'

/**
 * The BRC-114 label that asks a wallet-toolbox listing to report each action's
 * creation time (as an `action time <unixMillis>` label on the action). `0`
 * filters nothing; it only turns the reporting on. A wallet that does not know
 * the label is listed without it — and then reports no age, so nothing is
 * swept. See `sweepStuckNoSendActions`.
 */
const ACTION_TIME_FROM_ANY = 'action time from 0'

/** After this many failed abort retries the bulk sweep owns the cleanup. */
export const ABORT_RETRY_CAP = 5

/**
 * How old a noSend action must be before the bulk sweep may abort it.
 *
 * The 2026-09-15 incident: a transfer's tx was admitted AND broadcast by the
 * overlay, the wallet's `sendWith` resolved without posting (its storage holds
 * token requests for its own settlement drain), the lib cleared the 'accepted'
 * entry on that alone — and 0.7 s later the sweep, finding a noSend action with
 * no journal entry, aborted it. The wallet marked an on-chain transaction
 * failed and released its inputs; the next send double-spent them.
 *
 * Thirty minutes is far longer than any pipeline (createAction → overlay →
 * broadcast) can legitimately be in flight, and far shorter than a stuck action
 * is tolerable. Anything younger is presumed live.
 */
export const SWEEP_MIN_AGE_MS = 30 * 60 * 1000

/**
 * How many passes a 'retryable' refusal is re-submitted before reconcile gives
 * up, aborts the reference and drops the entry (§9.11). Generous: these are
 * liftable conditions (a pause, a screening hold) and the inputs are held on
 * purpose, so patience is cheaper than forcing a rebuild.
 */
export const RETRY_CAP = 20

/**
 * How many passes an overlay-accepted tx is re-broadcast before it is parked as
 * 'stranded' (§9.11). Smaller than RETRY_CAP: the overlay has already committed
 * this tx, so a broadcast that fails this many times is an operator problem,
 * and continuing to retry it blocks every other recovery behind it.
 */
export const BROADCAST_RETRY_CAP = 10

export interface ReconcileOptions {
  /**
   * Run the bulk sweep of stuck noSend actions (step 4). Default `true`: a
   * plain web console has no other cleanup for a crashed pipeline.
   *
   * **A host that manages its own noSend actions must pass `false`.** A wallet
   * with its own settlement drain holds token requests on purpose; to this
   * sweep those are indistinguishable from abandoned ones, and the journal
   * guards below — good as they are — only cover transactions the LIB created.
   */
  sweep?: boolean
  /**
   * Broadcast overlay-accepted entries through `createAction({ sendWith })`
   * (step 1, and the acceptance half of steps 2/2b). Default `true`.
   *
   * **A host whose own drain broadcasts token transactions must pass `false`.**
   * Such a wallet holds every token request for its drain, so the lib's
   * broadcast can never be proven posted there — it only burned
   * BROADCAST_RETRY_CAP passes into a 'stranded' entry (2026-09-15). With
   * `false`, an accepted entry is journaled and LEFT: the host clears it
   * (`journalRemove`) the moment its drain really broadcasts the transaction.
   */
  broadcast?: boolean
}

export interface ReconcileResult {
  /** Overlay-accepted txids whose broadcast was successfully retried. */
  rebroadcast: string[]
  /** Rejected txids whose pending abort was successfully retried. */
  aborted: string[]
  /** Retryable refusals the overlay has now accepted (§9.11). */
  resubmitted: string[]
  /** Accepted txids parked as 'stranded' this pass — kept, never auto-retried. */
  stranded: string[]
  /** Stuck nosend mandala actions released by the bulk sweep. */
  swept: number
  /** True when another reconcile (this tab or another) held the lock. */
  skipped?: boolean
}

export async function reconcileWallet (
  wallet: WalletInterface,
  opts: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const { acquired, result } = await tryWithLock('mandala.reconcile', async () =>
    await reconcilePass(wallet, opts.sweep !== false, opts.broadcast !== false)
  )
  if (!acquired || result == null) {
    return { rebroadcast: [], aborted: [], resubmitted: [], stranded: [], swept: 0, skipped: true }
  }
  return result
}

/** Release the inputs a dead/abandoned action still holds, best effort. */
async function releaseReference (wallet: WalletInterface, reference?: string): Promise<void> {
  if (reference == null || reference === '') return
  try {
    await wallet.abortAction({ reference })
  } catch { /* already on-chain, or the wallet is offline — the sweep owns it now */ }
}

async function reconcilePass (wallet: WalletInterface, sweep: boolean, broadcast: boolean): Promise<ReconcileResult> {
  const rebroadcast: string[] = []
  const aborted: string[] = []
  const resubmitted: string[] = []
  const stranded: string[] = []
  const now = Date.now()
  /**
   * Every txid/reference this pass has seen an entry for, INCLUDING entries it
   * has since cleared. The sweep at the bottom must not touch any of them: a
   * successful broadcast or abort earlier in this very pass is exactly the
   * 0.7 s window in which the 2026-09-15 sweep aborted an on-chain tx.
   */
  const seenTxids = new Set<string>()
  const seenRefs = new Set<string>()
  const remember = (entry: JournalEntry): void => {
    seenTxids.add(entry.txid)
    if (entry.reference != null && entry.reference !== '') seenRefs.add(entry.reference)
  }

  /**
   * Keep an accepted-but-unbroadcast entry for the next pass, or park it as
   * 'stranded' once BROADCAST_RETRY_CAP passes have got nowhere (§9.11): the
   * overlay folded this tx in, so aborting it would desync wallet from overlay,
   * but one permanently unbroadcastable tx must not wedge every other recovery.
   */
  const keepOrStrand = async (entry: JournalEntry, why: string, e?: unknown): Promise<void> => {
    const attempts = (entry.attempts ?? 0) + 1
    if (attempts >= BROADCAST_RETRY_CAP) {
      await journalPut({ ...entry, stage: 'stranded', attempts })
      stranded.push(entry.txid)
      console.warn(
        `[mandala] ${entry.txid} was accepted by the overlay but ${attempts} broadcast attempts failed (${why}); ` +
        'parked as stranded (journalListStranded) — it will not be retried automatically:', e
      )
    } else {
      await journalPut({ ...entry, attempts })
    }
  }

  /**
   * Broadcast an entry the overlay has accepted, clearing it ONLY when the
   * wallet proves it posted the transaction (`broadcastAcceptedTx`). Shared by
   * the 'accepted' branch and by a 'retryable' entry that has just been
   * accepted on re-submit — both reach the identical commit point.
   */
  const broadcastAccepted = async (entry: JournalEntry): Promise<void> => {
    if (!broadcast) {
      // The host's own drain broadcasts and clears this entry; the lib's job
      // ended at acceptance. Not an attempt, not a strand — just left in place.
      return
    }
    try {
      if (!await broadcastAcceptedTx(wallet, entry.txid)) {
        // Resolved, but nothing was posted (a wallet holding the request for
        // its own drain). Not an error — but not a broadcast either, so the
        // entry stays exactly as a failed attempt would leave it.
        await keepOrStrand(entry, 'the wallet did not report it as posted')
        return
      }
      await journalRemove(entry.txid)
      rebroadcast.push(entry.txid)
    } catch (e) {
      if (isAlreadyBroadcast(e)) {
        // The network already has it (e.g. the background broadcast won a
        // race with a crash) — recovery is complete, clear the entry.
        await journalRemove(entry.txid)
        rebroadcast.push(entry.txid)
        return
      }
      await keepOrStrand(entry, 'broadcast failed', e)
    }
  }

  for (const entry of await journalList()) {
    remember(entry)
    if (entry.stage === 'intent') {
      // A live pipeline's marker — leave fresh ones alone; expire stale ones
      // (crashed pipeline) so the sweep below can reclaim its inputs.
      if (now - entry.at >= INTENT_TTL_MS) await journalRemove(entry.txid)
      continue
    }
    if (entry.stage === 'stranded') {
      // Parked by a previous pass. Never retried automatically, never aborted,
      // never blocking anything — the host decides what happens next.
      continue
    }
    if (entry.stage === 'retryable' || entry.stage === 'handed_over') {
      // A 'handed_over' entry is the payer's OPTIONAL later submit (offline
      // settlement §0.1 rule 6): the payee may already have submitted, which
      // is fine — /submit is idempotent and re-admission returns the same σ_I.
      // Mechanically identical to a retryable refusal: re-POST the stored
      // bytes, commit + broadcast on acceptance, abort at a final verdict or
      // at RETRY_CAP.
      await retryRefused(wallet, entry, resubmitted, broadcastAccepted)
      continue
    }
    if (entry.stage === 'accepted') {
      await broadcastAccepted(entry)
    } else {
      try {
        if (entry.reference != null) await wallet.abortAction({ reference: entry.reference })
        await journalRemove(entry.txid)
        aborted.push(entry.txid)
      } catch {
        // Abort still failing (wallet offline / transient) — KEEP the durable
        // record and retry next pass; only after the cap does the bulk sweep
        // own it. Deleting on first failure orphaned held inputs.
        const attempts = (entry.attempts ?? 0) + 1
        if (attempts >= ABORT_RETRY_CAP || entry.reference == null) {
          await journalRemove(entry.txid)
        } else {
          await journalPut({ ...entry, attempts })
        }
      }
    }
  }

  // Bulk sweep of any remaining stuck nosend mandala actions (crashed flows
  // that never journaled). Unsafe while an overlay-accepted tx still awaits
  // broadcast (the sweep can't tell it apart), while a 'retryable' refusal is
  // deliberately still holding its inputs for a re-submit, or while a live
  // pipeline's fresh intent entry exists (its noSend action would be aborted
  // mid-flight) — so skip until they drain. A 'stranded' entry does NOT block:
  // that is the whole point of parking it (§9.11).
  let swept = 0
  const entries = await journalList()
  for (const e of entries) remember(e)
  const blocked = entries.some(e =>
    e.stage === 'accepted' ||
    e.stage === 'retryable' ||
    // A handed-over tx's inputs are held ON PURPOSE — the payee holds evidence
    // over these exact bytes, so sweeping the action would un-pay them.
    e.stage === 'handed_over' ||
    (e.stage === 'intent' && Date.now() - e.at < INTENT_TTL_MS)
  )
  if (sweep && !blocked) {
    swept = await sweepStuckNoSendActions(wallet, seenTxids, seenRefs)
  }

  return { rebroadcast, aborted, resubmitted, stranded, swept }
}

/** One listed noSend action, reduced to what the sweep decides on. */
interface SweepCandidate {
  txid?: string
  reference?: string
  age: number
}

/**
 * An action's creation time as the wallet reports it — a `createdAt`/
 * `created_at` field (number, Date or parseable string), or the BRC-114
 * `action time <unixMillis>` label a wallet-toolbox listing adds when asked.
 * `undefined` means "this wallet does not say", which the sweep treats as
 * "never abort it".
 */
function actionCreatedAt (a: unknown): number | undefined {
  const raw = (a as { createdAt?: unknown, created_at?: unknown })?.createdAt ??
    (a as { created_at?: unknown })?.created_at
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    if (!Number.isNaN(t)) return t
  }
  const labels = (a as { labels?: unknown })?.labels
  for (const label of Array.isArray(labels) ? labels : []) {
    if (typeof label !== 'string' || !label.startsWith('action time ')) continue
    const ms = Number(label.slice('action time '.length))
    if (Number.isSafeInteger(ms) && ms > 0) return ms
  }
  return undefined
}

/**
 * Abort the stuck noSend mandala actions that are provably abandoned — and
 * nothing else (2026-09-15).
 *
 * The wallet-toolbox spec-op is a LISTING that also aborts everything it lists
 * when handed the 'abort' label: all or nothing, no exceptions. So this lists
 * read-only first, applies the guards per action, and only then aborts:
 *
 *   · an action whose txid (or reference) the tx journal has touched at any
 *     point in this pass is never aborted — whatever its stage, and even if the
 *     entry has since cleared. That entry is the lib saying "this transaction's
 *     fate is mine";
 *   · an action is only old enough when the wallet reports a creation time and
 *     that time is more than SWEEP_MIN_AGE_MS ago. No timestamp, no abort;
 *   · an action the wallet gives a `reference` for is aborted individually. The
 *     indiscriminate bulk abort is the fallback for wallets that report none,
 *     and it may only run when EVERY listed action passed the guards.
 *
 * Returns how many actions were actually aborted.
 */
async function sweepStuckNoSendActions (
  wallet: WalletInterface,
  seenTxids: Set<string>,
  seenRefs: Set<string>
): Promise<number> {
  // Ask for creation times (BRC-114) but never depend on them being understood.
  let labels = [SPEC_OP_NOSEND_ACTIONS, 'mandala', ACTION_TIME_FROM_ANY]
  let actions: unknown[] | undefined
  for (const attempt of [labels, [SPEC_OP_NOSEND_ACTIONS, 'mandala']]) {
    try {
      const res = await wallet.listActions({ labels: attempt, includeLabels: true, limit: 100 } as any)
      const listed = (res as { actions?: unknown }).actions
      labels = attempt
      actions = Array.isArray(listed) ? listed : []
      // An empty answer may just mean the wallet took the time label as a
      // filter it has never seen — ask again without it before believing it.
      if (actions.length > 0) break
    } catch { /* try the plainer listing, then give up */ }
  }
  // A wallet without spec-op support — nothing listed, nothing to sweep.
  if (actions == null || actions.length === 0) return 0

  const now = Date.now()
  const eligible: SweepCandidate[] = []
  for (const a of actions) {
    // A wallet that does not implement the spec op ignores the label and lists
    // ordinary mandala actions instead — aborting one of those (completed,
    // already broadcast) is the exact harm this sweep exists to avoid.
    const status = (a as { status?: unknown })?.status
    if (status != null && status !== 'nosend') continue
    const txid = typeof (a as { txid?: unknown })?.txid === 'string' ? (a as { txid: string }).txid : undefined
    const rawRef = (a as { reference?: unknown })?.reference
    const reference = typeof rawRef === 'string' && rawRef !== '' ? rawRef : undefined
    if (txid != null && seenTxids.has(txid)) continue
    if (reference != null && seenRefs.has(reference)) continue
    const createdAt = actionCreatedAt(a)
    if (createdAt == null) continue
    const age = now - createdAt
    if (age < SWEEP_MIN_AGE_MS) continue
    eligible.push({ txid, reference, age })
  }
  if (eligible.length === 0) return 0

  const announce = (c: SweepCandidate): void => {
    console.warn(
      `[mandala] sweep aborted stuck noSend action ${c.txid ?? '(txid unreported)'} — ` +
      `age ${Math.round(c.age / 60000)}m, no journal entry`
    )
  }

  let swept = 0
  const unreferenced: SweepCandidate[] = []
  for (const c of eligible) {
    if (c.reference == null) {
      unreferenced.push(c)
      continue
    }
    try {
      await wallet.abortAction({ reference: c.reference })
      announce(c)
      swept++
    } catch (e) {
      // Already on chain, or the wallet is offline — either way, leave it.
      console.warn(`[mandala] sweep could not abort ${c.txid ?? c.reference}:`, e)
    }
  }

  if (unreferenced.length > 0) {
    if (eligible.length === actions.length) {
      try {
        await wallet.listActions({ labels: [...labels, 'abort'], includeLabels: true, limit: 100 } as any)
        for (const c of unreferenced) {
          announce(c)
          swept++
        }
      } catch (e) {
        console.warn('[mandala] sweep could not run the bulk abort:', e)
      }
    } else {
      console.warn(
        `[mandala] sweep left ${unreferenced.length} stuck noSend action(s) alone: the wallet reports no ` +
        'reference to abort them individually, and the bulk abort would also hit actions that are still live'
      )
    }
  }
  return swept
}

/**
 * One pass over a 'retryable' entry (§9.11).
 *
 * The action behind it is still alive with its inputs held — that is the
 * correct behaviour for a liftable refusal, but it means SOMETHING has to
 * either finish it or release it. This does both:
 *
 * - bytes journaled → re-POST them. Acceptance is the ordinary commit point:
 *   write the 'accepted' entry (carrying σ_I) and broadcast, exactly as
 *   submitAndBroadcast does, so the crash windows are identical.
 * - a FINAL verdict on the retry, or RETRY_CAP fruitless passes → abort the
 *   reference and drop the entry. The condition is not lifting (or the bytes
 *   were never journaled and nothing here can lift it), and holding a wallet's
 *   coins hostage forever is worse than forcing a rebuild.
 */
async function retryRefused (
  wallet: WalletInterface,
  entry: JournalEntry,
  resubmitted: string[],
  broadcastAccepted: (e: JournalEntry) => Promise<void>
): Promise<void> {
  const attempts = (entry.attempts ?? 0) + 1
  const giveUp = async (): Promise<void> => {
    await releaseReference(wallet, entry.reference)
    await journalRemove(entry.txid)
  }

  if (entry.submit == null) {
    // No bytes to re-POST (an older entry, or a store that lost the field).
    // All this pass can do is count — then release the inputs at the cap.
    if (attempts >= RETRY_CAP) await giveUp()
    else await journalPut({ ...entry, attempts })
    return
  }

  try {
    const admitted = await submitToOverlay(
      Utils.toArray(entry.submit.txHex, 'hex'),
      entry.submit.offChainHex != null ? Utils.toArray(entry.submit.offChainHex, 'hex') : undefined,
      undefined,
      entry.submit.topics
    )
    // THE COMMIT POINT, same as the live path: the 'accepted' entry lands
    // before anything is broadcast.
    const accepted: JournalEntry = {
      txid: entry.txid,
      stage: 'accepted',
      at: Date.now(),
      ...(entry.reference != null ? { reference: entry.reference } : {}),
      ...admissionReceipt(admitted)
    }
    await journalPut(accepted)
    resubmitted.push(entry.txid)
    await broadcastAccepted(accepted)
  } catch (e) {
    // A refusal the contract calls final means these bytes will never be
    // admitted — retrying is pointless, so release the inputs now.
    const final = e instanceof OverlayRefusedError && !e.retryable
    if (final || attempts >= RETRY_CAP) {
      await giveUp()
      return
    }
    await journalPut({
      ...entry,
      attempts,
      ...(e instanceof OverlayRefusedError ? { code: e.code } : {})
    })
  }
}
