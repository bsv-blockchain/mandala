/**
 * Pins the @bsv/mandala 0.5.0 surface the console consumes (contract §8.1, §9).
 * This file is the arbiter under the plan's lib-mismatch policy: a missing
 * §8.1 name means lib/dist is stale or P-LIB has not landed.
 */
import { it, expect } from 'vitest'
import * as M from '@bsv/mandala'
import { readFileSync } from 'node:fs'
// Read the installed manifests by path: an `exports` map may not expose ./package.json.
// app/src → ../node_modules (the @bsv/mandala entry is the symlink to ../lib).
const pkgOf = (name: string): { version: string } =>
  JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'))
const sdkPkg = pkgOf('@bsv/sdk'), tplPkg = pkgOf('@bsv/templates'), libPkg = pkgOf('@bsv/mandala')
const ID = 'a'.repeat(64) + '_0'
it('resolves the vendored stack', () => {
  expect(sdkPkg.version).toBe('4.0.0'); expect(tplPkg.version).toMatch(/^2\.2\./); expect(libPkg.version).toBe('0.5.0')
})
it('locks exactly one @bsv/sdk (npm ^4.0.0) and one @bsv/templates (vendored 993c98b) (contract §9)', () => {
  const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
  const lock: { packages: Record<string, { version?: string, resolved?: string }> } = read('../package-lock.json')
  const manifest: { overrides?: Record<string, string> } = read('../package.json')
  for (const name of ['@bsv/sdk', '@bsv/templates']) {
    // Any nested copy (e.g. under message-box-client) would be a second sdk in the bundle.
    const copies = Object.keys(lock.packages).filter(k => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
    expect(copies).toEqual([`node_modules/${name}`])
    expect(manifest.overrides?.[name]).toBe(`$${name}`)
  }
  const deps = (manifest as { dependencies: Record<string, string> }).dependencies
  expect(deps['@bsv/sdk']).toBe('^4.0.0')
  expect(lock.packages['node_modules/@bsv/sdk'].resolved).toBe('https://registry.npmjs.org/@bsv/sdk/-/sdk-4.0.0.tgz')
  expect(deps['@bsv/templates']).toBe('file:../vendor-ts-stack/bsv-templates-2.2.0-993c98b.tgz')
  expect(lock.packages['node_modules/@bsv/templates'].resolved).toBe('file:../vendor-ts-stack/bsv-templates-2.2.0-993c98b.tgz')
  // The console never reaches lib/profile.js (wallet hosts register the module), and no 4fa68e7 build remains.
  expect(deps['@bsv/color-permission-module']).toBeUndefined()
  expect(JSON.stringify(manifest) + JSON.stringify(lock)).not.toContain('4fa68e7')
  expect(deps['@bsv/mandala']).toBe('file:../lib')
})
it('exposes the contract §8.1 constants verbatim', () => {
  expect(M.TOPIC).toBe('tm_mandala'); expect(M.REGISTRY_TOPIC).toBe('tm_mandala_kyc')
  expect(M.MESSAGEBOX).toBe('mandala-color'); expect(M.TREASURY_BASKET).toBe('mandala treasury')
  expect(M.MANDALA_PROFILE_ID).toBe('https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md')
  expect((M as Record<string, unknown>).ATTESTED_PROFILE_ID).toBeUndefined() // B7: no attested companion
  expect(M.colorTopic(ID)).toBe('tm_color_' + ID); expect(M.colorLookup(ID)).toBe('ls_color_' + ID)
  expect(M.assetTag(ID)).toBe('a'.repeat(64) + 'v0'); expect(M.MAX_UINT64).toBe(2n ** 64n - 1n)
  expect(M.parseAmount('1234.56', 2)).toBe(123456n); expect(() => M.parseAmount('18446744073709551616', 0)).toThrow()
  // §8.1:493 pins formatAmount: plain, trimmed, no grouping, RangeError outside 0..18
  expect(M.formatAmount(M.MAX_UINT64, 18)).toBe('18.446744073709551615'); expect(M.formatAmount(100n, 2)).toBe('1')
  expect(() => M.formatAmount(1n, 19)).toThrow(RangeError)
})
it('exposes the functions the app calls', () => {
  for (const f of ['configureMandala','decodeToken','sendHandover','deliverHandover','settleHandover','receiveHandovers',
    'journalListHandovers','markHandoverDelivered',
    'registerAsset','issueTokens','payoutTokens','redeemTokens','submitAdminAction','listAdminAssets','formatAmount',
    // amountDisplay delegates to these (contract §8.1: formatAmountGrouped / formatCurrency stay)
    'parseAmount','formatAmountGrouped','currencySymbol','formatCurrency'])
    expect(typeof (M as any)[f]).toBe('function')
})
it('keeps the lib recovery entry points drainHandovers schedules', async () => {
  expect(typeof (await import('@bsv/mandala/reconcile')).reconcileWallet).toBe('function')
  expect(typeof (await import('@bsv/mandala/notifyJournal')).reconcileNotifications).toBe('function')
})
it('no longer exports the removed names', () => {
  for (const n of ['BASKET','FT_PROTOCOL','MAX_SAFE_AMOUNT','tokenTopic','decodeValue','transferTokens','receiveTokens','ATTESTED_PROFILE_ID'])
    expect((M as any)[n]).toBeUndefined()
})
it('keeps the non-contract subpaths the console uses, bigint-typed', async () => {
  const g = await import('@bsv/mandala/submitGuards')
  expect(g.guardPositiveAmount(1n as any).ok).toBe(true); expect(g.guardPositiveAmount(0n as any).ok).toBe(false)
  for (const p of ['history','metadata','adminState','adminHistory','overlayActivity','banking','singleFlight',
    'adminAuthGate','contacts','contactsStore','registry','reconcile','notifyJournal','feeRate','assetRecover','assets'])
    await expect(import(`@bsv/mandala/${p}`)).resolves.toBeDefined()
})
