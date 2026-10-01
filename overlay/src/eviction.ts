/**
 * FIX E — eviction is the exact inverse of admission for inputs.
 *
 * `Engine.evictAppliedTransaction` (pinned) notifies the lookup services,
 * deletes the evicted transaction's OUTPUTS and deletes its applied-transaction
 * rows. It never touches the INPUTS the transaction consumed. So when Arcade
 * posts a terminal status for a transaction the overlay already admitted —
 * fee/policy rejection, double-spend, stale block — the coins that transaction
 * spent are left marked spent with no token row, and (once FIX L's spent-input
 * guard exists) permanently unspendable, even though they are provably unspent
 * on chain. That is EB-2.1, the liveness fatal.
 *
 * The inverse needs data that no longer exists at eviction time: the pre-spend
 * token rows. The broadcast-failure compensation seam captures exactly this in
 * a closure during Submit; FIX E gives that snapshot a durable home on the
 * admission record (written by the /submit wrapper from the topic-manager
 * wrapper's capture) so the post-hoc path can read it back.
 *
 * A coin is handed back only while the evicted tx still holds it. /arc-ingest
 * runs outside the engine's submission lock, so between a failed attempt and
 * Arcade's retry another tx can spend the coin. The unmark is conditional on
 * `spentBy`, and a token row is restored only for a coin that is live again:
 * one this call unmarked, or one an earlier, partly failed attempt already
 * unmarked.
 *
 * Order (contract §5): unmark spent → restore token rows → stamp `evictedAt` →
 * delete the evicted outputs as today → find the assets whose admin-history
 * rows carry the tx → rebuild each one's state from its history EXCLUDING
 * those rows → only then delete the rows. Rebuild-first: the rows are the only
 * record of which assets need a rebuild, so a 503 retry after any failure
 * redoes the whole idempotent sequence and converges. `evictedAt` lands BEFORE the deletion so
 * a /submit racing the callback already sees the 410 verdict rather than
 * re-admitting the same bytes. The history purge is last and never skipped on
 * a repeat callback: it is what moves the asset-auth head off a never-mined
 * admin action (2026-09-21 incident), and re-delivering the terminal status
 * is the operator's repair path for heads stuck behind an older eviction.
 *
 * /arc-ingest: overlay-express 2.7.3 fails closed (its route mounts only with
 * a callback token, and `start()` refuses Arcade without one), so the old
 * empty-token blocking stub (EB-1b) is gone. `mountArcIngest` still registers
 * this repo's route ahead of the pinned one, because the pinned route evicts
 * without restoring inputs.
 */
import { isTerminalArcStatus } from '@bsv/overlay-express'
import type { AdmissionStore, AdmissionRecord } from './admission.js'
import type { AdmissionTokenRow } from './submitSideChannel.js'
import type { KnexLike } from './spentGuard.js'
import { errorBody, InfraError, isInfraError } from './submitVerdict.js'
import { constantTimeEqual } from './secrets.js'

/**
 * `@bsv/overlay-express`'s own classifier, the one its /arc-ingest route and
 * ArcadeProvider use. Re-exported so the tests pin it against the cases
 * overlay-go's `arcade.IsTerminalStatus` must agree with exactly.
 */
export { isTerminalArcStatus }

export interface EvictionDeps {
  store: AdmissionStore
  /**
   * Hand a coin back: `UPDATE outputs SET spent = false, spentBy = NULL` for
   * this outpoint on the token topic, ONLY while it is still spent by
   * `evictedTxid` (or by an unlabelled legacy spend). Returns rows affected: 0
   * means the coin is already unspent, gone, or spent by another live tx.
   */
  unmarkSpent: (txid: string, outputIndex: number, evictedTxid: string) => Promise<number>
  /** True when the coin's engine row exists with `spent = false`. */
  isUnspent: (txid: string, outputIndex: number) => Promise<boolean>
  /** Re-insert (upsert) a pre-spend token row into the lookup store. */
  restoreTokenRow: (row: AdmissionTokenRow) => Promise<void>
  /** `engine.evictAppliedTransaction(txid, { reason })`. */
  evict: (txid: string, reason?: string) => Promise<unknown>
  /**
   * Distinct asset IDs (sorted) whose `mandalaAdminHistory` rows carry this
   * txid. Those rows are what the asset-auth head and the state rebuild read,
   * so an evicted (never-mined) admin action left behind keeps naming the
   * evicted tx as the live head (2026-09-21 incident).
   */
  assetsTouchedBy: (txid: string) => Promise<string[]>
  /** Refold the asset's state (and fee rate) from its history minus this txid's rows; persist. */
  rebuildAssetStateExcluding: (assetId: string, txid: string) => Promise<unknown>
  /** Delete every history row this txid produced. Called only after every rebuild succeeded. */
  purgeAdminHistory: (txid: string) => Promise<void>
  now?: () => string
}

