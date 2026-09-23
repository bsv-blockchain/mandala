import { describe, it, expect, vi } from 'vitest'
import { foldAction, defaultAssetState, replayAssetState, type ReplayStorage } from './pinnedReducer.js'

const G = 'aa'.repeat(32)
const F = 'ff'.repeat(32)

describe('pinnedReducer shim', () => {
  // A package bump that moves or renames the reducer file must fail here, loudly.
  it('resolves the pinned foldAction/defaultAssetState as functions', () => {
    expect(typeof foldAction).toBe('function')
    expect(typeof defaultAssetState).toBe('function')
    expect(defaultAssetState(`${G}.0`).assetId).toBe(`${G}.0`)
  })
})

describe('replayAssetState (≡ pinned MandalaLookupService.rebuildState over the given rows)', () => {
  const storage = (): ReplayStorage & { put: ReturnType<typeof vi.fn> } => {
    const put = vi.fn(async () => {})
    return {
      put,
      putAssetState: put,
      getTokenRow: async (txid, vout) => txid === F && vout === 1 ? { amount: 40, identityKey: 'owner' } : null
    }
  }

  it('folds issuer + frozen ctx and persists, leaving lastProcessed*/lastAdmitSeq at defaults like the pinned rebuild', async () => {
    const s = storage()
    const state = await replayAssetState(`${G}.0`, [
      { actionDetails: { kind: 'register', issuer: 'iss' } },
      { actionDetails: { kind: 'pause' } },
      { actionDetails: { kind: 'freezeOutput', outpoint: `${F}.1` } }
    ], s)
    expect(state.issuerIdentityKey).toBe('iss')
    expect(state.isPaused).toBe(true)
    expect(state.frozenOutpoints).toEqual([{ outpoint: `${F}.1`, amount: 40, owner: 'owner' }])
    expect(state.lastProcessedHeight).toBe(0)
    expect(state.lastProcessedOffset).toBe(0)
    expect(state.lastAdmitSeq).toBe(0)
    expect(s.put).toHaveBeenCalledWith(state)
  })

  it('no surviving rows → default state persisted', async () => {
    const s = storage()
    const state = await replayAssetState(`${G}.0`, [], s)
    expect(state).toEqual(defaultAssetState(`${G}.0`))
    expect(s.put).toHaveBeenCalledTimes(1)
  })
})
