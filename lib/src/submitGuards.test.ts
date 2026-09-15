import { describe, it, expect } from 'vitest'
import {
  guardPositiveAmount,
  guardSendSubmit,
  guardIssueSubmit,
  guardRedeemSubmit,
  guardRegisterSubmit,
  guardAdminFields,
  guardIdentityKey,
  guardTokenRecipient
} from './submitGuards.js'

describe('guardPositiveAmount', () => {
  it('accepts positive integers', () => {
    expect(guardPositiveAmount(1).ok).toBe(true)
    expect(guardPositiveAmount(100).ok).toBe(true)
  })

  it('rejects non-positive, non-integer, NaN', () => {
    expect(guardPositiveAmount(0).ok).toBe(false)
    expect(guardPositiveAmount(-1).ok).toBe(false)
    expect(guardPositiveAmount(1.5).ok).toBe(false)
    expect(guardPositiveAmount(NaN).ok).toBe(false)
    expect(guardPositiveAmount(Infinity).ok).toBe(false)
  })
})

describe('guardSendSubmit', () => {
  const base = {
    assetId: 'asset.0',
    recipientKey: '02' + 'ab'.repeat(32),
    amount: 10,
    balance: 100,
    isPaused: false,
    walletReady: true
  }

  it('allows a valid send', () => {
    expect(guardSendSubmit(base).ok).toBe(true)
  })

  it('rejects empty asset, empty recipient, zero amount, over-balance', () => {
    expect(guardSendSubmit({ ...base, assetId: '' }).ok).toBe(false)
    expect(guardSendSubmit({ ...base, recipientKey: '' }).ok).toBe(false)
    expect(guardSendSubmit({ ...base, amount: 0 }).ok).toBe(false)
    expect(guardSendSubmit({ ...base, amount: 101 }).ok).toBe(false)
  })

  it('rejects send while paused unless pauseBypass (dev mode)', () => {
    expect(guardSendSubmit({ ...base, isPaused: true }).ok).toBe(false)
    expect(guardSendSubmit({ ...base, isPaused: true, pauseBypass: true }).ok).toBe(true)
  })

  it('rejects when wallet is not ready', () => {
    expect(guardSendSubmit({ ...base, walletReady: false }).ok).toBe(false)
  })
})

describe('guardIssueSubmit / guardRedeemSubmit', () => {
  it('issue requires asset and positive amount', () => {
    expect(guardIssueSubmit({ assetId: 'a.0', amount: 5, walletReady: true }).ok).toBe(true)
    expect(guardIssueSubmit({ assetId: '', amount: 5, walletReady: true }).ok).toBe(false)
    expect(guardIssueSubmit({ assetId: 'a.0', amount: 0, walletReady: true }).ok).toBe(false)
  })

  it('issue accepts a 64-hex deposit hash as bankRef and refuses anything else when one is given (A14)', () => {
    const base = { assetId: 'a.0', amount: 5, walletReady: true }
    expect(guardIssueSubmit({ ...base, bankRef: 'ab'.repeat(32) }).ok).toBe(true)
    expect(guardIssueSubmit({ ...base, bankRef: 'AB'.repeat(32) }).ok).toBe(true)
    // Optional: absent / empty / whitespace is fine when not mandatory.
    expect(guardIssueSubmit({ ...base, bankRef: '' }).ok).toBe(true)
    expect(guardIssueSubmit({ ...base, bankRef: '   ' }).ok).toBe(true)
    // Provided but not a sha256 digest — the raw bank reference must never go on-chain.
    expect(guardIssueSubmit({ ...base, bankRef: 'BR-2024-0001' }).ok).toBe(false)
    expect(guardIssueSubmit({ ...base, bankRef: 'ab'.repeat(31) }).ok).toBe(false)
    expect(guardIssueSubmit({ ...base, bankRef: 'zz'.repeat(32) }).ok).toBe(false)
    const r = guardIssueSubmit({ ...base, bankRef: 'BR-1' })
    expect(r.ok === false && r.reason).toMatch(/64|hex|sha256/i)
  })

  it('issue requires a bankRef when the deposit reference is configured as mandatory (A14)', () => {
    const base = { assetId: 'a.0', amount: 5, walletReady: true, requireBankRef: true }
    expect(guardIssueSubmit({ ...base }).ok).toBe(false)
    expect(guardIssueSubmit({ ...base, bankRef: '' }).ok).toBe(false)
    expect(guardIssueSubmit({ ...base, bankRef: 'ab'.repeat(32) }).ok).toBe(true)
  })

  it('redeem refuses amount above balance when balance is provided', () => {
    expect(
      guardRedeemSubmit({ assetId: 'a.0', amount: 50, balance: 40, walletReady: true }).ok
    ).toBe(false)
    expect(
      guardRedeemSubmit({ assetId: 'a.0', amount: 40, balance: 40, walletReady: true }).ok
    ).toBe(true)
  })
})

