import { describe, it, expect, afterEach } from 'vitest'
import { P2PKH, Transaction } from '@bsv/sdk'
import { createHarness, HARNESS_TOPIC, type Harness } from './testkit/engineHarness.js'
import { knexEngineOutputs } from './engineOutputs.js'

let h: Harness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('knexEngineOutputs', () => {
  it('reads an admitted unspent output and nulls it once spent', async () => {
    h = await createHarness()
    const a = await h.spend(900)
    await h.submit(a)
    const r = knexEngineOutputs(h.knex)
    const got = await r.findAdmittedOutput(a.id('hex'), 0, HARNESS_TOPIC)
    expect(got).toEqual({ lockingScript: a.outputs[0].lockingScript.toBinary(), satoshis: 900 })
    expect(await r.findAdmittedOutput(a.id('hex'), 0, 'tm_other')).toBeNull()
    expect(await r.findAdmittedOutput(a.id('hex'), 1, HARNESS_TOPIC)).toBeNull()
    const b = await h.spend(800, a, 0)
    await h.submit(b)
    expect(await r.findAdmittedOutput(a.id('hex'), 0, HARNESS_TOPIC)).toBeNull()
  })
  it('pages unspent outputs in (txid, outputIndex) keyset order', async () => {
    h = await createHarness()
    const txs: Transaction[] = []
    let src: Transaction | undefined
    for (let i = 0; i < 3; i++) { const t = await h.spend(900 - i, src ?? h.root, 0); await h.submit(t); src = t; txs.push(t) }
    const r = knexEngineOutputs(h.knex)
    const all = await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, null, 10)
    expect(all).toEqual([{ txid: txs[2].id('hex'), outputIndex: 0 }]) // earlier ones are spent by the chain
    const page1 = await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, null, 1)
    expect(await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, page1[0], 1)).toEqual([])
  })
  it('keysets across two unspent outputs of one tx and across txids', async () => {
    h = await createHarness()
    const t = new Transaction(1, [{
      sourceTransaction: h.root, sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(h.key), sequence: 0xffffffff
    }], [{ lockingScript: h.lock, satoshis: 400 }, { lockingScript: h.lock, satoshis: 300 }], 0)
    await t.sign()
    await h.submit(t)
    const r = knexEngineOutputs(h.knex)
    const id = t.id('hex')
    const p1 = await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, null, 1)
    expect(p1).toEqual([{ txid: id, outputIndex: 0 }])
    const p2 = await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, p1[0], 1)
    expect(p2).toEqual([{ txid: id, outputIndex: 1 }])
    expect(await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, p2[0], 1)).toEqual([])
    expect(await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, null, 10)).toEqual([p1[0], p2[0]])
    // a second tx: strictly-after crosses txid boundaries in txid order
    const u = await h.spend(200, t, 0)
    await h.submit(u)
    const rest = await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, null, 10)
    const expected = [{ txid: id, outputIndex: 1 }, { txid: u.id('hex'), outputIndex: 0 }]
      .sort((x, y) => x.txid < y.txid ? -1 : x.txid > y.txid ? 1 : x.outputIndex - y.outputIndex)
    expect(rest).toEqual(expected)
    expect(await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, expected[0], 10)).toEqual([expected[1]])
  })
  it('throws (never nulls) on an unreadable spent column', async () => {
    h = await createHarness()
    const a = await h.spend(900); await h.submit(a)
    await h.knex('outputs').where({ txid: a.id('hex') }).update({ spent: 7 })
    await expect(knexEngineOutputs(h.knex).findAdmittedOutput(a.id('hex'), 0, HARNESS_TOPIC)).rejects.toThrow(/outputs.spent/)
  })
})
