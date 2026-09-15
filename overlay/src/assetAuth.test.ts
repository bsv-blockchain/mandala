/**
 * A10 — overlay-backed recovery of the per-asset admin-auth head, and
 * A16 — `hasFrozenRow` on the asset-state payload.
 *
 * Route handlers are tested through the same fake req/res the Go tests
 * exercise through httptest, so both backends pin the identical wire shape.
 */
import { describe, it, expect } from 'vitest'
import {
  pickAssetAuthHead, assetAuthHeadHandler, assetAuthBeefHandler, withFrozenRowFlags,
  ASSET_AUTH_NOT_FOUND, ADMIN_TX_NOT_FOUND, type AdminHistoryRowLite
} from './assetAuth.js'

const ASSET = 'ab'.repeat(32) + '.0'
const row = (over: Partial<AdminHistoryRowLite>): AdminHistoryRowLite => ({
  assetId: ASSET,
  txid: 'aa'.repeat(32),
  outputIndex: 0,
  height: 100,
  offset: 0,
  admitSeq: 1,
  actionDetails: { kind: 'register' },
  ...over
})

interface Sent { status: number, body: unknown }
const fakeRes = (): { res: any, sent: () => Sent, done: Promise<Sent> } => {
  let resolve!: (s: Sent) => void
  const done = new Promise<Sent>(r => { resolve = r })
  let status = 200
  let body: unknown
  const res: any = {
    header: () => res,
    status: (s: number) => { status = s; return res },
    json: (b: unknown) => { body = b; resolve({ status, body }); return res }
  }
  return { res, sent: () => ({ status, body }), done }
}

describe('pickAssetAuthHead — ordering (height, offset, admitSeq)', () => {
  it('returns null for no history', () => {
    expect(pickAssetAuthHead([])).toBeNull()
  })

  it('prefers the greater height regardless of input order', () => {
    const head = pickAssetAuthHead([
      row({ txid: 'b'.repeat(64), height: 101, admitSeq: 1 }),
      row({ txid: 'a'.repeat(64), height: 100, admitSeq: 5 })
    ])
    expect(head?.txid).toBe('b'.repeat(64))
  })

  it('breaks a height tie on offset, then admitSeq', () => {
    expect(pickAssetAuthHead([
      row({ txid: 'a'.repeat(64), height: 100, offset: 3, admitSeq: 9 }),
      row({ txid: 'b'.repeat(64), height: 100, offset: 7, admitSeq: 1 })
    ])?.txid).toBe('b'.repeat(64))
    expect(pickAssetAuthHead([
      row({ txid: 'a'.repeat(64), height: 100, offset: 3, admitSeq: 2 }),
      row({ txid: 'b'.repeat(64), height: 100, offset: 3, admitSeq: 3 })
    ])?.txid).toBe('b'.repeat(64))
  })

  it('an unmined action (height = MAX_SAFE_INTEGER) sorts after every mined one', () => {
    expect(pickAssetAuthHead([
      row({ txid: 'u'.repeat(64), height: Number.MAX_SAFE_INTEGER, offset: 0, admitSeq: 2 }),
      row({ txid: 'm'.repeat(64), height: 900000, offset: 5, admitSeq: 3 })
    ])?.txid).toBe('u'.repeat(64))
  })

  it('a re-admitted duplicate row (fresh admitSeq, same outpoint) still yields the same head', () => {
    const head = pickAssetAuthHead([
      row({ txid: 'h'.repeat(64), outputIndex: 1, height: 100, admitSeq: 4 }),
      row({ txid: 'h'.repeat(64), outputIndex: 1, height: 100, admitSeq: 9 })
    ])
    expect(`${head?.txid}.${head?.outputIndex}`).toBe(`${'h'.repeat(64)}.1`)
  })
})

