import { describe, it, expect, vi } from 'vitest'
import { OneColor } from '@bsv/templates'
import type { ListOutputsArgs, ListOutputsResult, WalletInterface, WalletOutput } from '@bsv/sdk'
import type { HistoryRow } from '@bsv/mandala'
import { balanceSelector } from './holderBalances'
import { loadHolderData, type HolderDataDeps } from './loadHolderData'
import { holderDataKey } from '../../hooks/useHolderData'
import { treasuryKey } from '../../hooks/useTreasuryBalances'

const MAX = 2n ** 64n - 1n
const ID = `${'c'.repeat(64)}_0`
const ID2 = `${'d'.repeat(64)}_0`
const PKH = new Array(20).fill(7)
const lock = (id: string, amount: bigint): string => new OneColor().lock(id, amount, PKH).toHex()

let n = 0
const record = (id: string, amount: bigint, tags: string[]): WalletOutput => ({
  outpoint: `${(++n).toString(16).padStart(64, '0')}.0`,
  satoshis: 1,
  spendable: tags.includes('color_state_available'),
  lockingScript: lock(id, amount),
  tags
})
const avail = (id: string, amount: bigint): WalletOutput => record(id, amount, ['color_state_available'])
const availOffline = (id: string, amount: bigint): WalletOutput => record(id, amount, ['color_state_available', 'color_offline'])
const pend = (id: string, amount: bigint): WalletOutput => record(id, amount, ['color_state_pending'])

type Route = { totalOutputs: number | string, outputs: WalletOutput[] } | Error

/** A fake wallet whose `listOutputs` answers by `basket`; an Error route rejects. */
function routeWallet (routes: Record<string, Route>): WalletInterface & { calls: ListOutputsArgs[] } {
  const calls: ListOutputsArgs[] = []
  const w = {
    calls,
    listOutputs: async (args: ListOutputsArgs): Promise<ListOutputsResult> => {
      calls.push(args)
      const r = routes[args.basket]
      if (r === undefined) throw new Error(`no route for basket ${args.basket}`)
      if (r instanceof Error) throw r
      const offset = args.offset ?? 0
      return { totalOutputs: r.totalOutputs as number, outputs: r.outputs.slice(offset, offset + (args.limit ?? 10)) }
    }
  }
  return w as unknown as WalletInterface & { calls: ListOutputsArgs[] }
}

const row = (assetId: string, amount: bigint): HistoryRow => ({
  txid: 'a'.repeat(64), assetId, direction: 'received', amount, counterparty: '02', when: 0, kind: 'receive'
})

function deps (o: { meta?: Record<string, { label: string, decimals: number, ticker?: string }>, history?: HistoryRow[] } = {}) {
  return {
    loadHistory: vi.fn(async () => o.history ?? []),
    listAdminAssets: vi.fn(async () => []),
    resolveAssetMetadata: vi.fn(async (id: string) => {
      const m = o.meta?.[id]
      return m === undefined ? null : { ticker: '', ...m }
    })
  } satisfies HolderDataDeps
}

