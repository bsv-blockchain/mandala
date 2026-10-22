/**
 * Issuer and admin flows on 1Color (plan 04 Task 9): register writes the
 * Mandala `req` naming the overlay key and fails closed without it (S5),
 * issue/redeem carry exact uint64 bigint amounts into the `mandala treasury`
 * basket under ADMIN_PROTOCOL, every lib-built description fits BRC-100's
 * 5..50 UTF-8 bytes, and a malformed reissue is refused before the payout
 * path builds it. Wallet and overlay submit are stubbed; the 1Color locks run
 * for real. Merges the former issuerOps.redeem.test.ts pre-flight cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PrivateKey, Hash, Transaction, P2PKH, UnlockingScript, Utils } from '@bsv/sdk'
import { registerAsset, issueTokens, redeemTokens, registerDetails } from './issuerOps.js'
import { actionDescription, submitAdminAction, type AdminAsset } from './assets.js'
import { clearAdminAuthGates, StaleAdminAuthError } from './adminAuthGate.js'
import { hasFreshIntent, journalClear } from './txJournal.js'
import { notifyClear, notifyList } from './notifyJournal.js'
import { submitAndBroadcast } from './overlay.js'
import { configureMandala, ADMIN_PROTOCOL } from './constants.js'
import { decodeToken, readDeploy } from './brc162.js'
import { colorTopic } from './naming.js'
import { MAX_UINT64 } from './amount.js'
import { MandalaToken } from './__fixtures__/token.js'

vi.mock('./metadata.js', () => ({ resolveAssetMetadata: vi.fn().mockResolvedValue(null) }))
vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitAndBroadcast: vi.fn()
}))

const STUB_KEY = PrivateKey.fromHex('11'.repeat(32))
const OVERLAY_KEY = PrivateKey.fromHex('55'.repeat(32)).toPublicKey().toString()
const ISSUER = STUB_KEY.toPublicKey().toString()
const TXID = 'd'.repeat(64)
const COMMIT_TXID = 'c'.repeat(64)
const ASSET_ID = 'a'.repeat(64) + '_0'
const PRIOR = 'b'.repeat(64) + '.1'
const utf8Len = (s: string): number => Utils.toArray(s, 'utf8').length

/** A signable BEEF with `n` inputs, as createAction hands back for signing. */
function signableBeef (n = 1): number[] {
  const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
  const src = new Transaction()
  for (let i = 0; i < n; i++) src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  for (let i = 0; i < n; i++) {
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: i, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(pkh) })
  return tx.toBEEF(true)
}

const revealStub = () => vi.fn(async (a: { counterparty: string, verifier: string, protocolID: [2, string], keyID: string }) => ({
  prover: ISSUER,
  verifier: a.verifier,
  counterparty: a.counterparty,
  protocolID: a.protocolID,
  keyID: a.keyID,
  encryptedLinkage: [1],
  encryptedLinkageProof: [2],
  proofType: 0
}))

const keyStubs = () => ({
  getPublicKey: vi.fn().mockResolvedValue({ publicKey: ISSUER }),
  createSignature: vi.fn().mockResolvedValue({ signature: STUB_KEY.sign([1, 2, 3]).toDER() as number[] })
})

const mkRegWallet = () => ({
  createAction: vi.fn().mockResolvedValue({ tx: [1, 2, 3], txid: TXID }),
  listActions: vi.fn().mockResolvedValue({ actions: [] }),
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  revealSpecificKeyLinkage: revealStub(),
  ...keyStubs()
})

const mkAdminWallet = (inputs = 1, outputs: any[] = [{ outpoint: PRIOR }]) => ({
  listOutputs: vi.fn().mockResolvedValue({ outputs, BEEF: [1] }),
  createAction: vi.fn().mockResolvedValue({ signableTransaction: { tx: signableBeef(inputs), reference: 'ref-1' } }),
  signAction: vi.fn().mockResolvedValue({ tx: [9, 9, 9], txid: COMMIT_TXID }),
  revealSpecificKeyLinkage: revealStub(),
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  listActions: vi.fn().mockResolvedValue({ actions: [] }),
  ...keyStubs()
})

