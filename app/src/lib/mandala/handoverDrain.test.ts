import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WalletInterface } from '@bsv/sdk'
import type { ReconcileOptions, ReconcileResult } from '@bsv/mandala'
import {
  backoffMs,
  drainHandovers,
  withHandoverLock,
  SELF_GRACE_MS,
  type DrainDeps,
  type JournalHandover
} from './handoverDrain'

const A = '02' + 'aa'.repeat(32)
const B = '03' + 'bb'.repeat(32)
const R0: ReconcileResult = { rebroadcast: [], aborted: [], resubmitted: [], stranded: [], swept: 0, handoversAwaitingDelivery: 0 }

// The tests read only the fields the drain reads (A15).
const entry = (txid: string, stage: 'signed' | 'delivered', recipientKey: string, at: number): JournalHandover =>
  ({ txid, stage, recipientKey, at }) as unknown as JournalHandover
// Old enough for the self-send grace at the default clock (now() = 0).
const signedTo = (txid: string, rk: string): JournalHandover => entry(txid, 'signed', rk, -SELF_GRACE_MS)

const passThrough: NonNullable<DrainDeps['withLock']> = async (fn) => ({ ran: true, value: await fn() })

function deps (over: Partial<DrainDeps> = {}): DrainDeps {
  return {
    wallet: {} as unknown as WalletInterface,
    identityKey: A,
    messageBoxClient: { sendMessage: vi.fn(async () => undefined) },
    now: () => 0,
    state: { failures: 0, nextAt: 0 },
    list: vi.fn(async (): Promise<JournalHandover[]> => []),
    markDelivered: vi.fn(async (_txid: string) => {}),
    redeliver: vi.fn(async (): Promise<string[]> => []),
    reconcile: vi.fn(async (): Promise<ReconcileResult> => R0),
    withLock: passThrough,
    ...over
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('drainHandovers', () => {
  it('runs markSelf → redeliver → reconcile in that order, reconcile with sweep:false', async () => {
    const order: string[] = []
    const d = deps({
      list: vi.fn<DrainDeps['list']>().mockResolvedValueOnce([signedTo('t1', A), signedTo('t2', B)]).mockResolvedValue([]),
      markDelivered: vi.fn(async (t: string) => { order.push('mark:' + t) }),
      redeliver: vi.fn(async () => { order.push('redeliver'); return [] }),
      reconcile: vi.fn(async (_w: WalletInterface, o?: ReconcileOptions) => { order.push('reconcile:' + JSON.stringify(o)); return R0 })
    })
    const r = await drainHandovers(d, { force: true })
    expect(order).toEqual(['mark:t1', 'redeliver', 'reconcile:{"sweep":false}'])
    expect(r.markedSelf).toEqual(['t1'])
    expect(r.skipped).toBeNull()
    expect(r.reconcile).toEqual(R0)
    expect(r.awaiting).toEqual({ signed: 0, delivered: 0 })
    expect(d.state).toEqual({ failures: 0, nextAt: 300_000 }) // deps() default now() = 0
  })

  it('marks a self entry only after the 60 s grace', async () => {
    const fresh = entry('f', 'signed', A, 100_000 - 10_000)
    const old = entry('o', 'signed', A, 100_000 - 61_000)
    const d = deps({ now: () => 100_000, list: vi.fn<DrainDeps['list']>().mockResolvedValueOnce([fresh, old]).mockResolvedValue([]) })
    const r = await drainHandovers(d, { force: true })
    expect(r.markedSelf).toEqual(['o'])
    expect(d.markDelivered).toHaveBeenCalledTimes(1)
  })

  it('a markDelivered failure is warned and skipped; the pass continues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = deps({
      list: vi.fn<DrainDeps['list']>().mockResolvedValueOnce([signedTo('x', A), signedTo('y', A)]).mockResolvedValue([signedTo('x', A)]),
      markDelivered: vi.fn(async (t: string) => { if (t === 'x') throw new Error('store') })
    })
    const r = await drainHandovers(d, { force: true })
    expect(r.markedSelf).toEqual(['y'])
    expect(d.reconcile).toHaveBeenCalledTimes(1)
    expect(r.awaiting).toEqual({ signed: 1, delivered: 0 })
    expect(d.state.failures).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never calls deliver, settle, abortAction or storage itself', async () => {
    const wallet = { abortAction: vi.fn(), listOutputs: vi.fn() } as unknown as WalletInterface
    const ls = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), key: vi.fn(), length: 0, clear: vi.fn() }
    vi.stubGlobal('localStorage', ls)
    await drainHandovers(deps({ wallet, list: async () => [entry('t', 'delivered', B, 0)] }), { force: true })
    expect((wallet as unknown as { abortAction: ReturnType<typeof vi.fn> }).abortAction).not.toHaveBeenCalled()
    for (const f of [ls.getItem, ls.setItem, ls.removeItem]) expect(f).not.toHaveBeenCalled()
    // And the module cannot: no settle/deliver/abort/storage reference in its code (comments stripped).
    const code = readFileSync(fileURLToPath(new URL('./handoverDrain.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/deliverHandover|settleHandover|resubmitDelivered|abortAction|localStorage|sessionStorage|indexedDB/)
  })

  it('a redeliver failure still runs reconcile and counts as a failure', async () => {
    const d = deps({ redeliver: vi.fn<DrainDeps['redeliver']>().mockRejectedValue(new Error('mb down')) })
    const r = await drainHandovers(d, { force: true })
    expect(d.reconcile).toHaveBeenCalledTimes(1)
    expect(r.redeliverError).toBe('mb down')
    expect(d.state.failures).toBe(1)
  })

  it('a reconcile failure is recorded and counts as a failure', async () => {
    const d = deps({ now: () => 7, reconcile: vi.fn<DrainDeps['reconcile']>().mockRejectedValue(new Error('overlay down')) })
    const r = await drainHandovers(d, { force: true })
    expect(r.reconcileError).toBe('overlay down')
    expect(r.reconcile).toBeUndefined()
    expect(d.state).toEqual({ failures: 1, nextAt: 7 + 15_000 })
  })

  it('backoff grows while hand-overs remain and resets when the journal empties', async () => {
    const left = [entry('t', 'delivered', B, 0)]
    const d = deps({ now: () => 1000, list: vi.fn(async () => left) })
    await drainHandovers(d, { force: true }); expect(d.state).toEqual({ failures: 1, nextAt: 16000 })
    await drainHandovers(d, { force: true }); expect(d.state).toEqual({ failures: 2, nextAt: 31000 })
    d.list = vi.fn(async () => [])
    await drainHandovers(d, { force: true }); expect(d.state).toEqual({ failures: 0, nextAt: 1000 + 300_000 })
  })

  it('an idle app is not polled every tick', async () => {
    let t = 0
    const d = deps({ now: () => t })
    await drainHandovers(d, { force: true })
    t = 15_000; expect((await drainHandovers(d)).skipped).toBe('backoff')
    t = 300_000; expect((await drainHandovers(d)).skipped).toBeNull()
    expect(d.reconcile).toHaveBeenCalledTimes(2)
  })

  it('skips without force while backing off; force ignores nextAt', async () => {
    const d = deps({ now: () => 5, state: { failures: 3, nextAt: 10 } })
    const r = await drainHandovers(d)
    expect(r.skipped).toBe('backoff'); expect(d.reconcile).not.toHaveBeenCalled(); expect(d.list).not.toHaveBeenCalled()
    expect(d.state).toEqual({ failures: 3, nextAt: 10 })
    expect((await drainHandovers(d, { force: true })).skipped).toBeNull(); expect(d.reconcile).toHaveBeenCalledTimes(1)
  })

  it('concurrent drains: the second is skipped (same tab)', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const d = deps({ reconcile: vi.fn(async () => { await gate; return R0 }) })
    const p1 = drainHandovers(d, { force: true })
    const r2 = await drainHandovers(d, { force: true })
    release(); await p1
    expect(r2.skipped).toBe('busy'); expect(d.reconcile).toHaveBeenCalledTimes(1)
    // The in-flight marker is released: the next pass runs.
    expect((await drainHandovers(d, { force: true })).skipped).toBeNull()
  })

  it('another tab holding the lock gives skipped busy', async () => {
    const d = deps({ withLock: async () => ({ ran: false }) as const })
    const r = await drainHandovers(d, { force: true })
    expect(r.skipped).toBe('busy'); expect(d.redeliver).not.toHaveBeenCalled(); expect(d.reconcile).not.toHaveBeenCalled()
    expect(d.state).toEqual({ failures: 0, nextAt: 0 })
  })

  it('a list() failure skips self-marking but still reconciles', async () => {
    const d = deps({ list: vi.fn<DrainDeps['list']>().mockRejectedValue(new Error('idb')) })
    const r = await drainHandovers(d, { force: true })
    expect(d.markDelivered).not.toHaveBeenCalled(); expect(d.redeliver).toHaveBeenCalledTimes(1); expect(d.reconcile).toHaveBeenCalledTimes(1)
    expect(r.awaiting).toEqual({ signed: -1, delivered: -1 })
    expect(d.state.failures).toBe(1)
  })
})

