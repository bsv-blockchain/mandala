import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Beef, LockingScript, Transaction } from '@bsv/sdk'

vi.mock('./overlay.js', async () => {
  const actual = await vi.importActual<typeof import('./overlay.js')>('./overlay.js')
  return { ...actual, submitAndBroadcast: vi.fn() }
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

const { submitAndBroadcast } = await import('./overlay.js')
const { loadFtCandidates } = await import('./ftCandidates.js')
const { selectFtInputs } = await import('./ftSelect.js')
const { prepareBlindedPayment } = await import('./blinding.js')
const { transferTokens } = await import('./transfer.js')
const { journalClear } = await import('./txJournal.js')
const { notifyClear } = await import('./notifyJournal.js')

const ASSET = `${'11'.repeat(32)}.0`
const RECIPIENT = '02' + 'ab'.repeat(32)
const SENDER_BLINDED = '03' + 'cd'.repeat(32)
const OVERLAY_KEY = '02' + 'ef'.repeat(32)
const TXID = 'a'.repeat(64)

/** A signable BEEF the pipeline can parse and sign (no inputs to unlock). */
const signableBeef = (): number[] => {
  const t = new Transaction()
  t.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
  return t.toBEEF()
}

const mkWallet = (): any => ({
  createAction: vi.fn().mockResolvedValue({
    signableTransaction: { tx: signableBeef(), reference: 'ref-1' }
  }),
  signAction: vi.fn().mockResolvedValue({ tx: [1, 2, 3], txid: TXID }),
  getPublicKey: vi.fn().mockResolvedValue({ publicKey: RECIPIENT })
})

const send = async (overrides: Record<string, unknown> = {}): Promise<{ body: any, result: any, wallet: any }> => {
  const wallet = mkWallet()
  const messageBoxClient = { sendMessage: vi.fn().mockResolvedValue({}) }
  const result = await transferTokens({
    wallet,
    messageBoxClient,
    identityKey: '02' + '11'.repeat(32),
    assetId: ASSET,
    amount: 5,
    recipientKey: RECIPIENT,
    ...overrides
  })
  return { body: messageBoxClient.sendMessage.mock.calls[0][0].body, result, wallet }
}

beforeEach(async () => {
  await journalClear()
  await notifyClear()
  vi.mocked(loadFtCandidates).mockResolvedValue({ candidates: [], beef: new Beef().toBinary() })
  vi.mocked(selectFtInputs).mockReturnValue({ selected: [], total: 5 })
  vi.mocked(prepareBlindedPayment).mockResolvedValue({
    pubKeyHash: new Array(20).fill(4),
    senderBlinded: SENDER_BLINDED,
    r: 'rr',
    linkage: {}
  } as any)
})

describe('transferTokens — A12 receipt and the optional wire admission', () => {
  it('returns all three receipt fields the overlay handed back', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({
      outputsToAdmit: [0, 1],
      admissionSignature: 'deadbeef',
      admissionIdentityKey: OVERLAY_KEY
    })
    const { result } = await send()
    expect(result).toMatchObject({
      txid: TXID,
      notified: true,
      admissionSignature: 'deadbeef',
      admissionIdentityKey: OVERLAY_KEY,
      outputsToAdmit: [0, 1]
    })
  })

  it('forwards the tip’s own admission on the MessageBox body (the sender submitted online)', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({
      outputsToAdmit: [0, 1],
      admissionSignature: 'deadbeef',
      admissionIdentityKey: OVERLAY_KEY
    })
    const { body } = await send()
    expect(body.admission).toEqual({
      txid: TXID,
      outputsToAdmit: [0, 1],
      signature: 'deadbeef',
      signerKey: OVERLAY_KEY
    })
  })

  it('omits admission entirely when the overlay returned no σ_I (legacy-shaped body)', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { body, result } = await send()
    expect('admission' in body).toBe(false)
    expect(result.admissionSignature).toBeUndefined()
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('omits admission when the overlay returned a signature but no key to verify it with', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0], admissionSignature: 'deadbeef' })
    const { body } = await send()
    expect('admission' in body).toBe(false)
  })
})

describe('transferTokens — the optional sender note', () => {
  it('uses the sender’s note as the action description in place of the fixed wording', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { wallet } = await send({ note: 'lunch split' })
    const args = wallet.createAction.mock.calls[0][0]
    expect(args.description).toBe('lunch split')
  })

  it('falls back to the fixed "Send N of assetId" wording when no note is given', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { wallet } = await send()
    const args = wallet.createAction.mock.calls[0][0]
    expect(args.description).toBe(`Send 5 of ${ASSET}`)
  })

  it('carries the note on the MessageBox body so the recipient can show it too', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { body } = await send({ note: 'thanks!' })
    expect(body.note).toBe('thanks!')
  })

  it('omits the note from the body entirely when none is given', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { body } = await send()
    expect('note' in body).toBe(false)
  })

  it('trims whitespace-only notes to nothing, on both the description and the body', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { wallet, body } = await send({ note: '   ' })
    expect(wallet.createAction.mock.calls[0][0].description).toBe(`Send 5 of ${ASSET}`)
    expect('note' in body).toBe(false)
  })
})

describe('transferTokens — atomicBeef and offChainValues', () => {
  it('returns the exact signed AtomicBEEF bytes and off-chain payload posted to the overlay', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { result } = await send()
    const calls = vi.mocked(submitAndBroadcast).mock.calls
    const [, signedArg, offChainArg] = calls[calls.length - 1]
    expect(Array.isArray(result.atomicBeef)).toBe(true)
    expect(result.atomicBeef).toEqual((signedArg as any).tx)
    expect(result.offChainValues).toEqual(offChainArg)
  })
})

// ---------------------------------------------------------------------------
// The createAction reference — a host that maps reference → txid can tell a
// live noSend action from an abandoned one without guessing (2026-09-15).
// ---------------------------------------------------------------------------

describe('transferTokens — the signableTransaction reference reaches the caller', () => {
  it('returns it on the submit rail', async () => {
    vi.mocked(submitAndBroadcast).mockResolvedValue({ outputsToAdmit: [0] })
    const { result } = await send()
    expect(result.reference).toBe('ref-1')
  })
})
