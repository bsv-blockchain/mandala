import { describe, it, expect } from 'vitest'
import {
  Hash, PrivateKey, PublicKey, ProtoWallet, Utils
} from '@bsv/sdk'
import {
  addBlind, blindedSharedSecret, changeCustomInstructions, childOffset,
  invoiceNumber, outputPublicKey, prepareBlindedPayment,
  recipientCustomInstructions, sampleBlindingFactor
} from './blinding.js'
import { configureMandala, FT_PROTOCOL } from './constants.js'

describe('sender identity blinding (A′ = A + rG)', () => {
  it('opens: A′ − rG equals A', () => {
    const a = PrivateKey.fromRandom()
    const A = a.toPublicKey()
    const r = sampleBlindingFactor()
    const Aprime = addBlind(A, r)
    const opened = PublicKey.fromString(Aprime).add(r.toPublicKey().neg())
    expect(new PublicKey(opened.x, opened.y).toString()).toBe(A.toString())
  })

  it('ECDH with A′ equals (a+r)·B, not a·B', () => {
    const a = PrivateKey.fromRandom()
    const b = PrivateKey.fromRandom()
    const A = a.toPublicKey()
    const B = b.toPublicKey()
    const r = sampleBlindingFactor()
    const Aprime = PublicKey.fromString(addBlind(A, r))
    const S = a.deriveSharedSecret(B)
    const Sprime = blindedSharedSecret(S, r, B)
    const fromBob = b.deriveSharedSecret(Aprime)
    const fromAliceBlind = new PrivateKey(a.add(r)).deriveSharedSecret(B)
    expect(Sprime.toString()).toBe(fromBob.toString())
    expect(Sprime.toString()).toBe(fromAliceBlind.toString())
    expect(Sprime.toString()).not.toBe(S.toString())
  })

  it('recipient deriving against A′ recovers the blinded output key', async () => {
    const a = PrivateKey.fromRandom()
    const b = PrivateKey.fromRandom()
    const sender = new ProtoWallet(a)
    const recipient = new ProtoWallet(b)
    const r = sampleBlindingFactor()
    const A = (await sender.getPublicKey({ identityKey: true })).publicKey
    const B = (await recipient.getPublicKey({ identityKey: true })).publicKey
    const Aprime = addBlind(PublicKey.fromString(A), r)
    const keyID = 'xfer-test'
    const S = a.deriveSharedSecret(PublicKey.fromString(B))
    const Sprime = blindedSharedSecret(S, r, PublicKey.fromString(B))
    const k = childOffset(Sprime, FT_PROTOCOL, keyID)
    const Pout = outputPublicKey(PublicKey.fromString(B), k)

    const { publicKey: fromBob } = await recipient.getPublicKey({
      protocolID: FT_PROTOCOL,
      keyID,
      counterparty: Aprime,
      forSelf: true
    })
    expect(fromBob).toBe(Pout.toString())

    // Unblinded derivation against A must NOT match.
    const { publicKey: unblinded } = await recipient.getPublicKey({
      protocolID: FT_PROTOCOL,
      keyID,
      counterparty: A,
      forSelf: true
    })
    expect(unblinded).not.toBe(Pout.toString())
  })

  it('invoiceNumber matches BRC-43', () => {
    expect(invoiceNumber(FT_PROTOCOL, 'k1')).toBe('2-mandala token-k1')
  })

  it('sampleBlindingFactor is a 32-byte scalar', () => {
    const r = sampleBlindingFactor()
    expect(r.toHex().length).toBe(64)
  })

  it('prepareBlindedPayment locks to the key Bob derives from A′', async () => {
    const a = PrivateKey.fromRandom()
    const b = PrivateKey.fromRandom()
    const overlay = PrivateKey.fromRandom()
    configureMandala({ overlayIdentityKey: overlay.toPublicKey().toString() })
    const sender = new ProtoWallet(a)
    const recipient = new ProtoWallet(b)
    const identityKey = (await sender.getPublicKey({ identityKey: true })).publicKey
    const recipientKey = (await recipient.getPublicKey({ identityKey: true })).publicKey
    const prepared = await prepareBlindedPayment(sender as any, {
      identityKey,
      recipientKey,
      keyID: 'xfer-prep'
    })
    const { publicKey: fromBob } = await recipient.getPublicKey({
      protocolID: FT_PROTOCOL,
      keyID: 'xfer-prep',
      counterparty: prepared.senderBlinded,
      forSelf: true
    })
    expect(Hash.hash160(Utils.toArray(fromBob, 'hex'))).toEqual(prepared.pubKeyHash)
    expect(prepared.linkage.counterparty).toBe(recipientKey)
    expect(prepared.r).toHaveLength(64)
  })

  it('does not put r on the recipient output CI', () => {
    const rec = JSON.parse(recipientCustomInstructions({
      keyID: 'k', recipientKey: '02aa', senderBlinded: '02bb'
    }))
    const ch = JSON.parse(changeCustomInstructions({
      keyID: 'c', identityKey: '02aa', recipientKey: '03cc',
      sentAmount: 5, r: 'dd'.repeat(32), senderBlinded: '02bb'
    }))
    expect(rec.blindingR).toBeUndefined()
    expect(ch.blindingR).toBe('dd'.repeat(32))
  })
})

describe('HMAC offset is 32 bytes', () => {
  it('childOffset length', () => {
    const S = PrivateKey.fromRandom().toPublicKey()
    const k = childOffset(S, FT_PROTOCOL, 'abc')
    expect(k.length).toBe(32)
    expect(Hash.sha256hmac).toBeTypeOf('function')
    expect(Utils.toHex(k).length).toBe(64)
  })
})
