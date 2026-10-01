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
 * Reading the source with comments stripped is the honest way to pin the shape,
 * and it is paired below with a behavioural test of the same order over the real
 * guards.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import OverlayExpress from '@bsv/overlay-express'
import { initialDoubleSlashCompatibility } from '@bsv/overlay-express/security/edgePolicy.ts'
import { Transaction, UnlockingScript, P2PKH, PrivateKey, ProtoWallet, Hash, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { withUnlinkedTokenReject } from './tokenLinkageGuard.js'
import { withSpentInputGuard, type SpentInputStore } from './spentGuard.js'
import { withAdminChainAnchor, type AdminChainStore } from './adminChainGuard.js'
import { classifyManagerReason } from './submitVerdict.js'
import { wrapSubmitJson, normalizeDoubleSlash, signAdmissionV2Sync } from './admission.js'

const SOURCE = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

/** Comments name the wrappers too; only the code may be asserted on. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')

const orderOf = (haystack: string, needles: string[]): string[] =>
  [...needles].sort((a, b) => haystack.indexOf(a) - haystack.indexOf(b))

describe('index.ts — tm_mandala guard order (§9.6)', () => {
  const stack = CODE.slice(CODE.indexOf('configureTopicManager(TOKEN_TOPIC'))

  it('nests the guards in the canonical order: unlinked → spend → admin → manager', () => {
    const names = [
      'withUnlinkedTokenReject(',
      'withSpentInputGuard(',
      'withAdminChainAnchor(',
      'new MandalaTopicManager('
    ]
    for (const n of names) expect(stack).toContain(n)
    expect(orderOf(stack, names)).toEqual(names)
  })

  it('keeps capture outermost and "verdict wins" directly inside it', () => {
    const names = ['withVerdictCapture(', 'withPersistedVerdict(', 'withUnlinkedTokenReject(']
    expect(orderOf(stack, names)).toEqual(names)
  })

  it('passes every guard the state it gates on', () => {
    expect(stack).toMatch(/withSpentInputGuard\([\s\S]*?\),\s*\n\s*spentInputStore\s*\n\s*\)/)
    // The production store reads the engine's `outputs` table, not a stand-in.
    expect(CODE).toContain('knexSpentInputStore(server.knex!, TOKEN_TOPIC')
    expect(stack).toContain('adminChainStore')
    expect(stack).toContain('admissionStore')
    const wrap = CODE.slice(CODE.indexOf('wrapSubmitJson({'), CODE.indexOf('wrapSubmitJson({') + 400)
    expect(wrap).toContain('channel: submitChannel')
    expect(wrap).toContain('store: admissionStore')
  })

  it('wires the §9.4 provisional record on the token manager only', () => {
    expect(stack).toContain('putPending')
    // The registry manager is wrapped for capture but writes no token record.
    const registry = CODE.slice(CODE.indexOf('configureTopicManager(REGISTRY_TOPIC'))
    expect(registry).toContain('withVerdictCapture(')
    expect(registry).not.toContain('putPending')
    expect(registry).not.toContain('withPersistedVerdict')
  })

  // @bsv/overlay >= 2.6's markUTXOAsSpent is itself a compare-and-swap that
  // records spentBy (the 4th argument). Replacing it would drop spentBy, and the
  // spent-input guard's self-heal keys on it.
  it('leaves the engine\'s own compare-and-swap mark-spent in place', () => {
    expect(CODE).not.toMatch(/markUTXOAsSpent\s*=/)
    expect(CODE).not.toContain('inFlight')
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
  const MOUNT = "server.app.post('/submit', wrapSubmitJson("
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

describe('index.ts — eviction rebuild (PR #11 + token-fee §2, rebuild-first)', () => {
  const deps = CODE.slice(CODE.indexOf('mountArcIngest('))
  const rebuild = deps.slice(deps.indexOf('rebuildAssetStateExcluding:'), deps.indexOf('purgeAdminHistory:'))

  it('replays the history EXCLUDING the evicted txid, oldest first', () => {
    expect(rebuild).toMatch(/adminHistoryCol\.find\(\{ assetId, txid: \{ \$ne: txid \} \}\)[\s\S]*?\.sort\(\{ height: 1, offset: 1, admitSeq: 1 \}\)/)
  })

  it('folds state via the pinned reducer, then the fee rate from the identical row set', () => {
    expect(orderOf(rebuild, ['replayAssetState(', 'rebuildFeeRateFromHistory(feeRateStore, assetId, history)']))
      .toEqual(['replayAssetState(', 'rebuildFeeRateFromHistory(feeRateStore, assetId, history)'])
    expect(rebuild).not.toContain('createMandalaLookupService')
  })

  it('purge only deletes; the assets query is distinct+sorted', () => {
    const purge = deps.slice(deps.indexOf('purgeAdminHistory:'), deps.indexOf('ingestProof:'))
    expect(purge).toContain('adminHistoryCol.deleteMany({ txid })')
    expect(purge).not.toContain('distinct')
    const assets = deps.slice(deps.indexOf('assetsTouchedBy:'), deps.indexOf('rebuildAssetStateExcluding:'))
    expect(assets).toMatch(/adminHistoryCol\.distinct\('assetId', \{ txid \}\)[\s\S]*?\.sort\(\)/)
  })

  it('eviction.ts purges only after every rebuild (rebuild-first)', () => {
    const ev = readFileSync(new URL('./eviction.ts', import.meta.url), 'utf8')
    const body = ev.slice(ev.indexOf('export const evictWithRestore'))
    const iAssets = body.indexOf('deps.assetsTouchedBy(txid)')
    const iRebuild = body.indexOf('deps.rebuildAssetStateExcluding(assetId, txid)')
    const iPurge = body.indexOf('deps.purgeAdminHistory(txid)')
    expect(iAssets).toBeGreaterThan(0)
    expect(iRebuild).toBeGreaterThan(iAssets)
    expect(iPurge).toBeGreaterThan(iRebuild)
  })
})

// ───────────── the same order, asserted behaviourally over real guards ───────

describe('§9.6 guard order — first refusal wins, over the real guards', () => {
  const overlay = new ProtoWallet(new PrivateKey(44))
  const key = PrivateKey.fromRandom()
  const assetId = `${'ab'.repeat(32)}.0`

  const build = (tokenOutput: boolean): { beef: number[], prior: string } => {
    const src = new Transaction()
    src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({
      satoshis: 1,
      lockingScript: tokenOutput
        ? new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(key.toPublicKey().toString(), 'hex')))
        : new P2PKH().lock(key.toAddress())
    })
    return { beef: tx.toBEEF(), prior: `${src.id('hex')}.0` }
  }

  const payload = (admin: boolean, prior: string): number[] =>
    Utils.toArray(JSON.stringify({
      inputs: [],
      outputs: [],
      ...(admin ? { admin: [{ index: 0, actionDetails: { kind: 'unpause', assetId, priorOutpoint: prior } }] } : {})
    }), 'utf8')

  const spentInputs = (spent: boolean): SpentInputStore => ({
    spendStateOf: async () => ({ spent, spentBy: spent ? 'dd'.repeat(32) : null, consumedBy: [] }),
    wasEvicted: async () => false,
    releaseSpend: async () => 0
  })

  /** Anchors nothing, so any admin entry is unanchored. */
  const noAdminChain: AdminChainStore = { isAdminOutpoint: async () => false, hasTokenRow: async () => true }

  const run = async (opts: { token: boolean, spent: boolean, admin: boolean }): Promise<string> => {
    const { beef, prior } = build(opts.token)
    const inner = {
      identifyAdmissibleOutputs: async () => { throw new Error('conservation violated: outputs exceed authorized inputs/issuance') }
    } as any
    const tm = withUnlinkedTokenReject(
      withSpentInputGuard(withAdminChainAnchor(inner, noAdminChain), spentInputs(opts.spent)),
      { verifierWallet: overlay as any }
    )
    const err = await tm.identifyAdmissibleOutputs(beef, [0], payload(opts.admin, prior)).catch((e: unknown) => e)
    return classifyManagerReason((err as Error).message)
  }

  it('an unlinked token output outranks a conflicting spend, an unanchored admin action and the manager', async () => {
    expect(await run({ token: true, spent: true, admin: true })).toBe('ERR_LINKAGE')
  })

  it('a conflicting spend outranks an unanchored admin action and the manager', async () => {
    expect(await run({ token: false, spent: true, admin: true })).toBe('ERR_INPUT_SPENT')
  })

  it('an unanchored admin action outranks the manager', async () => {
    expect(await run({ token: false, spent: false, admin: true })).toBe('ERR_SHAPE')
  })

  it('the pinned manager has the last word when every guard passes', async () => {
    expect(await run({ token: false, spent: false, admin: false })).toBe('ERR_CONSERVATION')
  })
})
