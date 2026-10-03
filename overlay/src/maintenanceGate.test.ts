import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { MaintenanceGate, MaintenanceBusyError, gateSubmits, reconcileThenSubmitGate } from './maintenanceGate.js'

const tick = () => new Promise(r => setImmediate(r))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

describe('MaintenanceGate', () => {
  it('exclusive waits for in-flight submits to drain', async () => {
    const g = new MaintenanceGate(); const log: string[] = []
    const release = await g.enter()
    const ex = g.exclusive(async () => { log.push('maint') })
    await tick(); expect(log).toEqual([])
    release(); await ex; expect(log).toEqual(['maint'])
  })
  it('submits arriving during maintenance wait for it', async () => {
    const g = new MaintenanceGate(); const log: string[] = []
    let finish!: () => void
    const ex = g.exclusive(() => new Promise<void>(r => { finish = () => { log.push('maint'); r() } }))
    await tick()
    const entered = g.enter().then(rel => { log.push('submit'); rel() })
    await tick(); expect(log).toEqual([])
    finish(); await ex; await entered
    expect(log).toEqual(['maint', 'submit'])
  })
  it('a waiting exclusive blocks new submits (no starvation)', async () => {
    const g = new MaintenanceGate(); const log: string[] = []
    const r1 = await g.enter()
    const ex = g.exclusive(async () => { log.push('maint') })
    const late = g.enter().then(rel => { log.push('late'); rel() })
    await tick(); r1(); await ex; await late
    expect(log).toEqual(['maint', 'late'])
  })
  it('release is idempotent and an exclusive that throws frees the gate', async () => {
    const g = new MaintenanceGate()
    const r = await g.enter(); r(); r()
    await expect(g.exclusive(async () => { throw new Error('x') })).rejects.toThrow('x')
    const r2 = await g.enter(); r2(); expect(g.busy).toBe(false)
  })
  it('gateSubmits releases when end is invoked, once, and calls through', async () => {
    const g = new MaintenanceGate(); const mw = gateSubmits(g)
    const calls: unknown[][] = []
    const res: any = { end (...args: unknown[]) { calls.push(args); return 'r' } }
    let nexted = false
    await new Promise<void>(r => mw({} as any, res, () => { nexted = true; r() }))
    expect(nexted).toBe(true); expect(g.busy).toBe(true)
    expect(res.end('a', 'b')).toBe('r')
    expect(g.busy).toBe(false); expect(calls).toEqual([['a', 'b']])
    res.end(); expect(g.busy).toBe(false); expect(calls.length).toBe(2)
  })
  it('exclusive calls serialize in arrival order', async () => {
    const g = new MaintenanceGate(); const log: string[] = []
    const a = g.exclusive(async () => {
      log.push('a-start')
      await tick()
      log.push('a-end')
    })
    const b = g.exclusive(async () => {
      log.push('b-start')
      log.push('b-end')
    })
    await a; await b
    expect(log).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })
  it('drain timeout rejects the exclusive, skips fn, and unblocks queued submits', async () => {
    const g = new MaintenanceGate({ drainTimeoutMs: 50 })
    await g.enter() // never released
    let ran = false
    const ex = g.exclusive(async () => { ran = true })
    const late = g.enter()
    const err = await ex.catch(e => e)
    expect(err).toBeInstanceOf(MaintenanceBusyError)
    expect(err.name).toBe('MaintenanceBusyError')
    expect(err.message).toContain('1')
    expect(ran).toBe(false)
    const rel = await Promise.race([late, sleep(500).then(() => null)])
    expect(rel).not.toBeNull()
    ;(rel as () => void)()
  })
})

