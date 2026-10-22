import { describe, it, expect } from 'vitest'
import { Hash, PrivateKey, ProtoWallet, PublicKey, Utils } from '@bsv/sdk'
import {
  ATTESTATION_KEY_ID,
  ATTESTATION_PROTOCOL_ID,
  attestationFromSteak,
  attestationMessage,
  signAttestation,
  verifyAttestation
} from './attestation.js'

// BRC-207 Appendix C.0 (0207:10214-10264). Public test key 5555: never fund it.
const ID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0'
const ID_TXID = ID.slice(0, 64)
const TX = '05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931'
const SIGNER = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const LOW = '3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a'
const HIGH = '3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7'
const MESSAGE = `1color-admit:v1:tm_color_${ID}:${TX}:0,2`
const PRIV = new PrivateKey(5555)
const OTHER = new PrivateKey(7777).toPublicKey().toString()

const utf8 = (s: string): number[] => Utils.toArray(s, 'utf8')
const att = (signature: string, extra: Partial<{ txid: string, outputs: number[], signer: string }> = {}) =>
  ({ txid: TX, outputs: [0, 2], signer: SIGNER, signature, ...extra })

/** A C.0-shaped signature over arbitrary data / keyID, as a confused signer would mint it. */
async function signWith (data: number[], keyID: string): Promise<string> {
  const { signature } = await new ProtoWallet(PRIV).createSignature({
    data, protocolID: [2, 'color admission attestation'], keyID, counterparty: 'anyone'
  })
  return Utils.toHex(signature)
}