describe('loadHolderData', () => {
  it('balance comes from the module view, unsettled/incoming from inventory tags, metadata from overlay', async () => {
    const w = routeWallet({
      'p color assets': { totalOutputs: 3, outputs: [avail(ID, 7n), availOffline(ID, 4n), pend(ID, 3n)] },
      [balanceSelector(ID)]: { totalOutputs: '18446744073709551615', outputs: [] }
    })
    const d = await loadHolderData(w, deps({ meta: { [ID]: { label: 'Test Dollar', decimals: 2, ticker: 'TUSD' } } }))
    expect(d.assets).toEqual([{ assetId: ID, balance: MAX, unsettled: 4n, incoming: 3n, meta: { label: 'Test Dollar', decimals: 2, ticker: 'TUSD', issuer: undefined } }])
    expect(w.calls.find(c => c.basket === 'p color assets')).toMatchObject({ include: 'locking scripts', includeTags: true })
  })

  it('reads the inventory before any other wallet call (one color_access consent)', async () => {
    const order: string[] = []
    const w = routeWallet({
      'p color assets': { totalOutputs: 1, outputs: [avail(ID, 1n)] },
      [balanceSelector(ID)]: { totalOutputs: '1', outputs: [] }
    })
    const inner = w.listOutputs.bind(w)
    w.listOutputs = async (args) => { order.push(`start ${args.basket}`); const r = await inner(args); order.push(`end ${args.basket}`); return r }
    const d = deps()
    d.loadHistory.mockImplementation(async () => { order.push('history'); return [] })
    d.listAdminAssets.mockImplementation(async () => { order.push('admin'); return [] })
    await loadHolderData(w, d)
    expect(order.slice(0, 2)).toEqual(['start p color assets', 'end p color assets'])
  })

  it('holder history is loaded with scope holder', async () => {
    const d = deps()
    await loadHolderData(routeWallet({ 'p color assets': { totalOutputs: 0, outputs: [] } }), d)
    expect(d.loadHistory).toHaveBeenCalledWith(expect.anything(), { scope: 'holder' })
  })

  it('a failing balance view yields balance null for that asset only', async () => {
    const w = routeWallet({
      'p color assets': { totalOutputs: 2, outputs: [avail(ID, 1n), avail(ID2, 1n)] },
      [balanceSelector(ID)]: { totalOutputs: '5', outputs: [] },
      [balanceSelector(ID2)]: new Error('ERR_ACCESS')
    })
    const d = await loadHolderData(w, deps({ meta: { [ID]: { label: 'A', decimals: 0 }, [ID2]: { label: 'B', decimals: 0 } } }))
    expect(d.assets.map(a => [a.assetId, a.balance])).toEqual([[ID, 5n], [ID2, null]])
  })

  it('a malformed balance total yields null, never a rounded value', async () => {
    const w = routeWallet({
      'p color assets': { totalOutputs: 1, outputs: [avail(ID, 1n)] },
      [balanceSelector(ID)]: { totalOutputs: 1.5, outputs: [] }
    })
    expect((await loadHolderData(w, deps())).assets[0].balance).toBeNull()
  })

  it('history-only assets appear with balance 0n via the view; non-zero balances sort first', async () => {
    const w = routeWallet({
      'p color assets': { totalOutputs: 1, outputs: [avail(ID, 9n)] },
      [balanceSelector(ID)]: { totalOutputs: '9', outputs: [] },
      [balanceSelector(ID2)]: { totalOutputs: '0', outputs: [] }
    })
    const d = await loadHolderData(w, deps({
      meta: { [ID]: { label: 'Zed', decimals: 0 }, [ID2]: { label: 'Alpha', decimals: 0 } },
      history: [row(ID2, 3n)]
    }))
    expect(d.assets).toEqual([
      { assetId: ID, balance: 9n, unsettled: 0n, incoming: 0n, meta: { label: 'Zed', decimals: 0, ticker: '', issuer: undefined } },
      { assetId: ID2, balance: 0n, unsettled: 0n, incoming: 0n, meta: { label: 'Alpha', decimals: 0, ticker: '', issuer: undefined } }
    ])
    expect(w.calls.map(c => c.basket)).toContain(balanceSelector(ID2))
  })

  it('own admin assets win over overlay metadata; bad decimals fall back to 0', async () => {
    const w = routeWallet({
      'p color assets': { totalOutputs: 2, outputs: [avail(ID, 1n), avail(ID2, 1n)] },
      [balanceSelector(ID)]: { totalOutputs: '1', outputs: [] },
      [balanceSelector(ID2)]: { totalOutputs: '1', outputs: [] }
    })
    const d = deps({ meta: { [ID]: { label: 'Overlay', decimals: 2 }, [ID2]: { label: 'Wide', decimals: 19 } } })
    d.listAdminAssets.mockResolvedValue([{ assetId: ID, label: 'Mine', authOutpoint: 'x.0', authKeyID: 'k', metadata: { decimals: 6, ticker: 'MIN', issuer: '02aa' } }] as never)
    const out = await loadHolderData(w, d)
    expect(out.metas[ID]).toEqual({ label: 'Mine', decimals: 6, ticker: 'MIN', issuer: '02aa' })
    expect(out.metas[ID2].decimals).toBe(0)
    expect(d.resolveAssetMetadata).not.toHaveBeenCalledWith(ID)
  })

  it('a failing metadata lookup falls back to a short label instead of failing the load', async () => {
    const w = routeWallet({
      'p color assets': { totalOutputs: 1, outputs: [avail(ID, 1n)] },
      [balanceSelector(ID)]: { totalOutputs: '1', outputs: [] }
    })
    const d = deps()
    d.resolveAssetMetadata.mockRejectedValue(new Error('overlay down'))
    const out = await loadHolderData(w, d)
    expect(out.assets[0]).toMatchObject({ assetId: ID, balance: 1n, meta: { label: `${ID.slice(0, 10)}…`, decimals: 0 } })
  })

  it('an inventory failure fails the load (no partial holder view)', async () => {
    await expect(loadHolderData(routeWallet({ 'p color assets': new Error('ERR_ACCESS') }), deps())).rejects.toThrow('ERR_ACCESS')
  })

  it('never touches the old baskets', async () => {
    const w = routeWallet({
      'p color assets': { totalOutputs: 2, outputs: [avail(ID, 1n), pend(ID2, 2n)] },
      [balanceSelector(ID)]: { totalOutputs: '1', outputs: [] },
      [balanceSelector(ID2)]: { totalOutputs: '0', outputs: [] }
    })
    await loadHolderData(w, deps())
    const baskets = w.calls.map(c => c.basket)
    expect(baskets).not.toContain('p mandala')
    expect(baskets).not.toContain('mandala-tokens')
  })

  it('query keys are JSON-safe', () => {
    expect(() => JSON.stringify(holderDataKey('02ab'))).not.toThrow()
    expect(() => JSON.stringify(treasuryKey(null))).not.toThrow()
    expect(holderDataKey('02ab')).toEqual(['holder-data', '02ab'])
    expect(treasuryKey('02ab')).toEqual(['treasury', '02ab'])
  })
})
