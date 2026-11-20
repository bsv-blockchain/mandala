/**
 * Settlement of offline-credited receipts (design §9 B7): pending chains are
 * submitted parents first with their exact stored bytes, the tip σ must cover
 * the credited outputs, the record becomes settled, then the host's
 * markSettled runs. Final verdicts become `refused`; transport and retryable
 * outcomes only count attempts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Transaction, Utils } from '@bsv/sdk'
import { settleReceipts } from './receiptSettle.js'
import { createHostLedger, type HostLedger, type LedgerRecord } from './hostLedger.js'
import { configureMandala } from './constants.js'
import { colorTopic } from './naming.js'
import { OverlayRefusedError, submitToOverlay } from './overlay.js'
import { attestationFromSteak } from './attestation.js'
import { memoryStorage } from './storage.js'
import { OVERLAY_KEY, signedSteak } from './__fixtures__/overlaySigner.js'
import { chain, env, ID } from './__fixtures__/signedChain.js'

vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitToOverlay: vi.fn()
}))

let ledger: HostLedger
let C: Awaited<ReturnType<typeof chain>>
let pending: LedgerRecord

function admitAll (outs: number[] = [0, 1]): void {
  vi.mocked(submitToOverlay).mockImplementation(async (beef: number[]) => {
    const txid = Transaction.fromAtomicBEEF(beef).id('hex')
    const o = txid === C.T.id('hex') ? outs : [0]
    const attestation = attestationFromSteak(txid, ID, await signedSteak(txid, { [colorTopic(ID)]: o }))!
    return { topic: colorTopic(ID), outputsToAdmit: o, attestation }
  })
}

beforeEach(async () => {
  vi.mocked(submitToOverlay).mockReset()
  configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: OVERLAY_KEY })
  ledger = createHostLedger(memoryStorage())
  C = await chain()
  pending = {
    v: 1,
    txid: C.T.id('hex'),
    assetId: ID,
    state: 'pending',
    outputs: [0],
    submits: [
      { txid: C.P.id('hex'), beefHex: Utils.toHex(C.P.toAtomicBEEF()), offChainHex: Utils.toHex(env([0])) },
      { txid: C.T.id('hex'), beefHex: Utils.toHex(C.T.toAtomicBEEF()), offChainHex: Utils.toHex(env([0, 1])) }
    ],
    at: 1
  }
  await ledger.put(pending)
})

describe('settleReceipts', () => {
  it('submits the stored chain in order, records settled, then markSettled', async () => {
    admitAll()
    const marked: string[] = []
    const r = await settleReceipts({ ledger, markSettled: async t => { marked.push(t) } })
    expect(r).toEqual([{ txid: C.T.id('hex'), assetId: ID, status: 'admitted' }])
    const calls = vi.mocked(submitToOverlay).mock.calls
    expect(calls.map(c => Transaction.fromAtomicBEEF(c[0]).id('hex'))).toEqual([C.P.id('hex'), C.T.id('hex')])
    expect(calls[1][1]).toEqual(env([0, 1]))
    expect(calls[1][4]).toBe(OVERLAY_KEY)
    expect(marked).toEqual([C.T.id('hex')])
    expect(await ledger.get(C.T.id('hex'))).toMatchObject({ state: 'settled', marked: true })
    // A second pass has nothing to do.
    expect(await settleReceipts({ ledger, markSettled: async t => { marked.push(t) } })).toEqual([])
  })

  it('a final verdict marks the record refused and reports it', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_INPUT_SPENT', httpStatus: 400 }))
    const r = await settleReceipts({ ledger })
    expect(r[0]).toMatchObject({ status: 'refused', code: 'ERR_INPUT_SPENT' })
    expect(await ledger.get(C.T.id('hex'))).toMatchObject({ state: 'refused', code: 'ERR_INPUT_SPENT' })
  })

  it('transport and retryable verdicts only count attempts', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', httpStatus: 0, retryable: true }))
    expect((await settleReceipts({ ledger }))[0]).toMatchObject({ status: 'retry', code: 'ERR_UNAVAILABLE' })
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_PAUSED', httpStatus: 409, retryable: true }))
    expect((await settleReceipts({ ledger }))[0]).toMatchObject({ status: 'retry', code: 'ERR_PAUSED' })
    expect(await ledger.get(C.T.id('hex'))).toMatchObject({ state: 'pending', attempts: 2 })
  })

  it('an admission that does not cover the credited output stays pending', async () => {
    admitAll([1])
    expect((await settleReceipts({ ledger }))[0]).toMatchObject({ status: 'retry', code: 'ERR_NOT_ADMITTED' })
    expect((await ledger.get(C.T.id('hex')))?.state).toBe('pending')
  })

  it('crash between settled and markSettled: the next pass only runs markSettled', async () => {
    admitAll()
    await expect(settleReceipts({ ledger, markSettled: async () => { throw new Error('crash') } })).resolves.toMatchObject([{ status: 'retry' }])
    expect(await ledger.get(C.T.id('hex'))).toMatchObject({ state: 'settled', marked: false })
    vi.mocked(submitToOverlay).mockClear()
    const marked: string[] = []
    expect(await settleReceipts({ ledger, markSettled: async t => { marked.push(t) } })).toEqual([{ txid: C.T.id('hex'), assetId: ID, status: 'admitted' }])
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(marked).toEqual([C.T.id('hex')])
  })

  it('stale stored bytes are never submitted under the wrong txid', async () => {
    await ledger.put({ ...pending, txid: C.P.id('hex'), outputs: [0], submits: [{ txid: C.P.id('hex'), beefHex: Utils.toHex(C.T.toAtomicBEEF()), offChainHex: '00' }] })
    admitAll()
    const r = await settleReceipts({ ledger, txids: [C.P.id('hex')] })
    expect(r[0].status).toBe('retry')
    expect(submitToOverlay).not.toHaveBeenCalled()
  })

  it('an own hand-over is never submitted here; a settled-but-unmarked one is only marked', async () => {
    const own = 'f'.repeat(64)
    await ledger.put({ v: 1, txid: own, assetId: ID, state: 'pending', own: true, outputs: [1], submits: pending.submits, at: 2 })
    vi.mocked(submitToOverlay).mockClear()
    const marked: string[] = []
    let r = await settleReceipts({ ledger, markSettled: async t => { marked.push(t) }, txids: [own] })
    expect(r).toEqual([])
    expect(submitToOverlay).not.toHaveBeenCalled()
    await ledger.put({ v: 1, txid: own, assetId: ID, state: 'settled', own: true, outputs: [], marked: false, at: 3 })
    r = await settleReceipts({ ledger, markSettled: async t => { marked.push(t) }, txids: [own] })
    expect(r).toEqual([{ txid: own, assetId: ID, status: 'admitted' }])
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(marked).toEqual([own])
    expect(await ledger.get(own)).toMatchObject({ state: 'settled', marked: true })
  })

  it('fails closed without an overlay identity key (S5)', async () => {
    configureMandala({ overlayIdentityKey: '' })
    try {
      await expect(settleReceipts({ ledger })).rejects.toThrow(/overlay identity key/)
    } finally {
      configureMandala({ overlayIdentityKey: OVERLAY_KEY })
    }
  })
})
