/**
 * Issuer payouts and reissues create holder `p color` outputs with BRC-207
 * receipts (plan 04 Task 12, B4, C§7). The wallet is a real ProtoWallet for
 * every key operation (linkage, locks, unlock signatures) with
 * listOutputs/createAction/signAction stubbed; the overlay submit and the
 * deploy lookup are stubbed with real attested-v1 signatures (overlaySigner).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  Hash, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils
} from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { payoutTokens, type PayoutResult } from './payout.js'
import { submitAdminAction, type AdminAsset } from './assets.js'
import { submitAndBroadcast, submitToOverlay } from './overlay.js'
import { fetchDeployTx } from './overlayLookup.js'
import { configureMandala, ADMIN_PROTOCOL, ATTESTED_PROFILE_ID, MESSAGEBOX, TREASURY_BASKET } from './constants.js'
import { decodeToken } from './brc162.js'
import { decodeEnvelope } from './encoding.js'
import { colorProtocolID, colorTopic } from './naming.js'
import { MAX_UINT64 } from './amount.js'
import { notifyClear, notifyList, reconcileNotifications } from './notifyJournal.js'
import { blindingClear, blindingGet, blindingListReserved } from './blindingJournal.js'
import { hasFreshIntent, INTENT_TTL_MS, journalClear, journalGet, journalList, journalPut } from './txJournal.js'
import { configureStorage, getStorage, memoryStorage } from './storage.js'
import { adminAuthInFlightPrior, clearAdminAuthGates, StaleAdminAuthError } from './adminAuthGate.js'
import { attestationFromSteak, verifyAttestation, type Attestation } from './attestation.js'
import { handoverBody, issuerAttestedLeaf, issuerReceipt, newRemittance, ReceiptUnavailableError } from './receipt.js'
import { OVERLAY_KEY, signedSteak } from './__fixtures__/overlaySigner.js'

vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitAndBroadcast: vi.fn(),
  submitToOverlay: vi.fn()
}))
vi.mock('./overlayLookup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlayLookup.js')>()),
  fetchDeployTx: vi.fn()
}))

const ISSUER_PRIV = new PrivateKey(42)
const ISSUER = ISSUER_PRIV.toPublicKey().toString()
const RECIPIENT_PRIV = new PrivateKey(77)
const RECIPIENT = RECIPIENT_PRIV.toPublicKey().toString()
const TXID = 'e'.repeat(64)
const ATOMIC = [1, 1, 1, 1, 9, 8, 7]
const pkh = new PrivateKey(11).toPublicKey().toHash() as number[]

/** A deploy tx whose id is the asset id's txid. */
const DEPLOY = (() => {
  const src = new Transaction()
  src.addOutput({ satoshis: 5, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  tx.addOutput({ satoshis: 1, lockingScript: new OneColor().lock(null, 0n, pkh, [0xa0]) })
  return tx
})()
const ID = `${DEPLOY.id('hex')}_0`
const DEPLOY_HEX = DEPLOY.toHex()
const asset: AdminAsset = { assetId: ID, label: 'Test Dollar', authOutpoint: 'b'.repeat(64) + '.1', authKeyID: 'deploy' }

/** Treasury value coins of ID (the BEEF the wallet lists). */
function fund (amounts: bigint[]): { listed: any[], beef: number[] } {
  const src = new Transaction()
  src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  for (const a of amounts) tx.addOutput({ satoshis: 1, lockingScript: new OneColor().lock(ID, a, pkh) })
  const txid = tx.id('hex')
  return {
    listed: amounts.map((_, i) => ({
      outpoint: `${txid}.${i}`,
      satoshis: 1,
      spendable: true,
      lockingScript: tx.outputs[i].lockingScript.toHex(),
      customInstructions: JSON.stringify({ protocolID: ADMIN_PROTOCOL, keyID: `k${i}`, counterparty: ISSUER })
    })),
    beef: tx.toBEEF()
  }
}

/** What createAction hands back for signing: `n` inputs over real sources. */
function signableBeef (n: number): number[] {
  const src = new Transaction()
  for (let i = 0; i < n; i++) src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  for (let i = 0; i < n; i++) {
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: i, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(pkh) })
  return tx.toBEEF(true)
}

function mkWallet (coins: bigint[] = [100n, 50n]) {
  const proto = new ProtoWallet(ISSUER_PRIV)
  const { listed, beef } = fund(coins)
  return {
    keyDeriver: (proto as any).keyDeriver,
    getPublicKey: vi.fn(async (a: any) => await proto.getPublicKey(a)),
    encrypt: vi.fn(async (a: any) => await proto.encrypt(a)),
    createSignature: vi.fn(async (a: any) => await proto.createSignature(a)),
    revealSpecificKeyLinkage: vi.fn(async (a: any) => await proto.revealSpecificKeyLinkage(a)),
    listOutputs: vi.fn(async (a: { include?: string }) => a.include === 'entire transactions'
      ? { outputs: listed, BEEF: beef }
      : { outputs: listed }),
    listActions: vi.fn(async () => ({ actions: [] })),
    createAction: vi.fn(async (args: any) => ({ signableTransaction: { tx: signableBeef(args.inputs?.length ?? 1), reference: 'ref-1' } })),
    signAction: vi.fn(async (_a: any) => ({ tx: ATOMIC, txid: TXID })),
    abortAction: vi.fn(async (_a: any) => ({ aborted: true }))
  }
}

let ATT: Attestation
async function attest (outputs: number[]): Promise<Attestation> {
  const steak = await signedSteak(TXID, { [colorTopic(ID)]: outputs })
  return attestationFromSteak(TXID, ID, steak)!
}

const mkMb = () => ({ sendMessage: vi.fn(async (_a: { recipient: string, messageBox: string, body: object }) => ({})) })

let wallet: ReturnType<typeof mkWallet>
let mb: ReturnType<typeof mkMb>
const P = (over: Record<string, unknown> = {}) => ({
  wallet: wallet as any,
  identityKey: ISSUER,
  asset,
  amount: 120n,
  recipientKey: RECIPIENT,
  messageBoxClient: mb,
  ...over
}) as Parameters<typeof payoutTokens>[0]

beforeEach(async () => {
  clearAdminAuthGates()
  await journalClear()
  await notifyClear()
  await blindingClear()
  configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: OVERLAY_KEY })
  // resolveAssetState (frozen/evicted filter) answers 503: no exclusions.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
  ATT = await attest([0, 1])
  vi.mocked(submitAndBroadcast).mockReset().mockImplementation(async () =>
    ({ topic: colorTopic(ID), outputsToAdmit: ATT.outputs, admissionSignature: ATT.signature, admissionIdentityKey: ATT.signer, attestation: ATT }) as any)
  vi.mocked(fetchDeployTx).mockReset().mockImplementation(async () => Transaction.fromHex(DEPLOY_HEX))
  vi.mocked(submitToOverlay).mockReset()
  wallet = mkWallet()
  mb = mkMb()
})
afterEach(() => {
  configureMandala({ overlayIdentityKey: '' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Route submitAndBroadcast through the REAL implementation, with /submit
 * answering a retryable refusal (409 `code`), so the hold/abort decision is
 * exercised end to end.
 */
async function overlayRefusesRetryably (code = 'ERR_PAUSED'): Promise<void> {
  const actual = await vi.importActual<typeof import('./overlay.js')>('./overlay.js')
  vi.mocked(submitAndBroadcast).mockImplementation(actual.submitAndBroadcast)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/submit')
    ? { ok: false, status: 409, text: async () => JSON.stringify({ status: 'error', code, description: 'asset paused' }), json: async () => ({}) }
    : { ok: false, status: 503, text: async () => '', json: async () => ({}) }))
}

/**
 * Route submitAndBroadcast through the REAL implementation, with /submit
 * giving an AMBIGUOUS answer: a 200 STEAK that admitted output 0 with no
 * signature (the overlay folded and broadcast the tx), or a transport fault
 * after the request left (it may have arrived).
 */
async function overlayOutcomeUnknown (kind: 'unsigned-200' | 'network'): Promise<void> {
  const actual = await vi.importActual<typeof import('./overlay.js')>('./overlay.js')
  vi.mocked(submitAndBroadcast).mockImplementation(actual.submitAndBroadcast)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).endsWith('/submit')) return { ok: false, status: 503, text: async () => '', json: async () => ({}) }
    if (kind === 'network') throw new TypeError('fetch failed: socket hang up')
    const steak = { [colorTopic(ID)]: { outputsToAdmit: [0] } }
    return { ok: true, status: 200, text: async () => JSON.stringify(steak), json: async () => steak }
  }))
}

