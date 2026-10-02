import { afterEach, describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isTerminalArcStatus, evictWithRestore, arcIngestHandler, mountArcIngest, knexEvictionCoins,
  type EvictionDeps
} from './eviction.js'
import type { AdmissionRecord, AdmissionStore } from './admission.js'
import { isInfraError } from './submitVerdict.js'
import { createHarness, HARNESS_TOPIC, type Harness } from './testkit/engineHarness.js'

const TXID = 'ab'.repeat(32)
const IN0 = 'cc'.repeat(32)

const record = (over: Partial<AdmissionRecord> = {}): AdmissionRecord => ({
  txid: TXID,
  topics: ['tm_mandala'],
  outputsToAdmit: [0],
  admissionSignature: 's',
  admissionIdentityKey: 'k',
  at: '2026-09-14T00:00:00.000Z',
  restore: {
    spentOutpoints: [`${IN0}.0`, `${IN0}.1`],
    tokenRows: [{ txid: IN0, outputIndex: 0, assetId: 'a.0', amount: 100, identityKey: '02ab' }]
  },
  ...over
})

const deps = (rec: AdmissionRecord | null, over: Partial<EvictionDeps> = {}) => {
  const unmarked: string[] = []
  const restored: string[] = []
  const evicted: string[] = []
  const purged: string[] = []
  const rebuilt: string[] = []
  const rows: Record<string, AdmissionRecord> = rec != null ? { [rec.txid]: rec } : {}
  const order: string[] = []
  const store: AdmissionStore = {
    get: async (txid) => rows[txid] ?? null,
    putAdmitted: async () => {},
    putRefusal: async () => {},
    markEvicted: async (txid, at) => { order.push('markEvicted'); rows[txid] = { ...(rows[txid] ?? { txid }), evictedAt: at } }
  }
  const d: EvictionDeps = {
    store,
    // One engine row per outpoint, held by the evicted tx: each unmark affects it.
    unmarkSpent: async (txid, vout) => { order.push('unmark'); unmarked.push(`${txid}.${vout}`); return 1 },
    isUnspent: async () => { order.push('isUnspent'); return false },
    restoreTokenRow: async (row) => { order.push('restore'); restored.push(`${row.txid}.${row.outputIndex}`) },
    evict: async (txid, reason) => { order.push('evict'); evicted.push(`${txid}|${reason ?? ''}`); return { evictedOutputs: 1 } },
    assetsTouchedBy: async () => { order.push('assets'); return ['a.0', 'b.0'] },
    rebuildAssetStateExcluding: async (assetId, txid) => { order.push(`rebuild(${assetId})`); rebuilt.push(`${assetId}|${txid}`) },
    purgeAdminHistory: async (txid) => { order.push('purge'); purged.push(txid) },
    now: () => '2026-09-14T09:00:00.000Z',
    ...over
  }
  return { d, unmarked, restored, evicted, purged, rebuilt, rows, order }
}

describe('isTerminalArcStatus', () => {
  const cases: Array<[string, string, boolean]> = [
    ['SEEN_ON_NETWORK', '', false],
    ['MINED', '', false],
    ['seen_on_network', '', false],
    ['REJECTED', '', true],
    ['rejected', '', true],
    ['DOUBLE_SPEND_ATTEMPTED', '', true],
    ['INVALID', '', true],
    ['MALFORMED', '', true],
    ['MINED_IN_STALE_BLOCK', '', true],
    ['SEEN_ON_NETWORK', 'seen orphaned parent', true],
    ['SOME_ORPHAN_STATUS', '', true],
    ['', '', false]
  ]
  for (const [status, extra, want] of cases) {
    it(`${JSON.stringify(status)} / ${JSON.stringify(extra)} → ${String(want)}`, () => {
      expect(isTerminalArcStatus(status, extra)).toBe(want)
    })
  }
})

