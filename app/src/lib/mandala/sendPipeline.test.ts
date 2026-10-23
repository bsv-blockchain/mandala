import { describe, it, expect, vi } from 'vitest'
import type { WalletInterface } from '@bsv/sdk'
import type { Attestation, HandoverResult } from '@bsv/mandala'
import {
  describeSettle,
  explainSendError,
  sendAndDeliver,
  type SendDeps,
  type SendVars
} from './sendPipeline'

const A = '02' + 'aa'.repeat(32) // this wallet's identity key
const B = '03' + 'bb'.repeat(32) // another holder
const K = '02' + 'cc'.repeat(32) // overlay identity key (S5)
const ID = 'ab'.repeat(32) + '.0'
const ATT: Attestation = { txid: 'd'.repeat(64), outputs: [0], signer: K, signature: '3006020101020101' }
const H: HandoverResult = {
  txid: 'd'.repeat(64),
  tx: [1, 2, 3],
  reference: 'ref-1',
  outputIndex: 0,
  receipt: { version: 1, assetId: ID, derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: A },
  body: {} as HandoverResult['body'],
  offChainValues: [9, 9]
}
const V: SendVars = { assetId: ID, amount: 5n, recipientKey: B }

const passThrough: NonNullable<SendDeps['withLock']> = async (fn) => ({ ran: true, value: await fn() })

function deps (over: Partial<SendDeps> = {}): SendDeps {
  return {
    wallet: {} as unknown as WalletInterface,
    identityKey: A,
    overlayIdentityKey: K,
    messageBoxClient: { sendMessage: vi.fn(async () => undefined) },
    send: vi.fn(async () => H),
    deliver: vi.fn(async () => {}),
    markDelivered: vi.fn(async (_txid: string) => {}),
    settle: vi.fn(async () => ({ status: 'admitted', attestation: ATT }) as const),
    withLock: passThrough,
    ...over
  }
}

describe('sendAndDeliver (B5: sign → deliver → post-ACK settle)', () => {
  it('signs, delivers, then settles inside the handover lock (B5)', async () => {
    const order: string[] = []
    const d = deps({
      send: vi.fn(async () => { order.push('send'); return H }),
      deliver: vi.fn(async () => { order.push('deliver') }),
      settle: vi.fn(async () => { order.push('settle'); return { status: 'admitted', attestation: ATT } as const }),
      withLock: (async (fn, o) => { order.push('lock:' + String(o.wait)); return { ran: true, value: await fn() } }) as NonNullable<SendDeps['withLock']>
    })
    const out = await sendAndDeliver(d, { assetId: ID, amount: 2n ** 64n - 1n, recipientKey: B, note: 'rent' })
    expect(order).toEqual(['send', 'lock:true', 'deliver', 'settle'])
    expect(out).toEqual({ txid: H.txid, delivered: true, self: false, settle: { status: 'admitted', attestation: ATT } })
    expect(d.deliver).toHaveBeenCalledWith({ messageBoxClient: d.messageBoxClient, recipientKey: B, handover: H })
    expect(d.settle).toHaveBeenCalledWith({ wallet: d.wallet, handover: { txid: H.txid, tx: H.tx, offChainValues: H.offChainValues }, assetId: ID, overlayIdentityKey: K })
  })

  it('passes amount as bigint and leaves blind to the lib default', async () => {
    const d = deps()
    await sendAndDeliver(d, V)
    expect(d.send).toHaveBeenCalledWith({ wallet: d.wallet, identityKey: A, assetId: ID, amount: V.amount, recipientKey: B, note: undefined })
  })

  it('a failed delivery does not throw and does not settle', async () => {
    const d = deps({ deliver: vi.fn().mockRejectedValue(new Error('mb down')) })
    const out = await sendAndDeliver(d, V)
    expect(out).toEqual({ txid: H.txid, delivered: false, self: false, settle: null })
    expect(d.settle).not.toHaveBeenCalled()
  })

  it('self-send marks delivered instead of delivering, then settles', async () => {
    const d = deps()
    const out = await sendAndDeliver(d, { ...V, recipientKey: A })
    expect(d.deliver).not.toHaveBeenCalled()
    expect(d.markDelivered).toHaveBeenCalledWith(H.txid)
    expect(d.settle).toHaveBeenCalledTimes(1)
    expect(out.self).toBe(true)
  })

  it('refused shows the code and does not abort', async () => {
    const wallet = { abortAction: vi.fn() } as unknown as WalletInterface & { abortAction: ReturnType<typeof vi.fn> }
    const out = await sendAndDeliver(deps({ wallet, settle: vi.fn(async () => ({ status: 'refused', code: 'ERR_CONSERVATION' }) as const) }), V)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(describeSettle(out)).toEqual({ kind: 'error', text: 'The overlay refused this send (ERR_CONSERVATION). The tokens were returned to your balance.' })
  })

  it('a thrown settle resolves with settle:null (recovery retries it)', async () => {
    const out = await sendAndDeliver(deps({ settle: vi.fn().mockRejectedValue(new Error('net')) }), V)
    expect(out.settle).toBeNull()
    expect(out.delivered).toBe(true)
  })

  it('sendHandover failure propagates; nothing else runs', async () => {
    const d = deps({ send: vi.fn().mockRejectedValue(new Error('x')) })
    await expect(sendAndDeliver(d, V)).rejects.toThrow('x')
    expect(d.deliver).not.toHaveBeenCalled()
    expect(d.settle).not.toHaveBeenCalled()
  })

  // Once send() resolved the hand-over is signed and journaled: a rejection
  // here would roll the UI back and invite a second (double) payment.
  it('never rejects after the hand-over is signed: lock failure, lock refused, self-mark failure', async () => {
    const lockThrows = deps({ withLock: vi.fn().mockRejectedValue(new Error('SecurityError')) })
    expect(await sendAndDeliver(lockThrows, V)).toEqual({ txid: H.txid, delivered: false, self: false, settle: null })
    expect(lockThrows.deliver).not.toHaveBeenCalled()

    const lockRefused = deps({ withLock: (async () => ({ ran: false })) as NonNullable<SendDeps['withLock']> })
    expect(await sendAndDeliver(lockRefused, V)).toEqual({ txid: H.txid, delivered: false, self: false, settle: null })
    expect(lockRefused.settle).not.toHaveBeenCalled()

    const markFails = deps({ markDelivered: vi.fn().mockRejectedValue(new Error('idb')) })
    expect(await sendAndDeliver(markFails, { ...V, recipientKey: A })).toEqual({ txid: H.txid, delivered: false, self: true, settle: null })
    expect(markFails.settle).not.toHaveBeenCalled()
  })
})

