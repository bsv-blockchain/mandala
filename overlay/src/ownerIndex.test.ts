import { describe, it, expect, vi, afterEach } from 'vitest'
import { MaintenanceGate } from './maintenanceGate.js'
import { OwnerIndexMaintenance } from './ownerIndex.js'

const mk = (over: Partial<any> = {}) => {
  const calls: string[] = []
  const deps = {
    gate: new MaintenanceGate(),
    lookup: {
      tokenIdsWithHistory: async () => { calls.push('ids'); return ['a'.repeat(64) + '_0', 'b'.repeat(64) + '_0'] },
      rebuildState: async (id: string) => { calls.push('rebuild:' + id.slice(0, 1)) }
    },
    reconcile: async (topic: string) => { calls.push('reconcile:' + topic); return { scanned: 1, repaired: 0, unrepairable: [] as string[] } },
    topics: ['tm_mandala', 'tm_mandala_registry'],
    log: () => {},
    ...over
  }
  return { deps, calls, m: new OwnerIndexMaintenance(deps) }
}

describe('OwnerIndexMaintenance', () => {
  it('refolds every token, then reconciles each topic, inside the exclusive gate', async () => {
    const { deps, calls, m } = mk()
    const spy = vi.spyOn(deps.gate, 'exclusive')
    await m.runOnce()
    expect(calls).toEqual(['ids', 'rebuild:a', 'rebuild:b', 'reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await m.healthCheck().handler()).status).toBe('ok')
  })
  it('reports unrepairable outpoints as degraded (not critical)', async () => {
    const { m } = mk({ reconcile: async (t: string) => ({ scanned: 2, repaired: 0, unrepairable: t === 'tm_mandala' ? ['c'.repeat(64) + '.1'] : [] }) })
    await m.runOnce()
    const h = m.healthCheck()
    expect(h).toMatchObject({ name: 'mandala-owner-index', scope: 'ready', critical: false })
    const r = await h.handler()
    expect(r.status).toBe('degraded')
    expect(r.details).toEqual({ unrepairable: ['c'.repeat(64) + '.1'] })
  })
  it('a failing run never throws, reports degraded, and the next run recovers', async () => {
    let fail = true
    const { m } = mk({ reconcile: async () => { if (fail) throw new Error('mongo down'); return { scanned: 0, repaired: 0, unrepairable: [] } } })
    await expect(m.runOnce()).resolves.toBeUndefined()
    expect(m.status().lastError).toBe('reconcile tm_mandala failed (Error); reconcile tm_mandala_registry failed (Error)')
    expect((await m.healthCheck().handler()).status).toBe('degraded')
    fail = false; await m.runOnce()
    expect(m.status().lastError).toBeNull()
    expect((await m.healthCheck().handler()).status).toBe('ok')
  })
  it('one refold failure still reconciles (the index repair does not depend on state)', async () => {
    const { calls, m } = mk({ lookup: { tokenIdsWithHistory: async () => ['a'.repeat(64) + '_0'], rebuildState: async () => { throw new Error('fold') } } })
    await m.runOnce()
    expect(calls).toContain('reconcile:tm_mandala')
    expect(m.status().lastError).toBe('refold failed for 1 token(s) (Error)')
  })
  it('degraded before the first run completes', async () => {
    const { m } = mk()
    expect((await m.healthCheck().handler()).status).toBe('degraded')
  })
  afterEach(() => { vi.useRealTimers() })
  it('the interval never overlaps runs and stop() clears it', async () => {
    vi.useFakeTimers()
    let running = 0, maxRunning = 0, release!: () => void
    const { m } = mk({ reconcile: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise<void>(r => { release = r }); running--; return { scanned: 0, repaired: 0, unrepairable: [] } } })
    m.start(1000)
    await vi.advanceTimersByTimeAsync(3500)
    expect(maxRunning).toBe(1)
    m.stop(); release?.()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })
  it('a busy gate (submits will not drain) is a recorded failure, never a throw; the next run recovers', async () => {
    const gate = new MaintenanceGate({ drainTimeoutMs: 20 })
    const { m, calls } = mk({ gate })
    const release = await gate.enter()
    await expect(m.runOnce()).resolves.toBeUndefined()
    expect(calls).toEqual([])
    expect(m.status().lastError).toBe('owner index run failed (MaintenanceBusyError)')
    expect((await m.healthCheck().handler()).status).toBe('degraded')
    release()
    await m.runOnce()
    expect(m.status().lastError).toBeNull()
    expect((await m.healthCheck().handler()).status).toBe('ok')
  })
  // F2 — /health/ready is public: its message carries counts and error classes
  // only, never driver text (hosts, URLs, credentials). Full text is logged.
  const mongoErr = (): Error => Object.assign(new Error('connect ECONNREFUSED mongodb://admin:hunter2@secret-host:27017 ' + 'x'.repeat(500)), { name: 'MongoNetworkError' })
  const leaks = (s: string | null | undefined): boolean => s != null && /mongodb:|secret-host|hunter2|ECONNREFUSED|27017/.test(s)

  it('the public readiness message for many failing refolds is a count and a class; full text goes to the log', async () => {
    const logs: string[] = []
    const ids = Array.from({ length: 50 }, (_, i) => String(i).padStart(64, '0') + '_0')
    const { m } = mk({ log: (l: string, e?: unknown) => logs.push(l + (e != null ? ` ${String(e)}` : '')), lookup: { tokenIdsWithHistory: async () => ids, rebuildState: async () => { throw mongoErr() } } })
    await m.runOnce()
    const r = await m.healthCheck().handler()
    expect(r.status).toBe('degraded')
    expect(r.message).toBe('refold failed for 50 token(s) (MongoNetworkError)')
    expect(leaks(r.message)).toBe(false)
    expect(leaks(JSON.stringify(r))).toBe(false)
    expect(leaks(m.status().lastError)).toBe(false)
    const errorLogs = logs.filter(l => l.includes('owner index error:'))
    expect(errorLogs.length).toBe(50)
    expect(errorLogs.every(l => l.includes('secret-host'))).toBe(true)
  })

  it('names each failed reconcile topic with its error class, never the driver text', async () => {
    const { m } = mk({
      lookup: {
        tokenIdsWithHistory: async () => ['a'.repeat(64) + '_0', 'b'.repeat(64) + '_0'],
        rebuildState: async () => { throw mongoErr() }
      },
      reconcile: async (t: string) => { if (t === 'tm_mandala') throw mongoErr(); return { scanned: 0, repaired: 0, unrepairable: [] } }
    })
    await m.runOnce()
    const r = await m.healthCheck().handler()
    expect(r.message).toBe('refold failed for 2 token(s) (MongoNetworkError); reconcile tm_mandala failed (MongoNetworkError)')
    expect(leaks(JSON.stringify(r))).toBe(false)
  })

  it('a failure before the gate (busy, or the id listing) is a class only', async () => {
    const { m } = mk({ lookup: { tokenIdsWithHistory: async () => { throw mongoErr() }, rebuildState: async () => {} } })
    await m.runOnce()
    const r = await m.healthCheck().handler()
    expect(r.message).toBe('owner index run failed (MongoNetworkError)')
    expect(leaks(JSON.stringify(r))).toBe(false)
  })

  it('an error class that is not a plain identifier, or a non-Error throw, is never echoed', async () => {
    const odd = Object.assign(new Error('x'), { name: 'Evil mongodb://secret-host:27017' })
    const { m } = mk({ reconcile: async (t: string) => { if (t === 'tm_mandala') throw odd; throw 'mongodb://secret-host:27017' } }) // eslint-disable-line @typescript-eslint/no-throw-literal
    await m.runOnce()
    const r = await m.healthCheck().handler()
    expect(r.message).toBe('reconcile tm_mandala failed (Error); reconcile tm_mandala_registry failed (non-Error)')
    expect(leaks(JSON.stringify(r))).toBe(false)
  })

  it('keeps the unrepairable count message', async () => {
    const { m } = mk({ reconcile: async (t: string) => ({ scanned: 2, repaired: 0, unrepairable: t === 'tm_mandala' ? ['c'.repeat(64) + '.1', 'd'.repeat(64) + '.0'] : [] }) })
    await m.runOnce()
    expect((await m.healthCheck().handler()).message).toBe('2 owner index rows unrepairable')
  })
  it('concurrent runOnce calls share the in-flight promise', async () => {
    const { m } = mk()
    const a = m.runOnce(); const b = m.runOnce()
    expect(a).toBe(b)
    await a
  })
  it('after stop() no further run is triggered', async () => {
    vi.useFakeTimers()
    let n = 0
    const { m } = mk({ reconcile: async () => { n++; return { scanned: 0, repaired: 0, unrepairable: [] } } })
    m.start(1000)
    await vi.advanceTimersByTimeAsync(1500)
    const after = n
    expect(after).toBeGreaterThan(0)
    m.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(n).toBe(after)
  })
  it('a failing first refold does not stop the second', async () => {
    const rebuilt: string[] = []
    const { m } = mk({ lookup: { tokenIdsWithHistory: async () => ['a'.repeat(64) + '_0', 'b'.repeat(64) + '_0'], rebuildState: async (id: string) => { if (id[0] === 'a') throw new Error('x'); rebuilt.push(id[0]) } } })
    await m.runOnce()
    expect(rebuilt).toEqual(['b'])
  })
})
