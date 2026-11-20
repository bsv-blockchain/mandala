/**
 * Recipient linkage for `p color` outputs (C§5.1, C§8.1, B3, D20).
 *
 * Real ProtoWallets for the sender A, the recipient B and the overlay K: no
 * mocks. The overlay-equivalent check mirrors overlay-go linkage.go
 * VerifyKeyLinkage (base = counterparty): K decrypts L and recomputes
 * hash160(B + L·G).
 */
import { describe, it, expect, vi } from 'vitest'
import { Hash, PrivateKey, PublicKey, ProtoWallet, Utils, WalletInterface } from '@bsv/sdk'
import { recipientLinkage } from './linkage.js'
import { colorProtocolID } from './naming.js'
import { OVERLAY_IDENTITY_KEY_UNSET } from './constants.js'

const ID = `${'c7'.repeat(32)}_0`
const P = 'AAECAwQFBgcICQoLDA0ODw=='
const S = 'EBESExQVFhcYGRobHB0eHw=='

const aPriv = PrivateKey.fromRandom()
const bPriv = PrivateKey.fromRandom()
const kPriv = PrivateKey.fromRandom()
/** ProtoWallet implements every method recipientLinkage calls. */
const A = new ProtoWallet(aPriv) as unknown as WalletInterface
const B = new ProtoWallet(bPriv)
const K = new ProtoWallet(kPriv)
const a = aPriv.toPublicKey().toString()
const b = bPriv.toPublicKey().toString()
const k = kPriv.toPublicKey().toString()

const args = {
  identityKey: a,
  recipientKey: b,
  assetId: ID,
  derivationPrefix: P,
  derivationSuffix: S,
  overlayIdentityKey: k,
  blind: false
}

/** What the overlay does: decrypt L as K, then hash160(counterparty + L·G). */
async function overlayDerivedHash (linkage: Awaited<ReturnType<typeof recipientLinkage>>['linkage']): Promise<number[]> {
  const { plaintext: L } = await K.decrypt({
    ciphertext: linkage.encryptedLinkage,
    protocolID: [2, `specific linkage revelation 2 ${linkage.protocolID[1]}`],
    keyID: linkage.keyID,
    counterparty: linkage.prover
  })
  const { plaintext: proof } = await K.decrypt({
    ciphertext: linkage.encryptedLinkageProof,
    protocolID: [2, `specific linkage revelation 2 ${linkage.protocolID[1]}`],
    keyID: linkage.keyID,
    counterparty: linkage.prover
  })
  expect(proof).toEqual([0])
  const base = PublicKey.fromString(linkage.counterparty)
  return Hash.hash160(base.add(new PrivateKey(L).toPublicKey()).encode(true) as number[])
}

describe('recipientLinkage (unblinded)', () => {
  it('locks to the key B derives against A, and shows A', async () => {
    const res = await recipientLinkage(A, args)
    expect(res.senderIdentityKey).toBe(a)
    expect(res.r).toBeUndefined()
    const { publicKey } = await B.getPublicKey({ protocolID: colorProtocolID(ID, P, S), keyID: 'color', counterparty: a, forSelf: true })
    expect(res.pubKeyHash).toEqual(Hash.hash160(Utils.toArray(publicKey, 'hex')))
    expect(res.pubKeyHash).toHaveLength(20)
    expect(await overlayDerivedHash(res.linkage)).toEqual(res.pubKeyHash)
  })

  it('carries exactly the contract linkage members in contract order', async () => {
    const { linkage } = await recipientLinkage(A, args)
    expect(Object.keys(linkage)).toEqual([
      'prover', 'verifier', 'counterparty', 'protocolID', 'keyID', 'encryptedLinkage', 'encryptedLinkageProof', 'proofType'
    ])
    expect(linkage.prover).toBe(a)
    expect(linkage.verifier).toBe(k)
    expect(linkage.counterparty).toBe(b)
    expect(linkage.protocolID).toEqual(colorProtocolID(ID, P, S))
    expect(linkage.keyID).toBe('color')
    expect(linkage.proofType).toBe(0)
    expect(linkage.encryptedLinkage.length).toBeGreaterThan(0)
    expect(linkage.encryptedLinkageProof.length).toBeGreaterThan(0)
  })
})

