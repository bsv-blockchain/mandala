import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./constants', () => ({ TREASURY_BASKET: 'mandala treasury' }))
const resolveAssetState = vi.fn()
vi.mock('./adminState', () => ({ resolveAssetState: (...a: any[]) => resolveAssetState(...a) }))

import { reconcileBans } from './reconcileBans.js'

const wallet = () => {
  const relinquishOutput = vi.fn().mockResolvedValue({})
  const listOutputs = vi.fn().mockResolvedValue({
    outputs: [{ outpoint: 'held.0' }, { outpoint: 'held.1' }]
  })
  return { relinquishOutput, listOutputs } as any
}

describe('reconcileBans', () => {
  beforeEach(() => resolveAssetState.mockReset())

  it('relinquishes only evicted outputs the wallet still holds', async () => {
    resolveAssetState.mockResolvedValue({ evictedOutpoints: ['held.1', 'gone.9'] })
    const w = wallet()
    const done = await reconcileBans(w, ['asset.0'])
    expect(done).toEqual(['held.1'])
    expect(w.relinquishOutput).toHaveBeenCalledTimes(1)
    expect(w.relinquishOutput).toHaveBeenCalledWith({ basket: 'mandala treasury', output: 'held.1' })
  })

  it('does nothing when state is unavailable (fail open)', async () => {
    resolveAssetState.mockResolvedValue(null)
    const w = wallet()
    const done = await reconcileBans(w, ['asset.0'])
    expect(done).toEqual([])
    expect(w.relinquishOutput).not.toHaveBeenCalled()
  })
})