describe('withHandoverLock', () => {
  it('withHandoverLock wait:false refuses while held, wait:true queues (no navigator.locks)', async () => {
    vi.stubGlobal('navigator', {})
    let release!: () => void
    const held = withHandoverLock(() => new Promise<void>(resolve => { release = resolve }), { wait: true })
    expect(await withHandoverLock(async () => 1, { wait: false })).toEqual({ ran: false })
    const queued = withHandoverLock(async () => 2, { wait: true })
    // Queued but not yet running still refuses a wait:false caller.
    expect(await withHandoverLock(async () => 3, { wait: false })).toEqual({ ran: false })
    release(); await held
    expect(await queued).toEqual({ ran: true, value: 2 })
    expect(await withHandoverLock(async () => 4, { wait: false })).toEqual({ ran: true, value: 4 })
  })

  it('uses navigator.locks when present: wait:false refuses while another holder has the lock', async () => {
    if (typeof navigator === 'undefined' || navigator.locks == null) return // runtime without Web Locks
    let release!: () => void
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const held = withHandoverLock(async () => { started(); await new Promise<void>(resolve => { release = resolve }) }, { wait: true })
    await running
    expect(await withHandoverLock(async () => 1, { wait: false })).toEqual({ ran: false })
    release(); await held
    expect(await withHandoverLock(async () => 2, { wait: false })).toEqual({ ran: true, value: 2 })
  })

  it('backoffMs caps at 15 minutes', () => {
    expect([0, 1, 2, 3, 7, 50].map(backoffMs)).toEqual([0, 15000, 30000, 60000, 900000, 900000])
  })
})
