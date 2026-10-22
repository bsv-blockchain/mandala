import { describe, it, expect, vi, afterEach } from 'vitest'
import { PrivateKey, Transaction, P2PKH, UnlockingScript } from '@bsv/sdk'
import { MandalaToken } from '../__fixtures__/token.js'
import { configureMandala, TREASURY_BASKET } from '../constants.js'
import { MAX_UINT64 } from '../amount.js'
import { excludeFrozen, loadTreasuryCandidates } from './candidates.js'
import type { TreasuryCandidate } from './select.js'

const c = (outpoint: string): TreasuryCandidate => ({
  outpoint, amount: 1n, keyID: 'k', counterparty: '', confirmed: true, order: 0
})

describe('excludeFrozen', () => {
  it('drops candidates whose outpoint is frozen', () => {
    const out = excludeFrozen([c('a.0'), c('b.1'), c('c.2')], new Set(['b.1']))
    expect(out.map(o => o.outpoint)).toEqual(['a.0', 'c.2'])
  })

  it('drops candidates whose outpoint is in the excluded set (frozen + evicted)', () => {
    // The excluded set may contain both frozen and evicted outpoints
    const excluded = new Set(['b.1', 'c.2']) // e.g., b.1 frozen, c.2 evicted
    const out = excludeFrozen([c('a.0'), c('b.1'), c('c.2'), c('d.3')], excluded)
    expect(out.map(o => o.outpoint)).toEqual(['a.0', 'd.3'])
  })

  it('returns all candidates when the excluded set is empty (fail-open shape)', () => {
    const all = [c('a.0'), c('b.1')]
    expect(excludeFrozen(all, new Set())).toEqual(all)
  })
})

describe('loadTreasuryCandidates', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const fund = (outs: Array<{ assetId: string, amount: bigint } | 'authority'>): { tx: Transaction, beef: number[] } => {
    const pkh = new PrivateKey(11).toPublicKey().toHash() as number[]
    const src = new Transaction()
    src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
    for (const o of outs) {
      tx.addOutput({
        satoshis: 1,
        lockingScript: o === 'authority'
          ? new MandalaToken().lock('cc'.repeat(32) + '_0', 0n, pkh)
          : new MandalaToken().lock(o.assetId, o.amount, pkh)
      })
    }
    return { tx, beef: tx.toBEEF() }
  }

  // The mobile toolbox omits `lockingScript` from listOutputs even when asked
  // for 'locking scripts'; the loader must still find the coin via the BEEF
  // listing it fetches anyway.
  it('decodes the token output from the BEEF when the listing lacks lockingScript', async () => {
    configureMandala({ overlayUrl: 'http://test-overlay', overlayIdentityKey: '02' + 'ab'.repeat(32) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    const assetId = 'cc'.repeat(32) + '_0'
    const { tx, beef } = fund([{ assetId, amount: 25n }])
    const outpoint = `${tx.id('hex')}.0`
    const wallet = {
      listOutputs: vi.fn(async (args: { include?: string }) => args.include === 'entire transactions'
        ? { outputs: [{ outpoint, satoshis: 1, spendable: true }], BEEF: beef }
        : { outputs: [{ outpoint, satoshis: 1, spendable: true, customInstructions: JSON.stringify({ keyID: 'k', counterparty: '02' + '11'.repeat(32) }) }] }),
      listActions: vi.fn(async () => ({ actions: [] }))
    }
    const { candidates } = await loadTreasuryCandidates(wallet as any, assetId)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ outpoint, amount: 25n, keyID: 'k' })
    for (const call of wallet.listOutputs.mock.calls) expect((call[0] as { basket: string }).basket).toBe(TREASURY_BASKET)
  })

  it('reads MAX_UINT64 value coins exactly and skips authority coins and other assets', async () => {
    configureMandala({ overlayUrl: 'http://test-overlay', overlayIdentityKey: '02' + 'ab'.repeat(32) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    const assetId = 'cc'.repeat(32) + '_0'
    const other = 'dd'.repeat(32) + '_0'
    const { tx, beef } = fund([{ assetId, amount: MAX_UINT64 }, 'authority', { assetId: other, amount: 7n }])
    const txid = tx.id('hex')
    const listed = [0, 1, 2].map(i => ({
      outpoint: `${txid}.${i}`,
      satoshis: 1,
      spendable: true,
      lockingScript: tx.outputs[i].lockingScript.toHex(),
      customInstructions: JSON.stringify({ keyID: `k${i}`, counterparty: '02' + '11'.repeat(32) })
    }))
    const wallet = {
      listOutputs: vi.fn(async (args: { include?: string }) => args.include === 'entire transactions'
        ? { outputs: listed, BEEF: beef }
        : { outputs: listed }),
      listActions: vi.fn(async () => ({ actions: [{ txid, status: 'completed' }] }))
    }
    const { candidates } = await loadTreasuryCandidates(wallet as any, assetId)
    expect(candidates).toEqual([{
      outpoint: `${txid}.0`, amount: MAX_UINT64, keyID: 'k0', counterparty: '02' + '11'.repeat(32), confirmed: true, order: 0
    }])
  })
})
