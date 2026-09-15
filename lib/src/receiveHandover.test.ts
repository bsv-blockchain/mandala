/**
 * The MessageBox hand-over rail, recipient side (offline settlement §0.1
 * rules 3–4): the RECIPIENT runs COVER over the payer's evidence, credits on
 * proof it can verify itself, and is the party that submits — ancestors first,
 * tip last.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'

vi.mock('./overlay.js', async () => {
  const actual = await vi.importActual<typeof import('./overlay.js')>('./overlay.js')
  return { ...actual, submitToOverlay: vi.fn() }
})

const { submitToOverlay, OverlayRefusedError } = await import('./overlay.js')
const { admissionMessageV2 } = await import('./admission.js')
const { configureMandala } = await import('./constants.js')
const { receiveTokens } = await import('./receive.js')

const OVERLAY = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000c3')
const OVERLAY_KEY = OVERLAY.toPublicKey().toString()

const ASSET = `${'11'.repeat(32)}.0`
const AMOUNT = 42

const tokenTx = (parent: Transaction | undefined, amount: number, fill: number): Transaction => {
  const t = new Transaction()
  if (parent != null) {
    t.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromASM('OP_TRUE') })
  }
  t.addOutput({ lockingScript: new MandalaToken().lock(ASSET, amount, new Array(20).fill(fill)), satoshis: 1 })
  return t
}

const GRAND = tokenTx(undefined, AMOUNT, 1)
const MID = tokenTx(GRAND, AMOUNT, 3)
const TIP0 = tokenTx(GRAND, AMOUNT, 9) // 0-hop: spends the admitted coin directly
const TIP1 = tokenTx(MID, AMOUNT, 8) // 1-hop: spends a coin that was itself handed over

const sigOver = (txid: string, outputsToAdmit: number[]): string => {
  const der = OVERLAY.sign(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8')).toDER()
  return typeof der === 'string' ? der : Utils.toHex(der)
}

const grandAdmission = {
  txid: GRAND.id('hex'),
  outputsToAdmit: [0],
  signature: sigOver(GRAND.id('hex'), [0]),
  signerKey: OVERLAY_KEY
}

const body = (over: Record<string, unknown> = {}): any => ({
  v: 2,
  kind: 'handover',
  assetId: ASSET,
  amount: AMOUNT,
  sender: '02' + 'cd'.repeat(32),
  senderMode: 'blinded',
  keyID: 'xfer-1',
  protocolID: [2, 'mandala token'],
  transaction: TIP0.toAtomicBEEF(true),
  outputIndex: 0,
  linkage: [{ txid: TIP0.id('hex'), payload: [1, 1] }],
  admissions: [grandAdmission],
  ...over
})

const mkWallet = (): any => ({ internalizeAction: vi.fn().mockResolvedValue({ accepted: true }) })
const mkBox = (b: any): any => ({
  listMessages: vi.fn().mockResolvedValue([{ messageId: 'm1', body: b }]),
  acknowledgeMessage: vi.fn().mockResolvedValue({})
})

const run = async (b: any, settle?: any): Promise<any> => {
  const wallet = mkWallet()
  const box = mkBox(b)
  const res = await receiveTokens({ wallet, messageBoxClient: box, settle })
  return { res, wallet, box }
}

beforeEach(() => {
  vi.clearAllMocks()
  configureMandala({ overlayUrl: 'http://handover-test', overlayIdentityKey: OVERLAY_KEY })
  vi.mocked(submitToOverlay).mockResolvedValue({ outputsToAdmit: [0] })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
})

afterAll(() => {
  configureMandala({ overlayUrl: '', overlayIdentityKey: '' })
  vi.unstubAllGlobals()
})

describe('receiveTokens — v2 hand-over bodies', () => {
  it('credits a 0-hop covered bundle and the default settle submits the tip', async () => {
    const { res, wallet, box } = await run(body())
    expect(res.failed).toEqual([])
    expect(res.accepted).toHaveLength(1)
    expect(res.accepted[0]).toMatchObject({ handedOver: true, covered: true, settled: true })
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(box.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    expect(vi.mocked(submitToOverlay).mock.calls.map(c => Transaction.fromAtomicBEEF(c[0] as number[]).id('hex')))
      .toEqual([TIP0.id('hex')])
  })

  it('submits the unadmitted ancestor BEFORE the tip for a 1-hop bundle', async () => {
    const { res } = await run(body({
      transaction: TIP1.toAtomicBEEF(true),
      linkage: [
        { txid: MID.id('hex'), payload: [9, 9] },
        { txid: TIP1.id('hex'), payload: [1, 1] }
      ]
    }))
    expect(res.accepted[0]).toMatchObject({ covered: true, settled: true })
    const order = vi.mocked(submitToOverlay).mock.calls.map(c => Transaction.fromAtomicBEEF(c[0] as number[]).id('hex'))
    expect(order).toEqual([MID.id('hex'), TIP1.id('hex')])
    // Each submit carries that transaction's OWN off-chain linkage payload.
    expect(vi.mocked(submitToOverlay).mock.calls[0][1]).toEqual([9, 9])
    expect(vi.mocked(submitToOverlay).mock.calls[1][1]).toEqual([1, 1])
  })

  it('refuses an uncovered bundle, acknowledges it and never credits', async () => {
    // FIX A: σ_I exists for the parent but does NOT name the vout being spent.
    // The overlay has already ruled on that txid, so the coin can never become
    // admitted — a hole, not a hop.
    const { res, wallet, box } = await run(body({
      admissions: [{
        txid: GRAND.id('hex'),
        outputsToAdmit: [1],
        signature: sigOver(GRAND.id('hex'), [1]),
        signerKey: OVERLAY_KEY
      }]
    }))
    expect(res.accepted).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].refusedCode).toBe('not_covered')
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(box.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    expect(submitToOverlay).not.toHaveBeenCalled()
  })

  it('keeps the message for the next pass when a submit is retryably refused', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(
      new OverlayRefusedError({ code: 'ERR_PAUSED', description: 'paused', retryable: true, httpStatus: 400 })
    )
    const { res, box } = await run(body())
    expect(res.accepted).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(box.acknowledgeMessage).not.toHaveBeenCalled()
  })

  it('reports a FINAL refusal on the tip without dropping the credit', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(
      new OverlayRefusedError({ code: 'ERR_CONSERVATION', description: 'bad', retryable: false, httpStatus: 400 })
    )
    const { res, wallet, box } = await run(body())
    expect(res.accepted).toHaveLength(1)
    expect(res.accepted[0]).toMatchObject({ covered: true, settled: false, refusedCode: 'ERR_CONSERVATION' })
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(box.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
  })

  it('uses an injected settle instead of the overlay', async () => {
    const settle = vi.fn().mockResolvedValue(undefined)
    const { res } = await run(body(), settle)
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledTimes(1)
    const args = settle.mock.calls[0][0]
    expect(args.txid).toBe(TIP0.id('hex'))
    expect(args.mustSubmit).toEqual([TIP0.id('hex')])
    expect(args.bytesFor(TIP0.id('hex')).offChainValues).toEqual([1, 1])
    expect(res.accepted[0].settled).toBe(true)
  })

  it('still refuses a v2 body that contradicts its own transaction', async () => {
    const { res, wallet } = await run(body({ amount: 999 }))
    expect(res.accepted).toEqual([])
    expect(String(res.failed[0].error)).toMatch(/amount mismatch/)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('leaves legacy v1 bodies on exactly the old path (no cover, no settle)', async () => {
    const legacy = body()
    delete legacy.v
    delete legacy.kind
    delete legacy.linkage
    delete legacy.admissions
    const { res, wallet } = await run(legacy)
    expect(res.accepted).toHaveLength(1)
    expect(res.accepted[0]).toMatchObject({ handedOver: false, covered: false, settled: true })
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })
})
