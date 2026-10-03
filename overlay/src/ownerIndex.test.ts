import { describe, it, expect, vi, afterEach } from 'vitest'
import { MaintenanceGate } from './maintenanceGate.js'
import { OwnerIndexMaintenance, OWNER_INDEX_INTERVAL_MS } from './ownerIndex.js'

const mk = (over: Partial<any> = {}) => {
  const calls: string[] = []
  const deps = {
    gate: new MaintenanceGate(),
    reconcileLock: new MaintenanceGate(),
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
  it('the interval is 30 minutes', () => {
    expect(OWNER_INDEX_INTERVAL_MS).toBe(1_800_000)
  })
  it('boot run: refolds every token inside the exclusive submit gate, then reconciles each topic under the reconcile lock only', async () => {
    const seen: string[] = []
    const { deps, calls, m } = mk()
    deps.lookup = {
      tokenIdsWithHistory: async () => { calls.push('ids'); return ['a'.repeat(64) + '_0', 'b'.repeat(64) + '_0'] },
      rebuildState: async (id: string) => { calls.push('rebuild:' + id.slice(0, 1)); seen.push(`rebuild gate=${deps.gate.busy} lock=${deps.reconcileLock.busy}`) }
    }
    deps.reconcile = async (topic: string) => { calls.push('reconcile:' + topic); seen.push(`reconcile gate=${deps.gate.busy} lock=${deps.reconcileLock.busy}`); return { scanned: 1, repaired: 0, unrepairable: [] } }
    const g = vi.spyOn(deps.gate, 'exclusive'); const r = vi.spyOn(deps.reconcileLock, 'exclusive')
    await m.runOnce()
    expect(calls).toEqual(['ids', 'rebuild:a', 'rebuild:b', 'reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(seen).toEqual([
      'rebuild gate=true lock=true', 'rebuild gate=true lock=true',
      'reconcile gate=false lock=true', 'reconcile gate=false lock=true'
    ])
    expect(g).toHaveBeenCalledTimes(1); expect(r).toHaveBeenCalledTimes(1)
    // Lock order: the reconcile lock is taken before the submit gate.
    expect(r.mock.invocationCallOrder[0]).toBeLessThan(g.mock.invocationCallOrder[0])
    expect((await m.healthCheck().handler()).status).toBe('ok')
  })
  it('interval run (after a successful refold): reconciles only, never refolds, never takes the submit gate', async () => {
    const { deps, calls, m } = mk()
    await m.runOnce()
    calls.length = 0
    const g = vi.spyOn(deps.gate, 'exclusive'); const r = vi.spyOn(deps.reconcileLock, 'exclusive')
    await m.runOnce()
    expect(calls).toEqual(['reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(g).not.toHaveBeenCalled()
    expect(r).toHaveBeenCalledTimes(1)
    expect(m.status().lastError).toBeNull()
    expect((await m.healthCheck().handler()).status).toBe('ok')
  })
  it('a failed boot refold is retried (inside the submit gate) on every run until one succeeds; then runs are reconcile-only', async () => {
    let failRefold = true
    const { deps, calls, m } = mk({
      lookup: {
        tokenIdsWithHistory: async () => { calls.push('ids'); return ['a'.repeat(64) + '_0'] },
        rebuildState: async () => { calls.push('rebuild'); if (failRefold) throw new Error('fold') }
      }
    })
    const g = vi.spyOn(deps.gate, 'exclusive')
    await m.runOnce()
    expect(m.status().lastError).toBe('refold failed for 1 token(s) (Error)')
    expect(g).toHaveBeenCalledTimes(1)
    calls.length = 0
    await m.runOnce() // still failing: refolds again, exclusive
    expect(calls).toEqual(['ids', 'rebuild', 'reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(g).toHaveBeenCalledTimes(2)
    failRefold = false; calls.length = 0
    await m.runOnce() // succeeds: refolds once more
    expect(calls).toEqual(['ids', 'rebuild', 'reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(g).toHaveBeenCalledTimes(3)
    expect(m.status().lastError).toBeNull()
    calls.length = 0
    await m.runOnce() // back to reconcile-only
    expect(calls).toEqual(['reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(g).toHaveBeenCalledTimes(3)
  })
  it('a failed token listing or a busy gate keeps the refold pending', async () => {
    let failIds = true
    const { calls, m } = mk({
      lookup: {
        tokenIdsWithHistory: async () => { calls.push('ids'); if (failIds) throw new Error('down'); return [] },
        rebuildState: async () => {}
      }
    })
    await m.runOnce()
    expect(m.status().lastError).toBe('owner index run failed (Error)')
    failIds = false; calls.length = 0
    await m.runOnce()
    expect(calls).toEqual(['ids', 'reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    calls.length = 0
    await m.runOnce()
    expect(calls).toEqual(['reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
  })
  it('a submit holding the submit gate does not block an interval reconcile', async () => {
    const gate = new MaintenanceGate({ drainTimeoutMs: 60_000 })
    const { calls, m } = mk({ gate })
    await m.runOnce()
    calls.length = 0
    const release = await gate.enter() // an in-flight /submit
    await m.runOnce()
    expect(calls).toEqual(['reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(m.status().lastError).toBeNull()
    release()
  })
  it('an eviction holding the reconcile lock blocks the interval reconcile until it releases (no overlap)', async () => {
    const { deps, calls, m } = mk()
    await m.runOnce()
    calls.length = 0
    let releaseEviction!: () => void
    let evicting = false
    const eviction = deps.reconcileLock.exclusive(async () => { evicting = true; await new Promise<void>(r => { releaseEviction = r }); evicting = false })
    await new Promise(r => setImmediate(r))
    const overlap: boolean[] = []
    deps.reconcile = async (topic: string) => { overlap.push(evicting); calls.push('reconcile:' + topic); return { scanned: 0, repaired: 0, unrepairable: [] } }
    const run = m.runOnce()
    await new Promise(r => setImmediate(r))
    expect(calls).toEqual([])
    releaseEviction(); await eviction; await run
    expect(calls).toEqual(['reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(overlap).toEqual([false, false])
    expect(m.status().lastError).toBeNull()
  })
  it('a reconcile lock held past its drain timeout is a recorded failure, never a throw', async () => {
    const reconcileLock = new MaintenanceGate({ drainTimeoutMs: 20 })
    const { m, calls } = mk({ reconcileLock })
    let release!: () => void
    const holder = reconcileLock.exclusive(() => new Promise<void>(r => { release = r }))
    await new Promise(r => setImmediate(r))
    await expect(m.runOnce()).resolves.toBeUndefined()
    expect(calls).toEqual([])
    expect(m.status().lastError).toBe('owner index run failed (MaintenanceBusyError)')
    release(); await holder
    await m.runOnce()
    expect(m.status().lastError).toBeNull()
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
  it('a busy gate (submits will not drain) during a pending refold is a recorded failure, never a throw; the next run recovers', async () => {
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
  // F8 — a failed run (the boot refold above all) is retried sooner than the
  // interval: 10s, doubling, capped at the interval; a success returns to it.
  describe('retry backoff after a failed run', () => {
    const counting = () => {
      const state = { runs: 0, fail: true }
      const { m } = mk({
        lookup: { tokenIdsWithHistory: async () => [], rebuildState: async () => {} },
        // Counted on the first topic: after the boot refold, runs reconcile only.
        reconcile: async (t: string) => { if (t === 'tm_mandala') state.runs++; if (state.fail) throw new Error('down'); return { scanned: 0, repaired: 0, unrepairable: [] } }
      })
      return { m, state }
    }

    it('a failed boot run retries after 10s, not after the interval', async () => {
      vi.useFakeTimers()
      const { m, state } = counting()
      await m.runOnce()
      expect(state.runs).toBe(1)
      m.start(300_000)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(state.runs).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(state.runs).toBe(2)
      m.stop()
    })

    it('doubles from 10s while runs keep failing, capped at the interval', async () => {
      vi.useFakeTimers()
      const { m, state } = counting()
      await m.runOnce()
      m.start(300_000)
      const at: number[] = []
      let t = 0
      while (at.length < 7) {
        await vi.advanceTimersByTimeAsync(1_000); t += 1_000
        if (state.runs - 1 > at.length) at.push(t)
      }
      // gaps: 10s, 20s, 40s, 80s, 160s, then capped at 300s
      expect(at.map((v, i) => v - (at[i - 1] ?? 0))).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
      m.stop()
    })

    it('a success returns to the normal interval, and a later failure starts again at 10s', async () => {
      vi.useFakeTimers()
      const { m, state } = counting()
      await m.runOnce()
      m.start(300_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.runs).toBe(2)
      state.fail = false
      await vi.advanceTimersByTimeAsync(20_000)
      expect(state.runs).toBe(3)
      expect(m.status().lastError).toBeNull()
      await vi.advanceTimersByTimeAsync(299_999)
      expect(state.runs).toBe(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(state.runs).toBe(4)
      state.fail = true
      await vi.advanceTimersByTimeAsync(300_000)
      expect(state.runs).toBe(5)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(state.runs).toBe(5)
      await vi.advanceTimersByTimeAsync(1)
      expect(state.runs).toBe(6)
      m.stop()
    })

    it('a successful boot run waits the full interval', async () => {
      vi.useFakeTimers()
      const { m, state } = counting()
      state.fail = false
      await m.runOnce()
      m.start(300_000)
      await vi.advanceTimersByTimeAsync(299_999)
      expect(state.runs).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(state.runs).toBe(2)
      m.stop()
    })

    it('stop() during an in-flight scheduled run schedules nothing after it', async () => {
      vi.useFakeTimers()
      let release!: () => void
      let runs = 0
      const { m } = mk({
        lookup: { tokenIdsWithHistory: async () => [], rebuildState: async () => {} },
        reconcile: async (t: string) => { if (t === 'tm_mandala') runs++; await new Promise<void>(r => { release = r }); throw new Error('down') }
      })
      m.start(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(runs).toBe(1)
      m.stop()
      release()
      await vi.advanceTimersByTimeAsync(0)
      release?.()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runs).toBe(1)
    })

    it('a start() after stop() reschedules exactly one chain', async () => {
      vi.useFakeTimers()
      const { m, state } = counting()
      state.fail = false
      m.start(1_000); m.stop(); m.start(1_000); m.start(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.runs).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.runs).toBe(2)
      m.stop()
    })
  })

  it('a failing first refold does not stop the second', async () => {
    const rebuilt: string[] = []
    const { m } = mk({ lookup: { tokenIdsWithHistory: async () => ['a'.repeat(64) + '_0', 'b'.repeat(64) + '_0'], rebuildState: async (id: string) => { if (id[0] === 'a') throw new Error('x'); rebuilt.push(id[0]) } } })
    await m.runOnce()
    expect(rebuilt).toEqual(['b'])
  })
})
