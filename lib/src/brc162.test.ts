/// <reference types="vite/client" />
/**
 * BRC-162 1Color codec boundary, the Mandala deploy `req` and fixture F-REQ (C§4, C§8.1).
 */
import { describe, it, expect } from 'vitest'
import { Hash, PrivateKey, ProtoWallet, PublicKey, Utils, WalletInterface } from '@bsv/sdk'
import { OneColor, encodeStrictCbor, readOneColorAttributes } from '@bsv/templates'
import fRaw from './__fixtures__/1color-deploy.json?raw'
import { MAX_UINT64 } from './amount.js'
import { ADMIN_PROTOCOL, MANDALA_PROFILE_ID } from './constants.js'
const ATTESTED_PROFILE_ID = 'https://brc.dev/207/attested'
import {
  authorityKeyIdOf, commitmentPayload, decodeToken, deployPayload, lockIssuerToken, mandalaReq,
  parseDeployPayload, readDeploy
} from './brc162.js'

const F = JSON.parse(fRaw) as { identityKey: string, sym: string, dec: number, label: string, reqHex: string, payloadHex: string, lockingScriptHex: string }
const TXID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f'
const ID = `${'ab'.repeat(32)}_0`
const PKH = new Array(20).fill(7)
const K_PKH = Hash.hash160(Utils.toArray(F.identityKey, 'hex'))
const OK = { sym: 'TUSD', dec: 2, label: 'Test Dollar', identityKey: F.identityKey }
const K2 = PrivateKey.fromRandom().toPublicKey().toString()

const deployScript = (payload: number[]): string => new OneColor().lock(null, 0n, K_PKH, payload).toHex()

describe('F-REQ fixture (C§4)', () => {
  it('mandalaReq(K) encodes to the pinned 181-byte req value (B7: issuer-v1 only)', () => {
    const req = encodeStrictCbor(mandalaReq(F.identityKey))
    expect(req.length).toBe(181)
    expect(Utils.toHex(req)).toBe(F.reqHex)
  })

  it('mandalaReq is exactly the issuer-v1 profile (B7: no attested companion)', () => {
    expect(mandalaReq(F.identityKey)).toEqual({
      [MANDALA_PROFILE_ID]: { version: 1, params: { identityKey: F.identityKey } }
    })
  })

  it('deployPayload reproduces the pinned 218-byte payload', () => {
    const p = deployPayload(OK)
    expect(p.length).toBe(218)
    expect(Utils.toHex(p)).toBe(F.payloadHex)
  })

  it('OneColor deploy lock reproduces the pinned locking script', () => {
    expect(new OneColor().lock(null, 0n, K_PKH, Utils.toArray(F.payloadHex, 'hex')).toHex()).toBe(F.lockingScriptHex)
  })

  it('readDeploy reads the fixture as a Mandala deploy for K', () => {
    expect(readDeploy(F.lockingScriptHex, TXID)).toEqual({ assetId: `${TXID}_0`, sym: 'TUSD', dec: 2, label: 'Test Dollar', mandalaKey: F.identityKey })
  })
})