describe('receipt helpers', () => {
  it('newRemittance is base64 of 16 random bytes', () => {
    const a = newRemittance()
    expect(Utils.toArray(a, 'base64')).toHaveLength(16)
    expect(a).toHaveLength(24)
    expect(newRemittance()).not.toBe(a)
  })

  it('issuerAttestedLeaf has exactly the C§7.1 members with lowercase hex', () => {
    const leaf = issuerAttestedLeaf({ declarationTx: DEPLOY.toBinary(), attestation: ATT, offChainValues: [0xab, 0x01] })
    expect(leaf).toEqual({ declarationTx: DEPLOY_HEX, transactions: [], attestations: [ATT], submissions: [{ txid: TXID, offChainValues: 'ab01' }] })
    expect(Object.keys(leaf)).toEqual(['declarationTx', 'transactions', 'attestations', 'submissions'])
  })

  it('handoverBody is the v3 body with no amount, and note only when given', () => {
    const receipt = { version: 1 as const, assetId: ID, derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: ISSUER, profileData: {} }
    expect(Object.keys(handoverBody({ assetId: ID, outputIndex: 0, tx: [0xab], receipt }))).toEqual(['v', 'kind', 'assetId', 'outputIndex', 'tx', 'receipt'])
    expect(handoverBody({ assetId: ID, outputIndex: 0, tx: [0xab], receipt, note: 'hi' })).toEqual({ v: 3, kind: 'handover', assetId: ID, outputIndex: 0, tx: 'ab', receipt, note: 'hi' })
  })
})