const asset: AdminAsset = { assetId: ASSET_ID, label: 'USD', authOutpoint: PRIOR, authKeyID: 'deploy' }

beforeEach(async () => {
  clearAdminAuthGates()
  await journalClear()
  await notifyClear()
  vi.mocked(submitAndBroadcast).mockReset().mockResolvedValue({ outputsToAdmit: [0, 1] } as any)
  configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: OVERLAY_KEY })
})
afterEach(() => {
  configureMandala({ overlayIdentityKey: '' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('actionDescription (BRC-100 5..50 UTF-8 bytes)', () => {
  it('keeps a description that already fits', () => {
    expect(actionDescription('Register Test Dollar')).toBe('Register Test Dollar')
  })
  it('trims, and pads a short description to 5 bytes', () => {
    expect(actionDescription('  Issue 5 X  ')).toBe('Issue 5 X')
    expect(utf8Len(actionDescription('ab'))).toBeGreaterThanOrEqual(5)
    expect(utf8Len(actionDescription(''))).toBeGreaterThanOrEqual(5)
  })
  it('truncates to 50 bytes with a trailing ellipsis inside the limit', () => {
    const d = actionDescription(`Issue ${MAX_UINT64} ${'L'.repeat(64)}`)
    expect(utf8Len(d)).toBeLessThanOrEqual(50)
    expect(d.endsWith('…')).toBe(true)
    expect(d.startsWith(`Issue ${MAX_UINT64} L`)).toBe(true)
  })
  it('measures UTF-8 bytes, never splitting a code point', () => {
    const d = actionDescription(`Issue ${MAX_UINT64} ${'€'.repeat(64)}`)
    expect(utf8Len(d)).toBeLessThanOrEqual(50)
    expect(d).not.toMatch(/�/)
    const emoji = actionDescription(`Register ${'😀'.repeat(64)}`)
    expect(utf8Len(emoji)).toBeLessThanOrEqual(50)
    expect(Utils.toUTF8(Utils.toArray(emoji, 'utf8'))).toBe(emoji)
  })
  it('keeps the fixed Redeem <amount> prefix intact at the uint64 boundary', () => {
    expect(actionDescription(`Redeem ${MAX_UINT64} ${'L'.repeat(64)}`)).toMatch(/^Redeem 18446744073709551615 /)
  })
})

describe('registerAsset on 1Color', () => {
  const params = (wallet: ReturnType<typeof mkRegWallet>) =>
    ({ wallet: wallet as any, identityKey: ISSUER, label: 'Test Dollar', ticker: 'tusd', decimals: 2 })

  it('fails closed before any wallet call while the overlay identity key is unset (S5)', async () => {
    configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: '' })
    const wallet = mkRegWallet()
    await expect(registerAsset(params(wallet))).rejects.toThrow(/overlay identity key/)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(submitAndBroadcast).not.toHaveBeenCalled()
    expect(await hasFreshIntent()).toBe(false)
    expect(() => registerDetails({ label: 'X', ticker: 'X', decimals: 0, identityKey: ISSUER })).toThrow(/overlay identity key/)
  })

  it('writes req = mandalaReq(K) for the overlay key, into the treasury, on [tm_mandala, tm_color_<txid>_0]', async () => {
    const wallet = mkRegWallet()
    await expect(registerAsset(params(wallet))).resolves.toMatchObject({ assetId: `${TXID}_0` })
    const args = wallet.createAction.mock.calls[0][0]
    const out = args.outputs[0]
    const deploy = readDeploy(out.lockingScript, TXID)
    expect(deploy?.mandalaKey).toBe(OVERLAY_KEY)
    expect(deploy).toMatchObject({ sym: 'TUSD', dec: 2, label: 'Test Dollar' })
    expect(out.basket).toBe('mandala treasury')
    expect(utf8Len(args.description)).toBeLessThanOrEqual(50)
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][5]).toEqual(['tm_mandala', `tm_color_${TXID}_0`])
  })

  it('omits feeRatePerKb by default (B6) and carries an icon only on chain', () => {
    configureMandala({ overlayIdentityKey: OVERLAY_KEY })
    const plain = registerDetails({ label: 'Test Dollar', ticker: 'tusd', decimals: 2, identityKey: ISSUER })
    expect(plain.payload).toEqual(registerDetails({ label: 'Test Dollar', ticker: 'TUSD', decimals: 2, identityKey: ISSUER }).payload)
    expect('feeRatePerKb' in plain.metadata).toBe(false)
    const icon = { mediaType: 'image/png', bytes: [1, 2, 3] }
    const withIcon = registerDetails({ label: 'Test Dollar', ticker: 'tusd', decimals: 2, identityKey: ISSUER, icon })
    expect(withIcon.payload.length).toBeGreaterThan(plain.payload.length)
    expect(JSON.stringify(withIcon.metadata)).not.toContain('image/png')
  })

  it('a 64-character label still yields a valid createAction description', async () => {
    const wallet = mkRegWallet()
    await registerAsset({ ...params(wallet), label: 'L'.repeat(64) })
    expect(utf8Len(wallet.createAction.mock.calls[0][0].description)).toBeLessThanOrEqual(50)
  })
})