describe('evictWithRestore — FIX E (contract §5)', () => {
  it('unmarks spent inputs, restores token rows, stamps evictedAt, THEN evicts', async () => {
    const h = deps(record())
    const report = await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(h.unmarked).toEqual([`${IN0}.0`, `${IN0}.1`])
    expect(h.restored).toEqual([`${IN0}.0`])
    expect(h.rows[TXID].evictedAt).toBe('2026-09-14T09:00:00.000Z')
    expect(h.evicted).toEqual([`${TXID}|REJECTED`])
    expect(h.order).toEqual(['unmark', 'unmark', 'restore', 'markEvicted', 'evict', 'assets', 'rebuild(a.0)', 'rebuild(b.0)', 'purge'])
    expect(report.restoredOutpoints).toBe(2)
    expect(report.restoredTokenRows).toBe(1)
  })

  it('still evicts (and still stamps evictedAt) when there is no record to restore from', async () => {
    const h = deps(null)
    const report = await evictWithRestore(TXID, 'INVALID', h.d)
    expect(h.unmarked).toEqual([])
    expect(h.rows[TXID].evictedAt).toBe('2026-09-14T09:00:00.000Z')
    expect(h.evicted).toEqual([`${TXID}|INVALID`])
    expect(report.restoredOutpoints).toBe(0)
  })

  it('is idempotent — a repeat callback restores nothing twice but still succeeds', async () => {
    const h = deps(record({ evictedAt: '2026-09-13T00:00:00.000Z' }))
    const report = await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(h.unmarked).toEqual([])
    expect(h.restored).toEqual([])
    expect(report.alreadyEvicted).toBe(true)
    expect(h.evicted).toEqual([`${TXID}|REJECTED`]) // deletion is safe to repeat
  })

  // 2026-09-21 incident: the evicted tx's admin-history rows stayed behind, so
  // the asset-auth head kept naming a never-mined tx and the asset state kept
  // its folded action. Eviction purges the rows and rebuilds every touched
  // asset's state, AFTER the engine eviction (same phase as the output delete).
  it('purges the evicted tx\'s admin-history rows and rebuilds each touched asset state', async () => {
    const h = deps(record())
    await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(h.purged).toEqual([TXID])
    expect(h.rebuilt).toEqual([`a.0|${TXID}`, `b.0|${TXID}`])
    expect(h.order).toEqual(['unmark', 'unmark', 'restore', 'markEvicted', 'evict', 'assets', 'rebuild(a.0)', 'rebuild(b.0)', 'purge'])
  })

  it('purges admin history on a repeat callback too — production heads were stuck behind a pre-fix eviction', async () => {
    const h = deps(record({ evictedAt: '2026-09-13T00:00:00.000Z' }))
    await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(h.purged).toEqual([TXID])
    expect(h.rebuilt).toEqual([`a.0|${TXID}`, `b.0|${TXID}`])
  })

  it('a failed history purge is retryable (InfraError) — it runs only after every rebuild succeeded', async () => {
    const h = deps(record(), { purgeAdminHistory: async () => { throw new Error('mongo down') } })
    const err = await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.rebuilt).toEqual([`a.0|${TXID}`, `b.0|${TXID}`])
  })

  it('a failed asset lookup is an InfraError and rebuilds/purges nothing', async () => {
    const h = deps(record(), { assetsTouchedBy: async () => { throw new Error('mongo down') } })
    const err = await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.rebuilt).toEqual([])
    expect(h.purged).toEqual([])
  })

  // Rebuild-first: the rows are the only record of which assets need a
  // rebuild, so deleting them before the rebuild succeeds strands the asset.
  it('a failed rebuild leaves purge uncalled and raises an InfraError', async () => {
    const h = deps(record(), {
      rebuildAssetStateExcluding: async (assetId) => { if (assetId === 'b.0') throw new Error('mongo down') }
    })
    const err = await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect((err as Error).message).toMatch(/retry/)
    expect(h.purged).toEqual([])
    expect(h.order).not.toContain('purge')
  })

  it('a repeat callback after a failed rebuild runs the full sequence again (rows still present) and converges', async () => {
    const rowsLeft = new Set([TXID])
    let fail = true
    const rebuilt: string[] = []
    const order: string[] = []
    const h = deps(record(), {
      assetsTouchedBy: async (txid) => { order.push('assets'); return rowsLeft.has(txid) ? ['a.0', 'b.0'] : [] },
      rebuildAssetStateExcluding: async (assetId) => {
        order.push(`rebuild(${assetId})`)
        if (fail && assetId === 'b.0') throw new Error('mongo down')
        rebuilt.push(assetId)
      },
      purgeAdminHistory: async (txid) => { order.push('purge'); rowsLeft.delete(txid) }
    })
    expect(isInfraError(await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e))).toBe(true)
    expect(rowsLeft.has(TXID)).toBe(true)
    fail = false
    order.length = 0
    await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(order).toEqual(['assets', 'rebuild(a.0)', 'rebuild(b.0)', 'purge'])
    expect(rebuilt).toEqual(['a.0', 'a.0', 'b.0'])
    expect(rowsLeft.has(TXID)).toBe(false)
  })

  // §9.8 — this USED to log and carry on, stamping evictedAt anyway. That
  // publishes "these inputs are spendable again" (the 410 every wallet acts on)
  // over coins still marked spent, which the spent-input guard then refuses to
  // let anyone spend: the coins are dead, and the overlay's own attestation says
  // they should not be.
  it('a failed unmark stamps NOTHING, evicts nothing, and raises an InfraError', async () => {
    const h = deps(record(), { unmarkSpent: async (txid, vout) => { throw new Error(`boom ${txid}.${vout}`) } })
    const err = await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.rows[TXID].evictedAt).toBeUndefined()
    expect(h.evicted).toEqual([])
    // It aborts on the FIRST failure: the second outpoint is never attempted.
    expect(h.unmarked).toEqual([])
    expect(h.restored).toEqual([])
  })

  it('a failed token-row restore also stamps nothing', async () => {
    const h = deps(record(), { restoreTokenRow: async () => { throw new Error('mongo down') } })
    const err = await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.rows[TXID].evictedAt).toBeUndefined()
    expect(h.evicted).toEqual([])
  })

  it('an unreadable admission record fails closed rather than evicting blind', async () => {
    const h = deps(record())
    const blind = { ...h.d, store: { ...h.d.store, get: async () => { throw new Error('mongo down') } } }
    const err = await evictWithRestore(TXID, 'REJECTED', blind).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.evicted).toEqual([])
  })

  it('a failed evictedAt stamp is retryable too — the restore is idempotent', async () => {
    const h = deps(record())
    const stuck = { ...h.d, store: { ...h.d.store, markEvicted: async () => { throw new Error('mongo down') } } }
    const err = await evictWithRestore(TXID, 'REJECTED', stuck).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.evicted).toEqual([])
  })

  it('ignores a malformed outpoint in the snapshot', async () => {
    // Bad data in the snapshot carries no coin to restore, so it is not a failed
    // restore and must not block the eviction.
    const h = deps(record({ restore: { spentOutpoints: ['nonsense', `${IN0}.0`], tokenRows: [] } }))
    await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(h.unmarked).toEqual([`${IN0}.0`])
    expect(h.rows[TXID].evictedAt).toBeTypeOf('string')
  })

  // /arc-ingest runs outside Engine.submit's lock. Between a failed attempt and
  // Arcade's retry, another tx can spend the coin (the engine's CAS sets
  // spentBy to it and the lookup deletes the token row). Unmarking it again, or
  // re-inserting its row, would resurrect a coin that is live-spent.
  it('never clobbers a live spend — a coin now spent by another tx is not unmarked and gets no token row', async () => {
    const calls: string[] = []
    const h = deps(record(), {
      unmarkSpent: async (txid, vout, evictedTxid) => { calls.push(`${txid}.${vout}|${evictedTxid}`); return 0 },
      isUnspent: async () => false
    })
    const report = await evictWithRestore(TXID, 'REJECTED', h.d)
    // The unmark is scoped to the evicted tx's own spend.
    expect(calls).toEqual([`${IN0}.0|${TXID}`, `${IN0}.1|${TXID}`])
    expect(h.restored).toEqual([])
    expect(h.order).toContain('markEvicted')
    expect(h.evicted).toEqual([`${TXID}|REJECTED`])
    expect(report.restoredOutpoints).toBe(0)
    expect(report.restoredTokenRows).toBe(0)
  })

  it('restores only the token rows of coins it could hand back', async () => {
    const IN1 = 'dd'.repeat(32)
    const h = deps(record({
      restore: {
        spentOutpoints: [`${IN0}.0`, `${IN1}.0`],
        tokenRows: [
          { txid: IN0, outputIndex: 0, assetId: 'a.0', amount: 100, identityKey: '02ab' },
          { txid: IN1, outputIndex: 0, assetId: 'a.0', amount: 50, identityKey: '02ab' }
        ]
      }
    }), {
      // IN0.0 is now spent by someone else; IN1.0 was still held by the evicted tx.
      unmarkSpent: async (txid) => txid === IN1 ? 1 : 0,
      isUnspent: async () => false
    })
    const report = await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(h.restored).toEqual([`${IN1}.0`])
    expect(report.restoredOutpoints).toBe(1)
    expect(report.restoredTokenRows).toBe(1)
  })

  it('a retry after a partial failure still restores the token row of a coin the first attempt unmarked', async () => {
    const spent = new Set([`${IN0}.0`, `${IN0}.1`])
    const restored: string[] = []
    let failRestore = true
    const h = deps(record(), {
      unmarkSpent: async (txid, vout) => spent.delete(`${txid}.${vout}`) ? 1 : 0,
      isUnspent: async (txid, vout) => !spent.has(`${txid}.${vout}`),
      restoreTokenRow: async (row) => {
        if (failRestore) throw new Error('mongo down')
        restored.push(`${row.txid}.${row.outputIndex}`)
      }
    })
    // Attempt 1: both coins unmarked, then the token-row restore fails → 503, nothing stamped.
    expect(isInfraError(await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e))).toBe(true)
    expect(spent.size).toBe(0)
    expect(h.rows[TXID].evictedAt).toBeUndefined()
    // Attempt 2: the unmarks affect nothing (already unspent), yet the coin is
    // live, so its token row is restored and the eviction completes.
    failRestore = false
    const report = await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(restored).toEqual([`${IN0}.0`])
    expect(h.rows[TXID].evictedAt).toBe('2026-09-14T09:00:00.000Z')
    expect(h.evicted).toEqual([`${TXID}|REJECTED`])
    expect(report.restoredOutpoints).toBe(0)
    expect(report.restoredTokenRows).toBe(1)
  })

  // §9.5 — an unreadable spend state is "we do not know", not "not restorable".
  it('an unreadable spend state is an InfraError and stamps nothing', async () => {
    const h = deps(record(), {
      unmarkSpent: async () => 0,
      isUnspent: async () => { throw new Error('sqlite locked') }
    })
    const err = await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.restored).toEqual([])
    expect(h.rows[TXID].evictedAt).toBeUndefined()
    expect(h.evicted).toEqual([])
  })
})