describe('readDeploy', () => {
  it('a req that still names the attested profile is not Mandala (B7)', () => {
    const req = { ...mandalaReq(F.identityKey), [ATTESTED_PROFILE_ID]: { version: 1, params: { trustMode: 'identity', identityKey: F.identityKey } } }
    const payload = encodeStrictCbor({ dec: 2n, req, sym: 'TUSD', label: 'Test Dollar' })
    expect(readDeploy(deployScript(payload), TXID)).toEqual({ assetId: `${TXID}_0`, sym: 'TUSD', dec: 2, label: 'Test Dollar' })
  })

  it('a req for another key K2 names K2', () => {
    const payload = encodeStrictCbor({ dec: 2n, req: mandalaReq(K2), sym: 'TUSD', label: 'Test Dollar' })
    expect(readDeploy(deployScript(payload), TXID)?.mandalaKey).toBe(K2)
  })

  it('an extra third profile is not Mandala', () => {
    const req = { ...mandalaReq(F.identityKey), 'https://example.com/extra': { version: 1, params: null } }
    const payload = encodeStrictCbor({ dec: 2n, req, sym: 'TUSD', label: 'Test Dollar' })
    expect(readDeploy(deployScript(payload), TXID)?.mandalaKey).toBeUndefined()
  })

  it('a deploy with no req is not Mandala', () => {
    const payload = encodeStrictCbor({ dec: 2n, sym: 'TUSD', label: 'Test Dollar' })
    expect(readDeploy(deployScript(payload), TXID)).toEqual({ assetId: `${TXID}_0`, sym: 'TUSD', dec: 2, label: 'Test Dollar' })
  })

  it('an opaque payload gives dec 0 and no display fields', () => {
    expect(readDeploy(deployScript([1, 2]), TXID)).toEqual({ assetId: `${TXID}_0`, dec: 0 })
  })

  it('a deploy with no payload gives dec 0', () => {
    expect(readDeploy(new OneColor().lock(null, 0n, K_PKH).toHex(), TXID)).toEqual({ assetId: `${TXID}_0`, dec: 0 })
  })

  it('a malformed dec reads as dec 0 (display fields are independent, 0162:221)', () => {
    const payload = encodeStrictCbor({ dec: 19n, sym: 'TUSD', label: 'Test Dollar' })
    expect(readDeploy(deployScript(payload), TXID)).toEqual({ assetId: `${TXID}_0`, sym: 'TUSD', dec: 0, label: 'Test Dollar' })
  })

  it('a float64 version in the issuer descriptor is not Mandala (exact wire bytes, plan 01 RF2)', () => {
    const floatHex = F.payloadHex.replace(/6776657273696f6e01(?![\s\S]*6776657273696f6e01)/, '6776657273696f6e' + 'fb3ff0000000000000')
    expect(floatHex).not.toBe(F.payloadHex)
    const floatScript = new OneColor().lock(null, 0n, K_PKH, Utils.toArray(floatHex, 'hex'))
    expect(readOneColorAttributes(Utils.toArray(floatHex, 'hex')).payload).toBe('map')
    expect(readDeploy(floatScript, TXID)?.mandalaKey).toBeUndefined()
  })

  it('returns null for a value or authority output, a non-token and a non-P2PKH remainder', () => {
    expect(readDeploy(new OneColor().lock(ID, 5n, PKH).toHex(), TXID)).toBeNull()
    expect(readDeploy(new OneColor().lock(ID, 0n, PKH, commitmentPayload([1])).toHex(), TXID)).toBeNull()
    expect(readDeploy('00', TXID)).toBeNull()
    expect(readDeploy(F.lockingScriptHex.replace(/76a914.*$/, '51'), TXID)).toBeNull()
  })
})

describe('decodeToken', () => {
  it('reads MAX_UINT64 exactly (was null under 2^53)', () => {
    const max = new OneColor().lock(ID, MAX_UINT64, PKH).toHex()
    expect(decodeToken(max)).toEqual({ role: 'value', assetId: ID, amount: MAX_UINT64 })
  })

  it('returns null for a non-P2PKH remainder, a non-token and a malformed token', () => {
    expect(decodeToken(new OneColor().lock(ID, 5n, PKH).toHex().replace(/76a914.*$/, '51'))).toBeNull()
    expect(decodeToken('00')).toBeNull()
    expect(decodeToken('zz')).toBeNull()
  })

  it('names a deploy by its txid and vout when given', () => {
    expect(decodeToken(F.lockingScriptHex, TXID)).toEqual({ role: 'deploy', assetId: `${TXID}_0`, amount: 0n, payload: Utils.toArray(F.payloadHex, 'hex') })
    expect(decodeToken(F.lockingScriptHex, TXID, 3)?.assetId).toBe(`${TXID}_3`)
    expect(decodeToken(F.lockingScriptHex)?.assetId).toBeUndefined()
  })

  it('reads an authority output', () => {
    const d = decodeToken(new OneColor().lock(ID, 0n, PKH, commitmentPayload([1])).toHex())
    expect(d?.role).toBe('authority')
    expect(d?.amount).toBe(0n)
    expect(authorityKeyIdOf(new OneColor().lock(ID, 0n, PKH, commitmentPayload([1])))).toBe(Utils.toHex(Hash.sha256([1])))
    expect(authorityKeyIdOf(F.lockingScriptHex)).toBe('deploy')
    expect(authorityKeyIdOf(new OneColor().lock(ID, 5n, PKH))).toBeNull()
  })
})

