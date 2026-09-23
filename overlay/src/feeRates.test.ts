import { describe, it, expect, vi } from 'vitest'
import { Transaction, UnlockingScript, P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import {
  feeRateFromDetails, feeRateAssetId, withFeeRateFold, withFeeRate, recomputeFeeRate, rebuildFeeRate, rebuildFeeRateFromHistory,
  type FeeRateRow, type FeeRateStore, type FeeRateHistoryEntry
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
// Output 0 is a MandalaToken (FT) script, not an admin P2PKH — used to prove
// an admin entry attached to a non-admin output does not fold.
const buildTokenTx = (): { beef: number[], txid: string } => {
  const key = PrivateKey.fromRandom()
  const src = new Transaction()
  src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET, 100, key.toPublicKey().toHash() as number[]) })
  return { beef: tx.toBEEF(), txid: tx.id('hex') }
}
const payload = (details: Record<string, unknown>, index = 0): number[] =>
  Utils.toArray(JSON.stringify({ admin: [{ index, actionDetails: details }] }), 'utf8')

const fakeStore = (history: FeeRateHistoryEntry[] = []): FeeRateStore & { rows: Map<string, FeeRateRow> } => {
  const rows = new Map<string, FeeRateRow>()
  return {
    rows,
    get: async assetId => rows.get(assetId) ?? null,
    upsert: async row => { rows.set(row.assetId, row) },
    historyFor: async () => history
  }
}
const fakeInner = () => ({
  admissionMode: 'whole-tx',
  spendNotificationMode: 'script',
  outputAdmittedByTopic: vi.fn(async () => {}),
  outputEvicted: vi.fn(async () => {}),
  getMetaData: async () => ({ name: 'ls_mandala', shortDescription: 'x' })
}) as any

// A REAL class instance: outputAdmittedByTopic/outputEvicted/getMetaData live
// on the prototype, not as own instance properties, so `{...inner}` does not
// copy them — only the Proxy fallback in withFeeRateFold makes them resolve.
// If that Proxy were removed, ls.outputEvicted/ls.getMetaData would be
// undefined and this test would fail.
class RealInner {
  deps = { name: 'ls_mandala' }
  admissionMode = 'whole-tx'
  spendNotificationMode = 'script'
  evictedCalls: Array<[string, number]> = []
  async outputAdmittedByTopic (): Promise<void> {}
  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    this.evictedCalls.push([txid, outputIndex])
  }
  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return { name: this.deps.name, shortDescription: 'x' }
  }
}

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
  it('disables on register without a rate (parity: Go "register without rate leaves nil")', () => {
    expect(feeRateFromDetails({ kind: 'register' })).toBeNull()
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

  it('leaves an existing rate untouched on pause (parity: Go "pause leaves rate alone")', async () => {
    const inner = fakeInner(); const store = fakeStore()
    await store.upsert({ assetId: ASSET, feeRatePerKb: 7, setByOutpoint: `${'ee'.repeat(32)}.0` })
    const ls = withFeeRateFold(inner, store)
    const { beef } = buildTx()
    await ls.outputAdmittedByTopic!(admitted(beef, payload({ kind: 'pause', assetId: ASSET })))
    expect(store.rows.get(ASSET)?.feeRatePerKb).toBe(7)
  })

  it('does not fold an admin entry attached to a non-admin (FT) output', async () => {
    const inner = fakeInner(); const store = fakeStore()
    const ls = withFeeRateFold(inner, store)
    const { beef } = buildTokenTx()
    await ls.outputAdmittedByTopic!(admitted(beef, payload({ kind: 'register', assetId: ASSET, feeRatePerKb: 7 })))
    expect(inner.outputAdmittedByTopic).toHaveBeenCalledTimes(1)
    expect(store.rows.size).toBe(0)
  })

  it('resolves outputEvicted to the inner service through the Proxy, and preserves prototype-bound methods', async () => {
    const inner = new RealInner()
    const ls = withFeeRateFold(inner as any, fakeStore())
    await ls.outputEvicted!('dd'.repeat(32), 0)
    expect(inner.evictedCalls).toEqual([['dd'.repeat(32), 0]])
    expect((await ls.getMetaData()).name).toBe('ls_mandala')
  })
})

describe('withFeeRate', () => {
  it('merges the rate as null when there is no row', () => {
    expect(withFeeRate({ assetId: ASSET, isPaused: false }, null)).toEqual({ assetId: ASSET, isPaused: false, feeRatePerKb: null })
    expect(withFeeRate({ assetId: ASSET }, { assetId: ASSET, feeRatePerKb: 4, setByOutpoint: 'x.0' }).feeRatePerKb).toBe(4)
  })

  it('falls back to the state\'s own feeRatePerKb when there is no repo-local row (a future pinned reducer that already carries the field)', () => {
    expect(withFeeRate({ assetId: ASSET, feeRatePerKb: 4 }, null).feeRatePerKb).toBe(4)
  })

  it('is null when neither the state nor a row carries the field', () => {
    expect(withFeeRate({ assetId: ASSET }, null).feeRatePerKb).toBeNull()
  })

  it('the row wins over the state when both are present', () => {
    expect(withFeeRate({ assetId: ASSET, feeRatePerKb: 4 }, { assetId: ASSET, feeRatePerKb: 9, setByOutpoint: 'x.0' }).feeRatePerKb).toBe(9)
  })
})

