import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { admissionMessageV2 } from './admission.js'
import { configureMandala } from './constants.js'
import { receiveTokens } from './receive.js'

const OVERLAY = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000a1')
const OVERLAY_KEY = OVERLAY.toPublicKey().toString()
const IMPOSTOR = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000b2')

const ASSET = `${'11'.repeat(32)}.0`
const AMOUNT = 42
const OTHER_TXID = 'f'.repeat(64)

// Two outputs so "the admitted set does not name MY output" is expressible.
const tx = new Transaction()
tx.addOutput({ lockingScript: new MandalaToken().lock(ASSET, 7, new Array(20).fill(3)), satoshis: 1 })
tx.addOutput({ lockingScript: new MandalaToken().lock(ASSET, AMOUNT, new Array(20).fill(9)), satoshis: 1 })
const TX_BEEF = tx.toBEEF()
const TXID = tx.id('hex')
const MY_INDEX = 1

const sigOver = (txid: string, outputsToAdmit: number[], key = OVERLAY): string => {
  const der = key.sign(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8')).toDER()
  return typeof der === 'string' ? der : Utils.toHex(der)
}

const admission = (over: Partial<{ txid: string, outputsToAdmit: number[], signature: string, signerKey: string }> = {}): any => {
  const txid = over.txid ?? TXID
  const outputsToAdmit = over.outputsToAdmit ?? [0, MY_INDEX]
  return {
    txid,
    outputsToAdmit,
    signature: over.signature ?? sigOver(txid, outputsToAdmit),
    signerKey: over.signerKey ?? OVERLAY_KEY
  }
}

const message = (body: object = {}): any => ({
  messageId: 'm1',
  body: {
    assetId: ASSET,
    amount: String(AMOUNT),
    sender: '02' + 'cd'.repeat(32),
    senderMode: 'blinded',
    keyID: 'xfer-1',
    protocolID: [2, 'mandala token'],
    transaction: TX_BEEF,
    outputIndex: MY_INDEX,
    ...body
  }
})

const mkWallet = (): any => ({ internalizeAction: vi.fn().mockResolvedValue({ accepted: true }) })
const mkBox = (msgs: any[]): any => ({
  listMessages: vi.fn().mockResolvedValue(msgs),
  acknowledgeMessage: vi.fn().mockResolvedValue({})
})

const receive = async (body: object = {}): Promise<any> => {
  const wallet = mkWallet()
  const box = mkBox([message(body)])
  const res = await receiveTokens({ wallet, messageBoxClient: box })
  return { res, wallet, box }
}

beforeEach(() => {
  configureMandala({ overlayUrl: 'http://receive-test', overlayIdentityKey: OVERLAY_KEY })
  // resolveAssetMetadata does a real lookup; keep the test offline.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
})

afterAll(() => {
  configureMandala({ overlayUrl: '', overlayIdentityKey: '' })
  vi.unstubAllGlobals()
})

describe('A12 / FIX H — a counterparty-supplied σ_I is verified, never trusted on shape', () => {
  it('credits a legacy message with no admission at all, flagged unverified', async () => {
    const { res, wallet } = await receive()
    expect(res.failed).toEqual([])
    expect(res.accepted).toHaveLength(1)
    expect(res.accepted[0].admissionVerified).toBe(false)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('records a verified σ_I over this txid and an admitted set naming our output', async () => {
    const { res } = await receive({ admission: admission() })
    expect(res.accepted[0].admissionVerified).toBe(true)
  })

  it.each([
    ['a signature from another key', () => admission({ signerKey: IMPOSTOR.toPublicKey().toString() })],
    ['a signature that is not DER at all', () => admission({ signature: 'not-a-signature' })],
    ['a σ_I minted for a different txid', () => admission({ txid: OTHER_TXID })],
    ['a claimed admitted set the signature does not cover', () => ({ ...admission(), outputsToAdmit: [0, 1, 2] })],
    ['an admitted set that does not name our own output', () => admission({ outputsToAdmit: [0] })],
    ['a structurally broken entry', () => ({ txid: TXID })]
  ])('treats %s as ABSENT — still credited, never declined', async (_name, build) => {
    const { res, wallet } = await receive({ admission: (build as () => any)() })
    // FIX H: an unverifiable σ_I is not a negative ack. The transfer is still
    // accepted on the strength of the transaction itself; only the flag drops.
    expect(res.failed).toEqual([])
    expect(res.accepted).toHaveLength(1)
    expect(res.accepted[0].admissionVerified).toBe(false)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('cannot verify anything while no overlay identity key is configured', async () => {
    configureMandala({ overlayIdentityKey: '' })
    const { res } = await receive({ admission: admission() })
    expect(res.accepted[0].admissionVerified).toBe(false)
  })

  it('still refuses a body that contradicts its own transaction, admission or not', async () => {
    const { res, wallet } = await receive({ amount: '999', admission: admission() })
    expect(res.accepted).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(String(res.failed[0].error)).toMatch(/amount mismatch/)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })
})

describe('the sender’s optional note', () => {
  it('uses the sender’s note as the credited action’s description', async () => {
    const { wallet } = await receive({ note: 'thanks!' })
    const args = wallet.internalizeAction.mock.calls[0][0]
    expect(args.description).toBe('thanks!')
  })

  it('falls back to the fixed "Receive N of assetId" wording when the body carries no note', async () => {
    const { wallet } = await receive()
    const args = wallet.internalizeAction.mock.calls[0][0]
    expect(args.description).toBe(`Receive ${AMOUNT} of ${ASSET}`)
  })

  it('never lets a non-string note field through as a description', async () => {
    const { wallet } = await receive({ note: 12345 })
    const args = wallet.internalizeAction.mock.calls[0][0]
    expect(args.description).toBe(`Receive ${AMOUNT} of ${ASSET}`)
  })
})
