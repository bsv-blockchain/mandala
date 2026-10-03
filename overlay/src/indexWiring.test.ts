/**
 * What `index.ts` actually WIRES — asserted against the source, because the
 * wiring is the contract.
 *
 * Every other test in this repo composes a stack by hand and proves that stack
 * behaves. None of them can notice that the server builds a DIFFERENT one: a
 * guard dropped, a dependency not passed, two wrappers swapped. §9.6 makes the
 * order itself binding across both engines — first refusal wins, and a
 * transaction can break several rules at once, so two stacks that disagree hand
 * the same bytes two different codes and a wallet keyed on the code (retry vs.
 * rebuild vs. abandon) behaves differently depending on which overlay it asked.
 *
 * `main()` needs Mongo, SQLite and a full env, so it cannot be imported here.
 * Reading the source with comments stripped is the honest way to pin the shape;
 * wrapperStack.test.ts drives the same stack behaviourally over the real
 * package manager.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import OverlayExpress from '@bsv/overlay-express'
import { initialDoubleSlashCompatibility } from '@bsv/overlay-express/security/edgePolicy.ts'
import { Transaction, UnlockingScript, P2PKH, PrivateKey } from '@bsv/sdk'
import { MANDALA_TOPIC } from '@bsv/overlay-topics'
import { wrapSubmitJson, normalizeDoubleSlash, signAdmissionV2Sync, TOKEN_TOPIC } from './admission.js'
import { OWNER_INDEX_INTERVAL_MS, OWNER_INDEX_RETRY_BASE_MS } from './ownerIndex.js'

const SOURCE = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

/** Comments name the wrappers too; only the code may be asserted on. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')

const orderOf = (haystack: string, needles: string[]): string[] =>
  [...needles].sort((a, b) => haystack.indexOf(a) - haystack.indexOf(b))

describe('index.ts — tm_mandala stack over @bsv/overlay-topics 2.0.0', () => {
  const stack = CODE.slice(CODE.indexOf('configureTopicManager(TOKEN_TOPIC'), CODE.indexOf('configureTopicManager(REGISTRY_TOPIC'))

  it('uses one name for the token topic, equal to the package constant', () => {
    expect(TOKEN_TOPIC).toBe(MANDALA_TOPIC)
    expect(CODE).not.toContain('MANDALA_TOPIC')
  })

  it('builds one MandalaStorageManager and shares it with the manager, the registry and the lookup', () => {
    expect(CODE.match(/new MandalaStorageManager\(/g)).toHaveLength(1)
    expect(CODE).toMatch(/const storage = new MandalaStorageManager\(lookupDb\)/)
    // Both topic managers read and journal through it.
    expect(CODE.match(/stateStore: storage\b/g)).toHaveLength(2)
    expect(CODE).toMatch(/createMandalaLookupService\(mandalaWallet, storage\)/)
    expect(CODE).toMatch(/createRegistryLookupService\(registryStorage, storage\)/)
    expect(CODE.match(/new RegistryStorage\(/g)).toHaveLength(1)
  })

  it('passes the trusted-issuer set and the engine output reader to both managers', () => {
    expect(CODE.match(/trustedIssuers: cfg\.issuerKeys/g)).toHaveLength(2)
    expect(CODE).toContain('const engineOutputs = knexEngineOutputs(server.knex!)')
    // Both managers, plus the reconciler.
    expect(CODE.match(/\bengineOutputs\b/g)!.length).toBeGreaterThanOrEqual(4)
    const registry = CODE.slice(CODE.indexOf('new RegistryTopicManager({'), CODE.indexOf('configureLookupServiceWithMongo(REGISTRY_LOOKUP'))
    expect(registry).toContain('trustedIssuers: cfg.issuerKeys')
    expect(registry).toMatch(/\bengineOutputs\b/)
    expect(registry).toContain('registry: registryStorage')
    expect(stack).toContain('trustedIssuers: cfg.issuerKeys')
    expect(stack).toMatch(/\bengineOutputs\b/)
  })

  it('wires membership from the registry, exempting the overlay identity', () => {
    expect(stack).toContain('membership: registryMembership(registryStorage)')
    expect(stack).toContain('membershipExempt: [overlayIdentityKey]')
    expect(stack).toContain('screeningProvider: new InMemoryScreeningProvider([])')
  })

  it('tm_mandala stack: capture → persisted verdict → spent guard → package manager (nothing between)', () => {
    expect(CODE).toMatch(/withVerdictCapture\(\s*withPersistedVerdict\(\s*withSpentInputGuard\(\s*new MandalaTopicManager\(/)
  })

  it('passes every guard the state it gates on', () => {
    expect(stack).toMatch(/\}\) as any,\s*spentInputStore\)/)
    // The production store reads the engine's `outputs` table, not a stand-in.
    expect(CODE).toContain('knexSpentInputStore(server.knex!, TOKEN_TOPIC')
    expect(stack).toMatch(/spentInputStore\),\s*admissionStore\)/)
    const wrap = CODE.slice(CODE.indexOf('wrapSubmitJson({'), CODE.indexOf('wrapSubmitJson({') + 400)
    expect(wrap).toContain('channel: submitChannel')
    expect(wrap).toContain('store: admissionStore')
  })

  it('wires the §9.4 provisional record on the token manager only', () => {
    expect(stack).toContain('putPending')
    // The registry manager is wrapped for capture but writes no token record.
    const registry = CODE.slice(CODE.indexOf('configureTopicManager(REGISTRY_TOPIC'))
    expect(registry.slice(0, registry.indexOf('configureLookupServiceWithMongo'))).toContain('withVerdictCapture(')
    expect(registry.slice(0, registry.indexOf('configureLookupServiceWithMongo'))).toContain('topic: REGISTRY_TOPIC')
    expect(registry).not.toContain('putPending')
    expect(registry).not.toContain('withPersistedVerdict')
  })

  // FIX E — the snapshot names every input; owners come from the journal at eviction.
  it('snapshots every input and stores it through the merging admission store', () => {
    expect(CODE).toContain('const admissionStore: AdmissionStore = mongoAdmissionStore(admissionsCol)')
    expect(stack).toMatch(/,\s*snapshotRestore\s*\}\)\)/)
    expect(CODE).not.toContain('snapshotRestoreFrom')
    expect(stack).not.toMatch(/for \(const ci of previousCoins\)/)
  })

  // @bsv/overlay >= 2.6's markUTXOAsSpent is itself a compare-and-swap that
  // records spentBy (the 4th argument). Replacing it would drop spentBy, and the
  // spent-input guard's self-heal keys on it.
  it('leaves the engine\'s own compare-and-swap mark-spent in place', () => {
    expect(CODE).not.toMatch(/markUTXOAsSpent\s*=/)
    expect(CODE).not.toContain('inFlight')
  })

  it('registers the lookups through configureLookupServiceWithMongo and fails boot loudly without ls_mandala', () => {
    expect(CODE).toMatch(/configureLookupServiceWithMongo\('ls_mandala', db => \(mandalaLookup = createMandalaLookupService\(mandalaWallet, storage\)\(db\)\)\)/)
    expect(CODE).toMatch(/configureLookupServiceWithMongo\(REGISTRY_LOOKUP, db => createRegistryLookupService\(registryStorage, storage\)\(db\)\)/)
    const after = CODE.slice(CODE.indexOf('await server.configureEngine(false)'))
    expect(after).toContain("throw new Error('ls_mandala lookup was not constructed')")
    expect(after.indexOf("throw new Error('ls_mandala lookup was not constructed')")).toBeLessThan(after.indexOf('new OwnerIndexMaintenance('))
  })

  it('drops every 1.x wrapper and the substring table', () => {
    for (const gone of ['withUnlinkedTokenReject', 'withAdminChainAnchor', 'withFeeRateFold', 'replayAssetState', 'classifyManagerReason', 'registryScreening', 'asset-auth', 'assetId', 'adminWallet', 'adminProtocolID', 'findAdminHistoryByAssetId', 'sharedStorage'])
      expect(SOURCE).not.toContain(gone)
  })
})

describe('index.ts — maintenance: quiesced /submit, owner index before start', () => {
  it('gates /submit, and only /submit, on the maintenance gate', () => {
    expect(CODE).toMatch(/server\.app\.post\('\/submit', gateSubmits\(gate\), wrapSubmitJson\(/)
    // Exactly one mount: /arc-ingest (whose eviction takes `exclusive`) and every
    // other route stay ungated, or each eviction deadlocks into a permanent 503.
    expect(CODE.match(/gateSubmits\(/g)).toHaveLength(1)
    const line = CODE.split('\n').find(l => l.includes('gateSubmits('))!
    expect(line).toContain("post('/submit'")
    expect(CODE.slice(CODE.indexOf('mountArcIngest('))).not.toContain('gateSubmits')
    expect(CODE).toContain('const gate = new MaintenanceGate()')
  })

  // Task 13 — a second, exclusive-only instance: the reconcile lock, shared by
  // the owner-index run and eviction only. Never mounted on a route.
  it('builds a separate reconcile lock that no route is gated on', () => {
    expect(CODE).toContain('const reconcileLock = new MaintenanceGate()')
    expect(CODE).not.toMatch(/gateSubmits\(reconcileLock\)/)
    expect(CODE).not.toMatch(/reconcileLock\.enter\(/)
  })

  it('pins the 30-minute reconcile interval', () => {
    expect(OWNER_INDEX_INTERVAL_MS).toBe(1_800_000)
    expect(OWNER_INDEX_RETRY_BASE_MS).toBe(10_000)
  })

  it('runs maintenance before start, then on the interval, and reports readiness', () => {
    const boot = CODE.indexOf('await ownerIndex.runOnce()')
    const start = CODE.indexOf('await server.start()')
    expect(boot).toBeGreaterThan(0)
    expect(boot).toBeLessThan(start)
    expect(CODE).toMatch(/registerHealthCheck\(ownerIndex\.healthCheck\(\)\)/)
    expect(CODE).toMatch(/ownerIndex\.start\(OWNER_INDEX_INTERVAL_MS\)/)
    expect(CODE.indexOf('ownerIndex.start(OWNER_INDEX_INTERVAL_MS)')).toBeLessThan(start)
  })

  it('builds the owner-index maintenance over the gate, the lookup, the reconciler and both topics', () => {
    const m = CODE.slice(CODE.indexOf('new OwnerIndexMaintenance('), CODE.indexOf('registerHealthCheck('))
    expect(m).toContain('gate,')
    expect(m).toContain('reconcileLock,')
    expect(m).toContain('lookup: mandalaLookup')
    expect(m).toContain('reconcileOwnerIndex({ storage, engine: engineOutputs, topic })')
    expect(m).toContain('topics: [TOKEN_TOPIC, REGISTRY_TOPIC]')
  })

  it('stops the interval on shutdown before closing the server', () => {
    expect(CODE).toMatch(/let ownerIndex: OwnerIndexMaintenance \| undefined/)
    expect(CODE).toContain('const close = async (): Promise<void> => { ownerIndex?.stop(); await overlay?.close() }')
  })
})

describe('index.ts — boot safety (§9.9)', () => {
  it('creates the mandalaAdmissions index through the aborting helper', () => {
    expect(CODE).toContain('await ensureAdmissionIndexes(admissionsCol)')
    // Bare await: no `.catch(...)` may turn the fatal into a warning.
    expect(CODE).toMatch(/await ensureAdmissionIndexes\(admissionsCol\)\s*\n/)
    expect(CODE).not.toMatch(/ensureAdmissionIndexes\([^)]*\)\s*\.catch/)
  })

  it('runs it before the /submit wrapper and before the server starts', () => {
    const names = ['ensureAdmissionIndexes(', 'wrapSubmitJson({', 'await server.start()']
    expect(orderOf(CODE, names)).toEqual(names)
  })

  // F1 — the paged admin-history route sorts by { tokenId, admitSeq: -1 }; without
  // this index Mongo sorts in memory and a long history hits the sort limit.
  it('creates the admin-history page index next to the linkage index, awaited, before start', () => {
    const line = "await lookupDb.collection('mandalaAdminHistory').createIndex({ tokenId: 1, admitSeq: -1 })"
    expect(CODE).toContain(line)
    const names = ["await linkageCol.createIndex({ createdAt: -1 })", line, 'await server.start()']
    expect(orderOf(CODE, names)).toEqual(names)
    expect(CODE).toMatch(/await linkageCol\.createIndex\(\{ createdAt: -1 \}\)\s*\n\s*await lookupDb\.collection\('mandalaAdminHistory'\)\.createIndex/)
  })

  it('never swallows any other boot index creation either', () => {
    const sites = CODE.split('\n').filter(l => l.includes('createIndex('))
    expect(sites.length).toBeGreaterThan(0)
    // A `.catch` on an index creation is how a boot-time failure becomes a
    // silently degraded server, which §9.9 forbids on both engines.
    for (const site of sites) expect(site).not.toContain('.catch')
    // Each is awaited directly or inside the awaited Promise.all below it.
    for (const site of sites) expect(site.trimStart()).toMatch(/^(await\s|[\w.]+\.createIndex\()/)
  })
})

describe('index.ts — boot configuration for overlay-express 2.7.3', () => {
  it('reads every boot variable through readBootConfig, not process.env', () => {
    expect(CODE).toContain('readBootConfig(process.env)')
    expect(CODE).not.toContain('requireEnv')
    // ADMIN_CORS_ORIGINS is the one console-only knob that is not in BootConfig.
    const reads = CODE.match(/process\.env\.\w+/g) ?? []
    expect(reads).toEqual(['process.env.ADMIN_CORS_ORIGINS'])
    // The env a secret was validated from is the only one that may reach the server.
    expect(CODE).not.toMatch(/HOSTING_URL|SERVER_PRIVATE_KEY|ARCADE_CALLBACK_TOKEN/)
  })

  it('constructs OverlayExpress with the canonical key and the bare https host, not the URL', () => {
    expect(CODE).toContain('new OverlayExpress(cfg.nodeName, cfg.serverPrivateKey, cfg.advertisableHost)')
    // The single overlay key signs sigma-I and decrypts linkage; no second key is read.
    expect(CODE).not.toMatch(/MANDALA_\w*PRIVATE_KEY/)
  })

  it('wires Arcade with the callback token unconditionally and the private-host flag on both calls', () => {
    const arcade = CODE.slice(CODE.indexOf('if (cfg.arcade != null) {'), CODE.indexOf('await server.configureKnex('))
    expect(arcade).toContain('server.configureArcade(cfg.arcade.url, { apiKey: cfg.arcade.apiKey, allowPrivateHosts: cfg.arcade.allowPrivateHosts })')
    expect(arcade).toContain('server.configureArcCallbackToken(cfg.arcade.callbackToken)')
    expect(arcade).toContain('server.configureChaintracks(cfg.arcade.chaintracksUrl, { apiPrefix: cfg.arcade.chaintracksApiPrefix, allowPrivateHosts: cfg.arcade.allowPrivateHosts })')
    // No `if (token !== '')` escape hatch: start() refuses Arcade without one.
    expect(arcade).not.toMatch(/callbackToken\s*(!==|===|!=|==)/)
    expect(arcade).toContain("server.configureChainTracker('scripts only')")
    expect(orderOf(arcade, ['configureArcade(', 'configureArcCallbackToken(', 'configureChaintracks(']))
      .toEqual(['configureArcade(', 'configureArcCallbackToken(', 'configureChaintracks('])
  })

  it('makes "a failed broadcast rejects the submit" explicit, before the engine is built', () => {
    const names = ['configureEngineParams({ throwOnBroadcastFailure: true })', 'await server.configureEngine(false)']
    for (const n of names) expect(CODE).toContain(n)
    expect(orderOf(CODE, names)).toEqual(names)
  })

  it('turns the SHIP/SLAP advertiser off after the engine exists and before start()', () => {
    const names = [
      'await server.configureEngine(false)',
      '.advertiser = undefined',
      'await server.start()'
    ]
    for (const n of names) expect(CODE).toContain(n)
    expect(orderOf(CODE, names)).toEqual(names)
    expect(CODE).toMatch(/\(server\.engine as unknown as \{ advertiser\?: unknown \}\)\.advertiser = undefined/)
  })

  it('maps non-terminal Arcade 2xx statuses to success on the engine broadcaster, after the engine exists', () => {
    const names = ['await server.configureEngine(false)', 'withArcadeStatusParity(engineBroadcaster)', 'await server.start()']
    for (const n of names) expect(CODE).toContain(n)
    expect(orderOf(CODE, names)).toEqual(names)
    expect(CODE).toMatch(/\(server\.engine as unknown as \{ broadcaster\?: /)
    // No broadcaster (local demo, no Arcade) is left alone, not an error.
    expect(CODE).toContain('if (engineBroadcaster != null) withArcadeStatusParity(engineBroadcaster)')
  })

  it('mounts /arc-ingest only with Arcade, using the validated token', () => {
    const mount = CODE.slice(CODE.indexOf('mountArcIngest('))
    expect(CODE).toMatch(/if \(cfg\.arcade != null\) \{\s*\n\s*mountArcIngest\(/)
    expect(mount).toContain('callbackToken: cfg.arcade.callbackToken')
  })
})

// overlay-express 2.7.3 installs its '//' collapse and the upstream /submit
// route inside start(), AFTER everything index.ts registers. Express routing
// is case-insensitive and non-strict, so an exact path check, or a mount the
// router does not share with upstream, lets '/Submit', '/submit/' or '//submit'
// reach the upstream route with no σ_I and no admission record.
describe('index.ts — the /submit wrapper shares the upstream route matcher', () => {
  const MOUNT = "server.app.post('/submit', gateSubmits(gate), wrapSubmitJson("
  const NORMALIZER = 'server.app.use(normalizeDoubleSlash)'

  it('mounts the wrapper with app.post on /submit, never app.use', () => {
    expect(CODE).toContain(MOUNT)
    expect(CODE).not.toMatch(/\.use\(\s*wrapSubmitJson/)
  })

  it('collapses a leading // first, before any route of ours, the /submit wrapper included', () => {
    expect(CODE).toContain(NORMALIZER)
    expect(CODE.search(/server\.app\b/)).toBe(CODE.indexOf(NORMALIZER))
    expect(orderOf(CODE, [NORMALIZER, MOUNT])).toEqual([NORMALIZER, MOUNT])
  })

  describe('over real Express routing (the app OverlayExpress builds)', () => {
    const overlayPriv = PrivateKey.fromRandom()
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '3d'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(overlayPriv.toAddress()) })
    const expected = signAdmissionV2Sync(overlayPriv, tx.id('hex'), [0]).admissionSignature
    let http: Server | undefined
    let base = ''

    beforeAll(async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { app } = new OverlayExpress('wiring', PrivateKey.fromRandom().toHex(), 'overlay.example.com')
      // index.ts's mount…
      app.use(normalizeDoubleSlash)
      app.post('/submit', wrapSubmitJson({ priv: overlayPriv }) as any)
      // …then what start() installs later: upstream's own '//' collapse and
      // its /submit route (here reading the body bodyParser.raw would have).
      app.use(initialDoubleSlashCompatibility)
      app.post('/submit', async (req: any, res: any) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        req.body = Buffer.concat(chunks)
        res.status(200).json({ tm_mandala: { outputsToAdmit: [0], coinsToRetain: [] } })
      })
      const listening = app.listen(0, '127.0.0.1')
      http = listening
      await new Promise<void>(resolve => listening.once('listening', () => resolve()))
      base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
    })
    afterAll(async () => {
      if (http != null) await new Promise<void>(resolve => (http as Server).close(() => resolve()))
      vi.restoreAllMocks()
    })

    it.each(['/submit', '/Submit', '/SUBMIT/', '/submit/', '//submit', '///Submit/', '//submit?x=1'])(
      '%s reaches the upstream route only through σ_I', async path => {
        const r = await fetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-topics': JSON.stringify(['tm_mandala']) },
          body: Buffer.from(tx.toBEEF())
        })
        expect(r.status).toBe(200)
        expect((await r.json()).tm_mandala.admissionSignature).toBe(expected)
      })
  })
})

// A signal must drain through OverlayExpress.close() (HTTP server, timers,
// knex, Mongo) rather than kill the process mid-write, and close() can only
// release the clients it owns — so the repo must not open a second Mongo client
// that nothing closes.
describe('index.ts — graceful lifecycle on OverlayExpress.close()', () => {
  it('opens no Mongo client of its own: the lookup db is the one configureMongo built', () => {
    expect(CODE).not.toMatch(/\bMongoClient\b/)
    expect(CODE).not.toMatch(/from 'mongodb'/)
    // Directly after configureMongo, the db OverlayExpress named `${name}_lookup_services`.
    expect(CODE).toMatch(/await server\.configureMongo\(cfg\.mongoUrl\)\s*\n\s*const lookupDb = server\.mongoDb!\s*\n/)
    expect(CODE).toContain('new MandalaStorageManager(lookupDb)')
    expect(CODE).toContain('new RegistryStorage(lookupDb)')
    expect(CODE.match(/const lookupDb\b/g)).toHaveLength(1)
  })

  it('captures the server for close() right after constructing it', () => {
    expect(CODE).toMatch(/let overlay: OverlayExpress \| undefined/)
    expect(CODE).toMatch(/new OverlayExpress\([^)]*\)\s*\n\s*overlay = server\s*\n/)
    expect(CODE).toContain('await overlay?.close()')
  })

  it('drains on SIGTERM and SIGINT once each, through the idempotent shutdown', () => {
    expect(CODE).toContain("createShutdown({ close, exit: (code) => process.exit(code), log, deadlineMs: 25_000 })")
    expect(CODE).toContain("process.once('SIGTERM', () => { void onSignal('SIGTERM') })")
    expect(CODE).toContain("process.once('SIGINT', () => { void onSignal('SIGINT') })")
  })

  it('a failed startup always exits 1, whether or not the cleanup close succeeds', () => {
    expect(CODE).toContain('createShutdown({ close, exit: () => process.exit(1), log, deadlineMs: 10_000 })')
    expect(CODE).toContain("main().catch((e) => { console.error(e); void onStartupFailure('startup-failure') })")
    // The only direct exits are the two shutdown instances above.
    expect(CODE.match(/process\.exit\(/g)).toHaveLength(2)
  })

  it('registers the handlers before main() starts the boot', () => {
    const names = ["process.once('SIGTERM'", "process.once('SIGINT'", 'main().catch(']
    expect(orderOf(CODE, names)).toEqual(names)
  })
})


describe('index.ts — eviction restores from the owner journal (BRC-162)', () => {
  const deps = CODE.slice(CODE.indexOf('mountArcIngest('))

  it('restores inputs through the journal and the lookup, refolds via purgeAndRefold, under the gate', () => {
    expect(deps).toMatch(/restoreInput: journalRestoreInput\(\(t, v, topic\) => storage\.getOwnerJournal\(t, v, topic\), j => mandalaLookup!\.restoreInputRow\(j\), TOKEN_TOPIC\)/)
    expect(deps).toContain('purgeAndRefold: txid => mandalaLookup!.purgeAndRefold(txid)')
    // Both locks, reconcile lock first (the order every holder uses).
    expect(deps).toContain('quiesce: reconcileThenSubmitGate(reconcileLock, gate)')
    expect(deps).not.toContain('quiesce: fn => gate.exclusive(fn)')
    expect(CODE).toMatch(/import \{[^}]*\breconcileThenSubmitGate\b[^}]*\} from '\.\/maintenanceGate\.js'/)
    expect(deps).toContain('...knexEvictionCoins(server.knex!, TOKEN_TOPIC)')
  })

  // F4 — the evicted tx's own index rows, retired through the package lookup.
  it('retires the evicted tx\'s own index rows through the lookup\'s outputEvicted', () => {
    expect(deps).toContain('retireOutputs: lookupRetireOutputs(mongoIndexedVouts(lookupDb), (t, v) => mandalaLookup!.outputEvicted(t, v))')
    expect(CODE).toMatch(/import \{[^}]*\blookupRetireOutputs\b[^}]*\bmongoIndexedVouts\b[^}]*\} from '\.\/eviction\.js'/)
  })

  it('drops the 1.x restore deps', () => {
    for (const gone of ['restoreTokenRow', 'assetsTouchedBy', 'rebuildAssetStateExcluding', 'purgeAdminHistory', 'mongoRestoreTokenRow'])
      expect(CODE).not.toContain(gone)
  })
})

describe('index.ts — v3 token routes (§6.5)', () => {
  it('mounts the v3 routes, beef before :tokenId', () => {
    const beef = CODE.indexOf("'/admin/authorities/beef/:txid'")
    const id = CODE.indexOf("'/admin/authorities/:tokenId'")
    expect(beef).toBeGreaterThan(0)
    expect(beef).toBeLessThan(id)
    for (const r of ["'/admin/asset-state/:tokenId'", "'/admin/admin-history/:tokenId'", "'/admin/admin-history-page/:tokenId'", "'/admin/admin-summary/:tokenId'", "'/admin/registry'", "'/admin/registry/beef/:txid'"])
      expect(CODE).toContain(r)
  })

  it('routes each through its tokenRoutes adapter', () => {
    for (const h of ['routes.assetStateResponse(', 'routes.authoritiesBeefResponse(', 'routes.authoritiesResponse(', 'routes.adminHistoryPageResponse(', 'routes.adminSummaryResponse('])
      expect(CODE).toContain(h)
    expect(CODE).toContain('storage.listAuthorities(TOKEN_TOPIC, id)')
    // The page dep sorts newest-first by admit sequence.
    expect(CODE).toMatch(/collection\('mandalaAdminHistory'\)\.find\(\{ tokenId: id \}, \{ projection: \{ _id: 0 \} \}\)\.sort\(\{ admitSeq: -1 \}\)\.skip\(offset\)\.limit\(limit\)/)
  })

  it('validates :tokenId on the full admin-history route and ?tokenId on /admin/activity', () => {
    const hist = CODE.slice(CODE.indexOf("'/admin/admin-history/:tokenId'"), CODE.indexOf("'/admin/admin-history/:tokenId'") + 600)
    expect(hist).toContain('routes.tokenIdParam(req.params.tokenId)')
    expect(hist).toContain("{ error: 'invalid tokenId' }")
    const act = CODE.slice(CODE.indexOf("server.app.get('/admin/activity'"))
    expect(act).toContain('routes.tokenIdParam(req.query.tokenId)')
    expect(act.slice(0, act.indexOf('buildActivity('))).toContain("{ error: 'invalid tokenId' }")
    expect(act).not.toMatch(/tokenId: typeof req\.query\.tokenId/)
  })

  it('keeps the identity-bearing routes behind the admin gate', () => {
    expect(CODE).toMatch(/server\.app\.get\('\/admin\/registry', \.\.\.adminGate,/)
    expect(CODE).toMatch(/server\.app\.get\('\/admin\/activity', \.\.\.adminGate,/)
    expect(CODE).toMatch(/server\.app\.get\('\/admin\/admission\/:txid', \.\.\.adminGate,/)
  })
})
