import { describe, it, expect, vi } from 'vitest'
import {
  authoritiesResponse, authoritiesBeefResponse, assetStateResponse, adminHistoryPageResponse,
  adminSummaryResponse, summarizeHistory, tokenIdParam, withFrozenRowFlags, splitOutpoint, voutParam,
  ADMIN_TX_NOT_FOUND
} from './tokenRoutes.js'
import { defaultAssetState } from '@bsv/overlay-topics'

const T = 'ab'.repeat(32) + '_0'
const K = '02' + 'cd'.repeat(32)
const BAD = ['ab'.repeat(32) + '.0', 'AB'.repeat(32) + '_0', 'ab'.repeat(32) + '_1', 'ab'.repeat(31) + '_0', '', undefined, 7, [T], T + '\n']

describe('tokenIdParam', () => {
  it.each([T])('accepts %s', id => expect(tokenIdParam(id)).toBe(id))
  it.each(BAD)('refuses %j', id => expect(tokenIdParam(id)).toBeNull())
})

describe('authoritiesResponse', () => {
  it('lists unspent authorities as outpoints, sorted', async () => {
    const r = await authoritiesResponse(T, { listAuthorities: async () => [
      { txid: 'ff'.repeat(32), outputIndex: 1, identityKey: K }, { txid: '00'.repeat(32), outputIndex: 2, identityKey: K }] })
    expect(r).toEqual({ status: 200, body: { tokenId: T, authorities: [
      { outpoint: '00'.repeat(32) + '.2', identityKey: K }, { outpoint: 'ff'.repeat(32) + '.1', identityKey: K }] } })
  })
  it('an old-format id is 400, not 200 []', async () => {
    const list = vi.fn()
    expect((await authoritiesResponse('ab'.repeat(32) + '.0', { listAuthorities: list })).status).toBe(400)
    expect(list).not.toHaveBeenCalled()
  })
  it('a known token with no authorities is 200 []', async () => {
    expect((await authoritiesResponse(T, { listAuthorities: async () => [] })).body).toEqual({ tokenId: T, authorities: [] })
  })
  it('500 {error} on a store failure', async () => {
    const r = await authoritiesResponse(T, { listAuthorities: async () => { throw new Error('boom') } })
    expect(r).toEqual({ status: 500, body: { error: 'Error: boom' } })
  })
})

describe('bad tokenId never reaches a dep', () => {
  it.each(BAD)('every handler answers 400 for %j', async id => {
    const dep = vi.fn()
    const want = { status: 400, body: { error: 'invalid tokenId' } }
    expect(await authoritiesResponse(id, { listAuthorities: dep })).toEqual(want)
    expect(await assetStateResponse(id, { getAssetState: dep, hasTokenRow: dep })).toEqual(want)
    expect(await adminHistoryPageResponse(id, '10', '0', { page: dep })).toEqual(want)
    expect(await adminSummaryResponse(id, { history: dep })).toEqual(want)
    expect(dep).not.toHaveBeenCalled()
  })
})

describe('summarizeHistory', () => {
  it('sums positive and negative deltas once per action', () => {
    expect(summarizeHistory([
      { txid: 'a', outputIndex: 1, kind: 'issue', delta: 500 },
      { txid: 'a', outputIndex: 1, kind: 'issue', delta: 500 },
      { txid: 'b', outputIndex: 1, kind: 'redeem', delta: -200 },
      { txid: 'c', outputIndex: 1, kind: 'pause', delta: 0 },
      { txid: 'd', outputIndex: 1, kind: 'reissue', delta: 50 }
    ])).toEqual({ totalIssued: 550, totalRedeemed: 200, actionCount: 4 })
  })
  it('same txid at different outputIndex is a distinct action', () => {
    expect(summarizeHistory([
      { txid: 'a', outputIndex: 1, kind: 'issue', delta: 5 },
      { txid: 'a', outputIndex: 2, kind: 'issue', delta: 7 }
    ])).toEqual({ totalIssued: 12, totalRedeemed: 0, actionCount: 2 })
  })
})

describe('adminSummaryResponse', () => {
  it('200 with the summary', async () => {
    const r = await adminSummaryResponse(T, { history: async () => [
      { txid: 'a', outputIndex: 1, kind: 'issue', delta: 9 }] as any })
    expect(r).toEqual({ status: 200, body: { totalIssued: 9, totalRedeemed: 0, actionCount: 1 } })
  })
})

describe('assetStateResponse', () => {
  it('flags frozen outpoints that have a token row', async () => {
    const s = { ...defaultAssetState(T, 25), frozenOutpoints: [{ outpoint: 'aa'.repeat(32) + '.0', amount: 5, owner: K }] }
    const r = await assetStateResponse(T, { getAssetState: async () => s, hasTokenRow: async () => true })
    expect(r.status).toBe(200)
    expect((r.body as any).feeRatePerKb).toBe(25)
    expect((r.body as any).frozenOutpoints[0].hasFrozenRow).toBe(true)
  })
})

