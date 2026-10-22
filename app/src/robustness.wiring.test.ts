/**
 * Structural checks that the shipped UI/pipeline modules wire the pure
 * single-flight / admin-auth / submit guards — not parallel reimplementations.
 * Reads source as the verifier's static CTA bar.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file lives at app/src/; app modules resolve against it. Lib-source
// invariants are owned by @bsv/mandala's own suite (contract §8.1), not scanned here.
const appSrc = dirname(fileURLToPath(import.meta.url))

function src(rel: string): string {
  return readFileSync(resolve(appSrc, rel), 'utf8')
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

  it('A08: the console surfaces a pending reissue notify', () => {
    const rc = src('components/issuer/RegulatoryControls.tsx')
    expect(rc).toContain('notified')
    expect(rc).toMatch(/recipient notification pending/i)
  })

  it('A18: the post-mutation asset-state refresh bypasses the lib memo', () => {
    const s = src('hooks/useAssetState.ts')
    expect(s).toMatch(/resolveAssetState\([^)]*\{\s*force:\s*true\s*\}/)
  })

  it('the note SendTokens captures reaches transferTokens, not just the Review screen', () => {
    const ui = src('components/SendTokens.tsx')
    const mut = src('hooks/useSendMutation.ts')
    // The field exists and is shown back on Review (already true) — the gap is
    // whether it is actually sent anywhere beyond that.
    expect(ui).toContain('const [note, setNote] = useState')
    expect(ui).toMatch(/sendMutation\.mutate\(\s*\{[\s\S]*?note[\s\S]*?\}/)
    expect(mut).toMatch(/interface SendVars\s*\{[\s\S]*?note\??:\s*string/)
    expect(mut).toMatch(/transferTokens\(\{[\s\S]*?note[\s\S]*?\}/)
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