/**
 * The production `unmarkSpent` / `isUnspent` over the engine's `outputs` table
 * (KnexStorage.findOutput does not select `spentBy`).
 *
 * `unmarkSpent` is a compare-and-swap on `spentBy`, the same shape as the
 * spent-input guard's `releaseSpend`: a coin another tx has since spent is
 * never touched. `isUnspent` fails CLOSED (§9.5) on a `spent` value it cannot
 * read, rather than reading it as "unspent" and restoring a token row.
 */
export const knexEvictionCoins = (
  knex: KnexLike, topic: string
): Pick<EvictionDeps, 'unmarkSpent' | 'isUnspent'> => ({
  unmarkSpent: async (txid, outputIndex, evictedTxid) =>
    await knex('outputs')
      .where({ txid, outputIndex, topic, spent: true })
      .andWhere((q: any) => q.where('spentBy', evictedTxid).orWhereNull('spentBy'))
      .update({ spent: false, spentBy: null }),
  isUnspent: async (txid, outputIndex) => {
    const row = await knex('outputs').where({ txid, outputIndex, topic }).first('spent')
    if (row == null) return false
    if (row.spent === false || row.spent === 0) return true
    if (row.spent === true || row.spent === 1) return false
    throw new Error(`outputs.spent has an unexpected value of type ${row.spent === null ? 'null' : typeof row.spent}`)
  }
})

export interface EvictionReport {
  txid: string
  reason?: string
  restoredOutpoints: number
  restoredTokenRows: number
  alreadyEvicted: boolean
  engine: unknown
}

const splitOutpoint = (outpoint: string): { txid: string, vout: number } | null => {
  const dot = String(outpoint).lastIndexOf('.')
  if (dot <= 0) return null
  const txid = String(outpoint).slice(0, dot)
  const vout = Number(String(outpoint).slice(dot + 1))
  if (!/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(vout) || vout < 0) return null
  return { txid: txid.toLowerCase(), vout }
}

/**
 * §9.8 — `evictedAt` is stamped ONLY after every input restore succeeded; on any
 * restore failure nothing is stamped and the caller answers 503 so Arcade
 * retries.
 *
 * The ordering matters because the stamp and the restore say opposite things if
 * they disagree. `evictedAt` is what makes /submit and
 * GET /admin/admission/:txid answer 410 "its inputs are spendable again"
 * forever — an answer a wallet acts on by building a fresh spend of those very
 * coins. Stamping it while an `unmarkSpent` has failed publishes that promise
 * over coins still marked spent, and the spent-input guard then refuses every
 * attempt to spend them: the coins are permanently dead, and the 410 is the
 * overlay's own attestation that they should not be. A partial restore that
 * stamps nothing is merely incomplete, and the retry is idempotent — the
 * unmarks and upserts simply run again.
 */
