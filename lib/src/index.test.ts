import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PrivateKey, type WalletInterface } from '@bsv/sdk'

// The facade is wiring only: the pipelines it composes are mocked so these
// tests pin the order, the arguments and what each failure does to `send`.
// Partial mocks: reconcile and receive import other names from the same modules.
vi.mock('./handover.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./handover.js')>()),
  sendHandover: vi.fn(),
  deliverHandover: vi.fn(),
  settleHandover: vi.fn()
}))
vi.mock('./receive.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./receive.js')>()),
  receiveHandovers: vi.fn()
}))
vi.mock('./payout.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./payout.js')>()),
  payoutTokens: vi.fn()
}))
const messageBox = vi.hoisted(() => ({ sendMessage: async () => ({}), listMessages: async () => [], acknowledgeMessage: async () => ({}) }))
vi.mock('@bsv/message-box-client', async importOriginal => ({
  ...(await importOriginal<typeof import('@bsv/message-box-client')>()),
  MessageBoxClient: vi.fn(function () { return messageBox })
}))

const {
  resolveAssetMetadata, parseMetadataFromBeef, payloadHash, journalListStranded, RETRY_CAP, BROADCAST_RETRY_CAP,
  createMandalaClient, sendHandover, deliverHandover, settleHandover, receiveHandovers, payoutTokens, BusyError
} = await import('./index.js')
type AssetMetadata = import('./index.js').AssetMetadata
type FetchAdmissionOptions = import('./index.js').FetchAdmissionOptions
type JournalSubmit = import('./index.js').JournalSubmit
type HandoverResult = import('./index.js').HandoverResult