// ────────────────────────────── /arc-ingest ─────────────────────────────────

const runHandler = async (handler: ReturnType<typeof arcIngestHandler>, req: any) => {
  let status = 200
  let body: unknown
  const res: any = { status (n: number) { status = n; return res }, json (b: unknown) { body = b; return res } }
  handler({ headers: {}, body: {}, ...req }, res)
  await new Promise(r => setTimeout(r, 5))
  return { status, body: body as any }
}

describe('arcIngestHandler', () => {
  const TOKEN = 'sekret'
  const base = (over: Partial<EvictionDeps> = {}) => {
    const h = deps(record(), over)
    return { h, handler: arcIngestHandler({ ...h.d, callbackToken: TOKEN, ingestProof: async () => {} }) }
  }

  it('401s without the callback token', async () => {
    const { handler } = base()
    const got = await runHandler(handler, { body: { txid: TXID, txStatus: 'REJECTED' } })
    expect(got.status).toBe(401)
    expect(got.body).toEqual({ status: 'error', message: 'Unauthorized callback' })
  })

  it('accepts Authorization: Bearer <token>', async () => {
    const { h, handler } = base()
    const got = await runHandler(handler, { headers: { authorization: `Bearer ${TOKEN}` }, body: { txid: TXID, txStatus: 'REJECTED' } })
    expect(got.status).toBe(200)
    expect(h.evicted).toHaveLength(1)
  })

  // Both comparisons are string equality, so this passes before and after the
  // switch to constantTimeEqual; it pins that the swap changed only the timing.
  it('401s a wrong token of the same length and a wrong token of another length', async () => {
    const { h, handler } = base()
    for (const wrong of ['sekreT', 'sekre', 'sekrets', '']) {
      for (const headers of [{ 'x-callback-token': wrong }, { authorization: `Bearer ${wrong}` }]) {
        const got = await runHandler(handler, { headers, body: { txid: TXID, txStatus: 'REJECTED' } })
        expect(got.status).toBe(401)
        expect(got.body).toEqual({ status: 'error', message: 'Unauthorized callback' })
      }
    }
    expect(h.unmarked).toEqual([])
    expect(h.evicted).toEqual([])
  })

  // Behaviourally indistinguishable from string equality, so pin the source:
  // `.includes` / `===` on a shared secret is a timing side channel.
  it('compares presented tokens with constantTimeEqual, never string equality', () => {
    const src = readFileSync(new URL('./eviction.ts', import.meta.url), 'utf8')
    const handler = src.slice(src.indexOf('export const arcIngestHandler'), src.indexOf('interface AppLike'))
    expect(handler).toContain('.some(c => constantTimeEqual(c, deps.callbackToken))')
    expect(handler).not.toMatch(/\.includes\(deps\.callbackToken\)/)
  })

  it('accepts the right token on x-callback-token even beside a wrong Authorization header', async () => {
    const { h, handler } = base()
    const got = await runHandler(handler, {
      headers: { authorization: 'Bearer wrong!', 'x-callback-token': TOKEN },
      body: { txid: TXID, txStatus: 'REJECTED' }
    })
    expect(got.status).toBe(200)
    expect(h.evicted).toHaveLength(1)
  })

  it('accepts x-callback-token: <token>', async () => {
    const { h, handler } = base()
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID, txStatus: 'DOUBLE_SPEND_ATTEMPTED' } })
    expect(got.status).toBe(200)
    expect(h.unmarked).toEqual([`${IN0}.0`, `${IN0}.1`])
  })

  it('400s on a missing txid', async () => {
    const { handler } = base()
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txStatus: 'REJECTED' } })
    expect(got.status).toBe(400)
  })

  it('202s a non-terminal status with no proof', async () => {
    const { h, handler } = base()
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID, txStatus: 'SEEN_ON_NETWORK' } })
    expect(got.status).toBe(202)
    expect(h.evicted).toEqual([])
  })

  // @bsv/overlay 2.6 throws when a forwarded blockHeight differs from the
  // proof's own, a deterministic 500 Arcade would retry forever. The engine
  // derives the height from the proof, so the provider's is never forwarded.
  it('ingests a merkle proof with exactly (txid, merklePathHex) and answers 200', async () => {
    const seen: unknown[][] = []
    const h = deps(record())
    const handler = arcIngestHandler({ ...h.d, callbackToken: TOKEN, ingestProof: async (...args: unknown[]) => { seen.push(args) } })
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID, merklePath: 'deadbeef', blockHeight: 42, txStatus: 'MINED' } })
    expect(got.status).toBe(200)
    expect(seen).toStrictEqual([[TXID, 'deadbeef']])
    expect(h.evicted).toEqual([])
  })

  // The engine caps the eviction reason at 1024 UTF-8 bytes and throws past it
  // — AFTER evictedAt is stamped, so the eviction would stick half-done. 256
  // UTF-16 units is at most 768 bytes.
  it('bounds the eviction reason to 256 UTF-16 units before evicting', async () => {
    const reasons: string[] = []
    const { handler } = base({ evict: async (_txid, reason) => { reasons.push(reason ?? ''); return {} } })
    const got = await runHandler(handler, {
      headers: { 'x-callback-token': TOKEN },
      body: { txid: TXID, txStatus: 'REJECTED', extraInfo: 'x'.repeat(2000) }
    })
    expect(got.status).toBe(200)
    expect(reasons).toHaveLength(1)
    expect(reasons[0].length).toBeLessThanOrEqual(256)
    expect(reasons[0].startsWith('REJECTED x')).toBe(true)
    expect(got.body.data.reason).toBe(reasons[0])
  })

  it('keeps a multi-byte reason under the engine\'s 1024-byte cap, even when the cut splits a surrogate pair', async () => {
    const reasons: string[] = []
    const { handler } = base({ evict: async (_txid, reason) => { reasons.push(reason ?? ''); return {} } })
    const got = await runHandler(handler, {
      headers: { 'x-callback-token': TOKEN },
      // 'REJECTED ' is 9 units, so the 256-unit cut lands inside an emoji.
      body: { txid: TXID, txStatus: 'REJECTED', extraInfo: '\u{1F600}'.repeat(1000) }
    })
    expect(got.status).toBe(200)
    expect(reasons[0].length).toBeLessThanOrEqual(256)
    expect(new TextEncoder().encode(reasons[0]).byteLength).toBeLessThanOrEqual(1024)
  })

  it.each([
    ['too short', 'ab'.repeat(31)],
    ['too long', `${'ab'.repeat(32)}0`],
    ['not hex', 'zz'.repeat(32)],
    ['an outpoint', `${'ab'.repeat(32)}.0`],
    ['padded', ` ${'ab'.repeat(32)}`]
  ])('400s a txid that is %s before touching any store', async (_label, badTxid) => {
    let gets = 0
    const proofs: string[] = []
    const h = deps(record())
    const handler = arcIngestHandler({
      ...h.d,
      store: { ...h.d.store, get: async (t) => { gets++; return await h.d.store.get(t) } },
      callbackToken: TOKEN,
      ingestProof: async (t) => { proofs.push(t) }
    })
    for (const body of [
      { txid: badTxid, txStatus: 'REJECTED' },
      { txid: badTxid, txStatus: 'MINED', merklePath: 'deadbeef' }
    ]) {
      const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body })
      expect(got.status).toBe(400)
      expect(got.body).toEqual({ status: 'error', message: 'Provider callback txid must be 64 hex characters' })
    }
    expect(gets).toBe(0)
    expect(proofs).toEqual([])
    expect(h.unmarked).toEqual([])
    expect(h.evicted).toEqual([])
  })

  it('still accepts an uppercase txid (it is lowercased before the check)', async () => {
    const { h, handler } = base()
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID.toUpperCase(), txStatus: 'REJECTED' } })
    expect(got.status).toBe(200)
    expect(h.evicted).toEqual([`${TXID}|REJECTED`])
  })

  // OverlayExpress registers bodyParser.json at the top of start(), i.e. AFTER
  // this route, so at handler time the body is still an unread stream.
  it('reads the JSON body off the raw stream when no parser has run yet', async () => {
    const { h, handler } = base()
    const listeners: Record<string, (arg: any) => void> = {}
    const req: any = {
      headers: { 'x-callback-token': TOKEN },
      on: (event: string, cb: (arg: any) => void) => { listeners[event] = cb }
    }
    let status = 200
    let body: any
    const res: any = { status (n: number) { status = n; return res }, json (b: unknown) { body = b; return res } }
    handler(req, res)
    await new Promise(r => setTimeout(r, 1))
    listeners.data(Buffer.from(JSON.stringify({ txid: TXID, txStatus: 'REJECTED' }), 'utf8'))
    listeners.end(undefined)
    await new Promise(r => setTimeout(r, 5))
    expect(status).toBe(200)
    expect(body.message).toBe('Terminal transaction status processed')
    expect(h.evicted).toEqual([`${TXID}|REJECTED`])
  })

  it('reads a Buffer body left by an upstream raw parser', async () => {
    const { h, handler } = base()
    const got = await runHandler(handler, {
      headers: { 'x-callback-token': TOKEN },
      body: Buffer.from(JSON.stringify({ txid: TXID, txStatus: 'INVALID' }), 'utf8')
    })
    expect(got.status).toBe(200)
    expect(h.evicted).toHaveLength(1)
  })

  it('400s on an unparseable body rather than evicting something arbitrary', async () => {
    const { h, handler } = base()
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: Buffer.from('not json', 'utf8') })
    expect(got.status).toBe(400)
    expect(h.evicted).toEqual([])
  })

  it('answers 500 when the eviction itself fails, so Arcade retries', async () => {
    const h = deps(record(), { evict: async () => { throw new Error('sqlite locked') } })
    const handler = arcIngestHandler({ ...h.d, callbackToken: TOKEN, ingestProof: async () => {} })
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID, txStatus: 'REJECTED' } })
    expect(got.status).toBe(500)
  })

  // §9.8 — a failed restore stamped nothing, so the eviction has NOT happened.
  it('answers 503 ERR_UNAVAILABLE when the input restore fails, and stamps nothing', async () => {
    const h = deps(record(), { unmarkSpent: async () => { throw new Error('sqlite locked') } })
    const handler = arcIngestHandler({ ...h.d, callbackToken: TOKEN, ingestProof: async () => {} })
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID, txStatus: 'REJECTED' } })
    expect(got.status).toBe(503)
    expect(got.body.code).toBe('ERR_UNAVAILABLE')
    expect(got.body.retryable).toBe(true)
    expect(h.rows[TXID].evictedAt).toBeUndefined()
    expect(h.evicted).toEqual([])
  })

  // §9.12 — exactly these keys, byte-identical on both engines.
  it('the terminal 200 body carries exactly the six contracted data keys', async () => {
    const { handler } = base()
    const got = await runHandler(handler, {
      headers: { 'x-callback-token': TOKEN },
      body: { txid: TXID, txStatus: 'DOUBLE_SPEND_ATTEMPTED', extraInfo: 'competing tx seen', competingTxs: ['ff'.repeat(32)] }
    })
    expect(got.status).toBe(200)
    expect(got.body).toEqual({
      status: 'success',
      message: 'Terminal transaction status processed',
      data: {
        txid: TXID,
        txStatus: 'DOUBLE_SPEND_ATTEMPTED',
        reason: 'DOUBLE_SPEND_ATTEMPTED competing tx seen',
        restoredOutpoints: 2,
        restoredTokenRows: 1,
        alreadyEvicted: false
      }
    })
    // The pinned engine's own eviction result and the provider's competingTxs
    // are deliberately not echoed — they would make the two stacks diverge on a
    // body the contract pins.
    expect(Object.keys(got.body.data)).toEqual([
      'txid', 'txStatus', 'reason', 'restoredOutpoints', 'restoredTokenRows', 'alreadyEvicted'
    ])
  })

  it('reports alreadyEvicted on a repeat callback', async () => {
    const h = deps(record({ evictedAt: '2026-09-13T00:00:00.000Z' }))
    const handler = arcIngestHandler({ ...h.d, callbackToken: TOKEN, ingestProof: async () => {} })
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID, txStatus: 'REJECTED' } })
    expect(got.body.data).toEqual({
      txid: TXID, txStatus: 'REJECTED', reason: 'REJECTED',
      restoredOutpoints: 0, restoredTokenRows: 0, alreadyEvicted: true
    })
  })
})

