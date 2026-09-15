/**
 * The MessageBox hand-over rail, payer side (offline settlement §0.1 rule 1–3).
 *
 * The maintainer's rule is the whole point of these tests: "we shouldn't have
 * to check anything with the issuer when making a payment (we need to be able
 * to do this offline)." So a hand-over send must never touch the overlay —
 * no /submit, no broadcast, no abort — and must hand the recipient enough
 * evidence to decide for itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Beef, LockingScript, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'

vi.mock('./overlay.js', async () => {
  const actual = await vi.importActual<typeof import('./overlay.js')>('./overlay.js')
  return {
    ...actual,
    submitAndBroadcast: vi.fn(),
    submitToOverlay: vi.fn(),
    // Never resolves: the background broadcast-then-journalRemove chain must
    // never race against this file's assertions on the 'accepted' entry.
    broadcastAcceptedTx: vi.fn(async () => await new Promise<void>(() => {}))
  }
})
vi.mock('./ftCandidates.js', () => ({ loadFtCandidates: vi.fn() }))
vi.mock('./ftSelect.js', () => ({ selectFtInputs: vi.fn() }))
vi.mock('./blinding.js', () => ({
  prepareBlindedPayment: vi.fn(),
  recipientCustomInstructions: vi.fn(() => '{}'),
  changeCustomInstructions: vi.fn(() => '{}')
}))
vi.mock('./tokens.js', () => ({
  revealLinkage: vi.fn(async () => ({})),
  matchOutputIndices: vi.fn(() => [0]),
  outpoint: (txid: string, vout: number) => `${txid}.${vout}`
}))
vi.mock('./unlock.js', () => ({ walletMandalaUnlock: vi.fn() }))

const { submitAndBroadcast, submitToOverlay, broadcastAcceptedTx, OverlayRefusedError } = await import('./overlay.js')
const { loadFtCandidates } = await import('./ftCandidates.js')
const { selectFtInputs } = await import('./ftSelect.js')
const { prepareBlindedPayment } = await import('./blinding.js')
const { transferTokens } = await import('./transfer.js')
const { collectHandoverEvidence, journalEvidenceSource } = await import('./handover.js')
const { journalClear, journalList, journalPut } = await import('./txJournal.js')
const { notifyClear } = await import('./notifyJournal.js')

const ASSET = `${'11'.repeat(32)}.0`
const OTHER_ASSET = `${'22'.repeat(32)}.0`
const RECIPIENT = '02' + 'ab'.repeat(32)
const SENDER_BLINDED = '03' + 'cd'.repeat(32)
const OVERLAY_KEY = '02' + 'ef'.repeat(32)

/** An unmined MandalaToken transaction of `assetId`, optionally spending `parent`. */
const tokenTx = (assetId: string, parent?: Transaction, fill = 9): Transaction => {
  const t = new Transaction()
  if (parent != null) {
    t.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromASM('OP_TRUE') })
  }
  t.addOutput({ lockingScript: new MandalaToken().lock(assetId, 5, new Array(20).fill(fill)), satoshis: 1 })
  return t
}

const GRAND = tokenTx(ASSET, undefined, 1) // the admitted ancestor
const MID = tokenTx(ASSET, GRAND, 3) // received offline, never submitted
const TIP = tokenTx(ASSET, MID, 9) // what this send builds
const TIP_BEEF = TIP.toAtomicBEEF(true)
const TXID = TIP.id('hex')

const signableBeef = (): number[] => {
  const t = new Transaction()
  t.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
  return t.toBEEF()
}

const mkWallet = (): any => ({
  createAction: vi.fn().mockResolvedValue({
    signableTransaction: { tx: signableBeef(), reference: 'ref-1' }
  }),
  signAction: vi.fn().mockResolvedValue({ tx: TIP_BEEF, txid: TXID }),
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  getPublicKey: vi.fn().mockResolvedValue({ publicKey: RECIPIENT })
})

