import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertFeeRate, setFeeRate } from './feeRate.js'
import { submitAdminAction } from './assets.js'
import type { AdminAsset } from './assets.js'

vi.mock('./assets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./assets.js')>()),
  submitAdminAction: vi.fn()
}))

const ASSET_ID = 'a'.repeat(64) + '.0'
const PRIOR = 'b'.repeat(64) + '.1'
const asset: AdminAsset = {
  assetId: ASSET_ID,
  label: 'USD',
  authOutpoint: PRIOR,
  authDetails: { kind: 'issue', assetId: ASSET_ID } as any
}
const wallet = {} as any

describe('assertFeeRate', () => {
  it('accepts safe integers ≥ 1', () => {
    expect(() => assertFeeRate(1)).not.toThrow()
    expect(() => assertFeeRate(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })
  it('rejects everything else', () => {
    for (const v of [0, -1, 1.5, '7', null, undefined, NaN, 2 ** 53 + 2]) {
      expect(() => assertFeeRate(v)).toThrow('feeRatePerKb must be a safe integer ≥ 1')
    }
  })
})

describe('setFeeRate', () => {
  beforeEach(() => { vi.mocked(submitAdminAction).mockReset() })

  it('submits a setFeeRate admin action anchored on the asset prior', async () => {
    vi.mocked(submitAdminAction).mockResolvedValueOnce({ txid: 'c'.repeat(64), nextAuthOutpoint: 'c'.repeat(64) + '.0', notified: true })
    const res = await setFeeRate({ wallet, asset, identityKey: '02' + 'ab'.repeat(32), feeRatePerKb: 25 })
    expect(res.nextAuthOutpoint).toBe('c'.repeat(64) + '.0')
    expect(submitAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      wallet, asset, identityKey: '02' + 'ab'.repeat(32),
      details: { kind: 'setFeeRate', assetId: ASSET_ID, priorOutpoint: PRIOR, feeRatePerKb: 25 }
    }))
  })

  it('null disables issuer-paid fees', async () => {
    vi.mocked(submitAdminAction).mockResolvedValueOnce({ txid: 'c'.repeat(64), nextAuthOutpoint: 'c'.repeat(64) + '.0', notified: true })
    await setFeeRate({ wallet, asset, identityKey: '02' + 'ab'.repeat(32), feeRatePerKb: null })
    expect(vi.mocked(submitAdminAction).mock.calls[0][0].details).toEqual({
      kind: 'setFeeRate', assetId: ASSET_ID, priorOutpoint: PRIOR, feeRatePerKb: null
    })
  })

  it('refuses an invalid rate before touching the wallet', async () => {
    await expect(setFeeRate({ wallet, asset, identityKey: '02', feeRatePerKb: 0 })).rejects.toThrow('safe integer')
    expect(submitAdminAction).not.toHaveBeenCalled()
  })

  it('folds a non-blank reason into the submitted details', async () => {
    vi.mocked(submitAdminAction).mockResolvedValueOnce({ txid: 'c'.repeat(64), nextAuthOutpoint: 'c'.repeat(64) + '.0', notified: true })
    await setFeeRate({ wallet, asset, identityKey: '02' + 'ab'.repeat(32), feeRatePerKb: 25, reason: 'court order 12/A' })
    expect(vi.mocked(submitAdminAction).mock.calls[0][0].details).toEqual({
      kind: 'setFeeRate', assetId: ASSET_ID, priorOutpoint: PRIOR, feeRatePerKb: 25, reason: 'court order 12/A'
    })
  })

  it('omits reason when blank or absent', async () => {
    vi.mocked(submitAdminAction).mockResolvedValue({ txid: 'c'.repeat(64), nextAuthOutpoint: 'c'.repeat(64) + '.0', notified: true })
    await setFeeRate({ wallet, asset, identityKey: '02' + 'ab'.repeat(32), feeRatePerKb: 25, reason: '   ' })
    expect(vi.mocked(submitAdminAction).mock.calls[0][0].details).toEqual({
      kind: 'setFeeRate', assetId: ASSET_ID, priorOutpoint: PRIOR, feeRatePerKb: 25
    })
    await setFeeRate({ wallet, asset, identityKey: '02' + 'ab'.repeat(32), feeRatePerKb: 25 })
    expect(vi.mocked(submitAdminAction).mock.calls[1][0].details).toEqual({
      kind: 'setFeeRate', assetId: ASSET_ID, priorOutpoint: PRIOR, feeRatePerKb: 25
    })
  })

  it('returns nextAuthDetails equal to the submitted details', async () => {
    vi.mocked(submitAdminAction).mockResolvedValueOnce({ txid: 'c'.repeat(64), nextAuthOutpoint: 'c'.repeat(64) + '.0', notified: true })
    const res = await setFeeRate({ wallet, asset, identityKey: '02' + 'ab'.repeat(32), feeRatePerKb: 25, reason: 'note' })
    expect(res.nextAuthDetails).toEqual({
      kind: 'setFeeRate', assetId: ASSET_ID, priorOutpoint: PRIOR, feeRatePerKb: 25, reason: 'note'
    })
    expect(res.nextAuthDetails).toEqual(vi.mocked(submitAdminAction).mock.calls[0][0].details)
  })
})