describe('attested admission statement (C§3, C.0 vectors)', () => {
  it('constants are the C§3 protocol tuple and key id', () => {
    expect(ATTESTATION_PROTOCOL_ID).toEqual([2, 'color admission attestation'])
    expect(ATTESTATION_KEY_ID).toBe('1')
  })

  it('message, digest, HMAC tweak and derived child match C.0', () => {
    expect(attestationMessage(ID, TX, [0, 2])).toBe(MESSAGE)
    expect(Utils.toHex(Hash.sha256(utf8(attestationMessage(ID, TX, [0, 2])))))
      .toBe('9f61b417ec979c3c057313fe56f3c6056d2962b6bceaaa8272377bb9a80d8f9d')
    expect(PublicKey.fromString(SIGNER).deriveChild(new PrivateKey(1), '2-color admission attestation-1').toString())
      .toBe('033520aaa77b6914019796e974d1737acc890c5283c0921ddcfc2d5c815db8fb90')
    expect(Utils.toHex(Hash.sha256hmac(
      PublicKey.fromString(SIGNER).deriveSharedSecret(new PrivateKey(1)).encode(true) as number[],
      utf8('2-color admission attestation-1')
    ))).toBe('6ef21748a4f6f5034842184e25f68e8df8663e036622ad9b3d061c6dd81ea93b')
    expect(PRIV.toPublicKey().toString()).toBe(SIGNER)
  })

  it('signAttestation reproduces the C.0 low-S signature (RFC 6979)', async () => {
    expect(await signAttestation(new ProtoWallet(PRIV), ID, TX, [0, 2])).toBe(LOW)
  })

  it('verifies both the low-S and the high-S encodings (Chronicle: never normalize S)', () => {
    expect(verifyAttestation(att(LOW), ID, SIGNER)).toBe(true)
    expect(verifyAttestation(att(HIGH), ID, SIGNER)).toBe(true)
  })

  it('C.0 negatives all fail', async () => {
    // reordered outputs, missing index 2
    expect(verifyAttestation(att(LOW, { outputs: [2, 0] }), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(LOW, { outputs: [0] }), ID, SIGNER)).toBe(false)
    // other topic (same deploy txid, other vout)
    expect(verifyAttestation(att(LOW), `${ID_TXID}_1`, SIGNER)).toBe(false)
    // keyID '2'
    const key2 = await signWith(utf8(MESSAGE), '2')
    expect(verifyAttestation(att(LOW), ID, SIGNER)).toBe(true)
    expect(verifyAttestation(att(key2), ID, SIGNER)).toBe(false)
    // trailing newline
    const nl = await signWith(utf8(MESSAGE + '\n'), '1')
    expect(verifyAttestation(att(nl), ID, SIGNER)).toBe(false)
    // the bare identity key (BRC-175 raw-key construction): PrivateKey.sign hashes once
    const bare = PRIV.sign(utf8(MESSAGE)).toDER('hex') as string
    expect(PRIV.toPublicKey().verify(utf8(MESSAGE), PRIV.sign(utf8(MESSAGE)))).toBe(true)
    expect(verifyAttestation(att(bare), ID, SIGNER)).toBe(false)
    // expected signer is another key
    expect(verifyAttestation(att(LOW), ID, OTHER)).toBe(false)
    // uppercase signer, uppercase signature hex
    expect(verifyAttestation(att(LOW, { signer: SIGNER.toUpperCase() }), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(LOW, { signer: SIGNER.toUpperCase() }), ID, SIGNER.toUpperCase())).toBe(false)
    expect(verifyAttestation(att(LOW.toUpperCase()), ID, SIGNER)).toBe(false)
  })

  it('rejects non-strict DER, duplicated outputs and other txids, never throwing', () => {
    // r with its sign bit set and no 0x00 pad (a negative DER INTEGER): Signature.fromDER
    // parses it, so only the strict round-trip catches it
    const unpadded = '30440220' + LOW.slice(10)
    expect(verifyAttestation(att(unpadded), ID, SIGNER)).toBe(false)
    // non-minimal: an extra leading zero on r
    expect(verifyAttestation(att('3046022200' + LOW.slice(8)), ID, SIGNER)).toBe(false)
    // trailing garbage after the DER sequence
    expect(verifyAttestation(att(LOW + '00'), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(LOW, { outputs: [0, 2, 2] }), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(LOW, { txid: 'a'.repeat(64) }), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(LOW, { txid: TX.toUpperCase() }), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(LOW), 'not-an-id', SIGNER)).toBe(false)
    expect(verifyAttestation(att('zz'), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(''), ID, SIGNER)).toBe(false)
    expect(verifyAttestation(att(LOW, { signer: '02' + '00'.repeat(32) }), ID, '02' + '00'.repeat(32))).toBe(false)
    expect(verifyAttestation(undefined as any, ID, SIGNER)).toBe(false)
    expect(verifyAttestation({ ...att(LOW), outputs: 'nope' } as any, ID, SIGNER)).toBe(false)
    expect(verifyAttestation({ ...att(LOW), signature: [1, 2] } as any, ID, SIGNER)).toBe(false)
  })

  it('attestationMessage throws TypeError on non-canonical input', () => {
    expect(() => attestationMessage(ID, TX, [2, 0])).toThrow(TypeError)
    expect(() => attestationMessage(ID, TX, [0, 0])).toThrow(TypeError)
    expect(() => attestationMessage(ID, TX, [])).toThrow(TypeError)
    expect(() => attestationMessage(ID, TX, [-1])).toThrow(TypeError)
    expect(() => attestationMessage(ID, TX, [1.5])).toThrow(TypeError)
    expect(() => attestationMessage(ID, TX, [4294967296])).toThrow(TypeError)
    expect(attestationMessage(ID, TX, [4294967295])).toBe(`1color-admit:v1:tm_color_${ID}:${TX}:4294967295`)
    expect(() => attestationMessage(ID, TX.toUpperCase(), [0])).toThrow(TypeError)
    expect(() => attestationMessage(ID.toUpperCase(), TX, [0])).toThrow(TypeError)
    expect(() => attestationMessage(`${ID_TXID}.0`, TX, [0])).toThrow(TypeError)
  })

  it('signAttestation refuses non-canonical input before touching the wallet', async () => {
    let called = false
    const wallet = { createSignature: async () => { called = true; return { signature: [] } } }
    await expect(signAttestation(wallet as any, ID, TX, [2, 0])).rejects.toThrow(TypeError)
    expect(called).toBe(false)
  })

  it('attestationFromSteak maps the tm_color_<assetId> STEAK entry (C§3 BRC-22 carrier)', () => {
    const entry = { outputsToAdmit: [0, 2], coinsToRetain: [], admissionSignature: LOW, admissionIdentityKey: SIGNER }
    expect(attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: entry }))
      .toEqual({ txid: TX, outputs: [0, 2], signer: SIGNER, signature: LOW })
    expect(attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: { outputsToAdmit: [0, 2], coinsToRetain: [] } })).toBeUndefined()
    // only the asset's own topic counts
    expect(attestationFromSteak(TX, ID, { [`tm_color_${ID_TXID}_1`]: entry, tm_mandala: entry })).toBeUndefined()
    // non-canonical or empty admitted set
    expect(attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: { ...entry, outputsToAdmit: [2, 0] } })).toBeUndefined()
    expect(attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: { ...entry, outputsToAdmit: [] } })).toBeUndefined()
    expect(attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: { ...entry, admissionSignature: 7 } })).toBeUndefined()
    // never throws on garbage
    expect(attestationFromSteak(TX, 'bad', { [`tm_color_${ID}`]: entry })).toBeUndefined()
    expect(attestationFromSteak(TX, ID, undefined as any)).toBeUndefined()
    // the mapped attestation verifies
    const a = attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: entry })
    expect(a != null && verifyAttestation(a, ID, SIGNER)).toBe(true)
    // a defensive copy: mutating the STEAK afterwards cannot change the attestation
    entry.outputsToAdmit.push(3)
    expect(a?.outputs).toEqual([0, 2])
  })
})