/** Evidence that knows σ_I for GRAND and linkage bytes for MID. */
const fullEvidence = (): any => ({
  admissionFor: vi.fn(async (txid: string) =>
    txid === GRAND.id('hex')
      ? { outputsToAdmit: [0], signature: 'deadbeef', signerKey: OVERLAY_KEY }
      : undefined),
  linkageFor: vi.fn(async (txid: string) =>
    txid === MID.id('hex') ? [7, 7, 7] : undefined)
})

const handover = async (evidence: any = fullEvidence()): Promise<{ body: any, result: any, wallet: any, box: any }> => {
  const wallet = mkWallet()
  const box = { sendMessage: vi.fn().mockResolvedValue({}) }
  const result = await transferTokens({
    wallet,
    messageBoxClient: box,
    identityKey: '02' + '11'.repeat(32),
    assetId: ASSET,
    amount: 5,
    recipientKey: RECIPIENT,
    mode: 'handover',
    evidence
  })
  return { body: box.sendMessage.mock.calls[0]?.[0]?.body, result, wallet, box }
}

beforeEach(async () => {
  await journalClear()
  await notifyClear()
  vi.clearAllMocks()
  vi.mocked(loadFtCandidates).mockResolvedValue({ candidates: [], beef: new Beef().toBinary() })
  vi.mocked(selectFtInputs).mockReturnValue({ selected: [], total: 5 })
  vi.mocked(prepareBlindedPayment).mockResolvedValue({
    pubKeyHash: new Array(20).fill(4),
    senderBlinded: SENDER_BLINDED,
    r: 'rr',
    linkage: {}
  } as any)
})

describe('transferTokens({ mode: "handover" }) — sending never contacts the overlay', () => {
  it('never submits, never broadcasts and never aborts the held inputs', async () => {
    const { wallet, result } = await handover()
    expect(submitAndBroadcast).not.toHaveBeenCalled()
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
    // Exactly one createAction — the build. A second one with `sendWith` IS
    // the broadcast, so its absence is the offline guarantee.
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(wallet.createAction.mock.calls[0][0].options?.sendWith).toBeUndefined()
    expect(result).toMatchObject({ txid: TXID, handedOver: true, notified: true })
    expect(result.atomicBeef).toEqual(TIP_BEEF)
  })

  it('posts a v2 hand-over body carrying the tip, its linkage and the ancestor admissions', async () => {
    const { body, result } = await handover()
    expect(body.v).toBe(2)
    expect(body.kind).toBe('handover')
    expect(body).toMatchObject({
      assetId: ASSET,
      amount: 5,
      sender: SENDER_BLINDED,
      senderMode: 'blinded',
      outputIndex: 0,
      protocolID: [2, 'mandala token']
    })
    expect(body.transaction).toEqual(TIP_BEEF)
    expect(body.admissions).toEqual([
      { txid: GRAND.id('hex'), outputsToAdmit: [0], signature: 'deadbeef', signerKey: OVERLAY_KEY }
    ])
    // The tip is itself unadmitted, so its own linkage bytes must ride along
    // or the recipient could not build the /submit body for it.
    const byTxid = Object.fromEntries(body.linkage.map((l: any) => [l.txid, l.payload]))
    expect(Object.keys(byTxid).sort()).toEqual([MID.id('hex'), TXID].sort())
    expect(byTxid[MID.id('hex')]).toEqual([7, 7, 7])
    expect(byTxid[TXID]).toEqual(result.offChainValues)
  })

  it('journals the handed_over entry BEFORE the message is posted', async () => {
    const wallet = mkWallet()
    let stagesAtPost: string[] = []
    const box = {
      sendMessage: vi.fn(async () => {
        stagesAtPost = (await journalList()).map(e => `${e.stage}:${e.txid}`)
        return {}
      })
    }
    await transferTokens({
      wallet,
      messageBoxClient: box,
      identityKey: '02' + '11'.repeat(32),
      assetId: ASSET,
      amount: 5,
      recipientKey: RECIPIENT,
      mode: 'handover',
      evidence: fullEvidence()
    })
    expect(stagesAtPost).toContain(`handed_over:${TXID}`)
    const entry = (await journalList()).find(e => e.txid === TXID)
    expect(entry).toMatchObject({ stage: 'handed_over', reference: 'ref-1' })
    expect(entry?.submit?.txHex).toBe(Utils.toHex(TIP_BEEF))
    expect(entry?.submit?.topics).toEqual(['tm_mandala'])
    expect(typeof entry?.submit?.offChainHex).toBe('string')
  })

  it('still returns handedOver with notified:false when the messagebox is down', async () => {
    const wallet = mkWallet()
    const box = { sendMessage: vi.fn().mockRejectedValue(new Error('box down')) }
    const result = await transferTokens({
      wallet,
      messageBoxClient: box,
      identityKey: '02' + '11'.repeat(32),
      assetId: ASSET,
      amount: 5,
      recipientKey: RECIPIENT,
      mode: 'handover',
      evidence: fullEvidence()
    })
    expect(result).toMatchObject({ handedOver: true, notified: false })
  })
})

