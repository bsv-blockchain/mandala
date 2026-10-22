/**
 * MessageBox receive into BRC-207 receipts (plan 04 Task 14, C§7.1-7.2, G13,
 * G17, D22): strict v3 body parse, script-checked output, internalize with the
 * receipt verbatim, acknowledge only on credit or a definitive refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { InvalidTransferError, parseHandoverBody, receiveHandovers } from './receive.js'
import { ATTESTED_PROFILE_ID, MANDALA_PROFILE_ID, MESSAGEBOX } from './constants.js'
import { assetTag } from './naming.js'

const ID = `${'c7'.repeat(32)}_0`
const OTHER = `${'d8'.repeat(32)}_0`
const SENDER = new PrivateKey(77).toPublicKey().toString()
const pkh = new PrivateKey(11).toPublicKey().toHash() as number[]

function buildTip (script: LockingScript, satoshis = 1): { tx: number[], txid: string } {
  const src = new Transaction()
  src.addOutput({ satoshis: 10, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  tx.addOutput({ satoshis, lockingScript: script })
  return { tx: tx.toAtomicBEEF(), txid: tx.id('hex') }
}

const TIP = buildTip(new OneColor().lock(ID, 5n, pkh))
const TXID = TIP.txid

const RECEIPT = {
  version: 1,
  assetId: ID,
  derivationPrefix: 'cHJlZml4cHJlZml4cHJlZg==',
  derivationSuffix: 'c3VmZml4c3VmZml4c3VmZg==',
  senderIdentityKey: SENDER,
  profileData: {
    [ATTESTED_PROFILE_ID]: {
      [ID]: { declarationTx: '00', transactions: [], attestations: [], submissions: [{ txid: TXID, offChainValues: '00' }] }
    }
  }
}

function body (over: Record<string, unknown> = {}, tip = TIP): Record<string, unknown> {
  return { v: 3, kind: 'handover', assetId: ID, outputIndex: 0, tx: Utils.toHex(tip.tx), receipt: RECEIPT, ...over }
}

function mkMb (messages: Array<{ messageId: string, body: unknown }>) {
  return {
    listMessages: vi.fn(async () => messages.map(m => ({ ...m, sender: SENDER }))),
    acknowledgeMessage: vi.fn(async () => ({}))
  }
}

function mkWallet (outputs: Array<{ outpoint: string, tags?: string[] }> = []) {
  return {
    internalizeAction: vi.fn(async () => ({ accepted: true })),
    listOutputs: vi.fn(async () => ({ totalOutputs: outputs.length, outputs }))
  } as any
}

describe('parseHandoverBody (C§7.2 strict)', () => {
  it('returns the receipt verbatim (same object) and the decoded tx', () => {
    const p = parseHandoverBody(body({ note: 'lunch money' }))
    expect(p.assetId).toBe(ID)
    expect(p.outputIndex).toBe(0)
    expect(p.tx).toEqual(TIP.tx)
    expect(p.receipt).toBe(RECEIPT)
    expect(p.note).toBe('lunch money')
  })

  it('accepts a JSON string body', () => {
    expect(parseHandoverBody(JSON.stringify(body())).receipt).toEqual(RECEIPT)
  })

  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['an array', [body()]],
    ['a non-JSON string', '{not json'],
    ['a v2 body', body({ v: 2 })],
    ['a wrong kind', body({ kind: 'payment' })],
    ['an extra amount member', body({ amount: '5' })],
    ['a missing tx', (() => { const b = body(); delete b.tx; return b })()],
    ['a non-Mandala asset id (_1)', body({ assetId: `${'c7'.repeat(32)}_1` })],
    ['an uppercase asset id', body({ assetId: ID.toUpperCase() })],
    ['a negative outputIndex', body({ outputIndex: -1 })],
    ['a fractional outputIndex', body({ outputIndex: 0.5 })],
    ['an outputIndex above uint32', body({ outputIndex: 2 ** 32 })],
    ['a string outputIndex', body({ outputIndex: '0' })],
    ['odd-length hex tx', body({ tx: 'abc' })],
    ['uppercase hex tx', body({ tx: Utils.toHex(TIP.tx).toUpperCase() })],
    ['an empty tx', body({ tx: '' })],
    ['a non-string note', body({ note: 5 })],
    ['a receipt with 5 members', body({ receipt: (() => { const { profileData, ...r } = RECEIPT; return r })() })],
    ['a receipt with 7 members', body({ receipt: { ...RECEIPT, lifecycles: {} } })],
    ['receipt version 2', body({ receipt: { ...RECEIPT, version: 2 } })],
    ['a receipt for another asset', body({ receipt: { ...RECEIPT, assetId: OTHER } })],
    ['a prefix of 49 bytes', body({ receipt: { ...RECEIPT, derivationPrefix: 'a'.repeat(49) } })],
    ['a suffix with whitespace', body({ receipt: { ...RECEIPT, derivationSuffix: 'a b' } })],
    ['a bad sender key', body({ receipt: { ...RECEIPT, senderIdentityKey: '02' + 'zz'.repeat(32) } })],
    ['an off-curve sender key', body({ receipt: { ...RECEIPT, senderIdentityKey: '02' + 'ff'.repeat(32) } })],
    ['a receipt carrying a MANDALA_PROFILE_ID leaf', body({ receipt: { ...RECEIPT, profileData: { ...RECEIPT.profileData, [MANDALA_PROFILE_ID]: { [ID]: {} } } } })],
    ['a missing attested leaf', body({ receipt: { ...RECEIPT, profileData: {} } })],
    ['an attested leaf for another asset only', body({ receipt: { ...RECEIPT, profileData: { [ATTESTED_PROFILE_ID]: { [OTHER]: {} } } } })],
    ['a non-object attested leaf', body({ receipt: { ...RECEIPT, profileData: { [ATTESTED_PROFILE_ID]: { [ID]: 'x' } } } })]
  ]
  it.each(bad)('rejects %s with InvalidTransferError', (_n, b) => {
    let err: unknown
    try { parseHandoverBody(b) } catch (e) { err = e }
    expect((err as Error)?.name).toBe('InvalidTransferError')
    expect(err).toBeInstanceOf(InvalidTransferError)
  })
})

describe('receiveHandovers', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('internalizes the receipt verbatim into p color <assetTag>, then acknowledges', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(mb.listMessages).toHaveBeenCalledWith({ messageBox: MESSAGEBOX, acceptPayments: false })
    const ia = wallet.internalizeAction.mock.calls[0][0]
    expect(ia.outputs[0]).toEqual({
      outputIndex: 0,
      protocol: 'basket insertion',
      insertionRemittance: { basket: `p color ${assetTag(ID)}`, customInstructions: JSON.stringify(RECEIPT) }
    })
    expect(ia.tx).toEqual(TIP.tx)
    expect(ia.labels).toEqual(['mandala', 'receive'])
    expect(ia.description).toBe('Receive Mandala tokens')
    expect(r.accepted[0]).toEqual({ messageId: 'm1', txid: TXID, assetId: ID, amount: 5n, outputIndex: 0, offline: false })
    expect(r.failed).toEqual([])
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    // acknowledge only after the internalize resolved
    expect(mb.acknowledgeMessage.mock.invocationCallOrder[0]).toBeGreaterThan(wallet.internalizeAction.mock.invocationCallOrder[0])
  })

  it('uses a 5..50-byte note as the description, else the default', async () => {
    const wallet = mkWallet()
    await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body({ note: 'lunch money' }) }]) })
    expect(wallet.internalizeAction.mock.calls[0][0].description).toBe('lunch money')
    const w2 = mkWallet()
    await receiveHandovers({ wallet: w2, messageBoxClient: mkMb([{ messageId: 'm1', body: body({ note: 'hi' }) }]) })
    expect(w2.internalizeAction.mock.calls[0][0].description).toBe('Receive Mandala tokens')
  })

  it('parses a JSON string body', async () => {
    const wallet = mkWallet()
    const r = await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: JSON.stringify(body()) }]) })
    expect(r.accepted).toHaveLength(1)
  })

  it('a v2 body is refused and acknowledged; internalizeAction not called', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: { v: 2, kind: 'handover', assetId: ID, amount: '5' } }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect((r.failed[0].error as Error).name).toBe('InvalidTransferError')
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  const badOutputs: Array<[string, Record<string, unknown>]> = [
    ['an output index out of range', body({ outputIndex: 1 })],
    ['a tx that is not AtomicBEEF', body({ tx: 'deadbeef' })],
    ['a 2-sat token output', body({}, buildTip(new OneColor().lock(ID, 5n, pkh), 2))],
    ['an output of another asset', body({}, buildTip(new OneColor().lock(OTHER, 5n, pkh)))],
    ['a non-token output', body({}, buildTip(new P2PKH().lock(pkh)))]
  ]
  it.each(badOutputs)('%s ⇒ InvalidTransferError, acked, not internalized', async (_n, b) => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: b }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect((r.failed[0].error as Error).name).toBe('InvalidTransferError')
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('an authority output is not a value receipt', async () => {
    const auth = new OneColor().lock(ID, 0n, pkh)
    expect(OneColor.decode(auth).role).toBe('authority')
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body({}, buildTip(auth)) }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect((r.failed[0].error as Error).name).toBe('InvalidTransferError')
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('retryable verdict leaves the message unacknowledged', async () => {
    const wallet = mkWallet()
    wallet.internalizeAction.mockRejectedValueOnce(new Error('mandala overlay refused (ERR_FROZEN, retryable): frozen'))
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, processed })
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    expect(r.failed[0].code).toBe('ERR_FROZEN')
    expect(r.accepted).toEqual([])
    expect(processed.has('m1')).toBe(false)
  })

  it('a final verdict (ERR_CONSERVATION) is acknowledged with its code', async () => {
    const wallet = mkWallet()
    wallet.internalizeAction.mockRejectedValueOnce(new Error('mandala overlay refused (ERR_CONSERVATION): burn'))
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, processed })
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    expect(r.failed[0].code).toBe('ERR_CONSERVATION')
    expect(processed.has('m1')).toBe(true)
  })

  it.each(['ERR_LINKAGE', 'ERR_SHAPE', 'ERR_SATOSHIS', 'ERR_INPUT_SPENT', 'ERR_EVICTED', 'ERR_AUTHORITY'])('final %s is acknowledged', async (code) => {
    const wallet = mkWallet()
    wallet.internalizeAction.mockRejectedValueOnce(new Error(`refused (${code}): x`))
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(mb.acknowledgeMessage).toHaveBeenCalledTimes(1)
  })

  it('a final-listed code marked retryable, and an unlisted final code, stay unacknowledged', async () => {
    for (const msg of ['refused (ERR_LINKAGE, retryable): x', 'refused (ERR_UNKNOWN_ASSET): x']) {
      const wallet = mkWallet()
      wallet.internalizeAction.mockRejectedValueOnce(new Error(msg))
      const mb = mkMb([{ messageId: 'm1', body: body() }])
      await receiveHandovers({ wallet, messageBoxClient: mb })
      expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['named AttestationEvidenceError', Object.assign(new Error('frontier'), { name: 'AttestationEvidenceError' })],
    ['prefixed [AttestationEvidenceError]', new Error('[AttestationEvidenceError] bad signature')],
    ['named ProfileDataError', Object.assign(new Error('hop'), { name: 'ProfileDataError' })],
    ['prefixed [ProfileDataError]', new Error('[ProfileDataError] burn hop')]
  ])('an error %s is acknowledged', async (_n, err) => {
    const wallet = mkWallet()
    wallet.internalizeAction.mockRejectedValueOnce(err)
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
    expect(r.failed).toHaveLength(1)
  })

  it.each([
    ['a transport failure', new Error('fetch failed')],
    ['UnsupportedProfileError', Object.assign(new Error('unsupported'), { name: 'UnsupportedProfileError' })],
    ['ProfileParamsError', new Error('[ProfileParamsError] bad params')]
  ])('%s leaves the message unacknowledged and retryable', async (_n, err) => {
    const wallet = mkWallet()
    wallet.internalizeAction.mockRejectedValueOnce(err)
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, processed })
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    expect(processed.has('m1')).toBe(false)
    expect(r.failed[0].messageId).toBe('m1')
  })

  it('offline: the p color assets view tag color_offline marks the credit offline', async () => {
    const wallet = mkWallet([{ outpoint: `${TXID}.0`, tags: ['color_offline'] }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body() }]) })
    expect(r.accepted[0].offline).toBe(true)
    expect(wallet.listOutputs).toHaveBeenCalledTimes(1)
    expect(wallet.listOutputs.mock.calls[0][0]).toMatchObject({ basket: 'p color assets', includeTags: true, include: 'locking scripts', limit: 1000 })
    for (const c of wallet.listOutputs.mock.calls) expect(c[0].basket).not.toBe(`p color ${assetTag(ID)}`)
  })

  it('offline: the same outpoint without the tag is not offline', async () => {
    const wallet = mkWallet([{ outpoint: `${TXID}.0`, tags: [] }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body() }]) })
    expect(r.accepted[0].offline).toBe(false)
  })

  it('a listOutputs failure after crediting keeps the credit (offline false)', async () => {
    const wallet = mkWallet()
    wallet.listOutputs.mockRejectedValueOnce(new Error('db busy'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: body() }]) })
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0].offline).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('no listOutputs read when nothing was accepted', async () => {
    const wallet = mkWallet()
    await receiveHandovers({ wallet, messageBoxClient: mkMb([{ messageId: 'm1', body: { v: 2 } }]) })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('declined consent stays processed and is not acknowledged (G17)', async () => {
    for (const err of [
      Object.assign(new Error('declined'), { name: 'ColorConsentDeclinedError' }),
      new Error('[ColorConsentDeclinedError] declined')
    ]) {
      const wallet = mkWallet()
      wallet.internalizeAction.mockRejectedValueOnce(err)
      const mb = mkMb([{ messageId: 'm1', body: body() }])
      const processed = new Set<string>()
      const r = await receiveHandovers({ wallet, messageBoxClient: mb, processed })
      expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
      expect(processed.has('m1')).toBe(true)
      expect(r.failed).toHaveLength(1)
      await receiveHandovers({ wallet, messageBoxClient: mb, processed })
      expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    }
  })

  it('processed dedup: two parallel calls sharing one Set internalize once', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    const processed = new Set<string>()
    const [a, b] = await Promise.all([
      receiveHandovers({ wallet, messageBoxClient: mb, processed }),
      receiveHandovers({ wallet, messageBoxClient: mb, processed })
    ])
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(a.accepted.length + b.accepted.length).toBe(1)
  })

  it('an acknowledge failure after crediting keeps the credit and frees the id for a re-ack', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }])
    mb.acknowledgeMessage.mockRejectedValueOnce(new Error('network'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, processed })
    expect(r.accepted).toHaveLength(1)
    expect(processed.has('m1')).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('an acknowledge failure on a definitive refusal frees the id so a later run drops it', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: { v: 2 } }])
    mb.acknowledgeMessage.mockRejectedValueOnce(new Error('network'))
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, processed })
    expect(r.failed).toHaveLength(1)
    expect(processed.has('m1')).toBe(false)
  })

  it('assetId filter skips other assets without touching them', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: body() }, { messageId: 'm2', body: { ...body(), assetId: OTHER } }])
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, assetId: ID, processed })
    expect(r.accepted.map(x => x.messageId)).toEqual(['m1'])
    expect(r.failed).toEqual([])
    expect(processed.has('m2')).toBe(false)
    expect(mb.acknowledgeMessage).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the MessageBox decrypt-failure sentinel', '[Error: Failed to decrypt or parse message]'],
    ['the live unstringifiable sentinel', '[Error: Unstringifiable message]'],
    ['a non-JSON string', '{not json']
  ])('%s body is retried: never acknowledged, never internalized, id freed', async (_n, b) => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: b }])
    const processed = new Set<string>()
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, processed })
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(processed.has('m1')).toBe(false)
    expect(r.accepted).toEqual([])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].messageId).toBe('m1')
    expect(r.failed[0].code).toBe('ERR_BODY_UNREADABLE')
    // A later pass (wallet unlocked) still sees the message.
    await receiveHandovers({ wallet, messageBoxClient: mb, processed })
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
    expect(r.failed[0].error).toBeInstanceOf(InvalidTransferError)
  })

  it('an unreadable body next to a good one: the good one is credited, the unreadable one stays', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: '[Error: Failed to decrypt or parse message]' }, { messageId: 'm2', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(r.accepted.map(a => a.messageId)).toEqual(['m2'])
    expect(r.failed.map(f => f.messageId)).toEqual(['m1'])
    expect(mb.acknowledgeMessage).toHaveBeenCalledTimes(1)
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m2'] })
  })

  it('under an assetId filter the sentinel body is skipped and not acknowledged', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: '[Error: Failed to decrypt or parse message]' }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb, assetId: ID })
    expect(r.failed).toEqual([])
    expect(mb.acknowledgeMessage).not.toHaveBeenCalled()
  })

  it('a JSON body that parses but is definitively invalid is still acknowledged', async () => {
    const wallet = mkWallet()
    const mb = mkMb([{ messageId: 'm1', body: JSON.stringify(body({ amount: '5' })) }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(r.failed[0].code).toBeUndefined()
    expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
  })

  it('one bad message does not block the rest', async () => {
    const wallet = mkWallet()
    wallet.internalizeAction.mockRejectedValueOnce(new Error('fetch failed'))
    const mb = mkMb([{ messageId: 'm1', body: body() }, { messageId: 'm2', body: body() }])
    const r = await receiveHandovers({ wallet, messageBoxClient: mb })
    expect(r.failed.map(f => f.messageId)).toEqual(['m1'])
    expect(r.accepted.map(a => a.messageId)).toEqual(['m2'])
  })
})
