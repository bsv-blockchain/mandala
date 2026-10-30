/**
 * MessageBox receive of v4 hand-overs (design §9 B7): strict body parse,
 * script-checked output, the host's own submit (online) or COVER with the S1
 * hop checks (offline), the host-ledger record BEFORE internalize, a plain
 * BRC-207 receipt, and acknowledge only on credit or a definitive refusal.
 *
 * The overlay submit is mocked with real σ (C.0 key); refusals are real
 * `OverlayRefusedError`s. Chains are really signed (signedChain.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { P2PKH, Transaction, Utils } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import {
  classifyReceiveError, dismissHandover, ERR_BODY_UNREADABLE, InvalidTransferError, parseHandoverBody,
  receiveHandovers, UNREADABLE_BUDGET
} from './receive.js'
import { configureMandala, MESSAGEBOX } from './constants.js'
import { assetTag, colorTopic } from './naming.js'
import { OverlayRefusedError, submitToOverlay } from './overlay.js'
import { handoverBody } from './notifyJournal.js'
import { createHostLedger, type HostLedger } from './hostLedger.js'
import { configureStorage, memoryStorage } from './storage.js'
import { attestationFromSteak } from './attestation.js'
import { OVERLAY_KEY, signedSteak } from './__fixtures__/overlaySigner.js'
import { A, B, chain, env, ID, sats, sigma, signed, tok } from './__fixtures__/signedChain.js'

vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitToOverlay: vi.fn()
}))

const A_KEY = A.toPublicKey().toString()
const OTHER = `${'d8'.repeat(32)}_0`
const PREFIX = 'cHJlZml4cHJlZml4cHJlZg=='
const SUFFIX = 'c3VmZml4c3VmZml4c3VmZg=='
const offline = (): OverlayRefusedError => new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', description: 'fetch failed', retryable: true, httpStatus: 0 })

let C: Awaited<ReturnType<typeof chain>>
let ledger: HostLedger

/** The overlay admits each tx with these outputs (default: every 1-sat token output). */
function overlayAdmits (admitted: Record<string, number[]> = {}): void {
  vi.mocked(submitToOverlay).mockImplementation(async (beef: number[]) => {
    const tx = Transaction.fromAtomicBEEF(beef)
    const txid = tx.id('hex')
    const outs = admitted[txid] ?? tx.outputs.flatMap((o, i) => {
      try { OneColor.decode(o.lockingScript); return o.satoshis === 1 ? [i] : [] } catch { return [] }
    })
    const attestation = attestationFromSteak(txid, ID, await signedSteak(txid, { [colorTopic(ID)]: outs }))!
    return { topic: colorTopic(ID), outputsToAdmit: outs, admissionSignature: attestation.signature, admissionIdentityKey: OVERLAY_KEY, attestation }
  })
}

function body (over: Record<string, unknown> = {}, tip?: Transaction): Record<string, unknown> {
  const t = tip ?? C.T
  return {
    ...handoverBody({
      assetId: ID,
      amount: 6n,
      outputIndex: 0,
      tx: t.toAtomicBEEF(),
      derivationPrefix: PREFIX,
      derivationSuffix: SUFFIX,
      senderIdentityKey: A_KEY,
      senderMode: 'identity',
      admissions: [C.gSigma],
      linkage: [{ txid: C.P.id('hex'), offChainValues: env([0]) }, { txid: t.id('hex'), offChainValues: env([0, 1]) }]
    }),
    ...over
  }
}

function mkMb (messages: Array<{ messageId: string, body: unknown }>) {
  return {
    listMessages: vi.fn(async () => messages.map(m => ({ ...m, sender: A_KEY }))),
    acknowledgeMessage: vi.fn(async () => ({}))
  }
}

const mkWallet = () => ({ internalizeAction: vi.fn(async () => ({ accepted: true })) }) as any

beforeEach(async () => {
  vi.mocked(submitToOverlay).mockReset()
  configureStorage(memoryStorage())
  configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: OVERLAY_KEY })
  C = await chain()
  ledger = createHostLedger(memoryStorage())
})

