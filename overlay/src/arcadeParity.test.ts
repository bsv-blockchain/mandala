import { describe, expect, it } from 'vitest'
import { PrivateKey, Transaction } from '@bsv/sdk'
import OverlayExpress, { ArcadeProvider } from '@bsv/overlay-express'
import { withArcadeStatusParity, UNKNOWN_SUCCESS_STATUS } from './arcadeParity.js'

const tx = new Transaction(1, [], [], 0)
const fake = (r: unknown) => ({ broadcast: async (_tx: Transaction): Promise<any> => r })

describe('withArcadeStatusParity', () => {
  it('maps a non-terminal unknown 2xx status to success (Go parity)', async () => {
    const b = withArcadeStatusParity(fake({ status: 'error', code: '500', description: UNKNOWN_SUCCESS_STATUS, more: { terminal: false } }))
    expect(await b.broadcast(tx)).toEqual({ status: 'success', txid: tx.id('hex'), message: 'non-terminal Arcade status accepted (Go parity)' })
  })
  it('passes terminal failures through', async () => {
    const f = { status: 'error', code: 'DOUBLE_SPEND_ATTEMPTED', description: 'x', more: { terminal: true } }
    expect(await withArcadeStatusParity(fake(f)).broadcast(tx)).toBe(f)
  })
  it('passes other 500s through (network, oversize body)', async () => {
    const f = { status: 'error', code: '500', description: 'fetch failed', more: { terminal: false } }
    expect(await withArcadeStatusParity(fake(f)).broadcast(tx)).toBe(f)
  })
  it('passes success through', async () => {
    const s = { status: 'success', txid: 'a', message: 'SEEN_ON_NETWORK' }
    expect(await withArcadeStatusParity(fake(s)).broadcast(tx)).toBe(s)
  })
})

// The constant is a string match against the installed overlay-express, so it
// is pinned against the REAL provider: an upstream rewording would otherwise
// turn the wrapper into a silent no-op and every re-submit echoing
// SEEN_MULTIPLE_NODES would fail again.
describe('withArcadeStatusParity over the real ArcadeProvider', () => {
  const provider = (status: number, body: unknown): ArcadeProvider =>
    new ArcadeProvider('https://arcade.example/api', {
      fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
    })

  it('without the wrapper the provider refuses a non-terminal 2xx with exactly UNKNOWN_SUCCESS_STATUS', async () => {
    const r = await provider(200, { txStatus: 'SEEN_MULTIPLE_NODES' }).broadcast(tx)
    expect(r).toMatchObject({ status: 'error', code: '500', description: UNKNOWN_SUCCESS_STATUS, more: { terminal: false } })
  })

  it.each(['SEEN_MULTIPLE_NODES', 'PENDING_RETRY', 'STUMP_PROCESSING', 'UNKNOWN'])(
    'accepts a 2xx %s echoed on re-submit',
    async (txStatus) => {
      const b = withArcadeStatusParity(provider(200, { txStatus }))
      expect(await b.broadcast(tx)).toEqual({ status: 'success', txid: tx.id('hex'), message: 'non-terminal Arcade status accepted (Go parity)' })
    }
  )

  it('keeps a 2xx terminal rejection a terminal failure', async () => {
    const r = await withArcadeStatusParity(provider(200, { txStatus: 'DOUBLE_SPEND_ATTEMPTED', extraInfo: 'x' })).broadcast(tx)
    expect(r).toMatchObject({ status: 'error', code: 'DOUBLE_SPEND_ATTEMPTED', more: { terminal: true } })
  })

  it('keeps a transport failure a retryable 500', async () => {
    const down = new ArcadeProvider('https://arcade.example/api', {
      fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    })
    const r = await withArcadeStatusParity(down).broadcast(tx)
    expect(r).toMatchObject({ status: 'error', code: '500', description: 'fetch failed', more: { terminal: false } })
  })

  it('leaves a provider-recognised success status unchanged', async () => {
    const r = await withArcadeStatusParity(provider(200, { txStatus: 'SEEN_ON_NETWORK', txid: tx.id('hex') })).broadcast(tx)
    expect(r).toMatchObject({ status: 'success', txid: tx.id('hex'), message: 'SEEN_ON_NETWORK' })
  })
})

// index.ts wraps `server.engine.broadcaster`. That is only the Arcade provider
// when Arcade is the sole provider; with an ARC key overlay-express would hand
// the engine a ProviderChainBroadcaster instead, whose failure conversion
// would sit between this wrapper and the provider.
describe('the broadcaster the engine receives when Arcade is configured as index.ts configures it', () => {
  it('is the ArcadeProvider itself, not a provider chain', () => {
    const server = new OverlayExpress('wiring', PrivateKey.fromRandom().toHex(), 'overlay.example.com')
    server.configureArcade('https://arcade.example', { apiKey: 'k' })
    server.configureArcCallbackToken('t'.repeat(32))
    const built = (server as unknown as { buildBroadcaster: () => unknown }).buildBroadcaster()
    expect(built).toBeInstanceOf(ArcadeProvider)
  })
})