describe('describeSettle', () => {
  it('describeSettle covers every outcome', () => {
    expect(describeSettle({ txid: 't', delivered: true, self: false, settle: { status: 'admitted', attestation: ATT } })).toEqual({ kind: 'success', text: 'Sent and settled.' })
    expect(describeSettle({ txid: 't', delivered: true, self: false, settle: { status: 'retry', code: 'ERR_UNAVAILABLE' } }).kind).toBe('info')
    expect(describeSettle({ txid: 't', delivered: true, self: false, settle: null }).kind).toBe('info')
    expect(describeSettle({ txid: 't', delivered: false, self: false, settle: null })).toEqual({ kind: 'warning', text: 'Signed, but the recipient could not be reached yet — delivery will retry automatically.' })
  })
})

describe('explainSendError', () => {
  it('B7: a console without a wallet host gets a clear reason, not the lib TypeError', () => {
    const t = explainSendError(new TypeError('@bsv/mandala: sendHandover needs the host ledger shared with the Mandala profile handler'))
    expect(t).toMatch(/host runtime/)
  })

  it('B7: sendAndDeliver forwards the host pieces to send and settle', async () => {
    const host = { hostWallet: {} as unknown as WalletInterface, ledger: {} as any, markSettled: vi.fn(async () => {}) }
    const d = deps({ host })
    await sendAndDeliver(d, V)
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ ledger: host.ledger, hostWallet: host.hostWallet }))
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ ledger: host.ledger, markSettled: host.markSettled }))
  })

  it('explainSendError names a wallet without the Mandala profile', () => {
    const msg = 'Your wallet cannot send Mandala assets: it needs the 1Color module with the Mandala issuer profile.'
    expect(explainSendError(Object.assign(new Error('x'), { name: 'UnsupportedProfileError' }))).toBe(msg)
    expect(explainSendError(new Error('the wallet lacks @bsv/color-permission-module 0.2.0 with the Mandala issuer-v1 profile'))).toBe(msg)
    expect(explainSendError(new Error('boom'))).toBe('boom')
  })
})