describe('index — metadata is reachable from the package root', () => {
  it('exports resolveAssetMetadata and parseMetadataFromBeef', () => {
    expect(typeof resolveAssetMetadata).toBe('function')
    expect(typeof parseMetadataFromBeef).toBe('function')
  })

  it('exports the AssetMetadata type', () => {
    const meta: AssetMetadata = { label: 'Gold', ticker: 'GLD', decimals: 2 }
    expect(meta.label).toBe('Gold')
  })

  // A duplicated name would make `export *` drop it silently, so the amendment
  // v2.1 surface is asserted at the package root, not just at its own module.
  it('exports the amendment v2.1 surface from the package root', () => {
    expect(typeof payloadHash).toBe('function')
    expect(typeof journalListStranded).toBe('function')
    expect(RETRY_CAP).toBeGreaterThan(0)
    expect(BROADCAST_RETRY_CAP).toBeGreaterThan(0)
    const fetchOpts: FetchAdmissionOptions = { payloadHash: payloadHash([]) }
    const submit: JournalSubmit = { txHex: 'de', topics: ['tm_mandala'] }
    expect(fetchOpts.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(submit.topics).toEqual(['tm_mandala'])
  })
})

const ME = PrivateKey.fromString('0a'.padStart(64, '0')).toPublicKey().toString()
const BOB = PrivateKey.fromString('0b'.padStart(64, '0')).toPublicKey().toString()
const OVERLAY_KEY = '02' + 'c3'.repeat(32)
const ASSET = 'd4'.repeat(32) + '_0'
const TXID = 'e5'.repeat(32)

const handover: HandoverResult = {
  txid: TXID,
  tx: [1, 2, 3],
  reference: 'ref-1',
  outputIndex: 0,
  receipt: { version: 1, assetId: ASSET, derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: ME },
  body: {} as any,
  offChainValues: [9]
}
const ledger = { get: vi.fn(), put: vi.fn(), list: vi.fn(), putSubmission: vi.fn(), getSubmission: vi.fn(), removeSubmission: vi.fn() } as any
const markSettled = vi.fn(async () => {})
const admitted = { status: 'admitted' as const, attestation: { txid: TXID, outputs: [0], signer: OVERLAY_KEY, signature: '30' } }

function fakeWallet (): WalletInterface {
  return { getPublicKey: vi.fn(async () => ({ publicKey: ME })) } as unknown as WalletInterface
}

function client (wallet = fakeWallet()) {
  return createMandalaClient({ wallet, overlayUrl: 'https://overlay.test', overlayIdentityKey: OVERLAY_KEY, messageBoxUrl: 'https://mb.test', ledger, markSettled })
}

describe('createMandalaClient.send', () => {
  beforeEach(() => {
    vi.mocked(sendHandover).mockReset().mockResolvedValue(handover)
    vi.mocked(deliverHandover).mockReset().mockResolvedValue(undefined)
    vi.mocked(settleHandover).mockReset().mockResolvedValue(admitted)
  })

  it('send to another key: sendHandover → deliverHandover → settleHandover with the configured overlay key', async () => {
    const wallet = fakeWallet()
    const r = await client(wallet).send({ assetId: ASSET, counterparty: BOB, amount: 400n, note: 'rent june', blind: false })
    expect(sendHandover).toHaveBeenCalledWith({ wallet, identityKey: ME, assetId: ASSET, amount: 400n, recipientKey: BOB, blind: false, note: 'rent june', ledger })
    expect(deliverHandover).toHaveBeenCalledWith({ messageBoxClient: messageBox, recipientKey: BOB, handover })
    expect(settleHandover).toHaveBeenCalledWith({ wallet, handover, assetId: ASSET, overlayIdentityKey: OVERLAY_KEY, ledger, markSettled })
    const order = [sendHandover, deliverHandover, settleHandover].map(f => vi.mocked(f).mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(r).toEqual({ handover, notified: true, settle: admitted })
  })

  it('send to self skips deliverHandover and calls settleHandover', async () => {
    const r = await client().send({ assetId: ASSET, counterparty: ME, amount: 5n })
    expect(sendHandover).toHaveBeenCalledWith(expect.objectContaining({ identityKey: ME, recipientKey: ME, amount: 5n }))
    expect(deliverHandover).not.toHaveBeenCalled()
    expect(settleHandover).toHaveBeenCalledTimes(1)
    // A self-send owes no delivery; the sender already holds it.
    expect(r).toEqual({ handover, notified: true, settle: admitted })
  })

  it('deliver failure ⇒ notified false, no settle (B5), and send still resolves', async () => {
    vi.mocked(deliverHandover).mockRejectedValue(new Error('messagebox down'))
    const r = await client().send({ assetId: ASSET, counterparty: BOB, amount: 400n })
    expect(r.notified).toBe(false)
    expect(r.handover).toBe(handover)
    expect(r.settle).toBeUndefined()
    expect(settleHandover).not.toHaveBeenCalled()
  })

  it('settle throwing ⇒ send resolves with settle undefined', async () => {
    vi.mocked(settleHandover).mockRejectedValue(new Error('overlay identity key unset'))
    const r = await client().send({ assetId: ASSET, counterparty: BOB, amount: 400n })
    expect(r).toEqual({ handover, notified: true })
    expect('settle' in r).toBe(false)
  })

  it('a settle verdict that is not admitted is passed through', async () => {
    vi.mocked(settleHandover).mockResolvedValue({ status: 'retry', code: 'ERR_PAUSED' })
    const r = await client().send({ assetId: ASSET, counterparty: BOB, amount: 400n })
    expect(r.settle).toEqual({ status: 'retry', code: 'ERR_PAUSED' })
  })

  // Double-click / multi-tab: the BusyError from the mandala.send lock reaches
  // the caller; nothing is delivered or settled for the refused second send.
  it('a sendHandover failure propagates and nothing is delivered', async () => {
    vi.mocked(sendHandover).mockRejectedValue(new BusyError('A token send is already in progress in another tab'))
    await expect(client().send({ assetId: ASSET, counterparty: BOB, amount: 1n })).rejects.toMatchObject({ name: 'BusyError' })
    expect(deliverHandover).not.toHaveBeenCalled()
    expect(settleHandover).not.toHaveBeenCalled()
  })

  it('resolves the identity key once per client', async () => {
    const wallet = fakeWallet()
    const c = client(wallet)
    await c.send({ assetId: ASSET, counterparty: BOB, amount: 1n })
    await c.send({ assetId: ASSET, counterparty: BOB, amount: 2n })
    expect(wallet.getPublicKey).toHaveBeenCalledTimes(1)
  })

  it('a failed identity-key lookup (locked wallet) is retried on the next call, not cached', async () => {
    const wallet = fakeWallet()
    vi.mocked(wallet.getPublicKey).mockRejectedValueOnce(new Error('locked'))
    const c = client(wallet)
    await expect(c.send({ assetId: ASSET, counterparty: BOB, amount: 1n })).rejects.toThrow('locked')
    expect(sendHandover).not.toHaveBeenCalled()
    await expect(c.send({ assetId: ASSET, counterparty: BOB, amount: 1n })).resolves.toMatchObject({ notified: true })
    expect(wallet.getPublicKey).toHaveBeenCalledTimes(2)
  })
})

describe('createMandalaClient.receive / payout', () => {
  it('receive passes one long-lived processed set across passes', async () => {
    vi.mocked(receiveHandovers).mockReset().mockResolvedValue({ accepted: [], failed: [] })
    const wallet = fakeWallet()
    const c = client(wallet)
    await c.receive()
    await c.receive({ assetId: ASSET })
    const [a, b] = vi.mocked(receiveHandovers).mock.calls.map(x => x[0])
    expect(a).toMatchObject({ wallet, messageBoxClient: messageBox })
    expect(a.assetId).toBeUndefined()
    expect(b).toMatchObject({ wallet, messageBoxClient: messageBox, assetId: ASSET })
    expect(a.processed).toBeInstanceOf(Set)
    expect(b.processed).toBe(a.processed)
  })

  it('payout fills wallet, identityKey and messageBoxClient', async () => {
    vi.mocked(payoutTokens).mockReset().mockResolvedValue({ txid: TXID } as any)
    const wallet = fakeWallet()
    const asset = { assetId: ASSET } as any
    await client(wallet).payout({ asset, amount: 7n, recipientKey: BOB, note: 'n' })
    expect(payoutTokens).toHaveBeenCalledWith({ wallet, identityKey: ME, messageBoxClient: messageBox, asset, amount: 7n, recipientKey: BOB, note: 'n' })
  })
})