describe('parseHandoverBody (v4 strict)', () => {
  it('derives the plain receipt and decodes the evidence', () => {
    const p = parseHandoverBody(body({ note: 'lunch money' }))
    expect(p.assetId).toBe(ID)
    expect(p.amount).toBe(6n)
    expect(p.receipt).toEqual({ version: 1, assetId: ID, derivationPrefix: PREFIX, derivationSuffix: SUFFIX, senderIdentityKey: A_KEY })
    expect(p.admissions).toEqual([C.gSigma])
    expect([...p.linkage.keys()]).toEqual([C.P.id('hex'), C.T.id('hex')])
    expect(p.note).toBe('lunch money')
  })

  it('accepts a JSON string body', () => {
    expect(parseHandoverBody(JSON.stringify(body())).amount).toBe(6n)
  })

  const bad: Array<[string, () => unknown]> = [
    ['null', () => null],
    ['a v3 body', () => body({ v: 3 })],
    ['a wrong kind', () => body({ kind: 'payment' })],
    ['an extra member', () => body({ receipt: {} })],
    ['a missing linkage', () => { const b = body(); delete b.linkage; return b }],
    ['a JSON number amount', () => body({ amount: 6 })],
    ['a non-canonical amount', () => body({ amount: '06' })],
    ['a zero amount', () => body({ amount: '0' })],
    ['an amount above uint64', () => body({ amount: (1n << 64n).toString() })],
    ['a non-Mandala asset id (_1)', () => body({ assetId: `${'c7'.repeat(32)}_1` })],
    ['a bad sender key', () => body({ senderIdentityKey: '02' + 'zz'.repeat(32) })],
    ['an off-curve sender key', () => body({ senderIdentityKey: '02' + 'ff'.repeat(32) })],
    ['a bad senderMode', () => body({ senderMode: 'secret' })],
    ['a prefix of 49 bytes', () => body({ derivationPrefix: 'a'.repeat(49) })],
    ['odd-length transaction hex', () => body({ transaction: 'abc' })],
    ['an outputIndex above uint32', () => body({ outputIndex: 2 ** 32 })],
    ['an admission with an extra member', () => body({ admissions: [{ ...C.gSigma, topic: 'x' }] })],
    ['an admission with no outputs', () => body({ admissions: [{ ...C.gSigma, outputs: [] }] })],
    ['a linkage row with uppercase hex', () => body({ linkage: [{ txid: C.T.id('hex'), offChainValues: 'AB' }] })],
    ['a duplicate linkage txid', () => body({ linkage: [{ txid: C.T.id('hex'), offChainValues: 'ab' }, { txid: C.T.id('hex'), offChainValues: 'cd' }] })],
    ['a non-string note', () => body({ note: 5 })]
  ]
  it.each(bad)('rejects %s with InvalidTransferError', (_n, b) => {
    let err: unknown
    try { parseHandoverBody(b()) } catch (e) { err = e }
    expect(err).toBeInstanceOf(InvalidTransferError)
  })
})