describe('transferTokens({ mode: "handover", submitAfterHandover: true }) — maintainer refinement: submit right after an acknowledged hand-over', () => {
  const ADMIT = { outputsToAdmit: [0], admissionSignature: 'cafebabe', admissionIdentityKey: OVERLAY_KEY }

  const send = async (box: any): Promise<any> =>
    await transferTokens({
      wallet: mkWallet(),
      messageBoxClient: box,
      identityKey: '02' + '11'.repeat(32),
      assetId: ASSET,
      amount: 5,
      recipientKey: RECIPIENT,
      mode: 'handover',
      evidence: fullEvidence(),
      submitAfterHandover: true
    })

  it('submits only AFTER the hand-over message is posted (order is inviolable)', async () => {
    const order: string[] = []
    const box = { sendMessage: vi.fn(async () => { order.push('posted'); return {} }) }
    vi.mocked(submitToOverlay).mockImplementation(async () => { order.push('submitted'); return ADMIT })
    await send(box)
    expect(order).toEqual(['posted', 'submitted'])
  })

  it('never attempts the immediate submit when the hand-over message failed to post', async () => {
    const box = { sendMessage: vi.fn().mockRejectedValue(new Error('box down')) }
    const result = await send(box)
    expect(result).toMatchObject({ handedOver: true, notified: false })
    expect(result.settled).toBeUndefined()
    expect(submitToOverlay).not.toHaveBeenCalled()
    const entry = (await journalList()).find(e => e.txid === TXID)
    expect(entry?.stage).toBe('handed_over')
  })

  it('on admission: promotes handed_over → accepted (with σ_I) and returns settled:true with the receipt', async () => {
    const box = { sendMessage: vi.fn().mockResolvedValue({}) }
    vi.mocked(submitToOverlay).mockResolvedValue(ADMIT)
    const result = await send(box)
    expect(result).toMatchObject({
      handedOver: true,
      settled: true,
      admissionSignature: 'cafebabe',
      admissionIdentityKey: OVERLAY_KEY,
      outputsToAdmit: [0]
    })
    const entry = (await journalList()).find(e => e.txid === TXID)
    expect(entry).toMatchObject({
      stage: 'accepted',
      admissionSignature: 'cafebabe',
      admissionIdentityKey: OVERLAY_KEY,
      outputsToAdmit: [0]
    })
    // Immediate — not left for a later reconcile tick.
    expect(broadcastAcceptedTx).toHaveBeenCalledWith(expect.anything(), TXID)
  })

  it('leaves handed_over and returns settled:false on a retryable refusal (reconcile retries later)', async () => {
    const box = { sendMessage: vi.fn().mockResolvedValue({}) }
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', retryable: true }))
    const result = await send(box)
    expect(result).toMatchObject({ handedOver: true, settled: false })
    expect(result.refusedCode).toBeUndefined()
    const entry = (await journalList()).find(e => e.txid === TXID)
    expect(entry?.stage).toBe('handed_over')
  })

  it('leaves handed_over and returns settled:false on a plain network failure', async () => {
    const box = { sendMessage: vi.fn().mockResolvedValue({}) }
    vi.mocked(submitToOverlay).mockRejectedValue(new Error('fetch failed'))
    const result = await send(box)
    expect(result).toMatchObject({ handedOver: true, settled: false })
    const entry = (await journalList()).find(e => e.txid === TXID)
    expect(entry?.stage).toBe('handed_over')
  })

  it('on a FINAL refusal keeps handed_over (never aborts) but surfaces refusedCode', async () => {
    const box = { sendMessage: vi.fn().mockResolvedValue({}) }
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_CONSERVATION', retryable: false }))
    const wallet = mkWallet()
    const result = await transferTokens({
      wallet,
      messageBoxClient: box,
      identityKey: '02' + '11'.repeat(32),
      assetId: ASSET,
      amount: 5,
      recipientKey: RECIPIENT,
      mode: 'handover',
      evidence: fullEvidence(),
      submitAfterHandover: true
    })
    expect(result).toMatchObject({ handedOver: true, settled: false, refusedCode: 'ERR_CONSERVATION' })
    const entry = (await journalList()).find(e => e.txid === TXID)
    expect(entry?.stage).toBe('handed_over')
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('never throws after the hand-over message was posted, even when the overlay submit fails', async () => {
    const box = { sendMessage: vi.fn().mockResolvedValue({}) }
    vi.mocked(submitToOverlay).mockRejectedValue(new Error('boom'))
    await expect(send(box)).resolves.toMatchObject({ handedOver: true, settled: false })
  })
})

describe('collectHandoverEvidence — the payer-side walk (FIX K)', () => {
  it('stops at an admitted ancestor and never walks past it', async () => {
    const ev = fullEvidence()
    const { admissions, linkage } = await collectHandoverEvidence(TIP, ASSET, ev)
    expect([...admissions.keys()]).toEqual([GRAND.id('hex')])
    expect([...linkage.keys()]).toEqual([MID.id('hex')])
    // GRAND's own (absent) parents are never queried.
    expect(ev.linkageFor).not.toHaveBeenCalledWith(TIP.id('hex'))
  })

  it('does not walk inputs of another asset (FIX K)', async () => {
    const foreign = tokenTx(OTHER_ASSET, undefined, 2)
    const tip = tokenTx(ASSET, foreign, 8)
    const ev = fullEvidence()
    const { admissions, linkage } = await collectHandoverEvidence(tip, ASSET, ev)
    expect(admissions.size).toBe(0)
    expect(linkage.size).toBe(0)
    expect(ev.admissionFor).not.toHaveBeenCalled()
  })
})

describe('journalEvidenceSource — the lib’s own journals as the default evidence', () => {
  it('reads σ_I from an accepted entry and linkage from a handed_over entry', async () => {
    await journalPut({
      txid: GRAND.id('hex'),
      stage: 'accepted',
      at: 1,
      outputsToAdmit: [0],
      admissionSignature: 'deadbeef',
      admissionIdentityKey: OVERLAY_KEY
    })
    await journalPut({
      txid: MID.id('hex'),
      stage: 'handed_over',
      at: 2,
      submit: { txHex: '00', offChainHex: '070707', topics: ['tm_mandala'] }
    })
    const src = journalEvidenceSource()
    expect(await src.admissionFor(GRAND.id('hex')))
      .toEqual({ outputsToAdmit: [0], signature: 'deadbeef', signerKey: OVERLAY_KEY })
    expect(await src.linkageFor(MID.id('hex'))).toEqual([7, 7, 7])
    expect(await src.admissionFor(MID.id('hex'))).toBeUndefined()
    expect(await src.linkageFor(GRAND.id('hex'))).toBeUndefined()
  })
})

describe('transferTokens({ mode: "handover" }) — the reference is durable and returned', () => {
  it('returns the createAction reference and journals it on the handed_over entry', async () => {
    const { result } = await handover()
    expect(result.reference).toBe('ref-1')
    expect(await journalList()).toMatchObject([
      { txid: TXID, stage: 'handed_over', reference: 'ref-1' }
    ])
  })
})
