import OverlayExpress from '@bsv/overlay-express'
import {
  MandalaTopicManager,
  MandalaStorageManager,
  createMandalaLookupService
} from '@bsv/overlay-topics'
import { KnexStorage } from '@bsv/overlay'
import { MerklePath, PrivateKey, ProtoWallet, WalletInterface } from '@bsv/sdk'
import { MongoClient } from 'mongodb'
import { config } from 'dotenv'
import type { Request, Response } from 'express'
import { buildActivity, LinkageRowLite } from './activity.js'
import {
  wrapSubmitJson, normalizeDoubleSlash, withPersistedVerdict, ensureAdmissionIndexes, TOKEN_TOPIC,
  type AdmissionRecord, type AdmissionStore, type AppliedProof
} from './admission.js'
import { admissionHandler } from './admissionRoute.js'
import { SubmitSideChannel, withVerdictCapture, type AdmissionTokenRow } from './submitSideChannel.js'
import { withUnlinkedTokenReject } from './tokenLinkageGuard.js'
import { withSpentInputGuard, knexSpentInputStore, type SpentInputStore } from './spentGuard.js'
import { mountArcIngest, knexEvictionCoins } from './eviction.js'
import { replayAssetState, type ReplayStorage } from './pinnedReducer.js'
import { withAdminChainAnchor } from './adminChainGuard.js'
import { assetAuthHeadHandler, assetAuthBeefHandler, withFrozenRowFlags, type AdminHistoryRowLite } from './assetAuth.js'
import { withFeeRateFold, withFeeRate, rebuildFeeRateFromHistory, type FeeRateStore, type FeeRateRow, type FeeRateHistoryEntry } from './feeRates.js'
import { adminAuth, adminCors, parseAdminCorsOrigins, warnIfAdminAuthDisabled } from './adminAuth.js'
import { readBootConfig } from './bootConfig.js'
import {
  RegistryStore, RegistryTopicManager, createRegistryLookup,
  registryScreening, REGISTRY_TOPIC, REGISTRY_LOOKUP
} from './registry.js'
config()

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

  // OverlayExpress.configureMongo uses db `${cfg.nodeName}_lookup_services` (i.e. "mandala_lookup_services").
  // We must use that same db name so sharedStorage reads/writes the same collections.
  const mongoClient = new MongoClient(cfg.mongoUrl)
  await mongoClient.connect()
  const sharedStorage = new MandalaStorageManager(mongoClient.db(`${cfg.nodeName}_lookup_services`))

  const mandalaWallet = new ProtoWallet(PrivateKey.fromHex(cfg.serverPrivateKey)) as unknown as WalletInterface
  const lookupDb = mongoClient.db(`${cfg.nodeName}_lookup_services`)
  const registryStore = new RegistryStore(lookupDb)
  await registryStore.ensureIndexes()

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
  const admissionStore: AdmissionStore = {
    get: async (txid) =>
      await admissionsCol.findOne({ txid }, { projection: { _id: 0 } }) as AdmissionRecord | null,
    // §9.4 — the provisional record, written by the topic-manager wrapper
    // before the engine can broadcast. `pending` is set ONLY on insert, so a
    // re-submit of an already-finalized txid never downgrades its record.
    putPending: async (rec) => {
      await admissionsCol.updateOne(
        { txid: rec.txid },
        {
          $set: {
            topics: rec.topics,
            ...(rec.restore != null ? { restore: rec.restore } : {})
          },
          $setOnInsert: { txid: rec.txid, at: rec.at, pending: true }
        },
        { upsert: true }
      )
    },
    putAdmitted: async (rec) => {
      await admissionsCol.updateOne(
        { txid: rec.txid },
        {
          $set: {
            topics: rec.topics,
            outputsToAdmit: rec.outputsToAdmit,
            admissionSignature: rec.admissionSignature,
            admissionIdentityKey: rec.admissionIdentityKey,
            pending: false,
            // The pre-spend snapshot FIX E reads back at eviction time. Absent
            // only when the topic-manager wrapper could not take it; the
            // eviction still runs, it just restores nothing.
            ...(rec.restore != null ? { restore: rec.restore } : {})
          },
          // §9.1 — an admission CLEARS the refusal fields. A transaction whose
          // earlier payload was refused and whose corrected payload is admitted
          // must stop carrying that refusal, or GET /admin/admission/:txid would
          // keep serving a 400 for a transaction this overlay has just signed.
          $unset: {
            refusedCode: '', refusedDescription: '', refusedAt: '',
            refusedPayloadHash: '', refusedSpendTxid: ''
          },
          $setOnInsert: { txid: rec.txid, at: rec.at }
        },
        { upsert: true }
      )
    },
    putRefusal: async (rec) => {
      // §9.1 — keyed by (txid, payloadHash). A later submission with a DIFFERENT
      // payload overwrites these fields with its own verdict; one with the same
      // payload is short-circuited before it ever reaches here.
      await admissionsCol.updateOne(
        { txid: rec.txid },
        {
          $set: {
            refusedCode: rec.refusedCode,
            refusedDescription: rec.refusedDescription,
            refusedAt: rec.refusedAt,
            refusedPayloadHash: rec.refusedPayloadHash
          },
          $setOnInsert: { txid: rec.txid, at: rec.refusedAt }
        },
        { upsert: true }
      )
    },
    markEvicted: async (txid, at) => {
      await admissionsCol.updateOne(
        { txid },
        { $set: { evictedAt: at }, $setOnInsert: { txid, at } },
        { upsert: true }
      )
    }
  }

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

  // FIX D — the topic manager's own reject reason, captured before the pinned
  // Engine swallows it into a 200 with an empty STEAK. Also carries the FIX E
  // restore snapshot from the same wrapper.
  const submitChannel = new SubmitSideChannel()

  // Collapse leading '//' before any route of ours matches (2.7.3 normalizes
  // only later, inside start(), so '//submit' would otherwise bypass σI).
  server.app.use(normalizeDoubleSlash)
  // Same matcher as the upstream route (case-insensitive, non-strict), so
  // '/Submit' and '/submit/' cannot bypass the admission wrapper either.
  // Its next() runs the edge policy and then the upstream /submit route.
  server.app.post('/submit', wrapSubmitJson({
    priv: overlayPriv,
    store: admissionStore,
    applied: appliedProof,
    channel: submitChannel
  }) as any)

  // The admin chain is anchored repo-locally until the same gate ships in
  // @bsv/overlay-topics: without it a third party forges admin actions, since
  // the upstream verifier re-derives the lock key from an attacker-supplied
  // counterparty and accepts any input as the prior. See adminChainGuard.ts.
  const adminHistoryCol = lookupDb.collection('mandalaAdminHistory')
  await adminHistoryCol.createIndex({ assetId: 1, txid: 1, outputIndex: 1 })
  const hasTokenRow = async (txid: string, vout: number): Promise<boolean> =>
    await sharedStorage.getTokenRow(txid, vout) != null
  const adminChainStore = {
    isAdminOutpoint: async (assetId: string, txid: string, vout: number): Promise<boolean> =>
      await adminHistoryCol.countDocuments({ assetId, txid, outputIndex: vout }, { limit: 1 }) > 0,
    hasTokenRow
  }

  // Per-asset feeRatePerKb (token-fee design §2), folded repo-locally from
  // register/setFeeRate admin outputs because the pinned reducer ignores the
  // field. Served merged into /admin/asset-state like withFrozenRowFlags.
  const feeRatesCol = lookupDb.collection('mandalaFeeRates')
  await feeRatesCol.createIndex({ assetId: 1 }, { unique: true })
  const feeRateStore: FeeRateStore = {
    get: async assetId =>
      (await feeRatesCol.findOne({ assetId }, { projection: { _id: 0 } })) as unknown as FeeRateRow | null,
    upsert: async row => {
      await feeRatesCol.updateOne({ assetId: row.assetId }, { $set: row }, { upsert: true })
    },
    // Oldest first, the pinned findAdminHistoryByAssetId / Go
    // FindAdminHistoryByAssetID order — the eviction rebuild replays it.
    historyFor: async assetId =>
      (await adminHistoryCol.find({ assetId })
        .sort({ height: 1, offset: 1, admitSeq: 1 })
        .project({ _id: 0, txid: 1, outputIndex: 1, actionDetails: 1 })
        .toArray()) as unknown as FeeRateHistoryEntry[]
  }

  // Membership (A04): once the registry has a row, non-admitted identities are
  // refused — except asset issuers and this overlay, exactly as Go's
  // membershipHolds. Issuer keys are read live from the asset-state cache on
  // every check, so a fresh register is honoured on the next submit.
  const assetStatesCol = lookupDb.collection('mandalaAssetStates')
  const overlayIdentityKey = PrivateKey.fromHex(cfg.serverPrivateKey).toPublicKey().toString()
  const membership = registryScreening(registryStore, [], {
    issuers: {
      issuerIdentityKeys: async () =>
        (await assetStatesCol.distinct('issuerIdentityKey', { issuerIdentityKey: { $ne: '' } })) as string[]
    },
    identityKeys: [overlayIdentityKey]
  })

  // FIX L — the live spend state of an input, and whether the transaction that
  // spent it has since been evicted (in which case the guard releases the coin
  // and the submitter retries).
  const spentInputStore: SpentInputStore = knexSpentInputStore(server.knex!, TOKEN_TOPIC, async (txid) => {
    const rec = await admissionsCol.findOne({ txid }, { projection: { evictedAt: 1 } })
    return rec?.evictedAt != null
  })

  // Wrapper stack for tm_mandala, outermost first. The inner four are §9.6's
  // CANONICAL GUARD ORDER, and both engines must refuse in exactly this order,
  // because the first refusal wins and a transaction can violate several rules
  // at once — two stacks that disagree hand the same bytes two different codes,
  // and a wallet keyed on the code (retry vs. rebuild vs. abandon) then behaves
  // differently depending on which overlay it asked. Cheapest and most specific
  // first: the linkage check reads only the submission itself, the spend check
  // reads one row per input, the admin check reads admin history, and the pinned
  // manager does the full validation.
  //   withVerdictCapture     — FIX D/E/§9.4: stash the reject reason, take the
  //                            pre-spend restore snapshot and make it durable
  //                            (pending record) before the engine broadcasts.
  //   withPersistedVerdict   — "verdict wins": a txid with a persisted FINAL
  //                            verdict (a refusal for THIS payload, §9.1, or an
  //                            eviction) is refused before any mutation or
  //                            broadcast. This has to live here rather than in a
  //                            /submit pre-check, because OverlayExpress
  //                            installs its body parsers after every route this
  //                            file registers.
  //   ── §9.6 order starts here ──
  //   withUnlinkedTokenReject— FIX A: reject (never skip) a MandalaToken
  //                            output with no verified linkage.
  //   withSpentInputGuard    — FIX L: refuse a conflicting second spend of
  //                            ANY input (the engine omits spent coins from
  //                            previousCoins), healing stale self/evicted spends;
  //                            a live input previousCoins does not list (un-spent
  //                            after the engine's query) is a retryable 503.
  //   withAdminChainAnchor   — admin actions must be anchored to the asset's
  //                            chain of spends.
  //   MandalaTopicManager    — the pinned rules.
  server.configureTopicManager(TOKEN_TOPIC, withVerdictCapture(
    withPersistedVerdict(
      withUnlinkedTokenReject(
        withSpentInputGuard(
          withAdminChainAnchor(new MandalaTopicManager({
            verifierWallet: mandalaWallet,
            screeningProvider: membership,
            adminWallet: mandalaWallet,
            adminProtocolID: [2, 'mandala admin'] as [2, string],
            stateStore: sharedStorage
          }) as any, adminChainStore),
          spentInputStore
        ),
        { verifierWallet: mandalaWallet }
      ),
      admissionStore
    ),
    {
      channel: submitChannel,
      // §9.4 — the snapshot is made durable here, before the engine broadcasts.
      putPending: async (rec) => { await admissionStore.putPending?.(rec) },
      snapshotRestore: async (tx, previousCoins) => {
        const spentOutpoints: string[] = []
        const tokenRows: AdmissionTokenRow[] = []
        for (const ci of previousCoins) {
          const inp = tx.inputs[ci]
          if (inp == null) continue
          const srcTxid = inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''
          if (srcTxid === '') continue
          spentOutpoints.push(`${srcTxid}.${inp.sourceOutputIndex}`)
          const row = await sharedStorage.getTokenRow(srcTxid, inp.sourceOutputIndex)
          if (row != null) {
            tokenRows.push({
              txid: row.txid,
              outputIndex: row.outputIndex,
              assetId: row.assetId,
              amount: row.amount,
              identityKey: row.identityKey,
              createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? '')
            })
          }
        }
        return { spentOutpoints, tokenRows }
      }
    }
  ))
  const mandalaLookup = createMandalaLookupService(mandalaWallet, sharedStorage)
  server.configureLookupServiceWithMongo('ls_mandala', (db) => withFeeRateFold(mandalaLookup(db), feeRateStore))
  // The registry manager is wrapped for capture too, so a registry-only
  // submission that the pinned engine swallows into an empty STEAK still comes
  // back as a structured 4xx rather than an ambiguous 200. Its verdict is never
  // persisted (the record is keyed by txid alone, and persisting it would
  // poison a later, valid tm_mandala submit of the same bytes) and never
  // outranks tm_mandala's on a multi-topic submission.
  server.configureTopicManager(REGISTRY_TOPIC, withVerdictCapture(
    new RegistryTopicManager(mandalaWallet, registryStore) as any,
    { channel: submitChannel, topic: REGISTRY_TOPIC }
  ))
  server.configureLookupService(REGISTRY_LOOKUP, createRegistryLookup(registryStore))

  server.configureEnableGASPSync(false)
  // "A failed broadcast rejects the submit" is load-bearing (the engine
  // broadcasts before folding state), so it is stated rather than left to
  // overlay-express's current default.
  server.configureEngineParams({ throwOnBroadcastFailure: true })
  await server.configureEngine(false)
  // overlay-express 2.7.3 builds a SHIP/SLAP WalletAdvertiser once the FQDN is
  // a valid https host. Mandala does not advertise (GASP sync is off), and the
  // advertiser would run babbage-storage calls at boot and SLAP lookups inside
  // the engine's submission lock. start() only inits it when it is a
  // WalletAdvertiser, so clearing it is safe.
  ;(server.engine as unknown as { advertiser?: unknown }).advertiser = undefined

  // FIX E. Mounted BEFORE server.start(), which is where OverlayExpress
  // registers its own /arc-ingest, so this route matches first: the pinned
  // route evicts without restoring inputs. The callback token is mandatory
  // whenever Arcade is configured (readBootConfig and start() both refuse
  // Arcade without one).
  //
  // Gated on the same condition the pinned route uses — with no provider
  // configured it never mounts /arc-ingest at all, so there is nothing to
  // shadow (the local demo has no Arcade).
  if (cfg.arcade != null) {
    mountArcIngest(server.app as any, {
      callbackToken: cfg.arcade.callbackToken,
      store: admissionStore,
      // unmarkSpent only while the evicted tx still holds the coin (or a
      // legacy NULL spentBy); isUnspent fails closed on an unreadable row.
      ...knexEvictionCoins(server.knex!, TOKEN_TOPIC),
      restoreTokenRow: async (row) => {
        await sharedStorage.storeToken({
          txid: row.txid,
          outputIndex: row.outputIndex,
          assetId: row.assetId,
          amount: row.amount,
          identityKey: row.identityKey,
          createdAt: row.createdAt != null && row.createdAt !== '' ? new Date(row.createdAt) : new Date()
        })
      },
      evict: async (txid, reason) =>
        await (server.engine as unknown as {
          evictAppliedTransaction: (t: string, o: { reason?: string }) => Promise<unknown>
        }).evictAppliedTransaction(txid, { reason }),
      assetsTouchedBy: async (txid) =>
        ((await adminHistoryCol.distinct('assetId', { txid })) as string[]).sort(),
      // Rebuild-first: the pinned rebuildState reads every row, so replay the
      // history minus this txid's rows with the pinned reducer (same ctx
      // sourcing), then refold the repo-local fee rate from the identical rows
      // — Go's RebuildStateExcluding folds the rate natively.
      rebuildAssetStateExcluding: async (assetId, txid) => {
        const history = (await adminHistoryCol.find({ assetId, txid: { $ne: txid } })
          .sort({ height: 1, offset: 1, admitSeq: 1 })
          .project({ _id: 0, txid: 1, outputIndex: 1, actionDetails: 1 })
          .toArray()) as unknown as FeeRateHistoryEntry[]
        await replayAssetState(assetId, history, sharedStorage as unknown as ReplayStorage)
        await rebuildFeeRateFromHistory(feeRateStore, assetId, history)
      },
      purgeAdminHistory: async (txid) => {
        await adminHistoryCol.deleteMany({ txid })
      },
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

  // Each frozen ref carries `hasFrozenRow` (A16): whether the frozen coin
  // still has a token row, i.e. whether a reissue of it can succeed.
  server.app.get('/admin/asset-state/:assetId', (req: Request<{ assetId: string }>, res: Response) => {
    res.header('Access-Control-Allow-Origin', '*')
    void (async () => {
      try {
        const state = await sharedStorage.getAssetState(req.params.assetId)
        const feeRow = await feeRateStore.get(req.params.assetId)
        res.json(await withFrozenRowFlags(withFeeRate(state, feeRow), hasTokenRow))
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  // Per-asset admin-auth head (A10): the newest admitted admin output of the
  // asset by (height, offset, admitSeq), plus the BEEF to spend it. Lets an
  // issuer whose wallet lost the auth output's bookkeeping re-attach it.
  server.app.get('/admin/asset-auth/beef/:txid', assetAuthBeefHandler({
    findBeef: async (txid, vout) => {
      const engineStorage = new KnexStorage(server.knex!)
      const out = await engineStorage.findOutput(txid, vout, 'tm_mandala', undefined, true)
      if (out?.beef == null) return null
      return { beef: Array.from(out.beef as number[] | Uint8Array), outputIndex: out.outputIndex }
    }
  }))
  server.app.get('/admin/asset-auth/:assetId', assetAuthHeadHandler({
    findAdminHistory: async (assetId) =>
      await sharedStorage.findAdminHistoryByAssetId(assetId) as unknown as AdminHistoryRowLite[]
  }))

  server.app.get('/admin/admin-history/:assetId', (req: Request<{ assetId: string }>, res: Response) => {
    res.header('Access-Control-Allow-Origin', '*')
    void (async () => {
      try {
        const history = await sharedStorage.findAdminHistoryByAssetId(req.params.assetId)
        res.json(history)
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  server.app.options('/admin/registry', adminCors(ADMIN_CORS_ORIGINS))
  server.app.get('/admin/registry', ...adminGate, (_req: Request, res: Response) => {
    void (async () => {
      try {
        res.json(await registryStore.list())
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
  // the overlay operator can see. Reads the append-only linkage collection
  // (identity per output, proven via revealSpecificKeyLinkage) and the
  // engine's raw-tx store (amounts, input provenance). Cursor-paginated
  // (?limit=&before=) so thousands of transactions stream in pages; see
  // activity.ts. Indexes are ensured at boot so the newest-first sort and
  // the paged admin-history reads never collection-scan.
  const linkageCol = lookupDb.collection('mandalaLinkageRecords')
  await Promise.all([
    linkageCol.createIndex({ createdAt: -1 }),
    adminHistoryCol.createIndex({ assetId: 1, admitSeq: -1 })
  ])

  server.app.options('/admin/activity', adminCors(ADMIN_CORS_ORIGINS))
  server.app.get('/admin/activity', ...adminGate, (req: Request, res: Response) => {
    void (async () => {
      try {
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
          assetId: typeof req.query.assetId === 'string' ? req.query.assetId : undefined,
          limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
          before: typeof req.query.before === 'string' ? req.query.before : undefined
        })
        res.json(page)
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  // Paged admin history (?limit=&offset=), newest-first by admit sequence.
  // The un-paged /admin/admin-history/:assetId stays for full exports; the
  // app's audit log uses this one so thousands of actions stream in pages.
  server.app.get('/admin/admin-history-page/:assetId', (req: Request<{ assetId: string }>, res: Response) => {
    res.header('Access-Control-Allow-Origin', '*')
    void (async () => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500)
        const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0)
        const rows = await adminHistoryCol
          .find({ assetId: req.params.assetId }, { projection: { _id: 0 } })
          .sort({ admitSeq: -1 })
          .skip(offset)
          .limit(limit)
          .toArray()
        res.json(rows)
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  // Aggregated issue/redeem totals — the Overview KPIs and the Banking
  // reconciliation need whole-history sums, which must not require shipping
  // the whole history to the client. Mongo does the sum against the
  // (assetId, …) index.
  server.app.get('/admin/admin-summary/:assetId', (req: Request<{ assetId: string }>, res: Response) => {
    res.header('Access-Control-Allow-Origin', '*')
    void (async () => {
      try {
        const groups = await adminHistoryCol.aggregate([
          { $match: { assetId: req.params.assetId } },
          // Re-admits (GASP re-sync / reorg replay) append duplicate rows for
          // the same on-chain action with a fresh admitSeq — collapse to one
          // per (txid, outputIndex) BEFORE summing, or totals double-count.
          {
            $group: {
              _id: { txid: '$txid', outputIndex: '$outputIndex' },
              kind: { $first: '$actionDetails.kind' },
              amount: { $first: '$actionDetails.amount' }
            }
          },
          { $group: { _id: '$kind', total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]).toArray()
        const byKind = new Map(groups.map(g => [g._id as string, g]))
        // Matches the client-side sums this replaces: 'issue' and 'redeem'
        // only ('reissue' conserves supply — it replaces frozen units).
        res.json({
          totalIssued: byKind.get('issue')?.total as number ?? 0,
          totalRedeemed: byKind.get('redeem')?.total as number ?? 0,
          actionCount: groups.reduce((a, g) => a + (g.count as number), 0)
        })
      } catch (e) {
        res.status(500).json({ error: String(e) })
      }
    })()
  })

  await server.start()
  console.log(`mandala overlay listening on ${cfg.hostingUrl}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
