import OverlayExpress from '@bsv/overlay-express'
import {
  MandalaTopicManager, MandalaStorageManager, createMandalaLookupService,
  RegistryStorage, RegistryTopicManager, createRegistryLookupService, registryMembership,
  REGISTRY_TOPIC, REGISTRY_LOOKUP, InMemoryScreeningProvider, reconcileOwnerIndex,
  type MandalaLookupService, type AdminHistoryEntry
} from '@bsv/overlay-topics'
import { KnexStorage } from '@bsv/overlay'
import { MerklePath, PrivateKey, ProtoWallet, WalletInterface } from '@bsv/sdk'
import { config } from 'dotenv'
import type { Request, Response } from 'express'
import { buildActivity, LinkageRowLite } from './activity.js'
import {
  wrapSubmitJson, normalizeDoubleSlash, withPersistedVerdict, ensureAdmissionIndexes, TOKEN_TOPIC,
  type AdmissionStore, type AppliedProof
} from './admission.js'
import { admissionHandler } from './admissionRoute.js'
import { SubmitSideChannel, withVerdictCapture, snapshotRestore } from './submitSideChannel.js'
import { mongoAdmissionStore } from './admissionStore.js'
import { withSpentInputGuard, knexSpentInputStore, type SpentInputStore } from './spentGuard.js'
import { mountArcIngest, knexEvictionCoins, journalRestoreInput, lookupRetireOutputs, mongoIndexedVouts } from './eviction.js'
import { adminAuth, adminCors, parseAdminCorsOrigins, warnIfAdminAuthDisabled } from './adminAuth.js'
import { readBootConfig } from './bootConfig.js'
import { createShutdown } from './shutdown.js'
import { withArcadeStatusParity } from './arcadeParity.js'
import { knexEngineOutputs } from './engineOutputs.js'
import { MaintenanceGate, gateSubmits } from './maintenanceGate.js'
import { OwnerIndexMaintenance, OWNER_INDEX_INTERVAL_MS } from './ownerIndex.js'
import * as routes from './tokenRoutes.js'
config()

// Assigned in main() the moment the server exists, so a signal or a failed boot
// can drain whatever has been opened so far through OverlayExpress.close().
let overlay: OverlayExpress | undefined
// The owner-index interval, stopped on shutdown before the server closes.
let ownerIndex: OwnerIndexMaintenance | undefined

