/**
 * Holder hand-over through a module-hosting wallet (plan 04 Task 13, C§8.1,
 * B2/B5, D24, D27): send (journaled `signed`), deliver (`delivered`), settle
 * (post-ACK submit, verified attestation, sendWith).
 *
 * The wallet is a real ProtoWallet for every key operation (recipient
 * linkage, self-send derivation) with createAction/signAction/abortAction
 * stubbed; `signAction` answers like @bsv/color-permission-module 0.2.0 with a
 * `colorHandoff` member over a real transaction. The overlay submit is
 * mocked; refusals are real `OverlayRefusedError`s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hash, LockingScript, P2PKH, PrivateKey, ProtoWallet, Random, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import {
  deliverHandover, markHandoverDelivered, resubmitDelivered, sendHandover, settleHandover,
  type HandoverResult
} from './handover.js'
import { OverlayRefusedError, submitToOverlay } from './overlay.js'
import { configureMandala, ATTESTED_PROFILE_ID, MANDALA_PROFILE_ID, MESSAGEBOX } from './constants.js'
import { colorProtocolID, colorTopic } from './naming.js'
import { PLAN_LABEL_PREFIX } from './plan.js'
import { configureStorage, getStorage, memoryStorage } from './storage.js'
import { hasFreshIntent, journalClear, journalGet, journalList, journalListHandovers, journalPut } from './txJournal.js'
import { notifyClear, notifyList, reconcileNotifications } from './notifyJournal.js'
import { reconcileWallet } from './reconcile.js'
import { blindingClear, blindingGet } from './blindingJournal.js'
import { attestationFromSteak, type Attestation } from './attestation.js'
import { OVERLAY_KEY, signedSteak } from './__fixtures__/overlaySigner.js'

vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitToOverlay: vi.fn()
}))

const A_PRIV = new PrivateKey(31)
const A = A_PRIV.toPublicKey().toString()
const B = new PrivateKey(77).toPublicKey().toString()
const ID = `${'c7'.repeat(32)}_0`
const SUBMISSION_HEX = Utils.toHex(Utils.toArray('{"outputs":[]}', 'utf8'))
const pkh = new PrivateKey(11).toPublicKey().toHash() as number[]

type HandoffMode = 'ok' | 'none' | 'wrongTxid' | 'noTip'

/** The tip a signAction call produces: a real tx carrying the requested output 0. */
function buildTip (lockingScriptHex: string): { tx: number[], txid: string } {
  const src = new Transaction()
  src.addOutput({ satoshis: 10, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(lockingScriptHex) })
  return { tx: tx.toAtomicBEEF(), txid: tx.id('hex') }
}

function mkWallet () {
  const proto = new ProtoWallet(A_PRIV)
  const state: { handoff: HandoffMode, lastTip?: { tx: number[], txid: string }, broadcast: () => Promise<any> } = {
    handoff: 'ok',
    broadcast: async () => ({ sendWithResults: [{ txid: state.lastTip?.txid, status: 'unproven' }] })
  }
  let lastScript = ''
  const w = {
    state,
    getPublicKey: vi.fn(async (a: any) => await proto.getPublicKey(a)),
    encrypt: vi.fn(async (a: any) => await proto.encrypt(a)),
    decrypt: vi.fn(async (a: any) => await proto.decrypt(a)),
    revealCounterpartyKeyLinkage: vi.fn(async (a: any) => await proto.revealCounterpartyKeyLinkage(a)),
    createAction: vi.fn(async (args: any) => {
      if (args.options?.sendWith != null) return await state.broadcast()
      lastScript = args.outputs[0].lockingScript
      return { signableTransaction: { tx: [0], reference: 'ref-h' } }
    }),
    signAction: vi.fn(async (_a: any) => {
      const tip = buildTip(lastScript)
      state.lastTip = tip
      const leaf = {
        declarationTx: 'ab',
        transactions: [],
        attestations: [],
        submissions: state.handoff === 'noTip' ? [] : [{ txid: tip.txid, offChainValues: SUBMISSION_HEX }]
      }
      const colorHandoff = state.handoff === 'none'
        ? undefined
        : { version: 1, txid: state.handoff === 'wrongTxid' ? 'f'.repeat(64) : tip.txid, profileData: { [ATTESTED_PROFILE_ID]: { [ID]: leaf } } }
      return { tx: tip.tx, txid: tip.txid, ...(colorHandoff != null ? { colorHandoff } : {}) }
    }),
    abortAction: vi.fn(async (_a: any) => ({ aborted: true }))
  }
  return w
}