describe('receiveHandovers: online (the recipient host submits first)', () => {
  it('submits the unadmitted chain parents first, records settled, then internalizes the plain receipt and acks', async () => {
    overlayAdmits()
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    let recordedFirst = false
    wallet.internalizeAction.mockImplementation(async () => {
      recordedFirst = (await ledger.get(C.T.id('hex')))?.state === 'settled'
      return { accepted: true }
    })
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect(recordedFirst).toBe(true)
    expect(mb.listMessages).toHaveBeenCalledWith({ messageBox: MESSAGEBOX, acceptPayments: false })
    const calls = vi.mocked(submitToOverlay).mock.calls
    expect(calls.map(c => Transaction.fromAtomicBEEF(c[0]).id('hex'))).toEqual([C.P.id('hex'), C.T.id('hex')])
    expect(calls[0][1]).toEqual(env([0]))
    expect(calls[1][1]).toEqual(env([0, 1]))
    expect(calls[1][3]).toEqual([colorTopic(ID)])
    expect(calls[1][4]).toBe(OVERLAY_KEY)
    const ia = wallet.internalizeAction.mock.calls[0][0]
    expect(ia.outputs[0]).toEqual({
      outputIndex: 0,
      protocol: 'basket insertion',
      insertionRemittance: {
        basket: `p color ${assetTag(ID)}`,
        customInstructions: JSON.stringify({ version: 1, assetId: ID, derivationPrefix: PREFIX, derivationSuffix: SUFFIX, senderIdentityKey: A_KEY })
      }
    })
    expect(ia.labels).toEqual(['mandala', 'receive'])
    expect(r.accepted[0]).toEqual({ messageId: 'm1', txid: C.T.id('hex'), assetId: ID, amount: 6n, outputIndex: 0, offline: false })
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
  })

  it('works without a host ledger (an app over BRC-100): submit, verify, internalize', async () => {
    overlayAdmits()
    const wallet = mkWallet()
    const r = await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body() }]) })
    expect(r.accepted).toHaveLength(1)
  })

  it('an admission that does not cover the received output is refused and acknowledged', async () => {
    overlayAdmits({ [C.T.id('hex')]: [1] })
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect(r.failed[0].code).toBe('ERR_NOT_ADMITTED')
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(mb.acknowledgeMessage).toHaveBeenCalled()
  })

  it('a final verdict is acknowledged with its code; nothing recorded, nothing credited', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_CONSERVATION', httpStatus: 400 }))
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect(r.failed[0].code).toBe('ERR_CONSERVATION')
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(await ledger.list()).toEqual([])
  })

  it('a retryable typed verdict never falls back offline: unacknowledged, nothing credited', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_FROZEN', httpStatus: 409, retryable: true }))
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger, processed })
    expect(r.failed[0].code).toBe('ERR_FROZEN')
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    expect(processed.has('m1')).toBe(false)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('the body amount must equal the script amount', async () => {
    overlayAdmits()
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body({ amount: '7' }) }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect((r.failed[0].error as Error).message).toMatch(/amount mismatch/)
    expect(mb.acknowledgeMessage).toHaveBeenCalled()
    expect(submitToOverlay).not.toHaveBeenCalled()
  })

  it('a 2-sat output, another asset and a non-token output are refused before any submit', async () => {
    for (const out of [tok(6n, B, ID, 2), tok(6n, B, OTHER), { lockingScript: new P2PKH().lock(B.toPublicKey().toHash() as number[]), satoshis: 1 }]) {
      const t = await signed([[C.P, 0, A], [C.P, 1, A]], [out, sats(A, 800)])
      const wallet = mkWallet()
      const mb = mkMb([{ messageId: 'm1', body: body({}, t) }])
      const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
      expect(r.failed[0].error).toBeInstanceOf(InvalidTransferError)
      expect(mb.acknowledgeMessage).toHaveBeenCalled()
    }
    expect(submitToOverlay).not.toHaveBeenCalled()
  })
})

describe('receiveHandovers: offline (transport failure only)', () => {
  it('COVER accepts: pending record with the exact submit chain, then internalize; offline true', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(offline())
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect(r.accepted[0]).toMatchObject({ txid: C.T.id('hex'), offline: true })
    const rec = await ledger.get(C.T.id('hex'))
    expect(rec).toMatchObject({ state: 'pending', outputs: [0] })
    expect(rec?.submits?.map(s => s.txid)).toEqual([C.P.id('hex'), C.T.id('hex')])
    expect(rec?.submits?.[1].offChainHex).toBe(Utils.toHex(env([0, 1])))
    expect(mb.acknowledgeMessage).toHaveBeenCalled()
  })

  it('a verified σ of the tip itself credits settled even offline', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(offline())
    const wallet = mkWallet()
    const tipSigma = await sigma(C.T, [0, 1])
    const r = await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body({ admission: tipSigma }) }]), ledger })
    expect(r.accepted[0].offline).toBe(false)
    expect(await ledger.get(C.T.id('hex'))).toMatchObject({ state: 'settled', attestation: tipSigma })
  })

  it('without a host ledger nothing is credited offline (retry later)', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(offline())
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(r.failed).toHaveLength(1)
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('evidence that does not reach σ stays for an online pass (ERR_NOT_COVERED, not acked)', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(offline())
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body({ admissions: [] }) }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect(r.failed[0].code).toBe('ERR_NOT_COVERED')
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('S1: value minted from nothing is refused for good (acknowledged), never credited', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(offline())
    const minted = await signed([[C.P, 0, A], [C.P, 1, A]], [tok(60n, B), sats(A, 800)])
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body({ amount: '60' }, minted) }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect(r.failed[0].code).toBe('ERR_EVIDENCE')
    expect(mb.acknowledgeMessage).toHaveBeenCalled()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(await ledger.list()).toEqual([])
  })

  it('a pending receipt received again online is upgraded to settled and markSettled runs after the internalize', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(offline())
    const wallet = mkWallet()
    await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body() }]), ledger })
    overlayAdmits()
    const marked: string[] = []
    const r = await receiveHandovers({
      wallet,
      messageBoxClient: mkMb([{ messageId: 'm1', body: body() }]),
      ledger,
      markSettled: async t => { marked.push(t) }
    })
    expect(r.accepted[0].offline).toBe(false)
    expect(marked).toEqual([C.T.id('hex')])
    expect(await ledger.get(C.T.id('hex'))).toMatchObject({ state: 'settled', marked: true })
  })

  it('a ledger write failure credits nothing', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(offline())
    const store = memoryStorage()
    const broken = createHostLedger({ ...store, setItem: async () => { throw new Error('disk full') } })
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger: broken })
    expect(r.failed).toHaveLength(1)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
  })
})

