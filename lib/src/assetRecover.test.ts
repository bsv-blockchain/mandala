import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LockingScript, Transaction } from '@bsv/sdk'
import { fetchAssetAuthHead, fetchAssetAuthBeef, recoverAdminAuth } from './assetRecover.js'
import { parseAdminCI } from './assets.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('./constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./constants.js')>()
  return { ...actual, OVERLAY_URL: 'http://test-overlay' }
})

const resolveAssetMetadata = vi.fn()
vi.mock('./metadata', () => ({ resolveAssetMetadata: (id: string) => resolveAssetMetadata(id) }))

const TXID = 'ab'.repeat(32)
const ASSET = `${TXID}.0`
// A real head tx: the overlay serves plain BEEF and the wallet's
// internalizeAction demands AtomicBEEF, so the fixture has to parse.
const HEAD_TX = new Transaction()
HEAD_TX.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
HEAD_TX.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
const HEAD_TXID = HEAD_TX.id('hex')
const HEAD_BEEF = HEAD_TX.toBEEF()
const registerDetails = { kind: 'register', label: 'Test Coin', ticker: 'TST', decimals: 2, issuer: '02' + 'aa'.repeat(32) }
const unpauseDetails = { kind: 'unpause', assetId: ASSET, priorOutpoint: `${TXID}.0` }

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const basketWith = (assets: Array<{ outpoint: string, customInstructions: string }>) => ({
  listOutputs: vi.fn().mockResolvedValue({ outputs: assets }),
  internalizeAction: vi.fn().mockResolvedValue({})
})

const ci = (assetId: string, label: string, authDetails: Record<string, unknown>): string =>
  JSON.stringify({ type: 'mandala-admin', assetId, label, authDetails })

beforeEach(() => {
  mockFetch.mockReset()
  resolveAssetMetadata.mockReset()
})

describe('fetchAssetAuthHead', () => {
  it('reads {authOutpoint, authDetails} from GET /admin/asset-auth/:assetId', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { authOutpoint: `${HEAD_TXID}.1`, authDetails: unpauseDetails }))
    const head = await fetchAssetAuthHead(ASSET)
    expect(head).toEqual({ authOutpoint: `${HEAD_TXID}.1`, authDetails: unpauseDetails })
    expect(mockFetch.mock.calls[0][0]).toBe(`http://test-overlay/admin/asset-auth/${encodeURIComponent(ASSET)}`)
  })

  it('is null when the overlay has no history for the asset (404), and throws on other failures', async () => {
    mockFetch.mockResolvedValueOnce(json(404, { error: 'no admin history for this asset' }))
    expect(await fetchAssetAuthHead(ASSET)).toBeNull()
    mockFetch.mockResolvedValueOnce(json(500, { error: 'boom' }))
    await expect(fetchAssetAuthHead(ASSET)).rejects.toThrow(/500/)
  })

  it('rejects a malformed body rather than handing back a half head', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { authOutpoint: `${HEAD_TXID}.1` }))
    expect(await fetchAssetAuthHead(ASSET)).toBeNull()
  })
})

describe('fetchAssetAuthBeef', () => {
  it('asks the overlay for the admin tx BEEF by txid and vout', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { beef: [1, 2, 3], outputIndex: 1 }))
    expect(await fetchAssetAuthBeef(HEAD_TXID, 1)).toEqual([1, 2, 3])
    expect(mockFetch.mock.calls[0][0]).toBe(`http://test-overlay/admin/asset-auth/beef/${HEAD_TXID}?vout=1`)
  })
})