describe('payoutTokens (B4)', () => {
  it('payout fails closed before listOutputs (S5)', async () => {
    configureMandala({ overlayIdentityKey: '' })
    await expect(payoutTokens(P())).rejects.toThrow(/overlay identity key/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(fetchDeployTx).not.toHaveBeenCalled()
    expect(await hasFreshIntent()).toBe(false)
  })

  it('refuses a bad amount, a payout to self and a missing MessageBox client before any wallet call', async () => {
    await expect(payoutTokens(P({ amount: 0n }))).rejects.toThrow(/greater than zero/)
    await expect(payoutTokens(P({ amount: MAX_UINT64 + 1n }))).rejects.toThrow(/uint64/)
    await expect(payoutTokens(P({ amount: 5 }))).rejects.toThrow(/whole number/)
    await expect(payoutTokens(P({ recipientKey: ISSUER }))).rejects.toThrow(TypeError)
    await expect(payoutTokens(P({ messageBoxClient: undefined }))).rejects.toThrow(TypeError)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(fetchDeployTx).not.toHaveBeenCalled()
  })

  it('builds the recipient p color output, treasury change, envelope, attested receipt and v3 body', async () => {
    const seenAtSend: string[] = []
    mb.sendMessage.mockImplementation(async () => { seenAtSend.push(...(await notifyList()).map(n => n.txid)); return {} })
    const r: PayoutResult = await payoutTokens(P())

    const args = wallet.createAction.mock.calls[0][0]
    expect(decodeToken(args.outputs[0].lockingScript)).toEqual({ role: 'value', assetId: ID, amount: 120n })
    expect(args.outputs[0].satoshis).toBe(1)
    expect(args.outputs[0].basket).toBeUndefined()
    expect(decodeToken(args.outputs[1].lockingScript)).toEqual({ role: 'value', assetId: ID, amount: 30n })
    expect(args.outputs[1].basket).toBe(TREASURY_BASKET)
    expect(JSON.parse(args.outputs[1].customInstructions)).toMatchObject({ protocolID: ADMIN_PROTOCOL, counterparty: ISSUER })
    expect(args.outputs).toHaveLength(2)
    expect(args.options).toEqual({ noSend: true, randomizeOutputs: false })
    expect(args.labels).toEqual(['mandala', 'payout'])
    expect(args.description).toBe('Payout 120 Test Dollar')
    expect(args.inputs).toHaveLength(2)
    expect(wallet.signAction.mock.calls[0][0]).toMatchObject({ reference: 'ref-1', options: { noSend: true } })

    // The recipient derives the output key by plain BRC-42 against the receipt's sender key.
    const { publicKey } = await new ProtoWallet(RECIPIENT_PRIV).getPublicKey({
      protocolID: colorProtocolID(ID, r.receipt.derivationPrefix, r.receipt.derivationSuffix),
      keyID: 'color',
      counterparty: r.receipt.senderIdentityKey,
      forSelf: true
    })
    const expected = new OneColor().lock(ID, 120n, Hash.hash160(Utils.toArray(publicKey, 'hex')))
    expect(args.outputs[0].lockingScript).toBe(expected.toHex())
    expect(r.receipt.senderIdentityKey).toBe(ISSUER) // blind defaults to false

    const call = vi.mocked(submitAndBroadcast).mock.calls[0]
    expect(call[1]).toEqual({ tx: ATOMIC, txid: TXID })
    expect(call[3]).toBe('ref-1')
    expect(call[5]).toEqual([`tm_color_${ID}`])
    const env = decodeEnvelope(call[2]!)
    expect(env.outputs!.map(o => o.index)).toEqual([0, 1])
    expect(env.outputs![0].linkage.counterparty).toBe(RECIPIENT)
    expect(env.outputs![0].linkage.prover).toBe(ISSUER)
    expect(env.outputs![0].linkage.verifier).toBe(OVERLAY_KEY)
    expect(env.outputs![1].linkage).toMatchObject({ prover: ISSUER, counterparty: ISSUER, protocolID: ADMIN_PROTOCOL, verifier: OVERLAY_KEY })
    expect(env.admin).toBeUndefined()

    expect(r).toMatchObject({ txid: TXID, outputIndex: 0, notified: true, topic: colorTopic(ID), outputsToAdmit: [0, 1] })
    expect(Object.keys(r.receipt)).toEqual(['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'profileData'])
    expect(r.receipt.version).toBe(1)
    expect(r.receipt.assetId).toBe(ID)
    expect(Object.keys(r.receipt.profileData)).toEqual([ATTESTED_PROFILE_ID])
    expect((r.receipt.profileData as any)[ATTESTED_PROFILE_ID][ID]).toEqual({
      declarationTx: DEPLOY_HEX,
      transactions: [],
      attestations: [ATT],
      submissions: [{ txid: TXID, offChainValues: Utils.toHex(call[2]!) }]
    })
    expect(verifyAttestation(ATT, ID, OVERLAY_KEY)).toBe(true)

    const sent = mb.sendMessage.mock.calls[0][0]
    expect(sent.recipient).toBe(RECIPIENT)
    expect(sent.messageBox).toBe('mandala-color')
    expect(sent.messageBox).toBe(MESSAGEBOX)
    expect(Object.keys(sent.body)).toEqual(['v', 'kind', 'assetId', 'outputIndex', 'tx', 'receipt'])
    expect(sent.body).toEqual({ v: 3, kind: 'handover', assetId: ID, outputIndex: 0, tx: Utils.toHex(ATOMIC), receipt: r.receipt })
    // The notification is journaled before sendMessage, and cleared on delivery.
    expect(seenAtSend).toContain(TXID)
    expect(await notifyList()).toEqual([])
    expect(await hasFreshIntent()).toBe(false)
  })

  it('carries a note in the body only when given', async () => {
    await payoutTokens(P({ note: 'salary' }))
    expect(mb.sendMessage.mock.calls[0][0].body).toMatchObject({ note: 'salary' })
    expect(Object.keys(mb.sendMessage.mock.calls[0][0].body).at(-1)).toBe('note')
  })

  it('an exact payout emits no change output', async () => {
    ATT = await attest([0])
    const r = await payoutTokens(P({ amount: 100n }))
    const args = wallet.createAction.mock.calls[0][0]
    expect(args.outputs).toHaveLength(1)
    expect(args.inputs).toHaveLength(1)
    expect(decodeEnvelope(vi.mocked(submitAndBroadcast).mock.calls[0][2]!).outputs!.map(o => o.index)).toEqual([0])
    expect(r.notified).toBe(true)
  })

  it('pays MAX_UINT64 exactly and keeps the exact bigint change of a selection above 2^64', async () => {
    wallet = mkWallet([MAX_UINT64 - 1n, MAX_UINT64 - 1n])
    await payoutTokens(P({ amount: MAX_UINT64 }))
    const args = wallet.createAction.mock.calls[0][0]
    expect(args.inputs).toHaveLength(2) // total 2^65 - 4 > 2^64
    expect(decodeToken(args.outputs[0].lockingScript)!.amount).toBe(MAX_UINT64)
    expect(decodeToken(args.outputs[1].lockingScript)!.amount).toBe(MAX_UINT64 - 2n)
    expect(args.description.length).toBeLessThanOrEqual(50)
  })

  it('a blinded payout shows A′, keeps r sender-side under the recipient outpoint, never in the receipt or body', async () => {
    const r = await payoutTokens(P({ blind: true }))
    expect(r.receipt.senderIdentityKey).not.toBe(ISSUER)
    const rec = await blindingGet(`${TXID}.0`)
    expect(rec).toMatchObject({ senderBlinded: r.receipt.senderIdentityKey, recipient: RECIPIENT, assetId: ID })
    expect(rec!.r).toMatch(/^[0-9a-f]{64}$/)
    expect(await blindingListReserved()).toEqual([])
    expect(JSON.stringify(mb.sendMessage.mock.calls[0][0].body)).not.toContain(rec!.r)
    // The envelope prover stays the real issuer key (C§5.1: intended mismatch).
    expect(decodeEnvelope(vi.mocked(submitAndBroadcast).mock.calls[0][2]!).outputs![0].linkage.prover).toBe(ISSUER)
    const { publicKey } = await new ProtoWallet(RECIPIENT_PRIV).getPublicKey({
      protocolID: colorProtocolID(ID, r.receipt.derivationPrefix, r.receipt.derivationSuffix),
      keyID: 'color',
      counterparty: r.receipt.senderIdentityKey,
      forSelf: true
    })
    const out0 = LockingScript.fromHex(wallet.createAction.mock.calls[0][0].outputs[0].lockingScript)
    expect(out0.toHex()).toBe(new OneColor().lock(ID, 120n, Hash.hash160(Utils.toArray(publicKey, 'hex'))).toHex())
  })

  it('stale or poisoned deploy answer: payoutTokens rejects before any coin is held', async () => {
    vi.mocked(fetchDeployTx).mockRejectedValue(Object.assign(new Error('[LookupError] (ERR_INVALID_ANSWER)'), { name: 'LookupError' }))
    await expect(payoutTokens(P())).rejects.toThrow(/ERR_INVALID_ANSWER/)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(await hasFreshIntent()).toBe(false)
  })

  it('a second concurrent payout (another tab) gets BusyError', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const orig = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementationOnce(async (a: any) => { await gate; return await orig(a) })
    const first = payoutTokens(P())
    await vi.waitFor(() => expect(wallet.createAction).toHaveBeenCalledTimes(1))
    const second = payoutTokens(P())
    await expect(second).rejects.toMatchObject({ name: 'BusyError' })
    release()
    await expect(first).resolves.toMatchObject({ txid: TXID })
  })

  it('a failed send keeps the journaled body (notified false) and reconcileNotifications delivers it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mb.sendMessage.mockRejectedValueOnce(new Error('messagebox down'))
    const r = await payoutTokens(P())
    expect(r.notified).toBe(false)
    expect(warn).toHaveBeenCalled()
    const pending = await notifyList()
    expect(pending.map(n => n.txid)).toEqual([TXID])
    expect(pending[0]).toMatchObject({ recipient: RECIPIENT, messageBox: MESSAGEBOX })
    const retry = mkMb()
    expect(await reconcileNotifications(retry)).toEqual([TXID])
    expect(retry.sendMessage.mock.calls[0][0].body).toEqual({ v: 3, kind: 'handover', assetId: ID, outputIndex: 0, tx: Utils.toHex(ATOMIC), receipt: r.receipt })
    expect(await notifyList()).toEqual([])
  })

  it('an overlay refusal sends nothing and journals no notification', async () => {
    vi.mocked(submitAndBroadcast).mockRejectedValue(new Error('overlay refused (ERR_FROZEN)'))
    await expect(payoutTokens(P())).rejects.toThrow(/ERR_FROZEN/)
    expect(mb.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toEqual([])
  })

  it('submits with holdRetryable: false (a receipt-bearing tx is never held on a retryable refusal)', async () => {
    await payoutTokens(P())
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][6]).toEqual({ holdRetryable: false })
  })

  it('a retryable refusal (ERR_PAUSED) releases the inputs: no retryable hold, nothing sent, safe to re-run', async () => {
    await overlayRefusesRetryably('ERR_PAUSED')
    const err = await payoutTokens(P()).then(() => undefined, (e: unknown) => e)
    expect(err).toMatchObject({ code: 'ERR_PAUSED', retryable: true })
    expect(String((err as Error).message)).toMatch(/nothing was committed/)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
    expect((await journalList()).filter(e => e.stage === 'retryable')).toEqual([])
    expect(await journalList()).toEqual([])
    expect(mb.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toEqual([])
  })

  it.each(['unsigned-200', 'network'] as const)('an ambiguous submit (%s) keeps the action and the R6 intent and says the outcome is unknown', async kind => {
    await overlayOutcomeUnknown(kind)
    const err = await payoutTokens(P()).then(() => undefined, (e: unknown) => e)
    expect(err).toMatchObject({ outcome: 'unknown', retryable: true })
    expect((err as { code: string }).code).toMatch(kind === 'network' ? /^ERR_UNAVAILABLE$/ : /^ERR_(NO|BAD)_ADMISSION$/)
    expect(String((err as Error).message)).toMatch(/outcome unknown/)
    expect(String((err as Error).message)).not.toMatch(/nothing was committed/)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    // The held action is protected from the sweep and settled by reconcile.
    expect(await journalList()).toMatchObject([{ txid: TXID, stage: 'retryable', reference: 'ref-1', submit: { topics: [colorTopic(ID)] } }])
    // The receipt inputs stay journaled (pending, never sent as is).
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true, intent: { outputIndex: 0 } }])
    expect(mb.sendMessage).not.toHaveBeenCalled()
  })

  it('a retryable refusal whose abort fails journals an abort entry, never a retryable one', async () => {
    await overlayRefusesRetryably('ERR_FROZEN')
    wallet.abortAction.mockRejectedValue(new Error('wallet down'))
    await expect(payoutTokens(P())).rejects.toMatchObject({ code: 'ERR_FROZEN' })
    expect(await journalList()).toMatchObject([{ txid: TXID, stage: 'abort', reference: 'ref-1' }])
    expect(mb.sendMessage).not.toHaveBeenCalled()
  })

  it('an admission whose attestation does not cover the recipient output delivers nothing', async () => {
    ATT = await attest([1])
    const err = await payoutTokens(P()).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(ReceiptUnavailableError)
    expect(err).toMatchObject({ name: 'ReceiptUnavailableError', committed: true, txid: TXID })
    await expect(Promise.reject(err)).rejects.toThrow(/attestation covering output 0.*do not retry/)
    expect(mb.sendMessage).not.toHaveBeenCalled()
    // R6: the committed output's receipt inputs stay journaled (pending, never
    // sent as is) so a later pass can complete the receipt once the overlay
    // attests the output.
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true, intent: { outputIndex: 0 } }])
  })

  it('a failure after createAction and before the submit releases the held inputs', async () => {
    wallet.signAction.mockRejectedValueOnce(new Error('user cancelled'))
    await expect(payoutTokens(P())).rejects.toThrow(/user cancelled/)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
    expect(submitAndBroadcast).not.toHaveBeenCalled()
  })
})

