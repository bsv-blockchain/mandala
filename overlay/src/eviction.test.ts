import { describe, it, expect } from 'vitest'
import {
  isTerminalArcStatus, evictWithRestore, arcIngestHandler, mountArcIngest,
  type EvictionDeps
} from './eviction.js'
import type { AdmissionRecord, AdmissionStore } from './admission.js'
import { isInfraError } from './submitVerdict.js'

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
    unmarkSpent: async (txid, vout) => { order.push('unmark'); unmarked.push(`${txid}.${vout}`) },
    restoreTokenRow: async (row) => { order.push('restore'); restored.push(`${row.txid}.${row.outputIndex}`) },
    evict: async (txid, reason) => { order.push('evict'); evicted.push(`${txid}|${reason ?? ''}`); return { evictedOutputs: 1 } },
    purgeAdminHistory: async (txid) => { order.push('purge'); purged.push(txid); return ['a.0', 'b.0'] },
    rebuildAssetState: async (assetId) => { order.push('rebuild'); rebuilt.push(assetId) },
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
    expect(h.order).toEqual(['unmark', 'unmark', 'restore', 'markEvicted', 'evict', 'purge', 'rebuild', 'rebuild'])
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
    expect(h.rebuilt).toEqual(['a.0', 'b.0'])
    expect(h.order).toEqual(['unmark', 'unmark', 'restore', 'markEvicted', 'evict', 'purge', 'rebuild', 'rebuild'])
  })

  it('purges admin history on a repeat callback too — production heads were stuck behind a pre-fix eviction', async () => {
    const h = deps(record({ evictedAt: '2026-09-13T00:00:00.000Z' }))
    await evictWithRestore(TXID, 'REJECTED', h.d)
    expect(h.purged).toEqual([TXID])
    expect(h.rebuilt).toEqual(['a.0', 'b.0'])
  })

  it('a failed history purge is retryable (InfraError) — evictedAt is already stamped, the retry re-runs the purge', async () => {
    const h = deps(record(), { purgeAdminHistory: async () => { throw new Error('mongo down') } })
    const err = await evictWithRestore(TXID, 'REJECTED', h.d).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect(h.rebuilt).toEqual([])
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

  it('ingests a merkle proof and answers 200', async () => {
    const seen: string[] = []
    const h = deps(record())
    const handler = arcIngestHandler({ ...h.d, callbackToken: TOKEN, ingestProof: async (txid, hex, height) => { seen.push(`${txid}|${hex}|${String(height)}`) } })
    const got = await runHandler(handler, { headers: { 'x-callback-token': TOKEN }, body: { txid: TXID, merklePath: 'deadbeef', blockHeight: 42, txStatus: 'MINED' } })
    expect(got.status).toBe(200)
    expect(seen).toEqual([`${TXID}|deadbeef|42`])
    expect(h.evicted).toEqual([])
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

  it('mounts the ingest route when a callback token is configured', () => {
    const app = fakeApp()
    const h = deps(record())
    const logged: string[] = []
    expect(mountArcIngest(app as any, { ...h.d, callbackToken: 'sekret', ingestProof: async () => {} }, m => logged.push(m))).toBe(true)
    expect(app.routes['/arc-ingest']).toBeTypeOf('function')
    expect(logged).toEqual([])
  })

  it('refuses to mount a working route with an empty token, logs, and keeps serving', async () => {
    const app = fakeApp()
    const h = deps(record())
    const logged: string[] = []
    expect(mountArcIngest(app as any, { ...h.d, callbackToken: '', ingestProof: async () => {} }, m => logged.push(m))).toBe(false)
    expect(logged.join(' ')).toMatch(/ARCADE_CALLBACK_TOKEN/)
    // A blocking stub still occupies the path, so the pinned overlay-express
    // route (which mounts unauthenticated when the token is empty) is shadowed
    // and can never evict.
    const blocker = app.routes['/arc-ingest'] as any
    expect(blocker).toBeTypeOf('function')
    const got = await runHandler(blocker, { body: { txid: TXID, txStatus: 'REJECTED' } })
    expect(got.status).toBe(503)
    expect(h.evicted).toEqual([])
  })
})
