/** The Mandala provider's host-ledger spendability (design §9 B7 offline parity). */
import { describe, it, expect, vi } from 'vitest'
import { withLedgerSpendability } from './profileSpendability.js'
import { createHostLedger, type HostLedger } from './hostLedger.js'
import { memoryStorage } from './storage.js'
import { ColorProviderError } from './providerError.js'

const ID = `${'c7'.repeat(32)}_0`
const T1 = 'a'.repeat(64)
const T2 = 'b'.repeat(64)
const T3 = 'd'.repeat(64)

async function ledgerWith (): Promise<HostLedger> {
  const l = createHostLedger(memoryStorage())
  await l.put({ v: 1, txid: T1, assetId: ID, state: 'pending', outputs: [1], beefHex: '0101', at: 1 })
  await l.put({ v: 1, txid: T2, assetId: ID, state: 'settled', outputs: [0], beefHex: '0202', at: 1 })
  await l.put({ v: 1, txid: T3, assetId: ID, state: 'refused', outputs: [0], beefHex: '0303', at: 1 })
  return l
}
const base = (spendability: any): any => ({ url: 'https://o', identityKey: '02' + '11'.repeat(32), spendability, admission: vi.fn(), submit: vi.fn() })
const ops = (r: any): string[] => r.outputs.map((o: any) => `${o.txid}.${o.outputIndex}`).sort()

describe('withLedgerSpendability', () => {
  it('overlay reachable: its list plus pending records; settled and refused records defer to the overlay', async () => {
    const p = withLedgerSpendability(base(async () => ({ type: 'output-list', outputs: [] })), await ledgerWith())
    expect(ops(await p.spendability(ID, [`${T1}.1`, `${T2}.0`, `${T3}.0`, `${T1}.0`]))).toEqual([`${T1}.1`])
  })

  it('overlay unreachable (transport): pending and settled records; never refused or unrecorded', async () => {
    const p = withLedgerSpendability(base(async () => { throw new ColorProviderError('ERR_UNAVAILABLE', true, true, 'down') }), await ledgerWith())
    const r: any = await p.spendability(ID, [`${T1}.1`, `${T2}.0`, `${T3}.0`, `${'e'.repeat(64)}.0`])
    expect(ops(r)).toEqual([`${T1}.1`, `${T2}.0`])
    expect(r.outputs.find((o: any) => o.txid === T1).beef).toEqual([1, 1])
  })

  it('a typed overlay refusal is never masked', async () => {
    const err = new ColorProviderError('ERR_SHAPE', false, false, 'bad query')
    const p = withLedgerSpendability(base(async () => { throw err }), await ledgerWith())
    await expect(p.spendability(ID, [`${T1}.1`])).rejects.toBe(err)
  })

  it('a record of another asset never counts', async () => {
    const p = withLedgerSpendability(base(async () => { throw new ColorProviderError('ERR_UNAVAILABLE', true, true, 'down') }), await ledgerWith())
    expect((await p.spendability(`${'ab'.repeat(32)}_0`, [`${T1}.1`]) as any).outputs).toEqual([])
  })
})