describe('recoverAdminAuth', () => {
  const headResponses = (details: Record<string, unknown>): void => {
    mockFetch
      .mockResolvedValueOnce(json(200, { authOutpoint: `${HEAD_TXID}.1`, authDetails: details }))
      .mockResolvedValueOnce(json(200, { beef: HEAD_BEEF, outputIndex: 1 }))
  }

  it('internalizes the overlay head with basket insertion + admin CI and returns it even when the basket stays empty', async () => {
    headResponses(registerDetails)
    const wallet = basketWith([])
    const asset = await recoverAdminAuth({ wallet: wallet as any, assetId: ASSET })
    expect(asset).toEqual({
      assetId: ASSET,
      label: 'Test Coin',
      authOutpoint: `${HEAD_TXID}.1`,
      authDetails: registerDetails,
      metadata: { label: 'Test Coin', ticker: 'TST', decimals: 2, issuer: registerDetails.issuer }
    })
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    const args = wallet.internalizeAction.mock.calls[0][0]
    // 2026-09-17: BSV Desktop refuses plain BEEF here ("must be valid AtomicBEEF").
    expect(args.tx.slice(0, 4)).toEqual([1, 1, 1, 1])
    expect(Transaction.fromAtomicBEEF(args.tx).id('hex')).toBe(HEAD_TXID)
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0].outputIndex).toBe(1)
    expect(args.outputs[0].protocol).toBe('basket insertion')
    expect(args.outputs[0].insertionRemittance.basket).toBe('mandala-tokens')
    const parsed = parseAdminCI(args.outputs[0].insertionRemittance.customInstructions)
    expect(parsed?.assetId).toBe(ASSET)
    expect(parsed?.label).toBe('Test Coin')
    expect(parsed?.authDetails).toEqual(registerDetails)
  })

  it('tolerates an already-internalized output (double click, second tab) and rethrows anything else', async () => {
    headResponses(registerDetails)
    const wallet = basketWith([])
    wallet.internalizeAction.mockRejectedValueOnce(new Error('output already exists in basket'))
    await expect(recoverAdminAuth({ wallet: wallet as any, assetId: ASSET })).resolves.toMatchObject({ authOutpoint: `${HEAD_TXID}.1` })

    headResponses(registerDetails)
    const broken = basketWith([])
    broken.internalizeAction.mockRejectedValueOnce(new Error('wallet offline'))
    await expect(recoverAdminAuth({ wallet: broken as any, assetId: ASSET })).rejects.toThrow(/wallet offline/)
  })

  it('does nothing when the basket already lists the overlay head', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { authOutpoint: `${HEAD_TXID}.1`, authDetails: unpauseDetails }))
    const wallet = basketWith([{ outpoint: `${HEAD_TXID}.1`, customInstructions: ci(ASSET, 'Test Coin', unpauseDetails) }])
    const asset = await recoverAdminAuth({ wallet: wallet as any, assetId: ASSET })
    expect(asset?.authOutpoint).toBe(`${HEAD_TXID}.1`)
    expect(asset?.label).toBe('Test Coin')
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the stale basket label when the basket still names the asset at an older outpoint', async () => {
    headResponses(unpauseDetails)
    const wallet = basketWith([{ outpoint: `${TXID}.0`, customInstructions: ci('', 'Old Label', registerDetails) }])
    const asset = await recoverAdminAuth({ wallet: wallet as any, assetId: ASSET })
    expect(asset?.label).toBe('Old Label')
    expect(asset?.authOutpoint).toBe(`${HEAD_TXID}.1`)
    expect(asset?.authDetails).toEqual(unpauseDetails)
    expect(resolveAssetMetadata).not.toHaveBeenCalled()
  })

  it('resolves the label from on-chain metadata when the head is not the genesis and the basket has nothing', async () => {
    headResponses(unpauseDetails)
    resolveAssetMetadata.mockResolvedValueOnce({ label: 'Chain Coin', ticker: 'CHN', decimals: 0 })
    const asset = await recoverAdminAuth({ wallet: basketWith([]) as any, assetId: ASSET })
    expect(asset?.label).toBe('Chain Coin')
    expect(asset?.metadata).toEqual({ label: 'Chain Coin', ticker: 'CHN', decimals: 0 })
  })

  it('falls back to a short asset id label when no metadata can be found', async () => {
    headResponses(unpauseDetails)
    resolveAssetMetadata.mockRejectedValueOnce(new Error('lookup down'))
    const asset = await recoverAdminAuth({ wallet: basketWith([]) as any, assetId: ASSET })
    expect(asset?.label).toBe(`${TXID.slice(0, 8)}…`)
    expect(asset?.metadata).toBeUndefined()
  })

  it('returns the basket listing (or null) when the overlay has no history for the asset', async () => {
    mockFetch.mockResolvedValueOnce(json(404, { error: 'no admin history for this asset' }))
    const wallet = basketWith([])
    expect(await recoverAdminAuth({ wallet: wallet as any, assetId: ASSET })).toBeNull()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('fails loudly when the BEEF cannot be loaded', async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { authOutpoint: `${HEAD_TXID}.1`, authDetails: registerDetails }))
      .mockResolvedValueOnce(json(404, { error: 'admin tx not in overlay storage' }))
      .mockResolvedValue({ ok: false, status: 404, text: async () => '' }) // WhatsOnChain fallback
    await expect(recoverAdminAuth({ wallet: basketWith([]) as any, assetId: ASSET })).rejects.toThrow(/could not load admin tx/)
  })
})
