import { describe, it, expect, vi } from 'vitest'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { configureMandala } from './constants.js'
import { loadFtCandidates } from './ftCandidates.js'

// The mobile toolbox omits `lockingScript` from listOutputs even when asked for
// 'locking scripts'; the candidate loader must still find the coin via the
// BEEF listing it fetches anyway.
describe('loadFtCandidates without lockingScript on the listing', () => {
  it('decodes the token output from the BEEF instead', async () => {
    configureMandala({ overlayUrl: 'http://test-overlay', overlayIdentityKey: '02' + 'ab'.repeat(32) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    const pkh = new PrivateKey(11).toPublicKey().toHash() as number[]
    const assetId = 'cc'.repeat(32) + '.0'
    const src = new Transaction()
    src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new (await import('@bsv/sdk')).UnlockingScript([]), sequence: 0xffffffff })
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 25, pkh) })
    const outpoint = `${tx.id('hex')}.0`
    const beef = tx.toBEEF()
    const wallet = {
      listOutputs: vi.fn(async (args: { include?: string }) => args.include === 'entire transactions'
        ? { outputs: [{ outpoint, satoshis: 1, spendable: true }], BEEF: beef }
        : { outputs: [{ outpoint, satoshis: 1, spendable: true, customInstructions: JSON.stringify({ keyID: 'k', counterparty: '02' + '11'.repeat(32) }) }] }),
      listActions: vi.fn(async () => ({ actions: [] }))
    }
    const { candidates } = await loadFtCandidates(wallet as any, assetId)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ outpoint, amount: 25, keyID: 'k' })
  })
})
