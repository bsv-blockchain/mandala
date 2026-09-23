import { describe, it, expect, vi } from 'vitest'
import { Transaction, UnlockingScript, P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import {
  feeRateFromDetails, feeRateAssetId, withFeeRateFold, withFeeRate, recomputeFeeRate,
  type FeeRateRow, type FeeRateStore
} from './feeRates.js'

const ASSET = 'ab'.repeat(32) + '.0'

const buildTx = (): { beef: number[], txid: string } => {
  const key = PrivateKey.fromRandom()
  const src = new Transaction()
  src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  return { beef: tx.toBEEF(), txid: tx.id('hex') }
}
const payload = (details: Record<string, unknown>, index = 0): number[] =>
  Utils.toArray(JSON.stringify({ admin: [{ index, actionDetails: details }] }), 'utf8')

const fakeStore = (): FeeRateStore & { rows: Map<string, FeeRateRow>, history: Map<string, any[]> } => {
  const rows = new Map<string, FeeRateRow>()
  const history = new Map<string, any[]>()
  return {
    rows,
    history,
    get: async assetId => rows.get(assetId) ?? null,
    findBySetBy: async outpoint => [...rows.values()].find(r => r.setByOutpoint === outpoint) ?? null,
    upsert: async row => { rows.set(row.assetId, row) },
    historyFor: async assetId => history.get(assetId) ?? []
  }
}
const fakeInner = () => ({
  admissionMode: 'whole-tx',
  spendNotificationMode: 'script',
  outputAdmittedByTopic: vi.fn(async () => {}),
  outputEvicted: vi.fn(async () => {}),
  getMetaData: async () => ({ name: 'ls_mandala', shortDescription: 'x' })
}) as any

describe('feeRateFromDetails (TS ≡ Go feeRateOf)', () => {
  it('sets on a safe integer ≥ 1 for register and setFeeRate', () => {
    expect(feeRateFromDetails({ kind: 'register', feeRatePerKb: 7 })).toBe(7)
    expect(feeRateFromDetails({ kind: 'setFeeRate', feeRatePerKb: 12 })).toBe(12)
  })
  it('disables on null, absent, 0, negative, fraction, string, unsafe', () => {
    for (const v of [null, undefined, 0, -3, 1.5, '7', 2 ** 53 + 2]) {
      expect(feeRateFromDetails({ kind: 'setFeeRate', feeRatePerKb: v })).toBeNull()
    }
  })
  it('is undefined for every other kind', () => {
    expect(feeRateFromDetails({ kind: 'pause', feeRatePerKb: 7 })).toBeUndefined()
    expect(feeRateFromDetails({ kind: 'issue' })).toBeUndefined()
  })
})

describe('feeRateAssetId', () => {
  it('keys register by its own outpoint even when the payload names an asset', () => {
    expect(feeRateAssetId({ kind: 'register', assetId: ASSET }, 'cc'.repeat(32), 3)).toBe('cc'.repeat(32) + '.3')
  })
  it('keys setFeeRate by details.assetId, null when missing', () => {
    expect(feeRateAssetId({ kind: 'setFeeRate', assetId: ASSET }, 'cc'.repeat(32), 0)).toBe(ASSET)
    expect(feeRateAssetId({ kind: 'setFeeRate' }, 'cc'.repeat(32), 0)).toBeNull()
  })
})

describe('withFeeRateFold', () => {
  const admitted = (beef: number[], offChainValues: number[], outputIndex = 0) => ({
    topic: 'tm_mandala', mode: 'whole-tx', atomicBEEF: beef, outputIndex, offChainValues
  }) as any

  it('calls the inner service first, then folds a register under the genesis outpoint', async () => {
    const inner = fakeInner(); const store = fakeStore()
    const ls = withFeeRateFold(inner, store)
    const { beef, txid } = buildTx()
    await ls.outputAdmittedByTopic!(admitted(beef, payload({ kind: 'register', assetId: ASSET, feeRatePerKb: 7 })))
    expect(inner.outputAdmittedByTopic).toHaveBeenCalledTimes(1)
    expect(store.rows.get(`${txid}.0`)).toEqual({ assetId: `${txid}.0`, feeRatePerKb: 7, setByOutpoint: `${txid}.0` })
    expect(store.rows.has(ASSET)).toBe(false)
  })

  it('folds setFeeRate under details.assetId and null disables', async () => {
    const inner = fakeInner(); const store = fakeStore()
    const ls = withFeeRateFold(inner, store)
    const a = buildTx()
    await ls.outputAdmittedByTopic!(admitted(a.beef, payload({ kind: 'setFeeRate', assetId: ASSET, feeRatePerKb: 12 })))
    expect(store.rows.get(ASSET)?.feeRatePerKb).toBe(12)
    const b = buildTx()
    await ls.outputAdmittedByTopic!(admitted(b.beef, payload({ kind: 'setFeeRate', assetId: ASSET, feeRatePerKb: null })))
    expect(store.rows.get(ASSET)).toEqual({ assetId: ASSET, feeRatePerKb: null, setByOutpoint: `${b.txid}.0` })
  })

  it('ignores other topics, other kinds, and entries for other output indexes', async () => {
    const inner = fakeInner(); const store = fakeStore()
    const ls = withFeeRateFold(inner, store)
    const { beef } = buildTx()
    await ls.outputAdmittedByTopic!(admitted(beef, payload({ kind: 'pause', assetId: ASSET })))
    await ls.outputAdmittedByTopic!({ ...admitted(beef, payload({ kind: 'setFeeRate', assetId: ASSET, feeRatePerKb: 5 })), topic: 'tm_other' })
    await ls.outputAdmittedByTopic!(admitted(beef, payload({ kind: 'setFeeRate', assetId: ASSET, feeRatePerKb: 5 }, 1)))
    expect(store.rows.size).toBe(0)
    expect(inner.outputAdmittedByTopic).toHaveBeenCalledTimes(3)
  })

  it('recomputes from history when the setting outpoint is evicted', async () => {
    const inner = fakeInner(); const store = fakeStore()
    const ls = withFeeRateFold(inner, store)
    const t1 = 'aa'.repeat(32); const t2 = 'bb'.repeat(32)
    store.rows.set(ASSET, { assetId: ASSET, feeRatePerKb: 12, setByOutpoint: `${t2}.0` })
    store.history.set(ASSET, [
      { txid: t1, outputIndex: 0, actionDetails: { kind: 'setFeeRate', assetId: ASSET, feeRatePerKb: 7 } },
      { txid: t2, outputIndex: 0, actionDetails: { kind: 'setFeeRate', assetId: ASSET, feeRatePerKb: 12 } }
    ])
    await ls.outputEvicted!(t2, 0)
    expect(inner.outputEvicted).toHaveBeenCalledWith(t2, 0)
    expect(store.rows.get(ASSET)).toEqual({ assetId: ASSET, feeRatePerKb: 7, setByOutpoint: `${t1}.0` })
  })

  it('leaves rows alone when an unrelated outpoint is evicted, and preserves prototype methods', async () => {
    const inner = fakeInner(); const store = fakeStore()
    const ls = withFeeRateFold(inner, store)
    store.rows.set(ASSET, { assetId: ASSET, feeRatePerKb: 12, setByOutpoint: 'cc'.repeat(32) + '.0' })
    await ls.outputEvicted!('dd'.repeat(32), 0)
    expect(store.rows.get(ASSET)?.feeRatePerKb).toBe(12)
    expect((await ls.getMetaData()).name).toBe('ls_mandala')
  })
})

describe('recomputeFeeRate', () => {
  it('folds register then setFeeRate in order, skipping the excluded outpoint', () => {
    const t1 = 'aa'.repeat(32); const t2 = 'bb'.repeat(32)
    const history = [
      { txid: t1, outputIndex: 0, actionDetails: { kind: 'register', feeRatePerKb: 3 } },
      { txid: t2, outputIndex: 0, actionDetails: { kind: 'setFeeRate', assetId: `${t1}.0`, feeRatePerKb: 9 } }
    ]
    expect(recomputeFeeRate(history, `${t2}.0`)).toEqual({ feeRatePerKb: 3, setByOutpoint: `${t1}.0` })
    expect(recomputeFeeRate(history, `${t1}.0`)).toEqual({ feeRatePerKb: 9, setByOutpoint: `${t2}.0` })
    expect(recomputeFeeRate([], 'x.0')).toEqual({ feeRatePerKb: null, setByOutpoint: '' })
  })
})

describe('withFeeRate', () => {
  it('merges the rate as null when there is no row', () => {
    expect(withFeeRate({ assetId: ASSET, isPaused: false }, null)).toEqual({ assetId: ASSET, isPaused: false, feeRatePerKb: null })
    expect(withFeeRate({ assetId: ASSET }, { assetId: ASSET, feeRatePerKb: 4, setByOutpoint: 'x.0' }).feeRatePerKb).toBe(4)
  })
})
