/**
 * Shape of the admin-auth output written by issue / redeem:
 *   - A09: every next-auth output carries the on-chain marker
 *     publicData = { t: 'mandala-admin', assetId } so wallets stop
 *     reclassifying it as vanilla P2PKH (and stripping customInstructions).
 *   - A14: `issue` commits a hash of the deposit record as `bankRef`;
 *     ref-less issues keep the pre-A14 commitment byte-for-byte.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hash, PrivateKey, Transaction, P2PKH, LockingScript, UnlockingScript } from '@bsv/sdk'
import { MandalaAdmin, MandalaToken } from '@bsv/templates'
import type { MandalaActionDetails } from '@bsv/templates'
import { issueTokens, redeemTokens } from './issuerOps.js'
import type { AdminAsset } from './assets.js'
import { submitAndBroadcast } from './overlay.js'
import { loadFtCandidates } from './ftCandidates.js'
import { clearAdminAuthGates } from './adminAuthGate.js'
import { journalClear } from './txJournal.js'

vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitAndBroadcast: vi.fn()
}))
vi.mock('./ftCandidates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ftCandidates.js')>()),
  loadFtCandidates: vi.fn()
}))
vi.mock('./unlock.js', () => ({
  walletMandalaUnlock: () => ({ sign: async () => new UnlockingScript([]), estimateLength: async () => 108 })
}))

const ISSUER = '02' + 'ab'.repeat(32)
const ASSET_ID = 'a'.repeat(64) + '.0'
const PRIOR = 'b'.repeat(64) + '.1'
const TXID = 'c'.repeat(64)
const DEPOSIT_HASH = 'f'.repeat(64)

const asset: AdminAsset = {
  assetId: ASSET_ID,
  label: 'USD',
  authOutpoint: PRIOR,
  authDetails: { kind: 'register', label: 'USD' },
  metadata: { decimals: 2 }
}

const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])

function srcTx (n: number): Transaction {
  const src = new Transaction()
  for (let i = 0; i < n; i++) src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
  return src
}

function signableBeef (n: number): number[] {
  const src = srcTx(n)
  const tx = new Transaction()
  for (let i = 0; i < n; i++) {
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: i, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(pkh) })
  return tx.toBEEF(true)
}

const mkWallet = (inputs: number) => ({
  listOutputs: vi.fn().mockResolvedValue({ outputs: [{ outpoint: PRIOR }], BEEF: [1] }),
  createAction: vi.fn().mockResolvedValue({ signableTransaction: { tx: signableBeef(inputs), reference: 'ref-1' } }),
  signAction: vi.fn().mockResolvedValue({ tx: [9, 9, 9], txid: TXID }),
  revealSpecificKeyLinkage: vi.fn().mockResolvedValue({ keyID: 'k' }),
  abortAction: vi.fn().mockResolvedValue({ aborted: true })
})

const lockedData = (): MandalaActionDetails[] =>
  vi.mocked(MandalaAdmin.lock).mock.calls.map(c => c[0].data)

beforeEach(async () => {
  clearAdminAuthGates()
  await journalClear()
  vi.spyOn(MandalaAdmin, 'lock').mockResolvedValue(new LockingScript([]))
  vi.spyOn(MandalaAdmin, 'unlock').mockReturnValue({ sign: async () => new UnlockingScript([]), estimateLength: async () => 108 })
  vi.spyOn(MandalaToken.prototype, 'lockBRC29').mockResolvedValue(new LockingScript([]))
  vi.mocked(submitAndBroadcast).mockReset().mockResolvedValue({ outputsToAdmit: [0, 1] })
})
afterEach(() => vi.restoreAllMocks())

describe('issueTokens deposit-record commitment (A14)', () => {
  it('commits the deposit hash as bankRef in the auth details, the CI, and the linkage payload', async () => {
    const wallet = mkWallet(1)
    const res = await issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 100, depositHash: DEPOSIT_HASH })

    const expected: MandalaActionDetails = { kind: 'issue', assetId: ASSET_ID, amount: 100, priorOutpoint: PRIOR, bankRef: DEPOSIT_HASH }
    expect(lockedData()).toEqual([expected])
    expect(res.nextAuthDetails).toEqual(expected)
    // The next-auth output's customInstructions carry the same details (they
    // are what the next action unlocks with).
    const outputs = wallet.createAction.mock.calls[0][0].outputs
    expect(JSON.parse(outputs[1].customInstructions).authDetails).toEqual(expected)
  })

  it('a ref-less issue omits bankRef — commitment byte-identical to the pre-A14 four-field shape', async () => {
    const preA14: MandalaActionDetails = { kind: 'issue', assetId: ASSET_ID, amount: 100, priorOutpoint: PRIOR }
    for (const depositHash of [undefined, '', '   ']) {
      vi.mocked(MandalaAdmin.lock).mockClear()
      clearAdminAuthGates()
      const wallet = mkWallet(1)
      await issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 100, depositHash })
      const [data] = lockedData()
      expect(Object.keys(data).sort()).toEqual(['amount', 'assetId', 'kind', 'priorOutpoint'])
      expect(MandalaAdmin.commitment(data)).toBe(MandalaAdmin.commitment(preA14))
    }
  })
})

describe('issue / redeem next-auth outputs carry the on-chain marker (A09)', () => {
  it('issueTokens passes publicData {t: mandala-admin, assetId}', async () => {
    const wallet = mkWallet(1)
    await issueTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 1 })
    expect(MandalaAdmin.lock).toHaveBeenCalledTimes(1)
    expect(MandalaAdmin.lock).toHaveBeenCalledWith(expect.objectContaining({
      publicData: { t: 'mandala-admin', assetId: ASSET_ID }
    }))
  })

  it('redeemTokens passes publicData {t: mandala-admin, assetId}', async () => {
    vi.mocked(loadFtCandidates).mockResolvedValue({
      candidates: [{ outpoint: 'ft.0', amount: 10, keyID: 'k', counterparty: ISSUER, confirmed: true, order: 0 }],
      beef: srcTx(1).toBEEF(true)
    })
    const wallet = mkWallet(2) // FT input + prior auth
    const res = await redeemTokens({ wallet: wallet as any, identityKey: ISSUER, asset, amount: 10 })
    expect(res.txid).toBe(TXID)
    expect(MandalaAdmin.lock).toHaveBeenCalledTimes(1)
    expect(MandalaAdmin.lock).toHaveBeenCalledWith(expect.objectContaining({
      data: { kind: 'redeem', assetId: ASSET_ID, amount: 10, priorOutpoint: PRIOR },
      publicData: { t: 'mandala-admin', assetId: ASSET_ID }
    }))
  })
})