describe('gateSubmits over real express', () => {
  let srv: http.Server | undefined
  afterEach(async () => {
    if (srv) { srv.closeAllConnections(); await new Promise(r => srv!.close(r)); srv = undefined }
  })
  const start = async (g: MaintenanceGate, handler: express.RequestHandler) => {
    const app = express()
    app.post('/submit', gateSubmits(g), handler)
    srv = http.createServer(app)
    await new Promise<void>(r => srv!.listen(0, r))
    const port = (srv.address() as AddressInfo).port
    return () => { const r = http.request({ port, method: 'POST', path: '/submit' }); r.on('error', () => {}); r.end(); return r }
  }

  it('abort while queued behind maintenance does not leak the slot', async () => {
    const g = new MaintenanceGate(); let handled = false
    const shoot = await start(g, (_req, res) => { void sleep(100).then(() => { handled = true; res.json({ ok: 1 }) }) })
    const maint = deferred()
    const ex = g.exclusive(() => maint.promise)
    await tick()
    const c = shoot(); await sleep(100)
    c.destroy(); await sleep(50)
    maint.resolve(); await ex
    await sleep(300)
    expect(handled).toBe(true)
    expect(g.busy).toBe(false)
    let ran = false
    await g.exclusive(async () => { ran = true })
    expect(ran).toBe(true)
  })

  it('abort mid-handler keeps the slot until the handler ends the response', async () => {
    const g = new MaintenanceGate(); const fold = deferred()
    let entered = false
    const shoot = await start(g, (_req, res) => { entered = true; void fold.promise.then(() => res.json({ ok: 1 })) })
    const c = shoot()
    while (!entered) await sleep(10)
    expect(g.busy).toBe(true)
    c.destroy(); await sleep(100)
    expect(g.busy).toBe(true)
    let ran = false
    const ex = g.exclusive(async () => { ran = true })
    await sleep(50); expect(ran).toBe(false)
    fold.resolve(); await ex
    expect(ran).toBe(true)
    expect(g.busy).toBe(false)
  })
})

// Task 13 — eviction is the only holder of BOTH the reconcile lock and the
// submit gate, always in that order (reconcile lock first). The owner-index run
// takes the gate (refold) and the lock (reconcile) one at a time, never nested,
// so nobody holds the gate while waiting on the lock and no cycle can form.
describe('reconcileThenSubmitGate (the eviction quiesce)', () => {
  it('acquires the reconcile lock first, then the submit gate, and runs fn under both', async () => {
    const reconcileLock = new MaintenanceGate(); const gate = new MaintenanceGate()
    const r = vi.spyOn(reconcileLock, 'exclusive'); const g = vi.spyOn(gate, 'exclusive')
    let seen: [boolean, boolean] | null = null
    const out = await reconcileThenSubmitGate(reconcileLock, gate)(async () => { seen = [reconcileLock.busy, gate.busy]; return 7 })
    expect(out).toBe(7)
    expect(seen).toEqual([true, true])
    expect(r).toHaveBeenCalledTimes(1); expect(g).toHaveBeenCalledTimes(1)
    expect(r.mock.invocationCallOrder[0]).toBeLessThan(g.mock.invocationCallOrder[0])
    expect(reconcileLock.busy).toBe(false); expect(gate.busy).toBe(false)
  })
  it('does not touch the submit gate while the reconcile lock is held elsewhere', async () => {
    const reconcileLock = new MaintenanceGate(); const gate = new MaintenanceGate()
    const held = deferred()
    const holder = reconcileLock.exclusive(() => held.promise)
    await tick()
    const g = vi.spyOn(gate, 'exclusive')
    const ran: string[] = []
    const ev = reconcileThenSubmitGate(reconcileLock, gate)(async () => { ran.push('evict') })
    await tick()
    expect(g).not.toHaveBeenCalled()
    // A submit is not blocked by a reconcile-lock holder: the gate is untouched.
    const rel = await gate.enter(); rel()
    held.resolve(); await holder; await ev
    expect(ran).toEqual(['evict'])
  })
  it('a reconcile lock that is not released within the drain timeout rejects MaintenanceBusyError (fn not run)', async () => {
    const reconcileLock = new MaintenanceGate({ drainTimeoutMs: 20 }); const gate = new MaintenanceGate()
    const held = deferred()
    const holder = reconcileLock.exclusive(() => held.promise)
    await tick()
    let ran = false
    await expect(reconcileThenSubmitGate(reconcileLock, gate)(async () => { ran = true })).rejects.toBeInstanceOf(MaintenanceBusyError)
    expect(ran).toBe(false)
    expect(gate.busy).toBe(false)
    held.resolve(); await holder
  })
  it('a submit gate that does not drain rejects MaintenanceBusyError and frees the reconcile lock', async () => {
    const reconcileLock = new MaintenanceGate(); const gate = new MaintenanceGate({ drainTimeoutMs: 20 })
    const rel = await gate.enter()
    await expect(reconcileThenSubmitGate(reconcileLock, gate)(async () => {})).rejects.toBeInstanceOf(MaintenanceBusyError)
    expect(reconcileLock.busy).toBe(false)
    rel()
  })
})