describe('issueTokens on 1Color', () => {
  it('mints MAX_UINT64 exactly into the treasury under ADMIN_PROTOCOL', async () => {
    const wallet = mkAdminWallet()
    const res = await issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: MAX_UINT64 })
    expect(res.txid).toBe(COMMIT_TXID)
    expect(res.nextAuthOutpoint).toBe(`${COMMIT_TXID}.1`)
    const args = wallet.createAction.mock.calls[0][0]
    const value = args.outputs[0]
    const d = decodeToken(value.lockingScript)
    expect(d).toMatchObject({ role: 'value', assetId: ASSET_ID, amount: MAX_UINT64 })
    expect(value.satoshis).toBe(1)
    expect(value.basket).toBe('mandala treasury')
    const ci = JSON.parse(value.customInstructions)
    expect(ci).toEqual({ protocolID: [2, 'mandala admin'], keyID: ci.keyID, counterparty: ISSUER })
    expect(ci.protocolID).toEqual(ADMIN_PROTOCOL)
    expect(decodeToken(args.outputs[1].lockingScript)?.role).toBe('authority')
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][5]).toEqual([colorTopic(ASSET_ID)])
  })

  it('a 20-digit amount and a 64-character label do not overflow the description', async () => {
    const wallet = mkAdminWallet()
    await issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset: { ...asset, label: 'L'.repeat(64) }, amount: MAX_UINT64 })
    const description = wallet.createAction.mock.calls.at(-1)![0].description as string
    expect(description.length).toBeLessThanOrEqual(50)
    expect(utf8Len(description)).toBeLessThanOrEqual(50)
    expect(description).toMatch(/^Issue 18446744073709551615 /)
  })

  it('refuses a zero, negative, out-of-range or non-bigint amount before any wallet call', async () => {
    const wallet = mkAdminWallet()
    await expect(issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 0n })).rejects.toThrow(/greater than zero/)
    await expect(issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: -1n })).rejects.toThrow(/greater than zero/)
    await expect(issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: MAX_UINT64 + 1n })).rejects.toThrow(/uint64/)
    await expect(issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 5 as unknown as bigint })).rejects.toThrow(/whole number/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('refuses a raw (non-digest) deposit reference before any wallet call', async () => {
    const wallet = mkAdminWallet()
    await expect(issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 5n, depositHash: 'ACME-INV-42' })).rejects.toThrow(/sha256/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('fails closed before createAction while the overlay identity key is unset (S5)', async () => {
    configureMandala({ overlayIdentityKey: '' })
    const wallet = mkAdminWallet()
    await expect(issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 5n })).rejects.toThrow(/overlay identity key/)
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})

