import { describe, it, expect } from 'vitest'
import { holderLines } from './holderLines'

const MAX = 2n ** 64n - 1n

describe('holderLines', () => {
  it('holderLines keeps unsettled inside the balance and incoming outside it', () => {
    expect(holderLines({ balance: 10n, unsettled: 4n, incoming: 3n }, 0)).toEqual({ hero: '10', unsettled: 'of which awaiting settlement: 4', incoming: 'Incoming: 3' })
    expect(holderLines({ balance: 10n, unsettled: 0n, incoming: 0n }, 0)).toEqual({ hero: '10', unsettled: null, incoming: null })
    expect(holderLines({ balance: null, unsettled: 0n, incoming: 2n }, 0)).toEqual({ hero: '—', unsettled: null, incoming: 'Incoming: 2' })
  })

  it('holderLines hides unsettled when the balance view failed', () => {
    expect(holderLines({ balance: null, unsettled: 4n, incoming: 0n }, 0)).toEqual({ hero: '—', unsettled: null, incoming: null })
  })

  it('holderLines formats exact uint64 figures at dec 18 without summing them', () => {
    expect(holderLines({ balance: MAX, unsettled: MAX, incoming: MAX }, 18)).toEqual({
      hero: '18.446744073709551615',
      unsettled: 'of which awaiting settlement: 18.446744073709551615',
      incoming: 'Incoming: 18.446744073709551615'
    })
    expect(holderLines({ balance: 1234567n, unsettled: 0n, incoming: 0n }, 2).hero).toBe('12,345.67')
  })
})