describe('recipientLinkage (blinded, B3)', () => {
  it('shows A′, keeps prover = A, and the recipient derives with A′ (plain BRC-42)', async () => {
    const blind = await recipientLinkage(A, { ...args, blind: true })
    expect(blind.senderIdentityKey).not.toBe(a)
    expect(blind.linkage.prover).toBe(a)
    expect(blind.linkage.counterparty).toBe(b)
    expect(blind.r).toMatch(/^[0-9a-f]{64}$/)
    // A′ − r·G = A
    const opened = PublicKey.fromString(blind.senderIdentityKey).add(new PrivateKey(blind.r as string, 'hex').toPublicKey().neg())
    expect(new PublicKey(opened.x, opened.y).toString()).toBe(a)
    const own = await B.getPublicKey({ protocolID: colorProtocolID(ID, P, S), keyID: 'color', counterparty: blind.senderIdentityKey, forSelf: true })
    expect(blind.pubKeyHash).toEqual(Hash.hash160(Utils.toArray(own.publicKey, 'hex')))
    // overlay-equivalent (overlay-go linkage.go VerifyKeyLinkage, base = counterparty)
    expect(await overlayDerivedHash(blind.linkage)).toEqual(blind.pubKeyHash)
    expect(blind.linkage.keyID).toBe('color')
    expect(blind.linkage.protocolID[1].startsWith('p color ')).toBe(true)
    // r never rides on the linkage the overlay or the recipient sees
    expect(JSON.stringify(blind.linkage)).not.toContain(blind.r as string)
  })

  it('a fresh r per call: two blinded sends to B are unlinkable by sender key', async () => {
    const x = await recipientLinkage(A, { ...args, blind: true })
    const y = await recipientLinkage(A, { ...args, blind: true })
    expect(x.senderIdentityKey).not.toBe(y.senderIdentityKey)
    expect(x.pubKeyHash).not.toEqual(y.pubKeyHash)
  })
})

describe('recipientLinkage refusals (before any wallet call)', () => {
  function spyWallet (): { w: WalletInterface, calls: () => number } {
    const w = new ProtoWallet(aPriv)
    const spies = [
      vi.spyOn(w, 'encrypt'), vi.spyOn(w, 'getPublicKey'),
      vi.spyOn(w, 'revealCounterpartyKeyLinkage'), vi.spyOn(w, 'decrypt')
    ]
    const deriver = (w as any).keyDeriver
    const reveal = vi.spyOn(deriver, 'revealCounterpartySecret')
    return { w: w as unknown as WalletInterface, calls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0) + reveal.mock.calls.length }
  }

  it('refuses a send to self (self uses owned outputs)', async () => {
    const { w, calls } = spyWallet()
    await expect(recipientLinkage(w, { ...args, recipientKey: a })).rejects.toThrow(/self/)
    await expect(recipientLinkage(w, { ...args, recipientKey: a })).rejects.toBeInstanceOf(TypeError)
    expect(calls()).toBe(0)
  })

  it('fails closed without an overlay identity key (S5)', async () => {
    const { w, calls } = spyWallet()
    await expect(recipientLinkage(w, { ...args, overlayIdentityKey: '' })).rejects.toThrow(/overlay identity key/)
    await expect(recipientLinkage(w, { ...args, overlayIdentityKey: '' })).rejects.toThrow(OVERLAY_IDENTITY_KEY_UNSET)
    expect(calls()).toBe(0)
  })

  it('refuses remittance strings over 48 UTF-8 bytes or with whitespace', async () => {
    const { w, calls } = spyWallet()
    await expect(recipientLinkage(w, { ...args, derivationPrefix: 'a'.repeat(49) })).rejects.toThrow(/48/)
    await expect(recipientLinkage(w, { ...args, derivationSuffix: 'a b' })).rejects.toBeInstanceOf(TypeError)
    expect(calls()).toBe(0)
  })

  it.each([
    ['identityKey', '02' + 'zz'.repeat(32)],
    ['recipientKey', '02' + '00'.repeat(32)],
    ['recipientKey', '04' + b.slice(2)],
    ['overlayIdentityKey', k.slice(0, 64)],
    ['overlayIdentityKey', '02' + '00'.repeat(32)] // x = 0 is not on the curve
  ])('refuses an invalid %s with TypeError', async (field, value) => {
    const { w, calls } = spyWallet()
    await expect(recipientLinkage(w, { ...args, [field]: value })).rejects.toBeInstanceOf(TypeError)
    expect(calls()).toBe(0)
  })

  it('refuses an invalid asset id', async () => {
    await expect(recipientLinkage(A, { ...args, assetId: 'c7'.repeat(32) + '.0' })).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses an identityKey that is not the wallet identity (prover must be the real key)', async () => {
    await expect(recipientLinkage(A, { ...args, identityKey: k, recipientKey: b })).rejects.toThrow(/identity/)
  })

  it('refuses a non-boolean blind flag', async () => {
    await expect(recipientLinkage(A, { ...args, blind: 'yes' as unknown as boolean })).rejects.toBeInstanceOf(TypeError)
  })
})