// PR #11 (2026-09-22): eviction purges the evicted txid's mandalaAdminHistory
// rows and refolds each touched asset. Go's RebuildState folds feeRatePerKb
// through FoldAction; the pinned TS reducer ignores it, so the TS eviction step
// replays the surviving history into mandalaFeeRates with the same rule.
const G = 'aa'.repeat(32)
const S = 'bb'.repeat(32)
const P = 'cc'.repeat(32)
const entry = (txid: string, outputIndex: number, actionDetails: Record<string, unknown>): FeeRateHistoryEntry =>
  ({ txid, outputIndex, actionDetails })

describe('recomputeFeeRate (TS ≡ Go RebuildState fold of feeRatePerKb)', () => {
  it('the last fee-bearing entry wins: register(7) then setFeeRate(12) → 12, set by the setFeeRate outpoint', () => {
    expect(recomputeFeeRate([
      entry(G, 0, { kind: 'register', feeRatePerKb: 7 }),
      entry(S, 1, { kind: 'setFeeRate', assetId: `${G}.0`, feeRatePerKb: 12 })
    ])).toEqual({ feeRatePerKb: 12, setByOutpoint: `${S}.1` })
  })

  it('register(7) alone → 7, set by the genesis outpoint', () => {
    expect(recomputeFeeRate([entry(G, 0, { kind: 'register', feeRatePerKb: 7 })]))
      .toEqual({ feeRatePerKb: 7, setByOutpoint: `${G}.0` })
  })

  it('register(7) then setFeeRate(null) → null, set by the setFeeRate outpoint', () => {
    expect(recomputeFeeRate([
      entry(G, 0, { kind: 'register', feeRatePerKb: 7 }),
      entry(S, 0, { kind: 'setFeeRate', assetId: `${G}.0`, feeRatePerKb: null })
    ])).toEqual({ feeRatePerKb: null, setByOutpoint: `${S}.0` })
  })

  it('no history → null with no setter', () => {
    expect(recomputeFeeRate([])).toEqual({ feeRatePerKb: null, setByOutpoint: '' })
  })

  it('skips non-fee-bearing entries (a pause between them changes nothing)', () => {
    expect(recomputeFeeRate([
      entry(G, 0, { kind: 'register', feeRatePerKb: 7 }),
      entry(P, 0, { kind: 'pause', assetId: `${G}.0`, feeRatePerKb: 99 })
    ])).toEqual({ feeRatePerKb: 7, setByOutpoint: `${G}.0` })
    expect(recomputeFeeRate([
      entry(G, 0, { kind: 'register', feeRatePerKb: 7 }),
      entry(P, 0, { kind: 'pause', assetId: `${G}.0` }),
      entry(S, 2, { kind: 'setFeeRate', assetId: `${G}.0`, feeRatePerKb: 12 })
    ])).toEqual({ feeRatePerKb: 12, setByOutpoint: `${S}.2` })
  })

  it('history with only non-fee-bearing entries → null with no setter', () => {
    expect(recomputeFeeRate([entry(P, 0, { kind: 'pause', assetId: `${G}.0` })]))
      .toEqual({ feeRatePerKb: null, setByOutpoint: '' })
  })
})

describe('rebuildFeeRate', () => {
  it('upserts the row recomputed from the asset\'s surviving history', async () => {
    const store = fakeStore([
      entry(G, 0, { kind: 'register', feeRatePerKb: 7 }),
      entry(S, 1, { kind: 'setFeeRate', assetId: `${G}.0`, feeRatePerKb: 12 })
    ])
    const historyFor = vi.spyOn(store, 'historyFor')
    const upsert = vi.spyOn(store, 'upsert')
    await rebuildFeeRate(store, `${G}.0`)
    expect(historyFor).toHaveBeenCalledWith(`${G}.0`)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith({ assetId: `${G}.0`, feeRatePerKb: 12, setByOutpoint: `${S}.1` })
  })

  it('rolls an evicted rate back: with no surviving rows the row is cleared, not left stale', async () => {
    const store = fakeStore([])
    await store.upsert({ assetId: `${G}.0`, feeRatePerKb: 12, setByOutpoint: `${S}.1` })
    const upsert = vi.spyOn(store, 'upsert')
    await rebuildFeeRate(store, `${G}.0`)
    expect(upsert).toHaveBeenCalledWith({ assetId: `${G}.0`, feeRatePerKb: null, setByOutpoint: '' })
    expect(store.rows.get(`${G}.0`)).toEqual({ assetId: `${G}.0`, feeRatePerKb: null, setByOutpoint: '' })
  })
})

describe('rebuildFeeRateFromHistory (eviction, rebuild-first)', () => {
  it('upserts from the given (txid-excluded) rows and never reads the store history', async () => {
    const store = fakeStore([entry(S, 1, { kind: 'setFeeRate', assetId: `${G}.0`, feeRatePerKb: 12 })])
    const historyFor = vi.spyOn(store, 'historyFor')
    await rebuildFeeRateFromHistory(store, `${G}.0`, [entry(G, 0, { kind: 'register', feeRatePerKb: 7 })])
    expect(historyFor).not.toHaveBeenCalled()
    expect(store.rows.get(`${G}.0`)).toEqual({ assetId: `${G}.0`, feeRatePerKb: 7, setByOutpoint: `${G}.0` })
  })

  it('an excluded setFeeRate does not survive: empty surviving history clears the row', async () => {
    const store = fakeStore()
    await store.upsert({ assetId: `${G}.0`, feeRatePerKb: 12, setByOutpoint: `${S}.1` })
    await rebuildFeeRateFromHistory(store, `${G}.0`, [])
    expect(store.rows.get(`${G}.0`)).toEqual({ assetId: `${G}.0`, feeRatePerKb: null, setByOutpoint: '' })
  })
})