/** Concatenate the `p color plan` chunks back into the plan JSON. */
function decodePlan (labels: string[]): any {
  const parts = labels
    .filter(l => l.startsWith(PLAN_LABEL_PREFIX + ' '))
    .map(l => l.split(' '))
    .map(p => ({ i: Number(p[3]), hex: p[5] }))
    .sort((x, y) => x.i - y.i)
  return JSON.parse(Utils.toUTF8(Utils.toArray(parts.map(p => p.hex).join(''), 'hex')))
}

const mkMb = () => ({ sendMessage: vi.fn(async (_a: { recipient: string, messageBox: string, body: object }) => ({})) })
const nonce = (): string => Utils.toBase64(Random(32)) // 44 chars, like createNonce output

let wallet: ReturnType<typeof mkWallet>
const S = (over: Record<string, unknown> = {}) => ({
  wallet: wallet as any,
  identityKey: A,
  assetId: ID,
  amount: 5n,
  recipientKey: B,
  ...over
}) as Parameters<typeof sendHandover>[0]

async function attest (txid: string, outputs: number[] = [0]): Promise<Attestation> {
  const steak = await signedSteak(txid, { [colorTopic(ID)]: outputs })
  return attestationFromSteak(txid, ID, steak)!
}

async function admittedFor (txid: string) {
  const attestation = await attest(txid)
  return {
    topic: colorTopic(ID),
    outputsToAdmit: [0],
    admissionSignature: attestation.signature,
    admissionIdentityKey: OVERLAY_KEY,
    attestation
  }
}

const journalKeys = async (): Promise<string[]> => (await getStorage().keys('mandala.txJournal.')).sort()

beforeEach(async () => {
  await journalClear()
  await notifyClear()
  await blindingClear()
  configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: OVERLAY_KEY })
  wallet = mkWallet()
  vi.mocked(submitToOverlay).mockReset()
})