describe('guardRegisterSubmit', () => {
  it('requires label and non-negative integer decimals', () => {
    expect(
      guardRegisterSubmit({ label: 'Gold', ticker: 'GLD', decimals: 2, walletReady: true }).ok
    ).toBe(true)
    expect(
      guardRegisterSubmit({ label: '  ', ticker: 'GLD', decimals: 0, walletReady: true }).ok
    ).toBe(false)
    expect(
      guardRegisterSubmit({ label: 'X', ticker: '', decimals: -1, walletReady: true }).ok
    ).toBe(false)
    expect(
      guardRegisterSubmit({ label: 'X', ticker: '', decimals: 1.5, walletReady: true }).ok
    ).toBe(false)
  })
})

describe('guardAdminFields', () => {
  it('rejects empty required outpoint / identity / recipient', () => {
    expect(guardAdminFields({ requireOutpoint: true, outpoint: '' }).ok).toBe(false)
    expect(guardAdminFields({ requireOutpoint: true, outpoint: '  ' }).ok).toBe(false)
    expect(guardAdminFields({ requireIdentity: true, identityKey: '' }).ok).toBe(false)
    expect(guardAdminFields({ requireRecipient: true, recipient: '' }).ok).toBe(false)
  })

  it('accepts filled required fields', () => {
    expect(
      guardAdminFields({
        requireOutpoint: true,
        outpoint: 'txid.0',
        requireRecipient: true,
        recipient: '02abc'
      }).ok
    ).toBe(true)
  })

  it('validates identity keys as compressed pubkeys when required', () => {
    expect(guardAdminFields({ requireIdentity: true, identityKey: '02abc' }).ok).toBe(false)
    expect(
      guardAdminFields({ requireIdentity: true, identityKey: '02' + 'ab'.repeat(32) }).ok
    ).toBe(true)
  })
})

describe('guardIdentityKey', () => {
  it('accepts compressed 02/03 keys and rejects empty, uncompressed, odd length', () => {
    expect(guardIdentityKey('02' + 'ab'.repeat(32)).ok).toBe(true)
    expect(guardIdentityKey('03' + 'cd'.repeat(32)).ok).toBe(true)
    expect(guardIdentityKey('').ok).toBe(false)
    expect(guardIdentityKey('04' + 'ab'.repeat(64)).ok).toBe(false)
    expect(guardIdentityKey('02' + 'ab'.repeat(31)).ok).toBe(false)
    expect(guardIdentityKey('zz' + 'ab'.repeat(32)).ok).toBe(false)
  })
})

describe('guardTokenRecipient (D4 — address rail refusal is a protocol fact)', () => {
  it('accepts a compressed identity key (no reason)', () => {
    expect(guardTokenRecipient('02' + 'ab'.repeat(32))).toBeNull()
    expect(guardTokenRecipient('03' + 'CD'.repeat(32))).toBeNull()
    expect(guardTokenRecipient('  03' + 'cd'.repeat(32) + '  ')).toBeNull()
  })

  it('returns a plain reason string for anything that is not an identity key', () => {
    // A bare P2PKH address cannot receive a Mandala token: the output key is
    // ECDH-derived against the recipient identity key and the overlay refuses
    // any FT output whose owner it cannot name from a linkage.
    const addr = guardTokenRecipient('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
    expect(typeof addr).toBe('string')
    expect(addr).toMatch(/identity key/i)
    expect(addr).toMatch(/address/i)
    expect(typeof guardTokenRecipient('04' + 'ab'.repeat(64))).toBe('string')
    expect(typeof guardTokenRecipient('02' + 'ab'.repeat(31))).toBe('string')
    expect(typeof guardTokenRecipient('')).toBe('string')
    expect(typeof guardTokenRecipient('   ')).toBe('string')
  })
})