describe('reissue through the payout path (submitAdminAction ftOutput)', () => {
  const FROZEN = 'f'.repeat(64) + '.0'
  const reissue = (over: Record<string, unknown> = {}) => submitAdminAction({
    wallet: wallet as any,
    asset,
    details: { kind: 'reissue', outpoint: FROZEN, recipient: RECIPIENT },
    ftOutput: { recipient: RECIPIENT, amount: 5n },
    messageBoxClient: mb,
    identityKey: ISSUER,
    ...over
  } as any)

  beforeEach(() => {
    wallet.listOutputs.mockImplementation(async () => ({ outputs: [{ outpoint: asset.authOutpoint }], BEEF: [1] }) as any)
  })

  it('outputs[0] is the recipient p color output, the authority follows, and a v3 body is sent', async () => {
    const res = await reissue()
    const args = wallet.createAction.mock.calls[0][0]
    expect(decodeToken(args.outputs[0].lockingScript)).toEqual({ role: 'value', assetId: ID, amount: 5n })
    expect(args.outputs[0].basket).toBeUndefined()
    expect(args.outputs[0].satoshis).toBe(1)
    expect(decodeToken(args.outputs[1].lockingScript)).toMatchObject({ role: 'authority', assetId: ID, amount: 0n })
    expect(args.outputs[1].basket).toBe(TREASURY_BASKET)
    expect(args.outputs).toHaveLength(2)
    expect(args.inputs).toHaveLength(1) // the prior authority only: a reissue spends no value inputs

    const call = vi.mocked(submitAndBroadcast).mock.calls[0]
    expect(call[5]).toEqual([colorTopic(ID)])
    const env = decodeEnvelope(call[2]!)
    expect(env.outputs!.map(o => o.index)).toEqual([0, 1])
    expect(env.outputs![0].linkage).toMatchObject({ prover: ISSUER, counterparty: RECIPIENT, verifier: OVERLAY_KEY, keyID: 'color' })
    expect(env.outputs![0].linkage.protocolID[1].startsWith('p color ')).toBe(true)
    expect(env.admin).toEqual([{ index: 1, details: expect.any(String) }])

    expect(res).toMatchObject({ txid: TXID, nextAuthOutpoint: `${TXID}.1`, notified: true })
    const sent = mb.sendMessage.mock.calls[0][0] as any
    expect(sent).toMatchObject({ recipient: RECIPIENT, messageBox: MESSAGEBOX })
    expect(sent.body).toMatchObject({ v: 3, kind: 'handover', assetId: ID, outputIndex: 0, tx: Utils.toHex(ATOMIC) })
    expect(sent.body.receipt.senderIdentityKey).toBe(ISSUER)
    expect(sent.body.receipt.profileData[ATTESTED_PROFILE_ID][ID]).toEqual({
      declarationTx: DEPLOY_HEX, transactions: [], attestations: [ATT], submissions: [{ txid: TXID, offChainValues: Utils.toHex(call[2]!) }]
    })
    const { publicKey } = await new ProtoWallet(RECIPIENT_PRIV).getPublicKey({
      protocolID: colorProtocolID(ID, sent.body.receipt.derivationPrefix, sent.body.receipt.derivationSuffix),
      keyID: 'color',
      counterparty: ISSUER,
      forSelf: true
    })
    expect(args.outputs[0].lockingScript).toBe(new OneColor().lock(ID, 5n, Hash.hash160(Utils.toArray(publicKey, 'hex'))).toHex())
    expect(await notifyList()).toEqual([])
  })

  it('a reissue submits with holdRetryable: false; an action without a recipient output keeps the hold', async () => {
    await reissue()
    expect(vi.mocked(submitAndBroadcast).mock.calls[0][6]).toEqual({ holdRetryable: false })
    await submitAdminAction({ wallet: wallet as any, asset, details: { kind: 'pause' }, identityKey: ISSUER } as any)
    expect(vi.mocked(submitAndBroadcast).mock.calls[1][6]).toEqual({ holdRetryable: true })
  })

  it.each(['unsigned-200', 'network'] as const)('an ambiguous reissue submit (%s) keeps the action and the R6 intent', async kind => {
    await overlayOutcomeUnknown(kind)
    const err = await reissue().then(() => undefined, (e: unknown) => e)
    expect(err).toMatchObject({ outcome: 'unknown' })
    expect(String((err as Error).message)).toMatch(/outcome unknown/)
    expect(String((err as Error).message)).not.toMatch(/nothing was committed/)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(await journalList()).toMatchObject([{ txid: TXID, stage: 'retryable', reference: 'ref-1' }])
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true, intent: { outputIndex: 0 } }])
    expect(mb.sendMessage).not.toHaveBeenCalled()
  })

  it('a retryable refusal on a reissue releases the inputs: no retryable hold, nothing sent', async () => {
    await overlayRefusesRetryably('ERR_PAUSED')
    await expect(reissue()).rejects.toMatchObject({ code: 'ERR_PAUSED', retryable: true, message: expect.stringMatching(/nothing was committed/) })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
    expect(await journalList()).toEqual([])
    expect(mb.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toEqual([])
    expect(adminAuthInFlightPrior(ID)).toBeUndefined()
  })

  it('an admission without an attestation for output 0 throws a committed ReceiptUnavailableError and releases the admin gate', async () => {
    ATT = await attest([1])
    const err = await reissue().then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(ReceiptUnavailableError)
    expect(err).toMatchObject({ committed: true, txid: TXID, message: expect.stringMatching(/do not retry/) })
    expect(adminAuthInFlightPrior(ID)).toBeUndefined()
    expect(mb.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true, intent: { outputIndex: 0 } }])
    // A caller that retries anyway with its stale asset fails closed: the
    // wallet no longer lists the spent authority.
    wallet.listOutputs.mockImplementation(async () => ({ outputs: [], BEEF: [1] }) as any)
    await expect(reissue()).rejects.toBeInstanceOf(StaleAdminAuthError)
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
  })

  it('a failed send keeps the journaled body and reports notified false; the action is not failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mb.sendMessage.mockRejectedValueOnce(new Error('down'))
    const res = await reissue()
    expect(res).toMatchObject({ txid: TXID, notified: false })
    expect((await notifyList()).map(n => n.txid)).toEqual([TXID])
  })

  it('reissue without messageBoxClient ⇒ TypeError, createAction not called', async () => {
    await expect(reissue({ messageBoxClient: undefined })).rejects.toThrow(TypeError)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('refuses a recipient that differs from details.recipient, a reissue with no ftOutput, and an ftOutput on another kind', async () => {
    const other = new PrivateKey(99).toPublicKey().toString()
    await expect(reissue({ ftOutput: { recipient: other, amount: 5n } })).rejects.toThrow(TypeError)
    await expect(reissue({ ftOutput: undefined })).rejects.toThrow(TypeError)
    await expect(reissue({ details: { kind: 'pause' } })).rejects.toThrow(TypeError)
    await expect(reissue({ ftOutput: { recipient: RECIPIENT, amount: 0n } })).rejects.toThrow(/greater than zero/)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('a reissue fetches the deploy before any coin is held', async () => {
    vi.mocked(fetchDeployTx).mockRejectedValue(new Error('lookup down'))
    await expect(reissue()).rejects.toThrow(/lookup down/)
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Plan 04 risk R6: the receipt inputs of an issuer payout or reissue are
// journaled (pending, throwing write) BEFORE the submit, removed on any submit
// failure, overwritten by the final v3 body after admission, and completed by
// reconcileNotifications after a crash: from the 'accepted' entry's σ while it
// exists, else (after INTENT_TTL_MS) only once a color-admission lookup shows
// the output admitted. Never re-POSTed blindly; never sent while pending.
// ---------------------------------------------------------------------------

describe('R6: issuer receipt intents', () => {
  const NOTIFY_KEY = `mandala.notifyJournal.${TXID}`

  /** Run a payout whose process "crashes" right after admission: the intent stays, nothing is sent. */
  async function crashAfterAdmission (run: () => Promise<unknown>, accepted: boolean): Promise<string> {
    let snapshot: string | null = null
    vi.mocked(submitAndBroadcast).mockImplementationOnce(async () => {
      snapshot = await getStorage().getItem(NOTIFY_KEY)
      if (accepted) {
        await journalPut({
          txid: TXID, stage: 'accepted', at: Date.now(), reference: 'ref-1', topic: colorTopic(ID),
          admissionSignature: ATT.signature, admissionIdentityKey: ATT.signer, outputsToAdmit: ATT.outputs
        } as any)
      }
      throw new Error('crash')
    })
    await expect(run()).rejects.toThrow('crash')
    expect(snapshot).not.toBeNull()
    return snapshot as unknown as string
  }

  /** Put the crashed intent back, aged `ageMs`. */
  async function restoreAged (raw: string, ageMs: number): Promise<any> {
    const entry = JSON.parse(raw)
    entry.at = Date.now() - ageMs
    await getStorage().setItem(NOTIFY_KEY, JSON.stringify(entry))
    return entry
  }

  function lookupAnswers (rows: Array<{ txid: string, outputIndex: number }> | 'down'): ReturnType<typeof vi.fn> {
    const f = vi.fn(async (url: string, _init: any) => {
      if (!String(url).endsWith('/lookup') || rows === 'down') return { ok: false, status: 503, text: async () => '', json: async () => ({}) }
      const body = { type: 'output-list', outputs: rows.map(r => ({ ...r, beef: [1, 2, 3] })) }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
    })
    vi.stubGlobal('fetch', f)
    return f
  }

  it('the payout journals a pending intent with every receipt input before the submit, and nothing is sent while pending', async () => {
    let atSubmit: any
    vi.mocked(submitAndBroadcast).mockImplementationOnce(async (...args: any[]) => {
      atSubmit = await notifyList()
      expect(mb.sendMessage).not.toHaveBeenCalled()
      // A pass while the payout is in flight never sends the pending entry.
      const other = mkMb()
      expect(await reconcileNotifications(other)).toEqual([])
      expect(other.sendMessage).not.toHaveBeenCalled()
      return await (vi.mocked(submitAndBroadcast).getMockImplementation() as any)(...args)
    })
    const r = await payoutTokens(P({ note: 'october' }))
    const env = vi.mocked(submitAndBroadcast).mock.calls[0][2]!
    expect(atSubmit).toHaveLength(1)
    expect(atSubmit[0]).toMatchObject({
      txid: TXID,
      pending: true,
      recipient: RECIPIENT,
      messageBox: MESSAGEBOX,
      intent: {
        assetId: ID,
        recipientKey: RECIPIENT,
        outputIndex: 0,
        derivationPrefix: r.receipt.derivationPrefix,
        derivationSuffix: r.receipt.derivationSuffix,
        senderIdentityKey: r.receipt.senderIdentityKey,
        note: 'october',
        declarationTxHex: DEPLOY_HEX,
        txHex: Utils.toHex(ATOMIC),
        offChainHex: Utils.toHex(env),
        topics: [colorTopic(ID)]
      }
    })
    expect(atSubmit[0].body).toBeUndefined()
    // After admission the final body replaced the intent, was sent and cleared.
    expect(await notifyList()).toEqual([])
  })

  it('a blinded payout commits r to the recipient outpoint before the submit', async () => {
    let atSubmit: unknown
    vi.mocked(submitAndBroadcast).mockImplementationOnce(async (...args: any[]) => {
      atSubmit = await blindingGet(`${TXID}.0`)
      return await (vi.mocked(submitAndBroadcast).getMockImplementation() as any)(...args)
    })
    await payoutTokens(P({ blind: true }))
    expect(atSubmit).toMatchObject({ recipient: RECIPIENT, assetId: ID })
  })

  it('an intent write that fails fails the payout before the submit and releases the inputs', async () => {
    const mem = memoryStorage()
    configureStorage({
      ...mem,
      setItem: async (k: string, v: string) => {
        if (k.startsWith('mandala.notifyJournal.')) throw new Error('disk full')
        await mem.setItem(k, v)
      }
    })
    try {
      await expect(payoutTokens(P())).rejects.toThrow(/disk full/)
      expect(submitAndBroadcast).not.toHaveBeenCalled()
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
      expect(mb.sendMessage).not.toHaveBeenCalled()
    } finally {
      configureStorage(null)
    }
  })

  it('a reissue journals its intent before the submit; a failed intent write aborts before the submit', async () => {
    wallet.listOutputs.mockImplementation(async () => ({ outputs: [{ outpoint: asset.authOutpoint }], BEEF: [1] }) as any)
    const reissue = async () => await submitAdminAction({
      wallet: wallet as any,
      asset,
      details: { kind: 'reissue', outpoint: 'f'.repeat(64) + '.0', recipient: RECIPIENT },
      ftOutput: { recipient: RECIPIENT, amount: 5n },
      messageBoxClient: mb,
      identityKey: ISSUER
    } as any)
    let atSubmit: any
    vi.mocked(submitAndBroadcast).mockImplementationOnce(async (...args: any[]) => {
      atSubmit = await notifyList()
      return await (vi.mocked(submitAndBroadcast).getMockImplementation() as any)(...args)
    })
    await reissue()
    expect(atSubmit).toMatchObject([{
      txid: TXID,
      pending: true,
      intent: { assetId: ID, recipientKey: RECIPIENT, outputIndex: 0, senderIdentityKey: ISSUER, declarationTxHex: DEPLOY_HEX, topics: [colorTopic(ID)] }
    }])
    expect(await notifyList()).toEqual([])

    clearAdminAuthGates()
    vi.mocked(submitAndBroadcast).mockClear()
    wallet.abortAction.mockClear()
    const mem = memoryStorage()
    configureStorage({
      ...mem,
      setItem: async (k: string, v: string) => {
        if (k.startsWith('mandala.notifyJournal.')) throw new Error('disk full')
        await mem.setItem(k, v)
      }
    })
    try {
      await expect(reissue()).rejects.toThrow(/disk full/)
      expect(submitAndBroadcast).not.toHaveBeenCalled()
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' })
    } finally {
      configureStorage(null)
    }
  })

  it('a reissue refused by the overlay leaves no intent behind', async () => {
    wallet.listOutputs.mockImplementation(async () => ({ outputs: [{ outpoint: asset.authOutpoint }], BEEF: [1] }) as any)
    vi.mocked(submitAndBroadcast).mockRejectedValueOnce(new Error('overlay refused (ERR_FROZEN)'))
    await expect(submitAdminAction({
      wallet: wallet as any,
      asset,
      details: { kind: 'reissue', outpoint: 'f'.repeat(64) + '.0', recipient: RECIPIENT },
      ftOutput: { recipient: RECIPIENT, amount: 5n },
      messageBoxClient: mb,
      identityKey: ISSUER
    } as any)).rejects.toThrow(/ERR_FROZEN/)
    expect(await notifyList()).toEqual([])
  })

  it('crash after admission: the next pass completes the receipt from the accepted entry and sends it', async () => {
    const raw = await crashAfterAdmission(async () => await payoutTokens(P({ note: 'october' })), true)
    // The live path removed the intent on the "crash" error; a real crash would not have.
    const intent = (await restoreAged(raw, 61_000)).intent
    const fetchSpy = lookupAnswers([])
    const later = mkMb()
    expect(await reconcileNotifications(later)).toEqual([TXID])
    expect(fetchSpy).not.toHaveBeenCalled() // σ came from the journal, no lookup
    expect(submitToOverlay).not.toHaveBeenCalled()
    const receipt = issuerReceipt({
      assetId: ID,
      derivationPrefix: intent.derivationPrefix,
      derivationSuffix: intent.derivationSuffix,
      senderIdentityKey: intent.senderIdentityKey,
      declarationTx: DEPLOY.toBinary(),
      attestation: ATT,
      offChainValues: Utils.toArray(intent.offChainHex, 'hex')
    })
    expect(later.sendMessage).toHaveBeenCalledTimes(1)
    expect(later.sendMessage.mock.calls[0][0]).toEqual({
      recipient: RECIPIENT,
      messageBox: MESSAGEBOX,
      body: handoverBody({ assetId: ID, outputIndex: 0, tx: ATOMIC, receipt, note: 'october' })
    })
    expect(await notifyList()).toEqual([])
    // The broadcast owns the 'accepted' entry; completion never touches it.
    expect((await journalGet(TXID))?.stage).toBe('accepted')
  })

  it('a failed completion send keeps the final body (not the intent) for the next pass', async () => {
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), true)
    await restoreAged(raw, 61_000)
    const down = { sendMessage: vi.fn(async () => { throw new Error('box down') }) }
    expect(await reconcileNotifications(down)).toEqual([])
    const kept = await notifyList()
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ txid: TXID, attempts: 1, body: { v: 3, kind: 'handover' } })
    expect((kept[0] as any).pending).toBeUndefined()
  })

  it('an intent younger than 60 s is left alone, even with an accepted entry (the live payout is still delivering)', async () => {
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), true)
    await restoreAged(raw, 10_000)
    const later = mkMb()
    expect(await reconcileNotifications(later)).toEqual([])
    expect(later.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true }])
  })

  it('no accepted entry and younger than INTENT_TTL_MS: waits, with no lookup and no submit', async () => {
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    await restoreAged(raw, 120_000)
    const fetchSpy = lookupAnswers([{ txid: TXID, outputIndex: 0 }])
    const later = mkMb()
    expect(await reconcileNotifications(later)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(later.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true }])
  })

  it('no accepted entry, past INTENT_TTL_MS, output absent from color-admission: dropped with no submit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    await restoreAged(raw, INTENT_TTL_MS + 1000)
    const fetchSpy = lookupAnswers([{ txid: 'a'.repeat(64), outputIndex: 0 }, { txid: TXID, outputIndex: 1 }])
    const later = mkMb()
    expect(await reconcileNotifications(later)).toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(sent).toEqual({
      service: `ls_color_${ID}`,
      query: { type: 'color-admission', version: 1, assetId: ID, topic: colorTopic(ID), outpoints: [`${TXID}.0`] }
    })
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(later.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toEqual([])
  })

  it('past INTENT_TTL_MS, output absent, but a retryable entry still holds the action: kept (reconcile may yet admit it)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    await restoreAged(raw, INTENT_TTL_MS + 1000)
    await journalPut({
      txid: TXID, stage: 'retryable', at: Date.now(), reference: 'ref-1', code: 'ERR_UNAVAILABLE', attempts: 0,
      submit: { txHex: Utils.toHex(ATOMIC), topics: [colorTopic(ID)] }
    })
    lookupAnswers([])
    expect(await reconcileNotifications(mkMb())).toEqual([])
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true }])
  })

  it('no accepted entry, past INTENT_TTL_MS, lookup unavailable: kept, no submit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    await restoreAged(raw, INTENT_TTL_MS + 1000)
    lookupAnswers('down')
    expect(await reconcileNotifications(mkMb())).toEqual([])
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true }])
  })

  it('no accepted entry, past INTENT_TTL_MS, output admitted: re-POSTs the journaled bytes and completes the receipt', async () => {
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    const intent = (await restoreAged(raw, INTENT_TTL_MS + 1000)).intent
    lookupAnswers([{ txid: TXID, outputIndex: 0 }])
    vi.mocked(submitToOverlay).mockResolvedValue({ topic: colorTopic(ID), outputsToAdmit: ATT.outputs, admissionSignature: ATT.signature, admissionIdentityKey: ATT.signer, attestation: ATT } as any)
    const later = mkMb()
    expect(await reconcileNotifications(later)).toEqual([TXID])
    expect(submitToOverlay).toHaveBeenCalledTimes(1)
    const [beef, offChain, , topics] = vi.mocked(submitToOverlay).mock.calls[0]
    expect(beef).toEqual(ATOMIC)
    expect(offChain).toEqual(Utils.toArray(intent.offChainHex, 'hex'))
    expect(topics).toEqual([colorTopic(ID)])
    const body = later.sendMessage.mock.calls[0][0].body as any
    expect(body.receipt.profileData[ATTESTED_PROFILE_ID][ID].attestations).toEqual([ATT])
    expect(body.receipt.derivationPrefix).toBe(intent.derivationPrefix)
    expect(await notifyList()).toEqual([])
  })

  it('an admitted re-POST whose attestation does not cover the recipient output keeps the intent pending', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    await restoreAged(raw, INTENT_TTL_MS + 1000)
    lookupAnswers([{ txid: TXID, outputIndex: 0 }])
    const other = await attest([1])
    vi.mocked(submitToOverlay).mockResolvedValue({ topic: colorTopic(ID), outputsToAdmit: [1], admissionSignature: other.signature, admissionIdentityKey: other.signer, attestation: other } as any)
    const later = mkMb()
    expect(await reconcileNotifications(later)).toEqual([])
    expect(later.sendMessage).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true }])
  })

  it('a malformed overlay key is treated like S5: the intent is neither looked up, re-POSTed nor dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    await restoreAged(raw, INTENT_TTL_MS + 1000)
    const fetchSpy = lookupAnswers([])
    configureMandala({ overlayIdentityKey: 'not-a-key' })
    expect(await reconcileNotifications(mkMb())).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(submitToOverlay).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true }])
    expect(warn.mock.calls.filter(c => /receipt intents wait/.test(String(c[0])))).toHaveLength(1)
  })

  it('S5: with the overlay key unset a pending intent is neither looked up nor dropped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = await crashAfterAdmission(async () => await payoutTokens(P()), false)
    await restoreAged(raw, INTENT_TTL_MS + 1000)
    const fetchSpy = lookupAnswers([])
    configureMandala({ overlayIdentityKey: '' })
    expect(await reconcileNotifications(mkMb())).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await notifyList()).toMatchObject([{ txid: TXID, pending: true }])
  })
})