describe('sendHandover', () => {
  it('builds a noSend 1-sat output with a transfer plan, blinds by default and journals signed before resolving', async () => {
    const h = await sendHandover(S())
    const ca = wallet.createAction.mock.calls[0][0]
    expect(ca.options).toEqual({ noSend: true, randomizeOutputs: false })
    expect(ca.outputs).toHaveLength(1)
    expect(ca.outputs[0].satoshis).toBe(1)
    expect(ca.outputs[0].outputDescription).toBe('Mandala token payment')
    expect(ca.description).toBe('Send Mandala tokens')
    expect(ca.labels).toEqual(expect.arrayContaining(['mandala', 'transfer']))
    const plan = decodePlan(ca.labels)
    expect(plan.assets).toEqual([ID])
    expect(plan.operations).toEqual([{ assetId: ID, operation: 'transfer' }])
    expect(plan.ownedOutputs).toEqual([])
    const leaf = plan.profileData[MANDALA_PROFILE_ID][ID]
    expect(leaf.outputs).toHaveLength(1)
    expect(leaf.outputs[0].index).toBe(0)
    expect(leaf.outputs[0].linkage.counterparty).toBe(B)
    expect(leaf.outputs[0].linkage.prover).toBe(A)
    expect(leaf.outputs[0].linkage.protocolID).toEqual(colorProtocolID(ID, h.receipt.derivationPrefix, h.receipt.derivationSuffix))
    expect(wallet.signAction).toHaveBeenCalledWith({ reference: 'ref-h', spends: {} })

    expect(h.txid).toBe(wallet.state.lastTip!.txid)
    expect(h.tx).toEqual(wallet.state.lastTip!.tx)
    expect(h.reference).toBe('ref-h')
    expect(h.outputIndex).toBe(0)
    expect(h.receipt.senderIdentityKey).not.toBe(A) // blinded by default
    expect(Object.keys(h.receipt)).toEqual(['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'profileData'])
    expect(h.receipt.version).toBe(1)
    expect(h.receipt.assetId).toBe(ID)
    expect(Object.keys(h.receipt.profileData)).toEqual([ATTESTED_PROFILE_ID])
    expect(h.offChainValues).toEqual(Utils.toArray(SUBMISSION_HEX, 'hex'))

    // journal entry is durable before sendHandover resolves
    const e = (await journalList()).find(x => x.txid === h.txid)
    expect(e?.stage).toBe('signed')
    expect(e).toMatchObject({
      reference: 'ref-h',
      assetId: ID,
      recipientKey: B,
      outputIndex: 0,
      receipt: JSON.stringify(h.receipt),
      submit: { txHex: Utils.toHex(h.tx), offChainHex: SUBMISSION_HEX, topics: [colorTopic(ID)] }
    })
    expect(await hasFreshIntent()).toBe(false)
    expect((await journalListHandovers()).map(x => x.txid)).toEqual([h.txid])
    // r is committed to the recipient outpoint
    const rec = await blindingGet(`${h.txid}.0`)
    expect(rec?.senderBlinded).toBe(h.receipt.senderIdentityKey)
    // the requested script locks the amount to the linkage-derived key
    expect(ca.outputs[0].lockingScript).toMatch(/^[0-9a-f]+$/)
  })

  it('blind: false shows the real sender key', async () => {
    const h = await sendHandover(S({ blind: false }))
    expect(h.receipt.senderIdentityKey).toBe(A)
    expect(await blindingGet(`${h.txid}.0`)).toBeUndefined()
  })

  it('a note of 5..50 bytes becomes the description', async () => {
    await sendHandover(S({ note: 'rent for october' }))
    expect(wallet.createAction.mock.calls[0][0].description).toBe('rent for october')
    await journalClear()
    wallet = mkWallet()
    await sendHandover(S({ note: 'hey' }))
    expect(wallet.createAction.mock.calls[0][0].description).toBe('Send Mandala tokens')
  })

  it('self-send: owned output under forSelf, no plan leaf, unblinded', async () => {
    const h = await sendHandover(S({ recipientKey: A }))
    const ca = wallet.createAction.mock.calls[0][0]
    const plan = decodePlan(ca.labels)
    expect(plan.ownedOutputs).toEqual([{
      outputIndex: 0, assetId: ID, derivationPrefix: h.receipt.derivationPrefix, derivationSuffix: h.receipt.derivationSuffix, senderIdentityKey: A
    }])
    expect(plan.profileData).toBeUndefined()
    const protocolID = colorProtocolID(ID, h.receipt.derivationPrefix, h.receipt.derivationSuffix)
    expect(wallet.getPublicKey).toHaveBeenCalledWith({ protocolID, keyID: 'color', counterparty: A, forSelf: true })
    const { publicKey } = await new ProtoWallet(A_PRIV).getPublicKey({ protocolID, keyID: 'color', counterparty: A, forSelf: true })
    const selfPkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
    expect(ca.outputs[0].lockingScript).toBe(new OneColor().lock(ID, 5n, selfPkh).toHex())
    expect(h.receipt.senderIdentityKey).toBe(A)
    expect(wallet.encrypt).not.toHaveBeenCalled()
  })

  it('self-send: journaled delivered (no delivery is owed), so reconcileWallet re-submits it and nothing is redelivered', async () => {
    const h = await sendHandover(S({ recipientKey: A }))
    expect((await journalGet(h.txid))?.stage).toBe('delivered')
    // Even once aged past the redelivery window, the sender is never sent its own receipt.
    const e = await journalGet(h.txid)
    await journalPut({ ...e!, at: Date.now() - 61_000 })
    const mb = mkMb()
    expect(await reconcileNotifications(mb)).toEqual([])
    expect(mb.sendMessage).not.toHaveBeenCalled()

    vi.mocked(submitToOverlay).mockResolvedValue(await admittedFor(h.txid) as any)
    const r = await reconcileWallet(wallet as any, { sweep: false })
    expect(submitToOverlay).toHaveBeenCalledTimes(1)
    expect(vi.mocked(submitToOverlay).mock.calls[0][0]).toEqual(h.tx)
    expect(vi.mocked(submitToOverlay).mock.calls[0][3]).toEqual([colorTopic(ID)])
    expect(r.resubmitted).toEqual([h.txid])
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('no colorHandoff ⇒ rejects, aborts the action, journals nothing', async () => {
    wallet.state.handoff = 'none'
    await expect(sendHandover(S())).rejects.toThrow(/color-permission-module/)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-h' })
    expect(await journalList()).toEqual([])
  })

  it('a colorHandoff for another txid or without the tip submission ⇒ rejects and aborts', async () => {
    wallet.state.handoff = 'wrongTxid'
    await expect(sendHandover(S())).rejects.toThrow(/color-permission-module/)
    wallet.state.handoff = 'noTip'
    await expect(sendHandover(S())).rejects.toThrow(/color-permission-module/)
    expect(wallet.abortAction).toHaveBeenCalledTimes(2)
    expect(await journalList()).toEqual([])
  })

  it('a signed entry that does not land rejects and aborts (nobody has the bytes yet)', async () => {
    const mem = memoryStorage()
    configureStorage({
      ...mem,
      setItem: async (k: string, v: string) => {
        if (k.startsWith('mandala.txJournal.') && !k.startsWith('mandala.txJournal.intent:') && JSON.parse(v).stage === 'signed') {
          throw new Error('disk full')
        }
        await mem.setItem(k, v)
      }
    })
    try {
      await expect(sendHandover(S())).rejects.toThrow()
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-h' })
    } finally {
      configureStorage(null)
    }
  })

  it('second concurrent sendHandover rejects BusyError', async () => {
    const p1 = sendHandover(S())
    const p2 = sendHandover(S())
    await expect(p2).rejects.toMatchObject({ name: 'BusyError' })
    await expect(p1).resolves.toMatchObject({ outputIndex: 0 })
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
  })

  it('uses caller remittances verbatim', async () => {
    const N1 = nonce()
    const N2 = nonce()
    expect(N1).toHaveLength(44)
    const h = await sendHandover(S({ derivationPrefix: N1, derivationSuffix: N2 }))
    expect(h.receipt.derivationPrefix).toBe(N1)
    expect(h.receipt.derivationSuffix).toBe(N2)
    const plan = decodePlan(wallet.createAction.mock.calls[0][0].labels)
    expect(plan.profileData[MANDALA_PROFILE_ID][ID].outputs[0].linkage.protocolID).toEqual(colorProtocolID(ID, N1, N2))
  })

  it('rejects bad remittances before any wallet call', async () => {
    await expect(sendHandover(S({ derivationPrefix: nonce() }))).rejects.toThrow(TypeError)
    await expect(sendHandover(S({ derivationPrefix: nonce() }))).rejects.toThrow(/together/)
    await expect(sendHandover(S({ derivationSuffix: nonce() }))).rejects.toThrow(/together/)
    await expect(sendHandover(S({ derivationPrefix: nonce(), derivationSuffix: 'x'.repeat(49) }))).rejects.toThrow(/48/)
    await expect(sendHandover(S({ derivationPrefix: 'a b', derivationSuffix: nonce() }))).rejects.toThrow(TypeError)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(await journalKeys()).toEqual([])
  })

  it('rejects bad amounts, keys and assets before any wallet call', async () => {
    await expect(sendHandover(S({ amount: 0n }))).rejects.toThrow()
    await expect(sendHandover(S({ amount: 1n << 64n }))).rejects.toThrow()
    await expect(sendHandover(S({ amount: 5 }))).rejects.toThrow()
    await expect(sendHandover(S({ recipientKey: 'zz' }))).rejects.toThrow(TypeError)
    await expect(sendHandover(S({ assetId: `${'c7'.repeat(32)}_1` }))).rejects.toThrow(TypeError)
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('fails closed without an overlay identity key (S5) before any wallet call', async () => {
    configureMandala({ overlayIdentityKey: '' })
    await expect(sendHandover(S())).rejects.toThrow(/overlay identity key/)
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(await journalKeys()).toEqual([])
  })

  it('journal: false writes no txJournal key but still commits r', async () => {
    const before = await journalKeys()
    const h = await sendHandover(S({ journal: false }))
    expect(await journalKeys()).toEqual(before)
    expect(await blindingGet(`${h.txid}.0`)).toBeDefined()
  })

  it('journal: false failure writes no key either', async () => {
    wallet.state.handoff = 'none'
    await expect(sendHandover(S({ journal: false }))).rejects.toThrow(/color-permission-module/)
    expect(await journalKeys()).toEqual([])
  })
})

describe('deliverHandover / markHandoverDelivered', () => {
  it('journals the notification, sends the v3 body, then marks delivered', async () => {
    const h = await sendHandover(S())
    const mb = mkMb()
    mb.sendMessage.mockImplementation(async () => {
      expect((await notifyList()).map(n => n.txid)).toContain(h.txid)
      return {}
    })
    await deliverHandover({ messageBoxClient: mb, recipientKey: B, handover: h })
    expect(mb.sendMessage).toHaveBeenCalledTimes(1)
    const sent = mb.sendMessage.mock.calls[0][0]
    expect(sent.recipient).toBe(B)
    expect(sent.messageBox).toBe(MESSAGEBOX)
    expect(sent.body).toEqual({ v: 3, kind: 'handover', assetId: ID, outputIndex: 0, tx: Utils.toHex(h.tx), receipt: h.receipt })
    expect((await journalList()).find(e => e.txid === h.txid)?.stage).toBe('delivered')
    expect(await notifyList()).toEqual([])
  })

  it('carries the note when given', async () => {
    const h = await sendHandover(S())
    const mb = mkMb()
    await deliverHandover({ messageBoxClient: mb, recipientKey: B, handover: h, note: 'thanks' })
    expect((mb.sendMessage.mock.calls[0][0].body as any).note).toBe('thanks')
  })

  it('a send failure rejects, keeps the notification and stays signed', async () => {
    const h = await sendHandover(S())
    const mb = mkMb()
    mb.sendMessage.mockRejectedValue(new Error('box down'))
    await expect(deliverHandover({ messageBoxClient: mb, recipientKey: B, handover: h })).rejects.toThrow(/box down/)
    expect((await notifyList()).map(n => n.txid)).toEqual([h.txid])
    expect((await journalList()).find(e => e.txid === h.txid)?.stage).toBe('signed')
  })

  it('delivers after a journal: false send without writing a journal entry', async () => {
    const h = await sendHandover(S({ journal: false }))
    const mb = mkMb()
    const { txid, tx, outputIndex, receipt } = h
    await deliverHandover({ messageBoxClient: mb, recipientKey: B, handover: { txid, tx, outputIndex, receipt } })
    expect(mb.sendMessage).toHaveBeenCalledTimes(1)
    expect(await journalList()).toEqual([])
  })

  it('markHandoverDelivered is idempotent and writes nothing for an unknown txid or another stage', async () => {
    await markHandoverDelivered('d'.repeat(64))
    expect(await journalKeys()).toEqual([])
    await journalPut({ txid: 'a'.repeat(64), stage: 'accepted', at: 1 })
    await markHandoverDelivered('a'.repeat(64))
    expect((await journalGet('a'.repeat(64)))?.stage).toBe('accepted')
    const h = await sendHandover(S())
    await markHandoverDelivered(h.txid)
    await markHandoverDelivered(h.txid)
    expect((await journalGet(h.txid))?.stage).toBe('delivered')
  })
})

describe('settleHandover', () => {
  let h: HandoverResult

  beforeEach(async () => {
    h = await sendHandover(S())
    await markHandoverDelivered(h.txid)
  })

  const settle = (over: Record<string, unknown> = {}) => settleHandover({
    wallet: wallet as any, handover: h, assetId: ID, overlayIdentityKey: OVERLAY_KEY, ...over
  } as Parameters<typeof settleHandover>[0])

  it('fails closed without an overlay identity key (S5)', async () => {
    await expect(settle({ overlayIdentityKey: '' })).rejects.toThrow(/overlay identity key/)
    expect(submitToOverlay).not.toHaveBeenCalled()
  })

  it('submits the exact bytes on the asset topic against the given key', async () => {
    vi.mocked(submitToOverlay).mockResolvedValue(await admittedFor(h.txid))
    await settle()
    expect(vi.mocked(submitToOverlay).mock.calls[0]).toEqual([h.tx, h.offChainValues, undefined, [colorTopic(ID)], OVERLAY_KEY])
  })

  it('refuses a txid that the bytes do not hash to (stale cache)', async () => {
    await expect(settle({ handover: { ...h, txid: 'e'.repeat(64) } })).rejects.toThrow(TypeError)
    expect(submitToOverlay).not.toHaveBeenCalled()
  })

  it('a retryable verdict ⇒ retry, attempts+1, never aborts', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_FROZEN', httpStatus: 409 }))
    expect(await settle()).toEqual({ status: 'retry', code: 'ERR_FROZEN' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(await journalGet(h.txid)).toMatchObject({ stage: 'delivered', attempts: 1 })
  })

  it('a non-refusal error ⇒ retry ERR_UNAVAILABLE, never aborts', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new Error('overlay rejected the transaction on tm_color_x'))
    expect(await settle()).toEqual({ status: 'retry', code: 'ERR_UNAVAILABLE' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('a final verdict ⇒ refused, aborts the journaled reference, drops the entry', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_CONSERVATION', httpStatus: 400 }))
    expect(await settle()).toEqual({ status: 'refused', code: 'ERR_CONSERVATION' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-h' })
    expect(await journalGet(h.txid)).toBeUndefined()
  })

  it('a final verdict whose abort fails leaves an abort entry', async () => {
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_LINKAGE', httpStatus: 400 }))
    wallet.abortAction.mockRejectedValueOnce(new Error('wallet offline'))
    expect(await settle()).toEqual({ status: 'refused', code: 'ERR_LINKAGE' })
    expect(await journalGet(h.txid)).toMatchObject({ stage: 'abort', reference: 'ref-h' })
  })

  it('admitted ⇒ accepted entry with σ fields, then sendWith; a proven post clears it', async () => {
    const admitted = await admittedFor(h.txid)
    vi.mocked(submitToOverlay).mockResolvedValue(admitted)
    let post!: (v: unknown) => void
    wallet.state.broadcast = async () => await new Promise(resolve => { post = resolve })
    const r = await settle()
    expect(r).toEqual({ status: 'admitted', attestation: admitted.attestation })
    expect(await journalGet(h.txid)).toMatchObject({
      stage: 'accepted',
      reference: 'ref-h',
      offChainHex: SUBMISSION_HEX,
      admissionSignature: admitted.admissionSignature,
      admissionIdentityKey: OVERLAY_KEY,
      outputsToAdmit: [0]
    })
    await vi.waitFor(() => expect(wallet.createAction).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ sendWith: [h.txid] })
    })))
    post({ sendWithResults: [{ txid: h.txid, status: 'unproven' }] })
    await vi.waitFor(async () => expect(await journalGet(h.txid)).toBeUndefined())
  })

  it('D24: a sendWith result marked failed keeps the accepted entry', async () => {
    vi.mocked(submitToOverlay).mockResolvedValue(await admittedFor(h.txid))
    let done!: () => void
    const finished = new Promise<void>(resolve => { done = resolve })
    wallet.state.broadcast = async () => { setTimeout(done, 0); return { sendWithResults: [{ txid: h.txid, status: 'failed' }] } }
    await settle()
    await finished
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await journalGet(h.txid))?.stage).toBe('accepted')
  })

  it('a thrown already-broadcast clears the accepted entry', async () => {
    vi.mocked(submitToOverlay).mockResolvedValue(await admittedFor(h.txid))
    wallet.state.broadcast = async () => { throw new Error('txn-already-known') }
    await settle()
    await vi.waitFor(async () => expect(await journalGet(h.txid)).toBeUndefined())
  })

  it('concurrent settleHandover submits once', async () => {
    let answer!: (v: unknown) => void
    vi.mocked(submitToOverlay).mockImplementation(async () => await new Promise(resolve => { answer = resolve }) as any)
    const p1 = settle()
    const p2 = settle()
    await vi.waitFor(() => expect(submitToOverlay).toHaveBeenCalledTimes(1))
    answer(await admittedFor(h.txid))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual(r2)
    expect(submitToOverlay).toHaveBeenCalledTimes(1)
  })

  it('without a journal entry a final verdict returns refused and aborts nothing', async () => {
    const h2 = await sendHandover(S({ journal: false }))
    vi.mocked(submitToOverlay).mockRejectedValue(new OverlayRefusedError({ code: 'ERR_CONSERVATION', httpStatus: 400 }))
    const r = await settleHandover({ wallet: wallet as any, handover: h2, assetId: ID, overlayIdentityKey: OVERLAY_KEY })
    expect(r).toEqual({ status: 'refused', code: 'ERR_CONSERVATION' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('resubmitDelivered re-POSTs the journaled bytes', async () => {
    const admitted = await admittedFor(h.txid)
    vi.mocked(submitToOverlay).mockResolvedValue(admitted)
    const [entry] = await journalListHandovers()
    expect(entry.stage).toBe('delivered')
    const r = await resubmitDelivered(wallet as any, entry, OVERLAY_KEY)
    expect(r).toEqual({ status: 'admitted', attestation: admitted.attestation })
    expect(vi.mocked(submitToOverlay).mock.calls[0]).toEqual([h.tx, h.offChainValues, undefined, [colorTopic(ID)], OVERLAY_KEY])
  })
})
