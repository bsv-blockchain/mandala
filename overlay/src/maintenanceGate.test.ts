import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { MaintenanceGate, gateSubmits } from './maintenanceGate.js'

const tick = () => new Promise(r => setImmediate(r))

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
  it('gateSubmits releases on finish and on close (client abort)', async () => {
    const g = new MaintenanceGate(); const mw = gateSubmits(g)
    for (const ev of ['finish', 'close']) {
      const res = new EventEmitter() as any; let nexted = false
      await new Promise<void>(r => mw({} as any, res, () => { nexted = true; r() }))
      expect(nexted).toBe(true); expect(g.busy).toBe(true)
      res.emit(ev); res.emit('close'); expect(g.busy).toBe(false)
    }
  })
  it('two concurrent exclusive calls serialize with writer preference', async () => {
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
})