export const evictWithRestore = async (
  txid: string, reason: string | undefined, deps: EvictionDeps
): Promise<EvictionReport> => {
  const now = deps.now ?? (() => new Date().toISOString())
  // Fails CLOSED (§9.5): an unreadable record is not "nothing to restore" — it
  // is "we do not know what to restore", and evicting on that basis is how the
  // snapshot gets skipped exactly when it is needed.
  const rec: AdmissionRecord | null = await deps.store.get(txid).catch((e: unknown) => {
    throw new InfraError(
      `the admission record for ${txid} could not be read, so its inputs cannot be restored; retry`, e
    )
  })
  const alreadyEvicted = rec?.evictedAt != null && rec.evictedAt !== ''

  let restoredOutpoints = 0
  let restoredTokenRows = 0
  if (!alreadyEvicted && rec?.restore != null) {
    // Outpoints whose coin is live again and so may carry a token row: the
    // unmark handed it back now, or an earlier attempt that failed later
    // already did. A coin spent by another live tx since is in neither set —
    // it stays spent and keeps no token row.
    const restorable = new Set<string>()
    for (const outpoint of rec.restore.spentOutpoints ?? []) {
      const parsed = splitOutpoint(outpoint)
      // A malformed outpoint carries no coin to restore; it is bad data in the
      // snapshot, not a failed restore, so it cannot block the eviction.
      if (parsed == null) continue
      try {
        if (await deps.unmarkSpent(parsed.txid, parsed.vout, txid) > 0) {
          restoredOutpoints++
          restorable.add(`${parsed.txid}.${parsed.vout}`)
        } else if (await deps.isUnspent(parsed.txid, parsed.vout)) {
          restorable.add(`${parsed.txid}.${parsed.vout}`)
        }
      } catch (e) {
        // §9.5 — an unreadable spend state is "we do not know", not "not restorable".
        throw new InfraError(`could not restore spent input ${outpoint} of ${txid}; retry`, e)
      }
    }
    for (const row of rec.restore.tokenRows ?? []) {
      if (!restorable.has(`${String(row.txid).toLowerCase()}.${row.outputIndex}`)) continue
      try {
        await deps.restoreTokenRow(row)
        restoredTokenRows++
      } catch (e) {
        throw new InfraError(`could not restore the token row for ${row.txid}.${row.outputIndex}; retry`, e)
      }
    }
  }

  // Stamped only now, and before the deletion: from here on /submit and
  // GET /admin/admission/:txid both answer 410 for this txid forever.
  await deps.store.markEvicted(txid, rec?.evictedAt ?? now()).catch((e: unknown) => {
    throw new InfraError(`the eviction of ${txid} could not be recorded; retry`, e)
  })

  const engine = await deps.evict(txid, reason)

  // The evicted tx's admin actions never happened: refold each touched asset
  // without its rows, THEN drop the rows. NOT gated on alreadyEvicted — a
  // repeat callback must repair a head stuck behind an older eviction. Nothing
  // is deleted until every rebuild succeeded, so a failure leaves the rows that
  // name the assets in place and the retry redoes the whole sequence.
  let assets: string[]
  try {
    assets = await deps.assetsTouchedBy(txid)
  } catch (e) {
    throw new InfraError(`could not find the assets touched by ${txid}; retry`, e)
  }
  for (const assetId of assets) {
    try {
      await deps.rebuildAssetStateExcluding(assetId, txid)
    } catch (e) {
      throw new InfraError(`could not rebuild the state of ${assetId} after evicting ${txid}; retry`, e)
    }
  }
  try {
    await deps.purgeAdminHistory(txid)
  } catch (e) {
    throw new InfraError(`could not purge the admin history of ${txid}; retry`, e)
  }
  return { txid, reason, restoredOutpoints, restoredTokenRows, alreadyEvicted, engine }
}

// ────────────────────────────── /arc-ingest ─────────────────────────────────

export interface ArcIngestDeps extends EvictionDeps {
  callbackToken: string
  /**
   * `engine.handleNewMerkleProof(txid, MerklePath.fromHex(hex))`. No block
   * height: the engine takes it from the proof and throws when a forwarded one
   * differs, which would be a permanent 500 that Arcade retries forever.
   */
  ingestProof: (txid: string, merklePathHex: string) => Promise<void>
}

interface IngestReq {
  headers: Record<string, unknown>
  body?: unknown
  on?: (event: string, cb: (arg: any) => void) => unknown
}
interface IngestRes { status: (code: number) => IngestRes, json: (b: unknown) => unknown }

/** Max callback body we will buffer ourselves (Arcade posts a few KB). */
const MAX_INGEST_BODY = 1_048_576

/**
 * OverlayExpress installs `bodyParser.json` at the top of `start()`, i.e. AFTER
 * every route this repo registers — so at the time our handler runs the body is
 * still an unread stream. We terminate the request either way, so consuming it
 * here is safe. A body an upstream parser already produced is used as-is.
 */
const readJsonBody = async (req: IngestReq): Promise<Record<string, unknown>> => {
  const raw = req.body
  if (Buffer.isBuffer(raw)) {
    try { return JSON.parse(raw.toString('utf8')) as Record<string, unknown> } catch { return {} }
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
  }
  if (raw != null && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof req.on !== 'function') return {}
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    req.on?.('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_INGEST_BODY) chunks.push(Buffer.from(c))
    })
    req.on?.('end', () => resolve())
    req.on?.('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
  })
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { return {} }
}

const presented = (headers: Record<string, unknown>): string[] => {
  const auth = headers.authorization
  const header = Array.isArray(auth) ? auth[0] : auth
  const xct = headers['x-callback-token']
  const callback = Array.isArray(xct) ? xct[0] : xct
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header
  return [bearer, callback].filter((v): v is string => typeof v === 'string')
}

