import { describe, it, expect } from 'vitest'
import {
  Hash, PrivateKey, PublicKey, ProtoWallet, Utils
} from '@bsv/sdk'
import * as blinding from './blinding.js'
import {
  addBlind, blindedSharedSecret, childOffset,
  invoiceNumber, outputPublicKey, rootSharedSecret, sampleBlindingFactor
} from './blinding.js'
import { ADMIN_PROTOCOL } from './constants.js'

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
    const k = childOffset(Sprime, ADMIN_PROTOCOL, keyID)
    const Pout = outputPublicKey(PublicKey.fromString(B), k)

    const { publicKey: fromBob } = await recipient.getPublicKey({
      protocolID: ADMIN_PROTOCOL,
      keyID,
      counterparty: Aprime,
      forSelf: true
    })
    expect(fromBob).toBe(Pout.toString())

    // Unblinded derivation against A must NOT match.
    const { publicKey: unblinded } = await recipient.getPublicKey({
      protocolID: ADMIN_PROTOCOL,
      keyID,
      counterparty: A,
      forSelf: true
    })
    expect(unblinded).not.toBe(Pout.toString())
  })

  it('invoiceNumber matches BRC-43', () => {
    expect(invoiceNumber(ADMIN_PROTOCOL, 'k1')).toBe('2-mandala admin-k1')
  })

  it('sampleBlindingFactor is a 32-byte scalar', () => {
    const r = sampleBlindingFactor()
    expect(r.toHex().length).toBe(64)
  })

  it('rootSharedSecret equals a·B (ProtoWallet key deriver path)', async () => {
    const a = PrivateKey.fromRandom()
    const b = PrivateKey.fromRandom()
    const S = await rootSharedSecret(new ProtoWallet(a) as any, b.toPublicKey().toString())
    expect(S.toString()).toBe(a.deriveSharedSecret(b.toPublicKey()).toString())
  })

  it('the holder-side CI/payment builders are gone (recipientLinkage replaces them)', () => {
    for (const n of ['prepareBlindedPayment', 'recipientCustomInstructions', 'changeCustomInstructions']) {
      expect(n in blinding).toBe(false)
    }
  })
})

describe('HMAC offset is 32 bytes', () => {
  it('childOffset length', () => {
    const S = PrivateKey.fromRandom().toPublicKey()
    const k = childOffset(S, ADMIN_PROTOCOL, 'abc')
    expect(k.length).toBe(32)
    expect(Hash.sha256hmac).toBeTypeOf('function')
    expect(Utils.toHex(k).length).toBe(64)
  })
})
