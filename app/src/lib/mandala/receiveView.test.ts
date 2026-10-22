import { describe, it, expect } from 'vitest'
import { describeAccepted, describeFailed } from './receiveView'

const ID = 'ab'.repeat(32) + '.0'

describe('Receive view', () => {
  it('formats exact amounts with the asset label', () => {
    expect(describeAccepted({ messageId: 'm1', assetId: ID, amount: 123456n, offline: false }, { [ID]: { label: 'Test Dollar', decimals: 2 } }))
      .toEqual({ key: 'm1', label: 'Test Dollar', amountText: '+1,234.56', title: 'Tokens received', pending: false })
  })

  it('marks offline credits as awaiting settlement (counted in the balance, unsettled)', () => {
    expect(describeAccepted({ messageId: 'm2', assetId: ID, amount: 1n, offline: true }, {}))
      .toMatchObject({ label: ID.slice(0, 10) + '…', amountText: '+1', title: 'Tokens received — awaiting settlement', pending: true })
  })

  it('shows MAX_UINT64 exactly at dec 18', () => {
    expect(describeAccepted({ messageId: 'm3', assetId: ID, amount: 18446744073709551615n, offline: false }, { [ID]: { label: 'Max', decimals: 18 } }).amountText)
      .toBe('+18.446744073709551615')
  })

  it('an out-of-range dec never throws: it displays as 0 like loadHolderData', () => {
    expect(describeAccepted({ messageId: 'm4', assetId: ID, amount: 1000n, offline: false }, { [ID]: { label: 'Bad', decimals: 19 } }).amountText)
      .toBe('+1,000')
  })

  it('failure text carries the overlay code', () => {
    expect(describeFailed({ error: new Error('frozen'), code: 'ERR_FROZEN' })).toBe('frozen (ERR_FROZEN)')
    expect(describeFailed({ error: 'x' })).toBe('Unexpected error')
  })

  it('does not repeat a code the message already carries', () => {
    expect(describeFailed({ error: new Error('[ColorError] bad (ERR_SHAPE)'), code: 'ERR_SHAPE' })).toBe('[ColorError] bad (ERR_SHAPE)')
    expect(describeFailed({ error: 'x', code: 'ERR_BODY_UNREADABLE' })).toBe('Unexpected error (ERR_BODY_UNREADABLE)')
  })
})