/**
 * Shape-compatible with the pinned overlay-express /arc-ingest route (same
 * status codes and messages) and with overlay-go's `arcIngestHandler`. The
 * differences: a terminal status restores inputs before evicting; a txid that
 * is not 64 hex characters is refused up front (400); and a long reason is
 * truncated. The engine would reject both of the last two only after
 * `evictedAt` is stamped.
 */
export const arcIngestHandler = (deps: ArcIngestDeps) =>
  (req: IngestReq, res: IngestRes): void => {
    void (async () => {
      try {
        // An empty configured token authenticates nothing (as upstream's
        // arcCallbackAuthorized): otherwise an empty presented header matches,
        // since constantTimeEqual('', '') is true — so the empty check stays first.
        if (deps.callbackToken === '' || !presented(req.headers ?? {}).some(c => constantTimeEqual(c, deps.callbackToken))) {
          res.status(401).json({ status: 'error', message: 'Unauthorized callback' })
          return
        }
        const body = await readJsonBody(req) as {
          txid?: unknown, merklePath?: unknown
          txStatus?: unknown, extraInfo?: unknown, competingTxs?: unknown
        }
        const txid = typeof body.txid === 'string' ? body.txid.toLowerCase() : ''
        if (txid === '') {
          res.status(400).json({ status: 'error', message: 'Provider callback is missing txid' })
          return
        }
        // Before any store is touched: the engine's assertHash would throw only
        // AFTER evictedAt is stamped, leaving a stamp for a txid that is no tx.
        if (!/^[0-9a-f]{64}$/.test(txid)) {
          res.status(400).json({ status: 'error', message: 'Provider callback txid must be 64 hex characters' })
          return
        }

        if (isTerminalArcStatus(body.txStatus, body.extraInfo)) {
          const reason = `${typeof body.txStatus === 'string' ? body.txStatus : ''} ${typeof body.extraInfo === 'string' ? body.extraInfo : ''}`.trim()
          // The engine refuses a reason over 1024 UTF-8 bytes, and it would do
          // so after evictedAt is stamped. 256 UTF-16 units is at most 768
          // bytes (a split surrogate encodes as one 3-byte U+FFFD).
          const bounded = reason.slice(0, 256)
          const report = await evictWithRestore(txid, bounded === '' ? undefined : bounded, deps)
          console.warn('[mandala] arc-ingest terminal status — evicted with input restore:', report)
          // §9.12 — exactly these six data keys, byte-identical on both engines.
          // The engine's own eviction result and the provider's competingTxs are
          // deliberately NOT echoed: they are shaped by the pinned package and
          // by the provider, so including them would make the two stacks diverge
          // on a body the contract pins.
          res.status(200).json({
            status: 'success',
            message: 'Terminal transaction status processed',
            data: {
              txid: report.txid,
              txStatus: typeof body.txStatus === 'string' ? body.txStatus : '',
              reason: report.reason ?? '',
              restoredOutpoints: report.restoredOutpoints,
              restoredTokenRows: report.restoredTokenRows,
              alreadyEvicted: report.alreadyEvicted
            }
          })
          return
        }

        const merklePath = typeof body.merklePath === 'string' ? body.merklePath : ''
        if (merklePath === '') {
          res.status(202).json({ status: 'success', message: 'Transaction status received without proof' })
          return
        }
        await deps.ingestProof(txid, merklePath)
        res.status(200).json({ status: 'success', message: 'Transaction status updated' })
      } catch (e) {
        // §9.8: a failed restore stamped nothing, so the eviction has NOT
        // happened — answer the contract's retryable 503 and let Arcade call
        // back. Anything else keeps the pre-existing 500, which Arcade also
        // retries.
        console.error('[mandala] arc-ingest failed:', e)
        if (isInfraError(e)) {
          res.status(503).json(errorBody('ERR_UNAVAILABLE', e.message))
          return
        }
        res.status(500).json({ status: 'error', message: e instanceof Error ? e.message : 'arc-ingest failed' })
      }
    })()
  }

interface AppLike { post: (path: string, handler: (req: any, res: any) => void) => unknown }

/**
 * Registers POST /arc-ingest ahead of the pinned overlay-express route (all of
 * its routes are registered inside `start()`, so anything mounted before
 * `server.start()` matches first). Always the real handler: an empty token
 * cannot reach here in production (overlay-express 2.7.3's `start()` refuses
 * Arcade without one), and the handler 401s every request if it ever does.
 */
export const mountArcIngest = (app: AppLike, deps: ArcIngestDeps): void => {
  app.post('/arc-ingest', arcIngestHandler(deps))
}