describe('mountArcIngest — FIX E, second half', () => {
  const fakeApp = () => {
    const routes: Record<string, unknown> = {}
    return { routes, post: (path: string, h: unknown) => { routes[path] = h } }
  }

  it('mounts the restoring ingest route ahead of the pinned one', async () => {
    const app = fakeApp()
    const h = deps(record())
    expect(mountArcIngest(app as any, { ...h.d, callbackToken: 'sekret', ingestProof: async () => {} })).toBeUndefined()
    const route = app.routes['/arc-ingest'] as any
    expect(route).toBeTypeOf('function')
    const got = await runHandler(route, { headers: { 'x-callback-token': 'sekret' }, body: { txid: TXID, txStatus: 'REJECTED' } })
    expect(got.status).toBe(200)
    expect(h.unmarked).toEqual([`${IN0}.0`, `${IN0}.1`])
  })

  // overlay-express 2.7.3 refuses to start() with Arcade and no token, so the
  // old blocking stub is gone. The handler itself still fails closed: an empty
  // configured token authenticates nothing — not even an empty presented one.
  it('with an empty token the mounted route authenticates nothing and evicts nothing', async () => {
    const app = fakeApp()
    const h = deps(record())
    mountArcIngest(app as any, { ...h.d, callbackToken: '', ingestProof: async () => {} })
    const route = app.routes['/arc-ingest'] as any
    expect(route).toBeTypeOf('function')
    for (const headers of [{}, { 'x-callback-token': '' }, { authorization: 'Bearer ' }, { authorization: '' }]) {
      const got = await runHandler(route, { headers, body: { txid: TXID, txStatus: 'REJECTED' } })
      expect(got.status).toBe(401)
      expect(got.body).toEqual({ status: 'error', message: 'Unauthorized callback' })
    }
    expect(h.unmarked).toEqual([])
    expect(h.evicted).toEqual([])
  })
})

