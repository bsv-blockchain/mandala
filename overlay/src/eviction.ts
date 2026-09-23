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
 * /arc-ingest auth: the pinned overlay-express route mounts whenever ARC or
 * Arcade is configured and checks the callback token only WHEN IT IS NON-EMPTY
 * — so an unset token means anyone on the network can evict an admitted
 * transaction (EB-1b). `mountArcIngest` registers this repo's route ahead of
 * the pinned one; with an empty token it registers a blocking stub instead, so
 * the unauthenticated pinned route is shadowed and the server still starts.
 */
import type { AdmissionStore, AdmissionRecord } from './admission.js'
import type { AdmissionTokenRow } from './submitSideChannel.js'
import { errorBody, InfraError, isInfraError } from './submitVerdict.js'

/**
 * Mirrors `@bsv/overlay-express`'s `isTerminalArcStatus` and overlay-go's
 * `arcade.IsTerminalStatus` — kept repo-local because the pinned package does
 * not export it from its entry point. Both stacks must agree exactly.
 */
const TERMINAL_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED', 'REJECTED', 'INVALID', 'MALFORMED', 'MINED_IN_STALE_BLOCK'
])

export const isTerminalArcStatus = (status?: unknown, extraInfo?: unknown): boolean => {
  const statusText = typeof status === 'string' ? status.toUpperCase() : ''
  const extraText = typeof extraInfo === 'string' ? extraInfo.toUpperCase() : ''
  return TERMINAL_STATUSES.has(statusText) || statusText.includes('ORPHAN') || extraText.includes('ORPHAN')
}

export interface EvictionDeps {
  store: AdmissionStore
  /** `UPDATE outputs SET spent = false WHERE txid/outputIndex/topic`. */
  unmarkSpent: (txid: string, outputIndex: number) => Promise<void>
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
    for (const outpoint of rec.restore.spentOutpoints ?? []) {
      const parsed = splitOutpoint(outpoint)
      // A malformed outpoint carries no coin to restore; it is bad data in the
      // snapshot, not a failed restore, so it cannot block the eviction.
      if (parsed == null) continue
      try {
        await deps.unmarkSpent(parsed.txid, parsed.vout)
        restoredOutpoints++
      } catch (e) {
        throw new InfraError(`could not restore spent input ${outpoint} of ${txid}; retry`, e)
      }
    }
    for (const row of rec.restore.tokenRows ?? []) {
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
  /** `engine.handleNewMerkleProof(txid, MerklePath.fromHex(hex), blockHeight)`. */
  ingestProof: (txid: string, merklePathHex: string, blockHeight?: number) => Promise<void>
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
 * status codes and messages) and with overlay-go's `arcIngestHandler`; the
 * only behavioural difference is that a terminal status now restores inputs
 * before evicting.
 */
export const arcIngestHandler = (deps: ArcIngestDeps) =>
  (req: IngestReq, res: IngestRes): void => {
    void (async () => {
      try {
        if (!presented(req.headers ?? {}).includes(deps.callbackToken)) {
          res.status(401).json({ status: 'error', message: 'Unauthorized callback' })
          return
        }
        const body = await readJsonBody(req) as {
          txid?: unknown, merklePath?: unknown, blockHeight?: unknown
          txStatus?: unknown, extraInfo?: unknown, competingTxs?: unknown
        }
        const txid = typeof body.txid === 'string' ? body.txid.toLowerCase() : ''
        if (txid === '') {
          res.status(400).json({ status: 'error', message: 'Provider callback is missing txid' })
          return
        }

        if (isTerminalArcStatus(body.txStatus, body.extraInfo)) {
          const reason = `${typeof body.txStatus === 'string' ? body.txStatus : ''} ${typeof body.extraInfo === 'string' ? body.extraInfo : ''}`.trim()
          const report = await evictWithRestore(txid, reason === '' ? undefined : reason, deps)
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
        await deps.ingestProof(txid, merklePath, typeof body.blockHeight === 'number' ? body.blockHeight : undefined)
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
 * `server.start()` matches first).
 *
 * With an empty callback token this mounts a blocking stub instead of the real
 * handler and returns false: eviction is never reachable unauthenticated, the
 * error is logged loudly, and the server keeps serving everything else.
 */
export const mountArcIngest = (
  app: AppLike, deps: ArcIngestDeps, log: (msg: string) => void = console.error
): boolean => {
  if (deps.callbackToken === '') {
    log(
      '[mandala] ARCADE_CALLBACK_TOKEN is empty — /arc-ingest is NOT mounted. ' +
      'Eviction restores spent inputs, so an unauthenticated ingest route lets anyone ' +
      'evict an admitted transaction (FIX E / EB-1b). Set ARCADE_CALLBACK_TOKEN to enable it.'
    )
    app.post('/arc-ingest', (_req: unknown, res: IngestRes) => {
      res.status(503).json(errorBody('ERR_UNAVAILABLE', 'arc-ingest is disabled: no callback token is configured'))
    })
    return false
  }
  app.post('/arc-ingest', arcIngestHandler(deps))
  return true
}
