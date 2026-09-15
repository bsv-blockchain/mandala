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
 *   4. Bulk sweep — wallet-toolbox specOpNoSendActions with the 'abort' label
 *      aborts every remaining stuck nosend mandala action server-side (it
 *      chain-checks first and refuses to abort anything already broadcast).
 *      Skipped while an 'accepted' or 'retryable' entry is pending (an
 *      overlay-admitted tx must not be swept before its broadcast retry, and a
 *      retryable one is deliberately still holding its inputs) and while any
 *      pipeline's fresh 'intent' entry exists (the sweep cannot tell a live
 *      noSend action from an abandoned one — the intent journal can).
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

/** After this many failed abort retries the bulk sweep owns the cleanup. */
export const ABORT_RETRY_CAP = 5

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

export async function reconcileWallet (wallet: WalletInterface): Promise<ReconcileResult> {
  const { acquired, result } = await tryWithLock('mandala.reconcile', async () =>
    await reconcilePass(wallet)
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

async function reconcilePass (wallet: WalletInterface): Promise<ReconcileResult> {
  const rebroadcast: string[] = []
  const aborted: string[] = []
  const resubmitted: string[] = []
  const stranded: string[] = []
  const now = Date.now()

  /**
   * Broadcast an entry the overlay has accepted, clearing it on success and
   * parking it as 'stranded' once BROADCAST_RETRY_CAP passes have failed.
   * Shared by the 'accepted' branch and by a 'retryable' entry that has just
   * been accepted on re-submit — both reach the identical commit point.
   */
  const broadcastAccepted = async (entry: JournalEntry): Promise<void> => {
    try {
      await broadcastAcceptedTx(wallet, entry.txid)
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
      const attempts = (entry.attempts ?? 0) + 1
      if (attempts >= BROADCAST_RETRY_CAP) {
        // §9.11. Keep it — the overlay folded this tx in, so aborting would
        // desync wallet from overlay — but stop retrying it and stop letting it
        // block the sweep. It is surfaced via journalListStranded().
        await journalPut({ ...entry, stage: 'stranded', attempts })
        stranded.push(entry.txid)
        console.warn(
          `[mandala] ${entry.txid} was accepted by the overlay but ${attempts} broadcast attempts failed; ` +
          'parked as stranded (journalListStranded) — it will not be retried automatically:', e
        )
      } else {
        // Still unreachable — keep the entry for the next reconcile.
        await journalPut({ ...entry, attempts })
      }
    }
  }

  for (const entry of await journalList()) {
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
  const blocked = entries.some(e =>
    e.stage === 'accepted' ||
    e.stage === 'retryable' ||
    // A handed-over tx's inputs are held ON PURPOSE — the payee holds evidence
    // over these exact bytes, so sweeping the action would un-pay them.
    e.stage === 'handed_over' ||
    (e.stage === 'intent' && Date.now() - e.at < INTENT_TTL_MS)
  )
  if (!blocked) {
    try {
      const res = await wallet.listActions({
        labels: [SPEC_OP_NOSEND_ACTIONS, 'mandala', 'abort'],
        limit: 100
      } as any)
      swept = (res as { actions?: unknown[] }).actions?.length ?? 0
    } catch { /* wallet without spec-op support — nothing to sweep */ }
  }

  return { rebroadcast, aborted, resubmitted, stranded, swept }
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