describe('deployPayload / parseDeployPayload', () => {
  it('rejects out-of-range or malformed metadata with TypeError', () => {
    for (const bad of [
      { dec: 19 }, { dec: -1 }, { dec: 1.5 }, { sym: '' }, { sym: 'x'.repeat(33) }, { label: '' }, { label: 'x'.repeat(65) },
      { identityKey: F.identityKey.toUpperCase() }, { identityKey: '' }, { identityKey: '02' + 'ff'.repeat(32) },
      { icon: { mediaType: '', bytes: [1] } }
    ]) expect(() => deployPayload({ ...OK, ...bad } as any)).toThrow(TypeError)
  })

  it('counts sym and label in code points', () => {
    expect(() => deployPayload({ ...OK, sym: '\u{1F600}'.repeat(32) })).not.toThrow()
    expect(() => deployPayload({ ...OK, label: '\u{1F600}'.repeat(64) })).not.toThrow()
    expect(() => deployPayload({ ...OK, label: '\u{1F600}'.repeat(65) })).toThrow(TypeError)
  })

  it('round-trips icon and feeRatePerKb', () => {
    const p = deployPayload({ ...OK, icon: { mediaType: 'image/png', bytes: [0x89, 0x50] }, feeRatePerKb: 10 })
    expect(parseDeployPayload(p)).toEqual({ sym: 'TUSD', dec: 2, label: 'Test Dollar', feeRatePerKb: 10, icon: { mediaType: 'image/png', bytes: [0x89, 0x50] } })
    expect(readDeploy(deployScript(p), TXID)?.mandalaKey).toBe(F.identityKey)
  })

  it('parses the fixture payload and refuses junk', () => {
    expect(parseDeployPayload(Utils.toArray(F.payloadHex, 'hex'))).toEqual({ sym: 'TUSD', dec: 2, label: 'Test Dollar' })
    expect(parseDeployPayload(undefined)).toBeNull()
    expect(parseDeployPayload([1, 2])).toBeNull()
  })
})

describe('lockIssuerToken', () => {
  it('locks under ADMIN_PROTOCOL to the derived key with a bigint amount', async () => {
    const priv = PrivateKey.fromRandom()
    const wallet = new ProtoWallet(priv) as unknown as WalletInterface
    const self = priv.toPublicKey().toString()
    const script = await lockIssuerToken(wallet, ID, MAX_UINT64, 'k1', self)
    const { publicKey } = await wallet.getPublicKey({ protocolID: ADMIN_PROTOCOL, keyID: 'k1', counterparty: self })
    expect(script.toHex()).toBe(new OneColor().lock(ID, MAX_UINT64, PublicKey.fromString(publicKey).toHash() as number[]).toHex())
    expect(decodeToken(script)).toEqual({ role: 'value', assetId: ID, amount: MAX_UINT64 })
  })

  it('refuses an amount outside 0..2^64-1 before deriving a key', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface
    await expect(lockIssuerToken(wallet, ID, MAX_UINT64 + 1n, 'k1', 'self')).rejects.toThrow(RangeError)
    await expect(lockIssuerToken(wallet, ID, -1n, 'k1', 'self')).rejects.toThrow(RangeError)
  })
})
