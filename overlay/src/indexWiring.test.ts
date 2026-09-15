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
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { Transaction, UnlockingScript, P2PKH, PrivateKey, ProtoWallet, Hash, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { withUnlinkedTokenReject } from './tokenLinkageGuard.js'
import { withSpentInputGuard, type SpentInputStore } from './spentGuard.js'
import { withAdminChainAnchor, type AdminChainStore } from './adminChainGuard.js'
import { classifyManagerReason } from './submitVerdict.js'

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
    expect(stack).toContain('spentInputStore')
    expect(stack).toContain('adminChainStore')
    expect(stack).toContain('admissionStore')
    // §9.7 — the in-flight claim is the guard's, not the wrapper's, to make.
    expect(stack).toMatch(/withSpentInputGuard\([\s\S]*?spentInputStore,\s*\n\s*inFlight/)
  })

  it('wires the §9.4 provisional record on the token manager only', () => {
    expect(stack).toContain('putPending')
    // The registry manager is wrapped for capture but writes no token record.
    const registry = CODE.slice(CODE.indexOf('configureTopicManager(REGISTRY_TOPIC'))
    expect(registry).toContain('withVerdictCapture(')
    expect(registry).not.toContain('putPending')
    expect(registry).not.toContain('withPersistedVerdict')
  })

  it('gives the /submit wrapper the in-flight set so a request releases its claims', () => {
    const wrap = CODE.slice(CODE.indexOf('wrapSubmitJson({'), CODE.indexOf('wrapSubmitJson({') + 400)
    expect(wrap).toContain('inFlight')
    expect(wrap).toContain('channel: submitChannel')
    expect(wrap).toContain('store: admissionStore')
  })

  it('releases an in-flight claim from the compare-and-swap (§9.7)', () => {
    expect(CODE).toMatch(/onMarked:[\s\S]*?inFlight\.releaseOutpoint/)
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
    spendStateOf: async () => ({ spent, consumedBy: spent ? [{ txid: 'dd'.repeat(32), outputIndex: 0 }] : [] }),
    wasEvicted: async () => false
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
