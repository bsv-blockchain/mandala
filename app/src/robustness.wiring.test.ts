/**
 * Structural checks that the shipped UI/pipeline modules wire the pure
 * single-flight / admin-auth / submit guards — not parallel reimplementations.
 * Reads source as the verifier's static CTA bar.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file lives at app/src/; app modules resolve against it. Lib-source
// invariants are owned by @bsv/mandala's own suite (contract §8.1), not scanned here.
const appSrc = dirname(fileURLToPath(import.meta.url))

function src(rel: string): string {
  return readFileSync(resolve(appSrc, rel), 'utf8')
}

/** Every shipped `.ts`/`.tsx` under `src`, relative to it (test files excluded). */
function listSrc(dir = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(resolve(appSrc, dir), { withFileTypes: true })) {
    const rel = dir === '' ? e.name : `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...listSrc(rel))
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel)
  }
  return out
}

describe('robustness wiring (shipped source)', () => {
  it('main.tsx configures no basket and gates on readMandalaConfig', () => {
    const m = src('main.tsx')
    expect(m).not.toMatch(/basket\s*:/)
    expect(m).not.toContain("'p mandala'")
    expect(m).toContain('readMandalaConfig(')
    expect(src('context/WalletContext.tsx')).toContain('configError')
    expect(src('components/issuer/IdentityRegistry.tsx')).not.toContain('tm_mandala_registry')
  })

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
    expect(ui).toContain('registryFlight')
    expect(ui).toContain('guardIdentityKey')
    expect(ui).toContain('startedRef')
    expect(ui).toContain('Re-attach identity chain')
    expect(ui).toContain('handleOpen')
    expect(mut).toContain('mockKycOpen')
    expect(mut).toContain('mockKycAdmit')
    expect(mut).toContain('mockKycRevoke')
  })

  it('useIssuerMutations wraps register in registerFlight and pre-gates amounts', () => {
    const s = src('hooks/useIssuerMutations.ts')
    expect(s).toContain('registerFlight.run')
    expect(s).toContain('guardIssueSubmit')
    expect(s).toContain('guardRedeemSubmit')
    expect(s).toContain('guardRegisterSubmit')
  })

  it('register writes no fee rate; redeem gates on the treasury balance and does not pass it on', () => {
    const s = src('hooks/useIssuerMutations.ts'); const strip = src('components/issuer/RegisterAssetStrip.tsx')
    expect(s).not.toContain('feeRatePerKb'); expect(strip).not.toMatch(/feeRate/); expect(strip).toContain('validateRegisterForm(')
    expect(s).toContain('qc.getQueryData<TreasuryData>(treasuryKey'); expect(s).toMatch(/guardRedeemSubmit\(\{[\s\S]*balance/)
    const call = s.slice(s.indexOf('redeemTokens({')); expect(call.slice(0, call.indexOf('})'))).not.toContain('balance')
    const redeemBlock = s.slice(s.indexOf('const redeem = useMutation')); expect(redeemBlock).not.toMatch(/onMutate\s*:/)
    expect(redeemBlock.indexOf('guardRedeemSubmit(')).toBeLessThan(redeemBlock.indexOf('adjustTreasury('))
    expect(src('components/IssuerPanel.tsx')).toContain('safeParseAmount(')
  })

  it('A08: the console surfaces a pending reissue notify', () => {
    const rc = src('components/issuer/RegulatoryControls.tsx')
    expect(rc).toContain('notified')
    expect(rc).toMatch(/recipient notification pending/i)
  })

  it('A18: the post-mutation asset-state refresh bypasses the lib memo', () => {
    const s = src('hooks/useAssetState.ts')
    expect(s).toMatch(/resolveAssetState\([^)]*\{\s*force:\s*true\s*\}/)
  })

  it('sendFlight is acquired before sendAndDeliver; the note reaches sendHandover', () => {
    const m = src('hooks/useSendMutation.ts')
    expect(m.indexOf('sendFlight.tryAcquire')).toBeGreaterThan(-1)
    expect(m).toContain('sendAndDeliver(')
    expect(m).not.toContain('transferTokens')
    expect(m).toMatch(/interface SendVars|SendVars/)
    expect(m).toContain('drainNow')
    expect(m).not.toMatch(/reconcileBans/)
    const ui = src('components/SendTokens.tsx')
    expect(ui).toContain('sendStartedRef')
    expect(ui).toContain('safeParseAmount(')
    expect(ui).toMatch(/sendMutation\.mutate\(\s*\{[\s\S]*?note[\s\S]*?\}/)
    expect(ui).not.toMatch(/Number\(/)
    // The note is forwarded by the pipeline to sendHandover and deliverHandover.
    const p = src('lib/mandala/sendPipeline.ts')
    expect(p).toMatch(/send\(\{[\s\S]*?note[\s\S]*?\}\)/)
    expect(src('context/WalletContext.tsx')).toMatch(/addEventListener\('online'/)
  })

  it('deliver and settle run inside the handover lock; the app never aborts a hand-over', () => {
    const p = src('lib/mandala/sendPipeline.ts')
    expect(p).toMatch(/withLock[\s\S]*wait:\s*true[\s\S]*settle\(/)
    expect(p).not.toContain('abortAction')
    const dr = src('lib/mandala/handoverDrain.ts')
    for (const banned of ['abortAction', 'deliverHandover', 'settleHandover', 'resubmitDelivered', 'localStorage']) expect(dr).not.toContain(banned)
    const w = src('context/WalletContext.tsx')
    expect(w).toMatch(/setInterval\([\s\S]*drainNow\(\)/)
    expect(w).toMatch(/drainNow\(\{\s*force:\s*true\s*\}\)/)
  })

  it('payout path uses payoutTokens unblinded with the MessageBox client', () => {
    const m = src('hooks/usePayoutMutation.ts'); expect(m).toMatch(/payoutTokens\(\{[\s\S]*blind:\s*false[\s\S]*messageBoxClient/); expect(m).toContain('payoutFlight')
    expect(m).toMatch(/notified\s*===\s*false/); expect(m).toContain('drainNow')
    // no authority is spent: nothing may read or advance the admin-auth cache from a payout
    for (const banned of ['nextAuthOutpoint', 'nextAuthKeyID', 'advanceAdminAuth', 'useAdvanceAdminAuth', 'isAdminAuthInFlight', 'reconcileWallet(']) expect(m).not.toContain(banned)
    const t = src('components/issuer/TreasurySection.tsx'); expect(t).toContain("mode=\"payout\""); expect(t).toContain('useTreasuryBalances'); expect(t).not.toContain('useHolderData')
  })

  it('one recovery path: reconcileWallet/reconcileNotifications are called only from handoverDrain via drainNow', () => {
    for (const f of listSrc().filter(f => f !== 'lib/mandala/handoverDrain.ts' && f !== 'context/WalletContext.tsx')) {
      expect(src(f), f).not.toMatch(/reconcileWallet\(|reconcileNotifications\(/)
    }
    const w = src('context/WalletContext.tsx')
    expect(w).not.toMatch(/reconcileWallet\(|reconcileNotifications\(/)
    expect(w).toContain('drainHandovers(')
    for (const f of listSrc()) expect(src(f), f).not.toContain('mandala.app.handover.')
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

  it('ReceiveTokens uses receiveHandovers', () => {
    const s = src('components/ReceiveTokens.tsx')
    expect(s).toContain('receiveHandovers(')
    expect(s).not.toContain('receiveTokens')
    expect(s).not.toMatch(/Number\(/)
  })

  it('holder views read no basket and format bigint amounts', () => {
    for (const f of ['components/holder/HolderHome.tsx', 'components/holder/AssetAccount.tsx', 'components/holder/TransactionHistory.tsx', 'components/holder/AlertBanners.tsx', 'components/TokenWallet.tsx']) {
      const s = src(f)
      expect(s).not.toMatch(/\bBASKET\b/)
      expect(s).not.toContain('decodeValue')
      expect(s).not.toContain("'@bsv/mandala/amount'")
    }
    const a = src('components/holder/AlertBanners.tsx')
    expect(a).toContain('frozenUnitsFor(')
    expect(a).not.toContain('listOutputs')
    const h = src('components/holder/HolderHome.tsx')
    expect(h).toContain('holderLines(')
    // unsettled is already inside the balance and incoming is outside it: never summed
    expect(h).not.toMatch(/balance\s*\+\s*(row\.|a\.|asset\.)?(incoming|unsettled)|(incoming|unsettled)\s*\+\s*(row\.|a\.|asset\.)?balance/)
    expect(h).not.toMatch(/\.pending\b/)
  })
})