describe('assetStateResponse frozen rows (A16)', () => {
  it('marks each frozen ref with whether its token row is live', async () => {
    const live = 'cc'.repeat(32) + '.0'
    const gone = 'dd'.repeat(32) + '.3'
    const s = { ...defaultAssetState(T, 25), frozenOutpoints: [
      { outpoint: live, amount: 40, owner: '02aa' },
      { outpoint: gone, amount: 0, owner: '' }
    ] }
    const calls: Array<[string, number]> = []
    const r = await assetStateResponse(T, {
      getAssetState: async () => s,
      hasTokenRow: async (txid, vout) => { calls.push([txid, vout]); return txid === 'cc'.repeat(32) && vout === 0 }
    })
    expect(calls).toEqual([['cc'.repeat(32), 0], ['dd'.repeat(32), 3]])
    expect((r.body as any).frozenOutpoints).toEqual([
      { outpoint: live, amount: 40, owner: '02aa', hasFrozenRow: true },
      { outpoint: gone, amount: 0, owner: '', hasFrozenRow: false }
    ])
    expect((r.body as any).tokenId).toBe(T)
    expect((r.body as any).feeRatePerKb).toBe(25)
  })
})

describe('adminHistoryPageResponse', () => {
  const run = async (limit: unknown, offset: unknown): Promise<[number, number]> => {
    const page = vi.fn(async () => [])
    const r = await adminHistoryPageResponse(T, limit, offset, { page })
    expect(r.status).toBe(200)
    expect(page).toHaveBeenCalledTimes(1)
    return [(page.mock.calls[0] as any)[1], (page.mock.calls[0] as any)[2]]
  }
  it('clamps limit and offset', async () => {
    expect(await run(0, 0)).toEqual([1, 0])
    expect(await run(9999, 0)).toEqual([500, 0])
    expect(await run('x', 0)).toEqual([100, 0])
    expect(await run(undefined, -1)).toEqual([100, 0])
    expect(await run('25', '7')).toEqual([25, 7])
    expect(await run(2.7, 3.9)).toEqual([2, 3])
    expect(await run(-5, 0)).toEqual([1, 0])
    expect(await run('', '')).toEqual([100, 0])
  })
  it('passes the tokenId and returns the rows', async () => {
    const rows = [{ txid: 'a' }] as any
    const page = vi.fn(async () => rows)
    const r = await adminHistoryPageResponse(T, '5', '2', { page })
    expect(page).toHaveBeenCalledWith(T, 5, 2)
    expect(r.body).toEqual(rows)
  })
})

describe('authoritiesBeefResponse (ported)', () => {
  it('serves {beef, outputIndex} from the engine store, defaulting vout to 0', async () => {
    const calls: Array<[string, number]> = []
    const r = await authoritiesBeefResponse('a'.repeat(64), undefined, {
      findBeef: async (txid, vout) => { calls.push([txid, vout]); return { beef: [1, 2, 3], outputIndex: vout } }
    })
    expect(r).toEqual({ status: 200, body: { beef: [1, 2, 3], outputIndex: 0 } })
    expect(calls).toEqual([['a'.repeat(64), 0]])
  })
  it('honours ?vout= and treats junk as 0', async () => {
    const calls: number[] = []
    const deps = { findBeef: async (_t: string, vout: number) => { calls.push(vout); return { beef: [9], outputIndex: vout } } }
    await authoritiesBeefResponse('a'.repeat(64), '2', deps)
    await authoritiesBeefResponse('a'.repeat(64), 'x', deps)
    expect(calls).toEqual([2, 0])
  })
  it('404 {error} when the tx is not in overlay storage', async () => {
    const r = await authoritiesBeefResponse('a'.repeat(64), undefined, { findBeef: async () => null })
    expect(r).toEqual({ status: 404, body: { error: ADMIN_TX_NOT_FOUND } })
  })
  it('500 {error} on a store failure', async () => {
    const r = await authoritiesBeefResponse('a'.repeat(64), undefined, { findBeef: async () => { throw new Error('boom') } })
    expect(r).toEqual({ status: 500, body: { error: 'Error: boom' } })
  })
})

describe('helpers', () => {
  it('voutParam / splitOutpoint', () => {
    expect(voutParam('3')).toBe(3)
    expect(voutParam('x')).toBe(0)
    expect(splitOutpoint('ab.2')).toEqual({ txid: 'ab', vout: 2 })
    expect(splitOutpoint('junk')).toBeNull()
  })
  it('withFrozenRowFlags fails closed on a malformed outpoint', async () => {
    const out = await withFrozenRowFlags({ frozenOutpoints: [{ outpoint: 'junk', amount: 1, owner: 'x' }] }, async () => true)
    expect(out.frozenOutpoints[0].hasFrozenRow).toBe(false)
  })
})
