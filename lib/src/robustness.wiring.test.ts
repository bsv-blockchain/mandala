/**
 * Source invariants of the shipped pipelines: the guards, locks, intent
 * markers and journals are wired in, not reimplemented beside them. Ported
 * from the lib-source checks of app/src/robustness.wiring.test.ts onto the
 * 1Color file layout (C§8.1; plan 05 A7 removes them from the app).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function lib (rel: string): string {
  return readFileSync(resolve(here, rel), 'utf8')
}

/** The source with block and line comments blanked, so prose never satisfies (or breaks) a code check. */
function code (rel: string): string {
  return lib(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** The body of `export async function <name>` up to the next top-level export. */
function fn (src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const next = src.indexOf('\nexport ', start + 1)
  return src.slice(start, next < 0 ? undefined : next)
}

/** Every journal write the crash windows depend on (D3c). */
const JOURNAL_CALLS = [
  'journalPut(', 'journalRemove(', 'journalIntentBegin(', 'journalIntentEnd(', 'journalPromoteSigned(',
  'notifyPut(', 'notifyPutIntent(', 'notifyRemove(', 'blindingPut(', 'blindingReserve(', 'blindingCommit('
]
const JOURNAL_FILES = ['overlay.ts', 'handover.ts', 'payout.ts', 'assets.ts', 'reconcile.ts', 'notifyJournal.ts', 'receipt.ts']
/** Measured when this test was written (Task 17); a lower count means a site was lost or renamed. */
const JOURNAL_SITES_MIN = 51

describe('robustness wiring (lib source)', () => {
  it('(1) issuerOps + submitAdminAction share withAdminAuthGate; redeem asserts the prior before the treasury BEEF load', () => {
    const issue = code('issuerOps.ts')
    const assets = code('assets.ts')
    const cand = code('treasury/candidates.ts')
    expect(issue).toContain('withAdminAuthGate(')
    expect(issue).toContain('assertSpendablePrior(')
    expect(assets).toContain('withAdminAuthGate(')
    expect(assets).toContain('assertSpendablePrior(')
    // redeemTokens fails fast on a stale prior via the candidates'
    // requireSpendable, asserted against the first basket listing, before the
    // heavier BEEF work.
    const redeem = fn(issue, 'redeemTokens')
    expect(redeem).toContain('requireSpendable')
    expect(redeem).toContain('guardRedeemSubmit(')
    const assertIdx = cand.indexOf('assertSpendablePrior(')
    const beefIdx = cand.indexOf("include: 'entire transactions'")
    expect(assertIdx).toBeGreaterThan(-1)
    expect(beefIdx).toBeGreaterThan(assertIdx)
  })

  it('(2) registry recovers its authority under the registry flight and the authority tx runner', () => {
    const s = code('registry.ts')
    for (const name of ['recoverRegistryAuth', 'registryFlight.run', 'nextRegistryPlan', 'runAuthorityTx']) {
      expect(s).toContain(name)
    }
  })

  it('(3) reconcile keeps the accepted rebroadcast; the sweep is blocked by accepted, retryable, signed, delivered and fresh intents', () => {
    const s = code('reconcile.ts')
    expect(s).toContain("entry.stage === 'accepted'")
    expect(s).toContain('broadcastAcceptedTx(')
    expect(s).toContain("tryWithLock('mandala.reconcile'")
    expect(s).toContain('ABORT_RETRY_CAP')
    expect(s).toContain('RETRY_CAP')
    expect(s).toContain('BROADCAST_RETRY_CAP')
    expect(s).toContain("stage: 'stranded'")
    expect(s).toContain('INTENT_TTL_MS')
    const sweepStart = s.indexOf('const blocked = entries.some(')
    expect(sweepStart).toBeGreaterThan(-1)
    const block = s.slice(sweepStart, s.indexOf('if (sweep && !blocked)', sweepStart))
    for (const stage of ["'accepted'", "'retryable'", "'signed'", "'delivered'"]) {
      expect(block).toContain(`e.stage === ${stage}`)
    }
    expect(block).toMatch(/e\.stage === 'intent' && Date\.now\(\) - e\.at < INTENT_TTL_MS/)
  })

  it('(4) txJournal stages are exactly the seven, with no handed_over and per-entry keys', () => {
    const s = code('txJournal.ts')
    expect(s).toContain("stage: 'intent' | 'accepted' | 'abort' | 'retryable' | 'stranded' | 'signed' | 'delivered'\n")
    expect(s).not.toContain('handed_over')
    expect(s).toContain("'mandala.txJournal.'")
    expect(s).not.toMatch(/stage:.*pending/)
  })

  it('(5) pipelines run under intent markers and cross-tab locks', () => {
    const handover = code('handover.ts')
    const payout = code('payout.ts')
    const issuer = code('issuerOps.ts')
    expect(handover).toContain('journalIntentBegin(')
    expect(handover).toContain("tryWithLock('mandala.send'")
    expect(payout).toContain("tryWithLock('mandala.payout'")
    expect(payout).toContain('withIntent(')
    expect(issuer).toContain("tryWithLock('mandala.register'")
    expect(issuer.match(/withIntent\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(code('assets.ts')).toContain('withIntent(')
    expect(code('adminAuthGate.ts')).toContain('tryWithLock(`mandala.admin.')
  })

  it('(6) receive acknowledges only after internalizing; a bad body is InvalidTransferError', () => {
    const s = code('receive.ts')
    const internalize = s.indexOf('wallet.internalizeAction(')
    const ack = s.indexOf('messageBoxClient.acknowledgeMessage(')
    expect(internalize).toBeGreaterThan(-1)
    expect(ack).toBeGreaterThan(internalize)
    expect(s).toContain('InvalidTransferError')
  })

  it('(7) every notification is journaled before it is sent', () => {
    // Holder hand-over: journal, send, clear.
    const h = fn(code('handover.ts'), 'deliverHandover')
    const hPut = h.indexOf('notifyPut(')
    expect(hPut).toBeGreaterThan(-1)
    expect(h.indexOf('messageBoxClient.sendMessage(', hPut)).toBeGreaterThan(hPut)
    expect(h.indexOf('notifyRemove(', hPut)).toBeGreaterThan(hPut)
    // Issuer receipts (payout, reissue) share deliverIssuerReceipt.
    const r = fn(code('receipt.ts'), 'deliverIssuerReceipt')
    const rPut = r.indexOf('notifyPut(')
    const rSend = r.indexOf('messageBoxClient.sendMessage(', rPut)
    expect(rPut).toBeGreaterThan(-1)
    expect(rSend).toBeGreaterThan(rPut)
    expect(r.indexOf('notifyRemove(', rSend)).toBeGreaterThan(rSend)
    // ...and journal their receipt intent (R6) before the submit, then clear it on refusal.
    for (const file of ['payout.ts', 'assets.ts']) {
      const s = code(file)
      const intent = s.indexOf('notifyPutIntent(')
      expect(intent, file).toBeGreaterThan(-1)
      expect(s.indexOf('deliverIssuerReceipt(', intent), file).toBeGreaterThan(intent)
      expect(s, file).toContain('notifyRemove(')
      expect(s, file).not.toContain('messageBoxClient.sendMessage(')
    }
  })

  it('(8) the global admin action runs under the composed gate, an intent and a spendable BEEF', () => {
    const g = fn(code('assets.ts'), 'submitGlobalAdminAction')
    expect(g).toContain('withAdminAuthGates(')
    expect(g).toContain('withIntent(')
    expect(g).toContain('spendableBeef(')
  })

  it('(9) D3c: the three journals persist only through the injected storage adapter', () => {
    for (const file of ['txJournal.ts', 'notifyJournal.ts', 'blindingJournal.ts']) {
      const s = code(file)
      expect(s, file).not.toContain('localStorage')
      expect(s, file).toContain("from './storage.js'")
      expect(s, file).toContain('getStorage()')
      // No memory mirror in front of the store: a second reader must never be
      // served an entry the store no longer has. (A Map local to one call is fine.)
      expect(s, file).not.toMatch(/^(?:const|let|var) \w+\s*(?::[^=]+)?=\s*new (?:Map|Set)\b/m)
      expect(s, file).not.toMatch(/new Map<string, \w+>\(memory\)/)
    }
    const storage = code('storage.ts')
    expect(storage).toContain('export interface MandalaStorage')
    expect(storage).toContain('export function configureStorage')
    expect(storage).toContain('export function getStorage')
    expect(storage).toContain('typeof localStorage !==')
    expect(code('constants.ts')).toContain('configureStorage(endpoints.storage)')
  })

  it("(10) D3c: the 'accepted' write is awaited before the background broadcast; every journal call is awaited", () => {
    const s = code('overlay.ts')
    const put = s.search(/await journalPut\(\{\s*txid: signed\.txid,\s*stage: 'accepted'/)
    const broadcast = s.indexOf('broadcastAcceptedTx(wallet, signed.txid)')
    expect(put).toBeGreaterThan(-1)
    expect(broadcast).toBeGreaterThan(put)

    const unawaited: string[] = []
    let sites = 0
    for (const file of JOURNAL_FILES) {
      for (const line of code(file).split('\n')) {
        const t = line.trim()
        // Imports name the symbols without calling them; so do declarations.
        if (t.startsWith('import') || t.startsWith('export ') || t.startsWith('*') || t.startsWith('//')) continue
        if (!JOURNAL_CALLS.some(c => t.includes(c))) continue
        sites++
        if (!t.includes('await ')) unawaited.push(`${file}: ${t}`)
      }
    }
    expect(unawaited).toEqual([])
    expect(sites).toBeGreaterThanOrEqual(JOURNAL_SITES_MIN)
  })
})