describe('redeemTokens on 1Color', () => {
  // A treasury value coin of the asset (as the wallet lists it) for coin selection.
  const fundTx = (amounts: bigint[]): Transaction => {
    const pkh = new PrivateKey(11).toPublicKey().toHash() as number[]
    const src = new Transaction()
    src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
    for (const a of amounts) tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET_ID, a, pkh) })
    return tx
  }

  it('burns the target and keeps change = gathered − amount exactly (bigint) in the treasury', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    const fund = fundTx([MAX_UINT64])
    const coin = `${fund.id('hex')}.0`
    const listed = [
      { outpoint: PRIOR },
      {
        outpoint: coin,
        lockingScript: fund.outputs[0].lockingScript.toHex(),
        customInstructions: JSON.stringify({ protocolID: ADMIN_PROTOCOL, keyID: 'mint-1', counterparty: ISSUER })
      }
    ]
    const wallet = mkAdminWallet(2, listed)
    wallet.listOutputs.mockImplementation(async (a: { include?: string }) =>
      a.include === 'entire transactions' ? { outputs: listed, BEEF: fund.toBEEF() } : { outputs: listed })
    const amount = 7n
    const res = await redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount })
    expect(res.txid).toBe(COMMIT_TXID)
    const args = wallet.createAction.mock.calls[0][0]
    expect(args.inputs.map((i: { outpoint: string }) => i.outpoint)).toEqual([PRIOR, coin])
    const change = decodeToken(args.outputs[0].lockingScript)
    expect(change).toMatchObject({ role: 'value', assetId: ASSET_ID, amount: MAX_UINT64 - amount })
    expect(args.outputs[0].basket).toBe('mandala treasury')
    expect(JSON.parse(args.outputs[0].customInstructions).protocolID).toEqual([2, 'mandala admin'])
    expect(decodeToken(args.outputs[1].lockingScript)?.role).toBe('authority')
    expect(args.description).toMatch(/^Redeem 7 /)
  })

  it('an exact redeem emits no change output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    const fund = fundTx([9n])
    const listed = [
      { outpoint: PRIOR },
      { outpoint: `${fund.id('hex')}.0`, lockingScript: fund.outputs[0].lockingScript.toHex(), customInstructions: JSON.stringify({ keyID: 'm', counterparty: ISSUER }) }
    ]
    const wallet = mkAdminWallet(2, listed)
    wallet.listOutputs.mockImplementation(async (a: { include?: string }) =>
      a.include === 'entire transactions' ? { outputs: listed, BEEF: fund.toBEEF() } : { outputs: listed })
    const res = await redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 9n })
    const args = wallet.createAction.mock.calls[0][0]
    expect(args.outputs).toHaveLength(1)
    expect(decodeToken(args.outputs[0].lockingScript)?.role).toBe('authority')
    expect(res.nextAuthOutpoint).toBe(`${COMMIT_TXID}.0`)
  })

  // Ported from issuerOps.redeem.test.ts: stale prior and amount-above-balance
  // refuse before loadTreasuryCandidates / createAction.
  const bareAsset: AdminAsset = { assetId: 'asset.0', label: 'USD', authOutpoint: 'auth-prior.0', authKeyID: 'deploy', metadata: { decimals: 0, label: 'USD', ticker: 'USD' } }

  it('rejects amount above known balance without any wallet I/O', async () => {
    const wallet = { listOutputs: vi.fn(), listActions: vi.fn(), createAction: vi.fn(), signAction: vi.fn(), abortAction: vi.fn() }
    await expect(redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset: bareAsset, amount: 50n, balance: 40n }))
      .rejects.toThrow(/exceeds available balance/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('a balance above 2^64 is compared exactly', async () => {
    const wallet = { listOutputs: vi.fn(), listActions: vi.fn(), createAction: vi.fn() }
    await expect(redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset: bareAsset, amount: MAX_UINT64, balance: MAX_UINT64 - 1n }))
      .rejects.toThrow(/exceeds available balance/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('rejects a non-positive or non-bigint amount without wallet I/O', async () => {
    const wallet = { listOutputs: vi.fn(), listActions: vi.fn(), createAction: vi.fn() }
    await expect(redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset: bareAsset, amount: 0n })).rejects.toThrow(/greater than zero/)
    await expect(redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset: bareAsset, amount: 1.5 as unknown as bigint })).rejects.toThrow(/whole number/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('asserts spendable prior before treasury coin selection when auth is stale', async () => {
    const listOutputs = vi.fn().mockResolvedValue({ outputs: [{ outpoint: 'other.0' }], BEEF: [1, 2, 3] })
    const listActions = vi.fn().mockResolvedValue({ actions: [] })
    const wallet = { listOutputs, listActions, createAction: vi.fn(), signAction: vi.fn() }
    await expect(redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset: bareAsset, amount: 10n }))
      .rejects.toBeInstanceOf(StaleAdminAuthError)
    expect(listOutputs).toHaveBeenCalled()
    expect(listActions).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('lists the treasury before coin selection when the prior is still spendable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const listOutputs = vi.fn().mockImplementation(async (args: { include?: string }) =>
      args?.include === 'entire transactions' ? { outputs: [], BEEF: [] } : { outputs: [{ outpoint: bareAsset.authOutpoint }], BEEF: undefined })
    const listActions = vi.fn().mockResolvedValue({ actions: [] })
    const wallet = { listOutputs, listActions, createAction: vi.fn(), signAction: vi.fn() }
    await expect(redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset: bareAsset, amount: 10n }))
      .rejects.toThrow(/insufficient/)
    expect(listOutputs.mock.calls[0][0]).not.toEqual(expect.objectContaining({ include: 'entire transactions' }))
    expect(listActions).toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})