describe('receiveHandovers: inbox robustness', () => {
  it('internalize "already" counts as credited (crash between internalize and ack)', async () => {
    overlayAdmits()
    const wallet = mkWallet()
    wallet.internalizeAction.mockRejectedValueOnce(new Error('output already exists'))
    const r = await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body() }]), ledger })
    expect(r.accepted).toHaveLength(1)
  })

  it('a wallet refusal named ProfileDataError is acknowledged; a transport fault is retried', async () => {
    overlayAdmits()
    for (const [err, acked] of [[new Error('[ProfileDataError] no'), true], [new Error('fetch failed'), false]] as const) {
      const wallet = mkWallet()
      wallet.internalizeAction.mockRejectedValueOnce(err)
      const mb = mkMb([{ messageId: 'm1', body: body() }])
      await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
      expect(mb.acknowledgeMessage.mock.calls.length > 0).toBe(acked)
    }
  })

  it('processed dedup: two parallel calls internalize once', async () => {
    overlayAdmits()
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const processed = new Set<string>()
    await Promise.all([
      receiveHandovers({ wallet, messageBoxClient: mb, processed, ledger }),
      receiveHandovers({ wallet, messageBoxClient: mb, processed, ledger })
    ])
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('an unreadable body is retried within its budget, then skipped as exhausted until dismissed (deferred item 4)', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: '[Error: Failed to decrypt or parse message]' }])
    for (let i = 0; i < UNREADABLE_BUDGET; i++) {
      const r = await receiveHandovers({ wallet, messageBoxClient: mb })
      expect(r.failed[0]).toMatchObject({ code: ERR_BODY_UNREADABLE })
      expect(r.failed[0].exhausted).toBeUndefined()
    }
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(r.failed[0]).toMatchObject({ code: ERR_BODY_UNREADABLE, exhausted: true })
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    await dismissHandover({ messageBoxClient: mb, messageId: 'm1' })
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
  })

  it('an unreadable body next to a good one: the good one is credited', async () => {
    overlayAdmits()
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: '{not json' }, { messageId: 'm2', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
    expect(r.accepted.map(a => a.messageId)).toEqual(['m2'])
    expect(mb.acknowledgeMessage).toHaveBeenCalledTimes(1)
  })

  it('assetId filter skips other assets without touching them', async () => {
    overlayAdmits()
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }, { messageId: 'm2', body: { ...body(), assetId: OTHER } }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, assetId: ID, ledger })
    expect(r.accepted.map(x => x.messageId)).toEqual(['m1'])
    expect(r.failed).toEqual([])
  })

  it('classifies by name, [ClassName] prefix and (ERR_X[, retryable]) code', () => {
    expect(classifyReceiveError(new InvalidTransferError('x', 'ERR_NOT_COVERED')).disposition).toBe('retry')
    expect(classifyReceiveError(new InvalidTransferError('x')).disposition).toBe('ack')
    expect(classifyReceiveError(new Error('[ColorConsentDeclinedError] no')).disposition).toBe('declined')
    expect(classifyReceiveError(new Error('refused (ERR_LINKAGE): x')).disposition).toBe('ack')
    expect(classifyReceiveError(new Error('refused (ERR_LINKAGE, retryable): x')).disposition).toBe('retry')
    expect(classifyReceiveError(new OverlayRefusedError({ code: 'ERR_SHAPE', httpStatus: 400 }))).toEqual({ disposition: 'ack', code: 'ERR_SHAPE' })
  })

  it('fails closed without an overlay identity key (S5): retried, nothing submitted', async () => {
    configureMandala({ overlayIdentityKey: '' })
    try {
      const wallet = mkWallet()
      const mb = mkMb([{ messageId: 'm1', body: body() }])
      const r = await receiveHandovers({ wallet, messageBoxClient: mb, ledger })
      expect(r.failed).toHaveLength(1)
      expect(submitToOverlay).not.toHaveBeenCalled()
      expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    } finally {
      configureMandala({ overlayIdentityKey: OVERLAY_KEY })
    }
  })
})