describe('knexEvictionCoins on the real engine schema', () => {
  let h: Harness
  afterEach(async () => { await h?.close() })

  it('hands a coin back only from the evicted tx (or a legacy NULL spentBy), on its own topic', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    expect((await h.submit(a)).refusal).toBeUndefined()
    const root = h.root.id('hex')
    const coin = async () => await h.knex('outputs').where({ txid: root, outputIndex: 0, topic: HARNESS_TOPIC }).first()
    const coins = knexEvictionCoins(h.knex, HARNESS_TOPIC)
    expect((await coin()).spentBy).toBe(a.id('hex'))
    expect(await coins.isUnspent(root, 0)).toBe(false)

    // Evicting some other tx, or on another topic, never touches A's live spend.
    expect(await coins.unmarkSpent(root, 0, 'bb'.repeat(32))).toBe(0)
    expect(await knexEvictionCoins(h.knex, 'tm_other').unmarkSpent(root, 0, a.id('hex'))).toBe(0)
    expect(Boolean((await coin()).spent)).toBe(true)
    expect((await coin()).spentBy).toBe(a.id('hex'))

    // Evicting A hands the coin back and clears spentBy.
    expect(await coins.unmarkSpent(root, 0, a.id('hex'))).toBe(1)
    expect(Boolean((await coin()).spent)).toBe(false)
    expect((await coin()).spentBy).toBeNull()
    expect(await coins.isUnspent(root, 0)).toBe(true)
    // A repeat affects nothing; the coin still reads live.
    expect(await coins.unmarkSpent(root, 0, a.id('hex'))).toBe(0)

    // A legacy spend (spentBy NULL) is handed back.
    await h.knex('outputs').where({ txid: root, outputIndex: 0, topic: HARNESS_TOPIC }).update({ spent: true, spentBy: null })
    expect(await coins.unmarkSpent(root, 0, a.id('hex'))).toBe(1)

    // No row: nothing to unmark, and not live.
    expect(await coins.unmarkSpent('ee'.repeat(32), 0, a.id('hex'))).toBe(0)
    expect(await coins.isUnspent('ee'.repeat(32), 0)).toBe(false)
  })

  it('isUnspent fails closed on a spent value it cannot read', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const root = h.root.id('hex')
    await h.knex('outputs').where({ txid: root, outputIndex: 0, topic: HARNESS_TOPIC }).update({ spent: 'garbled' })
    await expect(knexEvictionCoins(h.knex, HARNESS_TOPIC).isUnspent(root, 0)).rejects.toThrow(/outputs\.spent/)
  })

  // agent12 race, end to end: attempt 1 unmarks the coin, then the token-row
  // restore fails (503, nothing stamped). B spends the coin through the real
  // engine before Arcade retries. The retry must leave B's spend and give the
  // coin no token row, and the eviction still completes.
  it('a retry after another tx spent the handed-back coin neither unmarks it nor restores its token row', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    expect((await h.submit(a)).refusal).toBeUndefined()
    const b = await h.spend(800)
    const root = h.root.id('hex')
    const A = a.id('hex')
    const restored: string[] = []
    let failRestore = true
    const hd = deps(record({
      txid: A,
      restore: {
        spentOutpoints: [`${root}.0`],
        tokenRows: [{ txid: root, outputIndex: 0, assetId: 'a.0', amount: 100, identityKey: '02ab' }]
      }
    }), {
      ...knexEvictionCoins(h.knex, HARNESS_TOPIC),
      restoreTokenRow: async (row) => {
        if (failRestore) throw new Error('mongo down')
        restored.push(`${row.txid}.${row.outputIndex}`)
      },
      evict: async (txid, reason) => await h.engine.evictAppliedTransaction(txid, { reason })
    })

    expect(isInfraError(await evictWithRestore(A, 'REJECTED', hd.d).catch((e: unknown) => e))).toBe(true)
    expect(hd.rows[A].evictedAt).toBeUndefined()

    expect((await h.submit(b)).refusal).toBeUndefined()
    const coin = async () => await h.knex('outputs').where({ txid: root, outputIndex: 0, topic: HARNESS_TOPIC }).first()
    expect((await coin()).spentBy).toBe(b.id('hex'))

    failRestore = false
    const report = await evictWithRestore(A, 'REJECTED', hd.d)
    expect(Boolean((await coin()).spent)).toBe(true)
    expect((await coin()).spentBy).toBe(b.id('hex'))
    expect(restored).toEqual([])
    expect(report.restoredOutpoints).toBe(0)
    expect(report.restoredTokenRows).toBe(0)
    expect(hd.rows[A].evictedAt).toBeTypeOf('string')
    expect(await h.knex('outputs').where({ txid: A })).toHaveLength(0)
  })
})