const main = async (): Promise<void> => {
  // Every boot variable is validated here, before anything is constructed: a
  // missing or malformed value fails the boot with a message naming it, never a
  // half-configured server. See bootConfig.ts.
  const cfg = readBootConfig(process.env)

  // A13: bearer auth + narrowed CORS on the identity-bearing admin routes
  // (registry, activity, admission). Unset ADMIN_API_TOKEN is a supported
  // dev default — the routes stay open — but it must be loud, hence the one
  // startup warning rather than a silent fallback. A set token must be a
  // 32-byte-plus shared secret (readBootConfig), or the boot fails.
  warnIfAdminAuthDisabled(cfg.adminApiToken)
  const ADMIN_CORS_ORIGINS = parseAdminCorsOrigins(process.env.ADMIN_CORS_ORIGINS, cfg.hostingUrl)
  const adminGate = [adminCors(ADMIN_CORS_ORIGINS), adminAuth(cfg.adminApiToken)] as const

  // overlay-express 2.7.3 takes a bare https host here (it rejects http:// URLs
  // and paths), hence advertisableHost rather than the HOSTING_URL as given.
  const server = new OverlayExpress(cfg.nodeName, cfg.serverPrivateKey, cfg.advertisableHost)
  overlay = server
  server.configurePort(8080)
  server.configureNetwork(cfg.network)

  // With ARCADE_URL set, the overlay becomes a real network participant:
  //  - broadcasts accepted txs itself (ArcadeProvider POSTs to `${ARCADE_URL}/tx`;
  //    engine broadcasts BEFORE folding state, and throwOnBroadcastFailure is set
  //    explicitly below, so a failed broadcast rejects the submit — the app then
  //    aborts safely instead of desyncing),
  //  - refreshes merkle proofs from `${ARCADE_URL}/tx/:txid`,
  //  - runs FULL SPV: configureChaintracks installs the go-chaintracks client
  //    as the chain tracker (header validation + merkle-root checks + reorg
  //    SSE), replacing the local 'scripts only' mode.
  // Without it (local demo): validate scripts only; the wallet is the sole
  // broadcaster.
  //
  // FIX E, second half: eviction restores spent inputs, so an unauthenticated
  // /arc-ingest lets anyone strand or resurrect a coin. The callback token is
  // therefore mandatory with Arcade: readBootConfig refuses to boot without a
  // 32-byte-plus one, overlay-express 2.7.3's start() refuses Arcade without
  // one, and this repo's own route (mountArcIngest below) 401s every request if
  // the token is ever empty. Chaintracks lives at the /chaintracks service of
  // the same Arcade host by default; the host and API prefix are independently
  // overridable. allowPrivateHosts reaches BOTH calls — it is not inherited.
  if (cfg.arcade != null) {
    server.configureArcade(cfg.arcade.url, { apiKey: cfg.arcade.apiKey, allowPrivateHosts: cfg.arcade.allowPrivateHosts })
    server.configureArcCallbackToken(cfg.arcade.callbackToken)
    server.configureChaintracks(cfg.arcade.chaintracksUrl, { apiPrefix: cfg.arcade.chaintracksApiPrefix, allowPrivateHosts: cfg.arcade.allowPrivateHosts })
  } else {
    server.configureChainTracker('scripts only')
  }
  await server.configureKnex({
    client: 'sqlite3',
    connection: { filename: cfg.sqliteFile },
    useNullAsDefault: true
  })
  await server.configureMongo(cfg.mongoUrl)

  // OverlayExpress.configureMongo owns the one Mongo client (closed by
  // OverlayExpress.close()) and its db `${cfg.nodeName}_lookup_services`.
  // Reuse that db so the package storage reads/writes the same collections,
  // and so nothing here holds a client close() cannot reach.
  const lookupDb = server.mongoDb!
  // ONE instance: both topic managers, both lookups, the reconciler and the
  // routes read and journal through the same collections.
  const storage = new MandalaStorageManager(lookupDb)
  const registryStorage = new RegistryStorage(lookupDb)

  const mandalaWallet = new ProtoWallet(PrivateKey.fromHex(cfg.serverPrivateKey)) as unknown as WalletInterface
  // §4.2a host side: the engine's own admitted outputs, for the managers'
  // inline owner-row repair and the reconciler.
  const engineOutputs = knexEngineOutputs(server.knex!)
  // Quiesces /submit while a refold, reconcile or eviction runs (Review Focus 2).
  const gate = new MaintenanceGate()
  const overlayIdentityKey = PrivateKey.fromHex(cfg.serverPrivateKey).toPublicKey().toString()

  // Wrap /submit JSON so admitted STEAKs carry σ_I, and keep a record of every
  // admission. Offline settlement hands a payment on with the signatures for
  // the inputs it spends, so those must be servable long after the submit that
  // produced them. Must be installed before configureEngine registers the route.
  const admissionsCol = lookupDb.collection('mandalaAdmissions')
  // §9.9 — a failure here ABORTS startup (main()'s catch exits the process):
  // without the unique index the admission record is not single-valued and
  // "verdict wins" stops winning.
  await ensureAdmissionIndexes(admissionsCol)
  const overlayPriv = PrivateKey.fromHex(cfg.serverPrivateKey)

  // Wire-contract §4. The write is AWAITED before the /submit response is sent
  // (see admission.ts), so a client holding a 200 is guaranteed the very next
  // GET /admin/admission/:txid succeeds — the race SC-3.4/EB-2.3 describe.
  //
  // §9.4 — the restore snapshot on the record only ever grows: putPending and
  // putAdmitted MERGE into it (mergeRestore), because a retry after a crash
  // snapshots inputs an earlier attempt already let the lookup consume. See
  // admissionStore.ts.
  const admissionStore: AdmissionStore = mongoAdmissionStore(admissionsCol)

  // FIX C — the engine's own durable proof that a txid went through
  // tm_mandala, independent of the Mongo record. σ_I is deterministic, so a
  // re-signature from this proof is byte-identical to the original.
  const engineStorage = (): KnexStorage => new KnexStorage(server.knex!)
  const appliedProof: AppliedProof = {
    wasApplied: async (txid) => await engineStorage().doesAppliedTransactionExist({ txid, topic: TOKEN_TOPIC }),
    storedOutputs: async (txid) => (await engineStorage().findOutputsForTransaction(txid))
      .filter(o => o.topic === TOKEN_TOPIC)
      .map(o => o.outputIndex)
      .sort((a, b) => a - b)
  }

  // FIX D — the topic manager's own reject reason and code, captured before
  // the pinned Engine swallows it into a 200 with an empty STEAK. Also carries
  // the FIX E restore snapshot from the same wrapper.
  const submitChannel = new SubmitSideChannel()

  // Collapse leading '//' before any route of ours matches (2.7.3 normalizes
  // only later, inside start(), so '//submit' would otherwise bypass σI).
  server.app.use(normalizeDoubleSlash)
  // Same matcher as the upstream route (case-insensitive, non-strict), so
  // '/Submit' and '/submit/' cannot bypass the admission wrapper either.
  // Its next() runs the edge policy and then the upstream /submit route.
  //
  // gateSubmits holds a shared maintenance slot until the response ends. It is
  // mounted HERE ONLY: the gate is not re-entrant, and the eviction behind
  // /arc-ingest takes `exclusive`, so gating any other route would deadlock
  // every eviction into a permanent 503.
  server.app.post('/submit', gateSubmits(gate), wrapSubmitJson({
    priv: overlayPriv,
    store: admissionStore,
    applied: appliedProof,
    channel: submitChannel
  }) as any)

  // FIX L — the live spend state of an input, and whether the transaction that
  // spent it has since been evicted (in which case the guard releases the coin
  // and the submitter retries).
  const spentInputStore: SpentInputStore = knexSpentInputStore(server.knex!, TOKEN_TOPIC, async (txid) => {
    const rec = await admissionsCol.findOne({ txid }, { projection: { evictedAt: 1 } })
    return rec?.evictedAt != null
  })

  // Wrapper stack for tm_mandala, outermost first. Every BRC-162 rule (shape,
  // linkage, trusted issuers, authority, conservation, controls, membership)
  // lives in the package manager, which refuses with a typed MandalaReject;
  // the overlay never rewrites or re-classifies its reason.
  //   withVerdictCapture     — FIX D/E/§9.4: stash the reject reason and code,
  //                            take the pre-spend restore snapshot (every input)
  //                            and make it durable (pending record) before the
  //                            engine broadcasts.
  //   withPersistedVerdict   — "verdict wins": a txid with a persisted FINAL
  //                            verdict (a refusal for THIS payload, §9.1, or an
  //                            eviction) is refused before any mutation or
  //                            broadcast. It lives here rather than in a
  //                            /submit pre-check because OverlayExpress
  //                            installs its body parsers after every route this
  //                            file registers.
  //   withSpentInputGuard    — FIX L: refuse a conflicting second spend of
  //                            ANY input (the engine omits spent coins from
  //                            previousCoins), healing stale self/evicted spends;
  //                            a live input previousCoins does not list is a
  //                            retryable 503.
  //   MandalaTopicManager    — the package rules (BRC-162).
  server.configureTopicManager(TOKEN_TOPIC, withVerdictCapture(
    withPersistedVerdict(
      withSpentInputGuard(
        new MandalaTopicManager({
          verifierWallet: mandalaWallet,
          trustedIssuers: cfg.issuerKeys,
          stateStore: storage,
          engineOutputs,
          screeningProvider: new InMemoryScreeningProvider([]),
          // Off until the registry holds a row; then only admitted identities,
          // trusted issuers and this overlay pass.
          membership: registryMembership(registryStorage),
          membershipExempt: [overlayIdentityKey]
        }) as any,
        spentInputStore),
      admissionStore),
    {
      channel: submitChannel,
      // §9.4 — the snapshot is made durable here, before the engine broadcasts.
      putPending: async rec => { await admissionStore.putPending?.(rec) },
      snapshotRestore
    }))

  // Built by the engine inside configureEngine; the maintenance and the
  // eviction below need the instance itself (refold, restore, purge).
  let mandalaLookup: MandalaLookupService | undefined
  server.configureLookupServiceWithMongo('ls_mandala', db => (mandalaLookup = createMandalaLookupService(mandalaWallet, storage)(db)))

  // The registry manager is wrapped for capture too, so a registry-only
  // submission that the pinned engine swallows into an empty STEAK still comes
  // back as a structured 4xx rather than an ambiguous 200. Its verdict is never
  // persisted (the record is keyed by txid alone, and persisting it would
  // poison a later, valid tm_mandala submit of the same bytes) and never
  // outranks tm_mandala's on a multi-topic submission.
  server.configureTopicManager(REGISTRY_TOPIC, withVerdictCapture(new RegistryTopicManager({
    verifierWallet: mandalaWallet,
    trustedIssuers: cfg.issuerKeys,
    stateStore: storage,
    engineOutputs,
    registry: registryStorage
  }) as any, { channel: submitChannel, topic: REGISTRY_TOPIC }))
  server.configureLookupServiceWithMongo(REGISTRY_LOOKUP, db => createRegistryLookupService(registryStorage, storage)(db))

  server.configureEnableGASPSync(false)
  // "A failed broadcast rejects the submit" is load-bearing (the engine
  // broadcasts before folding state), so it is stated rather than left to
  // overlay-express's current default.
  server.configureEngineParams({ throwOnBroadcastFailure: true })
  await server.configureEngine(false)
  if (mandalaLookup == null) throw new Error('ls_mandala lookup was not constructed')
  // overlay-express 2.7.3 builds a SHIP/SLAP WalletAdvertiser once the FQDN is
  // a valid https host. Mandala does not advertise (GASP sync is off), and the
  // advertiser would run babbage-storage calls at boot and SLAP lookups inside
  // the engine's submission lock. start() only inits it when it is a
  // WalletAdvertiser, so clearing it is safe.
  ;(server.engine as unknown as { advertiser?: unknown }).advertiser = undefined

  // Go parity: overlay-go accepts every non-terminal 2xx Arcade status, but
  // overlay-express 2.7.3 refuses the ones outside its success set (Arcade
  // echoes SEEN_MULTIPLE_NODES / PENDING_RETRY / ... on a re-submit), failing a
  // re-broadcast the Go overlay admits. Mandala configures Arcade only (never
  // an ARC key), so the engine's broadcaster is the ArcadeProvider itself
  // rather than a ProviderChainBroadcaster, and its result is the provider's.
  const engineBroadcaster = (server.engine as unknown as { broadcaster?: { broadcast: (tx: any) => Promise<any> } }).broadcaster
  if (engineBroadcaster != null) withArcadeStatusParity(engineBroadcaster)

  // Boot refold of every token with history, then the owner-index reconcile of
  // both topics, inside the exclusive gate; repeated on an interval. runOnce
  // never rejects: a failure is logged and readiness reports degraded until a
  // later run succeeds (Review Focus 5).
  ownerIndex = new OwnerIndexMaintenance({
    gate,
    lookup: mandalaLookup,
    reconcile: async topic => await reconcileOwnerIndex({ storage, engine: engineOutputs, topic }),
    topics: [TOKEN_TOPIC, REGISTRY_TOPIC],
    log
  })
  server.registerHealthCheck(ownerIndex.healthCheck())

  // FIX E. Mounted BEFORE server.start(), which is where OverlayExpress
  // registers its own /arc-ingest, so this route matches first: the pinned
  // route evicts without restoring inputs. The callback token is mandatory
  // whenever Arcade is configured (readBootConfig and start() both refuse
  // Arcade without one).
  //
  // Gated on the same condition the pinned route uses — with no provider
  // configured it never mounts /arc-ingest at all, so there is nothing to
  // shadow (the local demo has no Arcade). NOT behind gateSubmits: the
  // eviction quiesces submits itself through `exclusive`.
  if (cfg.arcade != null) {
    mountArcIngest(server.app as any, {
      callbackToken: cfg.arcade.callbackToken,
      store: admissionStore,
      // unmarkSpent only while the evicted tx still holds the coin (or a
      // legacy NULL spentBy); isUnspent fails closed on an unreadable row.
      ...knexEvictionCoins(server.knex!, TOKEN_TOPIC),
      // Every role (value and authority) from the owner journal, credited once,
      // and only for a coin the engine shows live again (eviction.ts).
      restoreInput: journalRestoreInput((t, v, topic) => storage.getOwnerJournal(t, v, topic), j => mandalaLookup!.restoreInputRow(j), TOKEN_TOPIC),
      evict: async (txid, reason) =>
        await (server.engine as unknown as {
          evictAppliedTransaction: (t: string, o: { reason?: string }) => Promise<unknown>
        }).evictAppliedTransaction(txid, { reason }),
      // F4 — the engine swallows a failed outputEvicted and deletes the outputs
      // anyway; whatever index rows of the tx survived are retired here, through
      // the package's own outputEvicted (takes the row, debits once).
      retireOutputs: lookupRetireOutputs(mongoIndexedVouts(lookupDb), (t, v) => mandalaLookup!.outputEvicted(t, v)),
      // Refold every token the tx has history for without it, then purge its
      // history rows (in that order, so an interrupted run can be repeated).
      purgeAndRefold: txid => mandalaLookup!.purgeAndRefold(txid),
      quiesce: fn => gate.exclusive(fn),
      // No block height: the engine takes it from the proof, and throws when
      // a forwarded one differs from it.
      ingestProof: async (txid, merklePathHex) => {
        await (server.engine as unknown as {
          handleNewMerkleProof: (t: string, p: MerklePath) => Promise<unknown>
        }).handleNewMerkleProof(txid, MerklePath.fromHex(merklePathHex))
      }
    })
  }

  // σ_I for a previously admitted transaction. A wallet settling offline must
  // attach the signature for each input txid it spends (and, when one is
  // missing, the signatures for that transaction's own inputs), so it needs to
  // fetch signatures for transactions it did not submit itself. Contract §3:
  // 200 / 410 ERR_EVICTED / 400 <final code> / 404. Still behind adminGate.
  server.app.options('/admin/admission/:txid', adminCors(ADMIN_CORS_ORIGINS))
  server.app.get('/admin/admission/:txid', ...adminGate, admissionHandler({
    store: admissionStore,
    applied: appliedProof,
    priv: overlayPriv
  }) as unknown as (req: Request<{ txid: string }>, res: Response) => void)

  // v3 token routes (§6.5). Each validates its token id (`<txid>_0`) first and
  // answers 400 on a malformed one, so an old-format id never reads as "none".
  const send = (res: Response, r: routes.RouteResult): void => { res.status(r.status).json(r.body) }
  const publicRoute = <P>(handler: (req: Request<P>) => Promise<routes.RouteResult>) =>
    (req: Request<P>, res: Response): void => {
      res.header('Access-Control-Allow-Origin', '*')
      void (async () => {
        try {
          send(res, await handler(req))
        } catch (e) {
          res.status(500).json({ error: String(e) })
        }
      })()
    }

  // Each frozen ref carries `hasFrozenRow` (A16): whether the frozen coin
  // still has a token row, i.e. whether a reissue of it can succeed.
  server.app.get('/admin/asset-state/:tokenId', publicRoute<{ tokenId: string }>(async req =>
    await routes.assetStateResponse(req.params.tokenId, {
      getAssetState: id => storage.getAssetState(id),
      hasTokenRow: async (t, v) => (await storage.getTokenRow(t, v)) != null
    })))

  // The BEEF of an authority tx, so an issuer whose wallet lost the authority
  // coin's bookkeeping can re-attach it. Registered before '/:tokenId'.
  server.app.get('/admin/authorities/beef/:txid', publicRoute<{ txid: string }>(async req =>
    await routes.authoritiesBeefResponse(req.params.txid, req.query.vout, {
      findBeef: async (txid, vout) => {
        const out = await new KnexStorage(server.knex!).findOutput(txid, vout, TOKEN_TOPIC, undefined, true)
        if (out?.beef == null) return null
        return { beef: Array.from(out.beef as number[] | Uint8Array), outputIndex: out.outputIndex }
      }
    })))
  // The token's unspent authority coins (deploy and admin outputs).
  server.app.get('/admin/authorities/:tokenId', publicRoute<{ tokenId: string }>(async req =>
    await routes.authoritiesResponse(req.params.tokenId, {
      listAuthorities: id => storage.listAuthorities(TOKEN_TOPIC, id)
    })))

  // The full history in fold order, for exports.
  server.app.get('/admin/admin-history/:tokenId', publicRoute<{ tokenId: string }>(async req => {
    const id = routes.tokenIdParam(req.params.tokenId)
    if (id == null) return { status: 400, body: { error: 'invalid tokenId' } }
    return { status: 200, body: await storage.findAdminHistory(id) }
  }))

  // Paged admin history (?limit=&offset=), newest-first by admit sequence, so
  // the app's audit log streams thousands of actions in pages.
  server.app.get('/admin/admin-history-page/:tokenId', publicRoute<{ tokenId: string }>(async req =>
    await routes.adminHistoryPageResponse(req.params.tokenId, req.query.limit, req.query.offset, {
      page: async (id, limit, offset) =>
        await lookupDb.collection('mandalaAdminHistory').find({ tokenId: id }, { projection: { _id: 0 } }).sort({ admitSeq: -1 }).skip(offset).limit(limit).toArray() as unknown as AdminHistoryEntry[]
    })))

  // Issued/redeemed totals from the history deltas, deduplicated per outpoint
  // (the Overview KPIs and the Banking reconciliation).
  server.app.get('/admin/admin-summary/:tokenId', publicRoute<{ tokenId: string }>(async req =>
    await routes.adminSummaryResponse(req.params.tokenId, {
      history: id => storage.findAdminHistory(id)
    })))

  server.app.options('/admin/registry', adminCors(ADMIN_CORS_ORIGINS))
  server.app.get('/admin/registry', ...adminGate, (_req: Request, res: Response) => {
    void (async () => {
      try {
        res.json(await registryStorage.list())
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  server.app.get('/admin/registry/beef/:txid', (req: Request<{ txid: string }>, res: Response) => {
    res.header('Access-Control-Allow-Origin', '*')
    void (async () => {
      try {
        const vout = Number(req.query.vout ?? 0)
        const engineStorage = new KnexStorage(server.knex!)
        const out = await engineStorage.findOutput(req.params.txid, Number.isFinite(vout) ? vout : 0, REGISTRY_TOPIC, undefined, true)
        if (out?.beef == null) {
          res.status(404).json({ error: 'registry tx not in overlay storage' })
          return
        }
        const beef = Array.from(out.beef as number[] | Uint8Array)
        res.json({ beef, outputIndex: out.outputIndex })
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  // Overlay-wide transaction feed with linkage-proven counterparties — what
  // the overlay operator can see. Reads the package's append-only linkage
  // collection (identity per output, proven via revealSpecificKeyLinkage) and
  // the engine's raw-tx store (amounts, input provenance). Cursor-paginated
  // (?limit=&before=), optionally narrowed to one token (?tokenId=); see
  // activity.ts. The package indexes linkage by outpoint and identity only, so
  // the newest-first sort's index is ensured here, at boot.
  const linkageCol = lookupDb.collection('mandalaLinkageRecords')
  await linkageCol.createIndex({ createdAt: -1 })
  // The paged admin-history route above reads { tokenId } newest-first by
  // admitSeq; the package's own history indexes lead with height/txid, so
  // without this one Mongo sorts in memory. Same §9.9 failure semantics as the
  // linkage index: awaited, so a failure aborts the boot.
  await lookupDb.collection('mandalaAdminHistory').createIndex({ tokenId: 1, admitSeq: -1 })

  server.app.options('/admin/activity', adminCors(ADMIN_CORS_ORIGINS))
  server.app.get('/admin/activity', ...adminGate, (req: Request, res: Response) => {
    void (async () => {
      try {
        let tokenId: string | undefined
        if (req.query.tokenId !== undefined) {
          const id = routes.tokenIdParam(req.query.tokenId)
          if (id == null) {
            res.status(400).json({ error: 'invalid tokenId' })
            return
          }
          tokenId = id
        }
        const engineStorage = new KnexStorage(server.knex!)
        const page = await buildActivity({
          listLinkage: async (limit, before) =>
            await linkageCol
              .find(before != null ? { createdAt: { $lte: new Date(before) } } : {})
              .sort({ createdAt: -1 })
              .limit(limit)
              .toArray() as unknown as LinkageRowLite[],
          findLinkageByOutpoints: async (outpoints) =>
            outpoints.length === 0
              ? []
              : await linkageCol.find({ $or: outpoints.map(o => ({ txid: o.txid, outputIndex: o.outputIndex })) }).toArray() as unknown as LinkageRowLite[],
          findRawTxs: async (txids) => {
            const records = await engineStorage.findRawTransactions(txids)
            return new Map(records.map(r => [r.txid, r.rawTx]))
          }
        }, {
          tokenId,
          limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
          before: typeof req.query.before === 'string' ? req.query.before : undefined
        })
        res.json(page)
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  // Boot refold + reconcile BEFORE the first submit is accepted (start() is
  // where the server begins listening), then the interval.
  await ownerIndex.runOnce()
  ownerIndex.start(OWNER_INDEX_INTERVAL_MS)
  await server.start()
  console.log(`mandala overlay listening on ${cfg.hostingUrl}`)
}

const log = (m: string, e?: unknown): void => { if (e == null) console.log(m); else console.error(m, e) }
const close = async (): Promise<void> => { ownerIndex?.stop(); await overlay?.close() }
// Drain on a signal: stop accepting work, let in-flight requests finish, close
// knex and Mongo, then exit 0. 25s sits inside compose's 30s stop_grace_period.
const onSignal = createShutdown({ close, exit: (code) => process.exit(code), log, deadlineMs: 25_000 })
// A failed startup exits 1 whether or not the cleanup close succeeds.
const onStartupFailure = createShutdown({ close, exit: () => process.exit(1), log, deadlineMs: 10_000 })
process.once('SIGTERM', () => { void onSignal('SIGTERM') })
process.once('SIGINT', () => { void onSignal('SIGINT') })
main().catch((e) => { console.error(e); void onStartupFailure('startup-failure') })
