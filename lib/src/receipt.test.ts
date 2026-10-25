/**
 * Recipient key normalisation (checkRecipient, recipientLinkage) and the
 * single "may this have committed" check (mayHaveCommitted).
 */
import { describe, it, expect } from 'vitest'
import { PrivateKey, ProtoWallet, WalletInterface } from '@bsv/sdk'
import { checkRecipient, ReceiptUnavailableError } from './receipt.js'
import { recipientLinkage } from './linkage.js'
import { isOutcomeUnknown, mayHaveCommitted, OverlayRefusedError } from './overlay.js'

const A = new ProtoWallet(PrivateKey.fromString('11'.repeat(32)))
const key = (n: number): string => PrivateKey.fromString(n.toString(16).padStart(64, '0')).toPublicKey().toString()
const OVERLAY = key(7)
const mb = { sendMessage: async () => ({}) }

describe('checkRecipient', () => {
  it('accepts uppercase hex and returns the lowercase key', async () => {
    const issuer = (await A.getPublicKey({ identityKey: true })).publicKey
    const bob = key(5)
    expect(checkRecipient({ identityKey: issuer, recipientKey: bob.toUpperCase(), messageBoxClient: mb })).toBe(bob)
    expect(checkRecipient({ identityKey: issuer, recipientKey: bob, messageBoxClient: mb })).toBe(bob)
  })

  it('rejects an uppercase form of the issuer key as a self payout', async () => {
    const issuer = (await A.getPublicKey({ identityKey: true })).publicKey
    expect(() => checkRecipient({ identityKey: issuer, recipientKey: issuer.toUpperCase(), messageBoxClient: mb })).toThrow(/other than the issuer/)
  })

  it.each([
    ['too short', '02' + 'ab'.repeat(31)],
    ['bad prefix', '04' + 'ab'.repeat(32)],
    ['not hex', '02' + 'zz'.repeat(32)],
    ['not on the curve', '02' + '00'.repeat(32)],
    ['not a string', 42 as unknown as string]
  ])('rejects a recipient key that is %s', (_n, bad) => {
    expect(() => checkRecipient({ identityKey: key(1), recipientKey: bad, messageBoxClient: mb })).toThrow(/recipientKey must be|not a point/)
    expect(() => checkRecipient({ identityKey: key(1), recipientKey: bad, messageBoxClient: mb })).toThrow(TypeError)
  })
})

describe('recipientLinkage with an uppercase recipient key', () => {
  it('derives the same output and linkage as the lowercase key', async () => {
    const identityKey = (await A.getPublicKey({ identityKey: true })).publicKey
    const bob = key(5)
    const args = {
      identityKey, assetId: 'a'.repeat(64) + '_0', derivationPrefix: 'cHJlZml4', derivationSuffix: 'c3VmZml4',
      overlayIdentityKey: OVERLAY, blind: false
    }
    const lower = await recipientLinkage(A as unknown as WalletInterface, { ...args, recipientKey: bob })
    const upper = await recipientLinkage(A as unknown as WalletInterface, { ...args, recipientKey: bob.toUpperCase() })
    expect(upper.pubKeyHash).toEqual(lower.pubKeyHash)
    expect(upper.senderIdentityKey).toBe(lower.senderIdentityKey)
    expect(upper.linkage.counterparty).toBe(bob)
  })
})

describe('mayHaveCommitted', () => {
  it('is true for an unknown-outcome refusal and false for a proven refusal', () => {
    const unknown = new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', httpStatus: 503 })
    const refused = new OverlayRefusedError({ code: 'ERR_LINKAGE', httpStatus: 400 })
    expect(unknown.outcome).toBe('unknown')
    expect(mayHaveCommitted(unknown)).toBe(true)
    expect(refused.outcome).toBe('refused')
    expect(mayHaveCommitted(refused)).toBe(false)
  })

  it('is true for ReceiptUnavailableError, which isOutcomeUnknown misses', () => {
    const e = new ReceiptUnavailableError('f'.repeat(64), 0)
    expect(isOutcomeUnknown(e)).toBe(false)
    expect(mayHaveCommitted(e)).toBe(true)
  })

  it('is true for any error carrying committed === true, false for plain errors and non-errors', () => {
    expect(mayHaveCommitted(Object.assign(new Error('x'), { committed: true }))).toBe(true)
    expect(mayHaveCommitted(Object.assign(new Error('x'), { committed: false }))).toBe(false)
    expect(mayHaveCommitted(new Error('x'))).toBe(false)
    expect(mayHaveCommitted(undefined)).toBe(false)
    expect(mayHaveCommitted(null)).toBe(false)
    expect(mayHaveCommitted('committed')).toBe(false)
  })
})