describe('GET /admin/asset-auth/:assetId', () => {
  it('serves {authOutpoint, authDetails} for the chain head', async () => {
    const handler = assetAuthHeadHandler({
      findAdminHistory: async (assetId) => assetId === ASSET
        ? [
            row({ txid: 'a'.repeat(64), height: 100, admitSeq: 1, actionDetails: { kind: 'register' } }),
            row({ txid: 'b'.repeat(64), outputIndex: 1, height: 101, admitSeq: 2, actionDetails: { kind: 'unpause', assetId: ASSET, priorOutpoint: 'a'.repeat(64) + '.0' } })
          ]
        : []
    })
    const { res, done } = fakeRes()
    handler({ params: { assetId: ASSET } } as any, res)
    const { status, body } = await done
    expect(status).toBe(200)
    expect(body).toEqual({
      authOutpoint: 'b'.repeat(64) + '.1',
      authDetails: { kind: 'unpause', assetId: ASSET, priorOutpoint: 'a'.repeat(64) + '.0' }
    })
  })

  it('404 {error} when the overlay has no history for the asset', async () => {
    const handler = assetAuthHeadHandler({ findAdminHistory: async () => [] })
    const { res, done } = fakeRes()
    handler({ params: { assetId: ASSET } } as any, res)
    const { status, body } = await done
    expect(status).toBe(404)
    expect(body).toEqual({ error: ASSET_AUTH_NOT_FOUND })
  })

  it('500 {error} on a store failure', async () => {
    const handler = assetAuthHeadHandler({ findAdminHistory: async () => { throw new Error('boom') } })
    const { res, done } = fakeRes()
    handler({ params: { assetId: ASSET } } as any, res)
    const { status, body } = await done
    expect(status).toBe(500)
    expect(body).toEqual({ error: 'Error: boom' })
  })
})

describe('GET /admin/asset-auth/beef/:txid?vout=', () => {
  it('serves {beef, outputIndex} from the engine store, defaulting vout to 0', async () => {
    const calls: Array<[string, number]> = []
    const handler = assetAuthBeefHandler({
      findBeef: async (txid, vout) => { calls.push([txid, vout]); return { beef: [1, 2, 3], outputIndex: vout } }
    })
    const { res, done } = fakeRes()
    handler({ params: { txid: 'a'.repeat(64) }, query: {} } as any, res)
    const { status, body } = await done
    expect(status).toBe(200)
    expect(body).toEqual({ beef: [1, 2, 3], outputIndex: 0 })
    expect(calls).toEqual([['a'.repeat(64), 0]])
  })

  it('honours ?vout= and treats junk as 0', async () => {
    const calls: number[] = []
    const handler = assetAuthBeefHandler({
      findBeef: async (_txid, vout) => { calls.push(vout); return { beef: [9], outputIndex: vout } }
    })
    const a = fakeRes(); handler({ params: { txid: 'a'.repeat(64) }, query: { vout: '2' } } as any, a.res); await a.done
    const b = fakeRes(); handler({ params: { txid: 'a'.repeat(64) }, query: { vout: 'x' } } as any, b.res); await b.done
    expect(calls).toEqual([2, 0])
  })

  it('404 {error} when the tx is not in overlay storage', async () => {
    const handler = assetAuthBeefHandler({ findBeef: async () => null })
    const { res, done } = fakeRes()
    handler({ params: { txid: 'a'.repeat(64) }, query: {} } as any, res)
    const { status, body } = await done
    expect(status).toBe(404)
    expect(body).toEqual({ error: ADMIN_TX_NOT_FOUND })
  })
})

describe('withFrozenRowFlags (A16)', () => {
  it('marks each frozen ref with whether its token row is live', async () => {
    const live = 'cc'.repeat(32) + '.0'
    const gone = 'dd'.repeat(32) + '.3'
    const state = {
      assetId: ASSET,
      frozenOutpoints: [
        { outpoint: live, amount: 40, owner: '02aa' },
        { outpoint: gone, amount: 0, owner: '' }
      ]
    }
    const out = await withFrozenRowFlags(state as any, async (txid, vout) => `${txid}.${vout}` === live)
    expect(out.frozenOutpoints).toEqual([
      { outpoint: live, amount: 40, owner: '02aa', hasFrozenRow: true },
      { outpoint: gone, amount: 0, owner: '', hasFrozenRow: false }
    ])
    // Everything else on the state passes through untouched.
    expect(out.assetId).toBe(ASSET)
  })

  it('fails closed on a malformed outpoint', async () => {
    const out = await withFrozenRowFlags({ frozenOutpoints: [{ outpoint: 'junk', amount: 1, owner: 'x' }] } as any, async () => true)
    expect(out.frozenOutpoints[0].hasFrozenRow).toBe(false)
  })
})
