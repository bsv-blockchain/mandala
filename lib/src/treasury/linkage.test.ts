import { describe, it, expect, vi, afterEach } from 'vitest'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { ADMIN_PROTOCOL, OVERLAY_IDENTITY_KEY_UNSET, configureMandala } from '../constants.js'
import { revealIssuerLinkage } from './linkage.js'
import { decodeEnvelope, encodeEnvelope } from '../encoding.js'

const K = new PrivateKey(5555).toPublicKey().toString()

describe('revealIssuerLinkage', () => {
  afterEach(() => { configureMandala({ overlayIdentityKey: '' }) })

  it('reveals the ADMIN_PROTOCOL linkage to the configured overlay key, in contract member order', async () => {
    configureMandala({ overlayIdentityKey: K })
    const wallet = new ProtoWallet(new PrivateKey(42))
    const { publicKey: me } = await wallet.getPublicKey({ identityKey: true })
    const l = await revealIssuerLinkage(wallet as any, 'tkn-1', me)
    expect(Object.keys(l)).toEqual([
      'prover', 'verifier', 'counterparty', 'protocolID', 'keyID', 'encryptedLinkage', 'encryptedLinkageProof', 'proofType'
    ])
    expect(l).toMatchObject({ prover: me, verifier: K, counterparty: me, protocolID: ADMIN_PROTOCOL, keyID: 'tkn-1', proofType: 0 })
    expect(Array.isArray(l.encryptedLinkage) && l.encryptedLinkage.length > 0).toBe(true)
    // It round-trips through the strict envelope codec.
    expect(decodeEnvelope(encodeEnvelope({ outputs: [{ index: 0, linkage: l }] }))).toEqual({ outputs: [{ index: 0, linkage: l }] })
  })

  it('an explicit verifier overrides the configured key', async () => {
    configureMandala({ overlayIdentityKey: K })
    const other = new PrivateKey(7).toPublicKey().toString()
    const wallet = new ProtoWallet(new PrivateKey(42))
    const l = await revealIssuerLinkage(wallet as any, 'tkn-1', 'self', other)
    expect(l.verifier).toBe(other)
  })

  it('throws OVERLAY_IDENTITY_KEY_UNSET before touching the wallet when the verifier is empty (S5)', async () => {
    configureMandala({ overlayIdentityKey: '' })
    const wallet = { revealSpecificKeyLinkage: vi.fn() }
    await expect(revealIssuerLinkage(wallet as any, 'tkn-1', 'self')).rejects.toThrow(OVERLAY_IDENTITY_KEY_UNSET)
    await expect(revealIssuerLinkage(wallet as any, 'tkn-1', 'self', '')).rejects.toThrow(OVERLAY_IDENTITY_KEY_UNSET)
    expect(wallet.revealSpecificKeyLinkage).not.toHaveBeenCalled()
  })

  it('refuses a revelation that is not a security-level-2 proofType-0 linkage', async () => {
    configureMandala({ overlayIdentityKey: K })
    const base = {
      prover: K, verifier: K, counterparty: K, protocolID: ADMIN_PROTOCOL, keyID: 'k',
      encryptedLinkage: [1], encryptedLinkageProof: [2], proofType: 0
    }
    for (const bad of [{ ...base, proofType: 1 }, { ...base, protocolID: [1, 'mandala admin'] }]) {
      const wallet = { revealSpecificKeyLinkage: vi.fn(async () => bad) }
      await expect(revealIssuerLinkage(wallet as any, 'k', 'self')).rejects.toThrow(TypeError)
    }
  })
})
