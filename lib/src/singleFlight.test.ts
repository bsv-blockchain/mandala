import { describe, it, expect, beforeEach } from 'vitest'
import { createSingleFlight, BusyError, sendFlight, registerFlight, registryFlight } from './singleFlight.js'

describe('createSingleFlight', () => {
  it('allows only one acquire at a time', () => {
    const f = createSingleFlight('test')
    expect(f.tryAcquire()).toBe(true)
    expect(f.isHeld()).toBe(true)
    expect(f.tryAcquire()).toBe(false)
    f.release()
    expect(f.isHeld()).toBe(false)
    expect(f.tryAcquire()).toBe(true)
    f.release()
  })

  it('run rejects a concurrent second call without starting its fn', async () => {
    const f = createSingleFlight('pipe')
    let started = 0
    let finished = 0
    const slow = f.run(async () => {
      started++
      await new Promise(r => setTimeout(r, 20))
      finished++
      return 'ok'
    })
    await expect(
      f.run(async () => {
        started++
        return 'nope'
      })
    ).rejects.toBeInstanceOf(BusyError)
    expect(await slow).toBe('ok')
    expect(started).toBe(1)
    expect(finished).toBe(1)
    expect(f.isHeld()).toBe(false)
  })

  it('releases after run failure so a later call can proceed', async () => {
    const f = createSingleFlight('retry')
    await expect(
      f.run(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(f.isHeld()).toBe(false)
    expect(await f.run(async () => 42)).toBe(42)
  })

  it('release is idempotent', () => {
    const f = createSingleFlight()
    f.tryAcquire()
    f.release()
    f.release()
    expect(f.tryAcquire()).toBe(true)
    f.release()
  })
})

describe('process-wide flights', () => {
  beforeEach(() => {
    // Ensure a prior failed test cannot leave the latch held.
    while (sendFlight.isHeld()) sendFlight.release()
    while (registerFlight.isHeld()) registerFlight.release()
    while (registryFlight.isHeld()) registryFlight.release()
  })

  it('sendFlight and registerFlight are independent', () => {
    expect(sendFlight.tryAcquire()).toBe(true)
    expect(registerFlight.tryAcquire()).toBe(true)
    sendFlight.release()
    registerFlight.release()
  })

  it('registryFlight is independent of registerFlight', () => {
    expect(registerFlight.tryAcquire()).toBe(true)
    expect(registryFlight.tryAcquire()).toBe(true)
    registerFlight.release()
    registryFlight.release()
  })
})
