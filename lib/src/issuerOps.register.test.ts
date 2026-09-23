import { describe, it, expect } from 'vitest'
import { registerDetails } from './issuerOps.js'

const ISSUER = '02' + 'ab'.repeat(32)
const base = { label: ' Gold ', ticker: 'gld', decimals: 2, identityKey: ISSUER }

describe('registerDetails', () => {
  it('folds feeRatePerKb into both the commitment details and the on-chain metadata', () => {
    const { metadata, regDetails } = registerDetails({ ...base, feeRatePerKb: 7 })
    expect(metadata).toEqual({ label: 'Gold', ticker: 'GLD', decimals: 2, issuer: ISSUER, feeRatePerKb: 7 })
    expect(regDetails).toEqual({ kind: 'register', ...metadata })
  })

  it('omits the field entirely when not given (fees disabled, no key in the commitment)', () => {
    const { metadata, regDetails } = registerDetails(base)
    expect('feeRatePerKb' in metadata).toBe(false)
    expect('feeRatePerKb' in regDetails).toBe(false)
  })

  it('never carries an assetId (P0: a genesis names no asset)', () => {
    expect('assetId' in registerDetails(base).regDetails).toBe(false)
  })

  it('rejects an invalid rate', () => {
    expect(() => registerDetails({ ...base, feeRatePerKb: 0 })).toThrow('safe integer')
    expect(() => registerDetails({ ...base, feeRatePerKb: 1.5 })).toThrow('safe integer')
  })
})