describe('submitAdminAction on 1Color', () => {
  it('a pause spends the live authority on exactly tm_color_<assetId> and journals no notification', async () => {
    const wallet = mkAdminWallet()
    const mbc = { sendMessage: vi.fn() }
    const res = await submitAdminAction({ wallet: wallet as any, asset, details: { kind: 'pause' }, messageBoxClient: mbc, identityKey: ISSUER })
    expect(res.notified).toBe(true)
    expect(res.nextAuthOutpoint).toBe(`${COMMIT_TXID}.0`)
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][5]).toEqual([colorTopic(ASSET_ID)])
    const args = wallet.createAction.mock.calls[0][0]
    expect(args.outputs[0].basket).toBe('mandala treasury')
    expect(utf8Len(args.description)).toBeLessThanOrEqual(50)
    expect(mbc.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toEqual([])
  })

  it('a reissue without a MessageBox client or without an ftOutput is refused before any wallet call (payout.test.ts covers the reissue itself)', async () => {
    const wallet = mkAdminWallet()
    const recipient = '03' + 'cd'.repeat(32)
    await expect(submitAdminAction({
      wallet: wallet as any,
      asset,
      details: { kind: 'reissue', outpoint: 'f'.repeat(64) + '.0', recipient },
      ftOutput: { recipient, amount: 5n },
      identityKey: ISSUER
    })).rejects.toThrow(/messageBoxClient/)
    // A reissue with no recipient output at all is refused too.
    await expect(submitAdminAction({
      wallet: wallet as any,
      asset,
      details: { kind: 'reissue', outpoint: 'f'.repeat(64) + '.0', recipient },
      identityKey: ISSUER
    })).rejects.toThrow(/needs ftOutput/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(await notifyList()).toEqual([])
  })

  it('a 64-character label keeps the admin description within 50 bytes', async () => {
    const wallet = mkAdminWallet()
    await submitAdminAction({ wallet: wallet as any, asset: { ...asset, label: 'L'.repeat(64) }, details: { kind: 'unfreezeOutput', outpoint: 'e'.repeat(64) + '.3' }, identityKey: ISSUER })
    expect(utf8Len(wallet.createAction.mock.calls[0][0].description)).toBeLessThanOrEqual(50)
  })
})
