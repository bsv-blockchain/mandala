/**
 * Structural checks that the shipped UI/pipeline modules wire the pure
 * single-flight / admin-auth / submit guards — not parallel reimplementations.
 * Reads source as the verifier's static CTA bar.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file lives at app/src/; app modules resolve against it, the extracted
// @bsv/mandala package sources live at <repo>/lib/src.
const appSrc = dirname(fileURLToPath(import.meta.url))
const libSrc = resolve(appSrc, '../../lib/src')

function src(rel: string): string {
  return readFileSync(resolve(appSrc, rel), 'utf8')
}

function lib(rel: string): string {
  return readFileSync(resolve(libSrc, rel), 'utf8')
}

describe('robustness wiring (shipped source)', () => {
  it('SendTokens blocks re-entry with sync ref, sendFlight, and pending disable', () => {
    const s = src('components/SendTokens.tsx')
    expect(s).toContain('sendStartedRef')
    expect(s).toContain('sendFlight')
    expect(s).toContain('guardSendSubmit')
    expect(s).toContain('sendMutation.isPending')
    expect(s).toContain('BusyError')
    // Confirm CTA must not rely only on setStep('sending') for double-click.
    expect(s).toMatch(/disabled=\{[\s\S]*sendMutation\.isPending/)
  })

  it('useSendMutation acquires sendFlight before optimistic write', () => {
    const s = src('hooks/useSendMutation.ts')
    expect(s).toContain('sendFlight.tryAcquire')
    expect(s).toContain('BusyError')
    expect(s).toContain('guardPositiveAmount')
    expect(s).toContain('sendFlight.release')
  })

  it('issuerOps + submitAdminAction share withAdminAuthGate; redeem asserts prior before FT load', () => {
    const issue = lib('issuerOps.ts')
    const assets = lib('assets.ts')
    const ftc = lib('ftCandidates.ts')
    expect(issue).toContain('withAdminAuthGate')
    expect(issue).toContain('assertSpendablePrior')
    expect(assets).toContain('withAdminAuthGate')
    expect(assets).toContain('assertSpendablePrior')
    // redeemTokens fails fast on a stale prior via loadFtCandidates'
    // requireSpendable, which asserts against the first basket listing —
    // before the heavier BEEF/listActions work (skeptic gap).
    const redeemFn = issue.slice(issue.indexOf('export async function redeemTokens'))
    expect(redeemFn).toContain('requireSpendable')
    expect(redeemFn).toContain('guardRedeemSubmit')
    expect(ftc).toContain('assertSpendablePrior')
    const assertIdx = ftc.indexOf('assertSpendablePrior(')
    const beefIdx = ftc.indexOf("include: 'entire transactions'")
    expect(assertIdx).toBeGreaterThan(-1)
    expect(beefIdx).toBeGreaterThan(-1)
    expect(assertIdx).toBeLessThan(beefIdx)
  })

  it('IssuerPanel and RegisterAssetStrip use sync re-entry refs + guards', () => {
    const panel = src('components/IssuerPanel.tsx')
    const reg = src('components/issuer/RegisterAssetStrip.tsx')
    expect(panel).toContain('issueStartedRef')
    expect(panel).toContain('redeemStartedRef')
    expect(panel).toContain('guardIssueSubmit')
    expect(panel).toContain('guardRedeemSubmit')
    expect(panel).toContain('isAdminAuthInFlight')
    expect(reg).toContain('startedRef')
    expect(reg).toContain('registerFlight')
    expect(reg).toContain('guardRegisterSubmit')
  })

  it('RegulatoryControls uses busyRef + admin field guards', () => {
    const s = src('components/issuer/RegulatoryControls.tsx')
    expect(s).toContain('busyRef')
    expect(s).toContain('guardAdminFields')
    expect(s).toContain('isAdminAuthInFlight')
    expect(s).toContain('BusyError')
    expect(s).toMatch(/if \(busyRef\.current\) return/)
  })

  it('IdentityRegistry mock-KYC uses registryFlight and compressed-key guard', () => {
    const ui = src('components/issuer/IdentityRegistry.tsx')
    const mut = src('hooks/useRegistryMutations.ts')
    const libReg = lib('registry.ts')
    expect(ui).toContain('registryFlight')
    expect(ui).toContain('guardIdentityKey')
    expect(ui).toContain('startedRef')
    expect(ui).toContain('Re-attach identity chain')
    expect(ui).toContain('handleOpen')
    expect(mut).toContain('mockKycOpen')
    expect(libReg).toContain('recoverRegistryAuth')
    expect(mut).toContain('mockKycAdmit')
    expect(mut).toContain('mockKycRevoke')
    expect(libReg).toContain('registryFlight.run')
    expect(libReg).toContain('nextRegistryPlan')
    expect(libReg).toContain('buildRegistrySpendArgs')
    expect(libReg).toContain('priorOutpoint: live.authOutpoint')
    expect(libReg).toMatch(/inputs:\s*\[\{\s*outpoint: p\.priorOutpoint/)
  })

  it('useIssuerMutations wraps register in registerFlight and pre-gates amounts', () => {
    const s = src('hooks/useIssuerMutations.ts')
    expect(s).toContain('registerFlight.run')
    expect(s).toContain('guardIssueSubmit')
    expect(s).toContain('guardRedeemSubmit')
    expect(s).toContain('guardRegisterSubmit')
  })

  it('useIssuerMutations redeem passes holder-cache balance into guard + redeemTokens', () => {
    const s = src('hooks/useIssuerMutations.ts')
    // Mutation boundary must not omit balance (skeptic gap)
    expect(s).toMatch(/guardRedeemSubmit\(\{[\s\S]*balance/)
    expect(s).toMatch(/redeemTokens\(\{[\s\S]*balance/)
    expect(s).toContain('qc.getQueryData<HolderData>(holderKey)')
  })

  it('redeem gates on the PRE-decrement balance (react-query awaits onMutate before mutationFn)', () => {
    const s = src('hooks/useIssuerMutations.ts')
    const redeemBlock = s.slice(s.indexOf('const redeem = useMutation'))
    // The optimistic decrement must not live in onMutate — that runs before
    // mutationFn, so the balance gate would compare against balance-minus-amount
    // and refuse any redeem above half (redeem-all impossible).
    expect(redeemBlock).not.toMatch(/onMutate\s*:/)
    const guardIdx = redeemBlock.indexOf('guardRedeemSubmit(')
    const adjustIdx = redeemBlock.indexOf('adjustBalance(')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(adjustIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(adjustIdx)
  })

  it('reconcile prioritizes accepted rebroadcast; sweep blocked by accepted + fresh intents', () => {
    const s = lib('reconcile.ts')
    expect(s).toContain("entry.stage === 'accepted'")
    expect(s).toContain('broadcastAcceptedTx')
    // Sweep must stay away while an overlay-accepted tx awaits broadcast OR a
    // live pipeline's intent marker is fresh.
    expect(s).toMatch(/e\.stage === 'accepted' \|\|[\s\S]*e\.stage === 'intent'/)
    expect(s).toContain('INTENT_TTL_MS')
    // Cross-tab: the whole pass runs under a web lock.
    expect(s).toContain("tryWithLock('mandala.reconcile'")
    // Failed aborts are retained (attempts++), not dropped on first failure.
    expect(s).toContain('ABORT_RETRY_CAP')
    // §9.11: a retryable refusal is re-submitted then released; an accepted tx
    // whose broadcast keeps failing is parked, not retried forever.
    expect(s).toContain('RETRY_CAP')
    expect(s).toContain('BROADCAST_RETRY_CAP')
    expect(s).toContain("stage: 'stranded'")
    expect(s).toMatch(/e\.stage === 'retryable'/)
  })

  it('txJournal stages cover the four recovery states plus intent, with per-entry atomic keys', () => {
    const s = lib('txJournal.ts')
    // 'retryable' and 'stranded' are amendment v2.1 §9.11: a liftable refusal
    // leaves a live action that needs a durable record, and an accepted tx whose
    // broadcast never lands must stop wedging reconcile.
    expect(s).toContain("stage: 'intent' | 'accepted' | 'abort' | 'retryable' | 'stranded'")
    expect(s).toContain('journalListStranded')
    expect(s).toContain("'mandala.txJournal.'") // per-entry key prefix
    expect(s).not.toMatch(/stage:.*pending/)
  })

  it('pipelines run under intent markers and cross-tab locks', () => {
    const transfer = lib('transfer.ts')
    const issuer = lib('issuerOps.ts')
    const assets = lib('assets.ts')
    expect(transfer).toContain('journalIntentBegin')
    expect(transfer).toContain("tryWithLock('mandala.send'")
    expect(issuer.match(/withIntent\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(assets).toContain('withIntent(')
    expect(lib('adminAuthGate.ts')).toContain('tryWithLock(`mandala.admin.')
  })

  it('receive verifies the transaction against the message body before internalizing', () => {
    const s = lib('receive.ts')
    expect(s).toContain('verifyIncoming(msg)')
    expect(s).toContain('InvalidTransferError')
    expect(s).toContain('isAlreadyInternalized')
  })

  it('transfer journals the recipient notification before sending it', () => {
    const transfer = lib('transfer.ts')
    expect(transfer).toContain('notifyPut(')
    expect(transfer).toContain('notifyRemove(')
    const putIdx = transfer.indexOf('notifyPut(')
    const sendIdx = transfer.indexOf('messageBoxClient.sendMessage', putIdx)
    expect(putIdx).toBeGreaterThan(-1)
    expect(sendIdx).toBeGreaterThan(putIdx)
  })

  it('A08: submitAdminAction journals the reissue notification before sending; the console surfaces a pending notify', () => {
    const assets = lib('assets.ts')
    const putIdx = assets.indexOf('notifyPut(')
    const sendIdx = assets.indexOf('messageBoxClient.sendMessage', putIdx)
    expect(putIdx).toBeGreaterThan(-1)
    expect(sendIdx).toBeGreaterThan(putIdx)
    expect(assets).toContain('notifyRemove(')
    expect(assets).toContain("senderMode: 'unblinded'")
    expect(assets).toContain('outputIndex: 0')
    const rc = src('components/issuer/RegulatoryControls.tsx')
    expect(rc).toContain('notified')
    expect(rc).toMatch(/recipient notification pending/i)
  })

  it('A15: registerAsset runs under intent + the mandala.register lock; global admin action under the composed gate', () => {
    const issuer = lib('issuerOps.ts')
    const assets = lib('assets.ts')
    expect(issuer).toContain("tryWithLock('mandala.register'")
    expect(issuer.match(/withIntent\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    const globalFn = assets.slice(assets.indexOf('export async function submitGlobalAdminAction'))
    expect(globalFn).toContain('withAdminAuthGates(')
    expect(globalFn).toContain('withIntent(')
    expect(globalFn).toContain('assertSpendablePrior(')
  })

  it('D3c: the three journals persist only through the injected storage adapter', () => {
    for (const file of ['txJournal.ts', 'notifyJournal.ts', 'blindingJournal.ts']) {
      const s = lib(file)
      // The adapter owns the platform guard; a journal reaching for
      // localStorage directly is exactly the RN-unsafe path D3c removed.
      expect(s).not.toContain('localStorage !==')
      expect(s).toContain("from './storage.js'")
      expect(s).toContain('getStorage()')
      // No memory mirror in front of the store — a second reader must never
      // be served an entry the store no longer has.
      expect(s).not.toMatch(/new Map<string, (JournalEntry|PendingNotification|BlindingRecord)>\(memory\)/)
    }
    const storage = lib('storage.ts')
    expect(storage).toContain('export interface MandalaStorage')
    expect(storage).toContain('export function configureStorage')
    expect(storage).toContain('export function getStorage')
    expect(storage).toContain('typeof localStorage !==')
    // configureMandala stays the single entry point (D3a) and now carries it.
    expect(lib('constants.ts')).toContain('configureStorage(endpoints.storage)')
  })

  it("D3c: the 'accepted' commit-point write is awaited before the background broadcast", () => {
    const s = lib('overlay.ts')
    const put = s.indexOf("await journalPut({ txid: signed.txid, stage: 'accepted'")
    const broadcast = s.indexOf('broadcastAcceptedTx(wallet, signed.txid)')
    expect(put).toBeGreaterThan(-1)
    expect(broadcast).toBeGreaterThan(put)
    // Every journal call site awaits: an un-awaited one reopens the crash window.
    const calls = ['journalPut(', 'journalRemove(', 'journalIntentBegin(', 'journalIntentEnd(', 'notifyPut(', 'notifyRemove(', 'blindingPut(']
    const unawaited: string[] = []
    let sites = 0
    for (const file of ['overlay.ts', 'transfer.ts', 'assets.ts', 'reconcile.ts', 'notifyJournal.ts']) {
      for (const line of lib(file).split('\n')) {
        const trimmed = line.trim()
        // Imports name the symbols without calling them; so does the export.
        if (trimmed.startsWith('import') || trimmed.startsWith('export ') || trimmed.startsWith('*') || trimmed.startsWith('//')) continue
        if (!calls.some(c => trimmed.includes(c))) continue
        sites++
        if (!trimmed.includes('await ')) unawaited.push(`${file}: ${trimmed}`)
      }
    }
    expect(sites).toBeGreaterThanOrEqual(18) // the enumerated D3c call sites
    expect(unawaited).toEqual([])
  })

  it('A18: the post-mutation asset-state refresh bypasses the lib memo', () => {
    const s = src('hooks/useAssetState.ts')
    expect(s).toMatch(/resolveAssetState\([^)]*\{\s*force:\s*true\s*\}/)
  })

  it('A14: IssuerPanel hashes the deposit ref client-side and the issue mutation passes depositHash through the guard + issueTokens', () => {
    const panel = src('components/IssuerPanel.tsx')
    const mut = src('hooks/useIssuerMutations.ts')
    expect(panel).toContain('sha256')
    expect(panel).toContain('depositHash')
    expect(panel).not.toMatch(/issueRef[^\n]*UI-only/)
    expect(mut).toMatch(/guardIssueSubmit\(\{[\s\S]*bankRef/)
    expect(mut).toMatch(/issueTokens\(\{[\s\S]*depositHash/)
  })
})
