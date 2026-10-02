import { describe, expect, it, vi } from 'vitest'
import { createShutdown } from './shutdown.js'

describe('createShutdown', () => {
  it('closes once then exits 0, even when signalled twice', async () => {
    const close = vi.fn(async () => {}); const exit = vi.fn()
    const s = createShutdown({ close, exit, log: () => {}, deadlineMs: 25_000 })
    await Promise.all([s('SIGTERM'), s('SIGINT')])
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
  it('exits 1 when close throws', async () => {
    const exit = vi.fn()
    await createShutdown({ close: async () => { throw new Error('x') }, exit, log: () => {}, deadlineMs: 25_000 })('SIGTERM')
    expect(exit).toHaveBeenCalledWith(1)
  })
  it('arms a deadline that force-exits 1', async () => {
    let fire: () => void = () => {}
    const exit = vi.fn()
    const s = createShutdown({ close: () => new Promise(() => {}), exit, log: () => {}, deadlineMs: 5, setTimer: (fn) => { fire = fn; return {} } })
    void s('SIGTERM'); fire()
    expect(exit).toHaveBeenCalledWith(1)
  })
})
