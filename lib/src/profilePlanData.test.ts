/**
 * issuer-v1 plan-data checks and owner-linkage submission data (B1, C§5.1,
 * C§5.2, G9, G10).
 *
 * Real ProtoWallets: A is the sending wallet (ctx.wallet, ctx.identityKey),
 * B the recipient, K the Mandala overlay. Output 0 is B's blinded recipient
 * output from `recipientLinkage`; output 1 is A's own token change, locked to
 * `A.getPublicKey({ protocolID, keyID: 'color', counterparty: a, forSelf: true })`
 * as the module locks change. The overlay-equivalent check mirrors overlay-go
 * linkage.go VerifyKeyLinkage: K decrypts L and recomputes
 * hash160(counterparty + L·G).
 */
import { describe, it, expect } from 'vitest'
import {
  Hash, P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction, Utils, type WalletInterface
} from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import type { ProfileAssetContext, ProfileTxView, JsonValue } from '@bsv/color-permission-module'
import { checkPlanData, submissionData } from './profilePlanData.js'
import { createMandalaProfile, MANDALA_PROFILE_ID } from './profile.js'
import { recipientLinkage } from './linkage.js'
import { assetTag, colorProtocolID } from './naming.js'
import { decodeEnvelope } from './encoding.js'
import { outputPubKeyHash, outputPublicKey } from './blinding.js'

const TXID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f'
const ID = `${TXID}_0`
const OTHER_ID = `${'ab'.repeat(32)}_0`

const aPriv = new PrivateKey(1111)
const bPriv = new PrivateKey(2222)
const kPriv = new PrivateKey(5555)
const A = new ProtoWallet(aPriv)
const K = new ProtoWallet(kPriv)
const a = aPriv.toPublicKey().toString()
const b = bPriv.toPublicKey().toString()
const k = kPriv.toPublicKey().toString()

const R_PREFIX = 'AAECAwQFBgcICQoLDA0ODw=='
const R_SUFFIX = 'EBESExQVFhcYGRobHB0eHw=='
const C_PREFIX = 'ICEiIyQlJicoKSorLC0uLw=='
const C_SUFFIX = 'MDEyMzQ1Njc4OTo7PD0+Pw=='
const CHANGE_CUSTODY = { assetId: ID, derivationPrefix: C_PREFIX, derivationSuffix: C_SUFFIX, senderIdentityKey: a }

const ctx = {
  assetId: ID,
  profileId: MANDALA_PROFILE_ID,
  descriptor: { version: 1, params: { identityKey: k } },
  req: new Map(),
  declarationTx: new Transaction(),
  wallet: A as unknown as WalletInterface,
  identityKey: a,
  originator: 'app.example'
} as unknown as ProfileAssetContext

const recipient = await recipientLinkage(A as unknown as WalletInterface, {
  identityKey: a,
  recipientKey: b,
  assetId: ID,
  derivationPrefix: R_PREFIX,
  derivationSuffix: R_SUFFIX,
  overlayIdentityKey: k,
  blind: true
})
const changeProtocol = colorProtocolID(ID, C_PREFIX, C_SUFFIX)
const { publicKey: changeKey } = await A.getPublicKey({ protocolID: changeProtocol, keyID: 'color', counterparty: a, forSelf: true })
const CHANGE_PKH = Hash.hash160(Utils.toArray(changeKey, 'hex'))
const OTHER_PKH = Hash.hash160(Utils.toArray(new PrivateKey(3333).toPublicKey().toString(), 'hex'))

const LEAF = { outputs: [{ index: 0, linkage: recipient.linkage }] } as unknown as JsonValue

const tokenOut = (id: string, amount: bigint, pkh: number[], satoshis = 1): { lockingScript: any, satoshis: number } =>
  ({ lockingScript: new OneColor().lock(id, amount, pkh), satoshis })

/** A funding parent: output 0 is a 10-unit coin of ID (A's), output 1 is 1000 plain sats. */
function parent (tokenId = ID): Transaction {
  const p = new Transaction()
  p.addOutput(tokenOut(tokenId, 10n, CHANGE_PKH))
  p.addOutput({ lockingScript: new P2PKH().lock(OTHER_PKH), satoshis: 1000 })
  return p
}

interface TxOpts { out0Pkh?: number[], out0Sats?: number, extraOutput?: { lockingScript: any, satoshis: number }, extraInputParent?: Transaction }
function signTx (o: TxOpts = {}): Transaction {
  const tx = new Transaction()
  const p = parent()
  tx.addInput({ sourceTransaction: p, sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addInput({ sourceTransaction: p, sourceOutputIndex: 1, sequence: 0xffffffff })
  if (o.extraInputParent !== undefined) tx.addInput({ sourceTransaction: o.extraInputParent, sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addOutput(tokenOut(ID, 6n, o.out0Pkh ?? recipient.pubKeyHash, o.out0Sats ?? 1))
  tx.addOutput(tokenOut(ID, 4n, CHANGE_PKH))
  tx.addOutput({ lockingScript: new P2PKH().lock(OTHER_PKH), satoshis: 900 })
  if (o.extraOutput !== undefined) tx.addOutput(o.extraOutput)
  return tx
}

const baseView = (): ProfileTxView => ({
  assetId: ID,
  inputs: [{ inputIndex: 0, outpoint: `${'11'.repeat(32)}.0`, role: 'value', amount: 10n, custody: CHANGE_CUSTODY }],
  outputs: [
    { outputIndex: 0, role: 'value', amount: 6n },
    { outputIndex: 1, role: 'value', amount: 4n, custody: CHANGE_CUSTODY }
  ],
  planLeaf: LEAF
})
const viewAtCreate = baseView()
const viewAtSign: ProfileTxView = { ...baseView(), tx: signTx() }
const signView = (o: TxOpts): ProfileTxView => ({ ...baseView(), tx: signTx(o) })

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

function mutate (leaf: JsonValue, c: string): JsonValue | undefined {
  const l = clone(leaf) as any
  const lk = l.outputs[0].linkage
  switch (c) {
    case 'extra index 1': l.outputs.push({ index: 1, linkage: clone(lk) }); break
    case 'missing leaf': return undefined
    case 'verifier ≠ K': lk.verifier = b; break
    case 'prover ≠ A': lk.prover = b; break
    case "keyID 'x'": lk.keyID = 'x'; break
    case 'other asset tag': lk.protocolID[1] = lk.protocolID[1].replace(assetTag(ID), assetTag(OTHER_ID)); break
    case 'proofType 1': lk.proofType = 1; break
    case 'empty encryptedLinkage': lk.encryptedLinkage = []; break
    case '1025-byte encryptedLinkage': lk.encryptedLinkage = new Array(1025).fill(7); break
    case "unknown member 'foo'": lk.foo = 1; break
    case 'uppercase protocol hex': lk.protocolID[1] = lk.protocolID[1].replace(/ ([0-9a-f]+) ([0-9a-f]+)$/, (_: string, p: string, s: string) => ` ${p.toUpperCase()} ${s}`); break
    case 'extra top-level member': l.inputs = []; break
    case 'duplicate index': l.outputs.push(clone(l.outputs[0])); break
    case 'entry with extra member': l.outputs[0].note = 'x'; break
    case 'leaf is an array': return [l] as unknown as JsonValue
    case 'leaf is null': return null
    case 'index 2 (not a token output)': l.outputs[0].index = 2; break
    case 'counterparty not a key': lk.counterparty = 'zz'; break
    default: throw new Error(c)
  }
  return l
}

const CASES = [
  ['extra index 1'], ['missing leaf'], ['verifier ≠ K'], ['prover ≠ A'], ["keyID 'x'"], ['other asset tag'], ['proofType 1'],
  ['empty encryptedLinkage'], ['1025-byte encryptedLinkage'], ["unknown member 'foo'"], ['uppercase protocol hex'],
  ['extra top-level member'], ['duplicate index'], ['entry with extra member'], ['leaf is an array'], ['leaf is null'],
  ['index 2 (not a token output)'], ['counterparty not a key']
]

/** What the overlay does for an output linkage: K decrypts L, then hash160(counterparty + L·G). */
async function overlayDerivedHash (l: { prover: string, counterparty: string, protocolID: [2, string], keyID: string, encryptedLinkage: number[] }): Promise<number[]> {
  const { plaintext: L } = await K.decrypt({
    ciphertext: l.encryptedLinkage,
    protocolID: [2, `specific linkage revelation 2 ${l.protocolID[1]}`],
    keyID: l.keyID,
    counterparty: l.prover
  })
  return outputPubKeyHash(outputPublicKey(PublicKey.fromString(l.counterparty), L))
}

describe('checkPlanData (C§5.2)', () => {
  it('accepts the sender leaf at createAction and at signAction', async () => {
    await expect(checkPlanData(ctx, LEAF, viewAtCreate)).resolves.toBeUndefined()
    await expect(checkPlanData(ctx, LEAF, viewAtSign)).resolves.toBeUndefined()
  })

  it('accepts no leaf when every token output is wallet-owned', async () => {
    const view: ProfileTxView = { ...viewAtCreate, outputs: [viewAtCreate.outputs[1]] }
    await expect(checkPlanData(ctx, undefined, view)).resolves.toBeUndefined()
  })

  it.each(CASES)('%s ⇒ ProfileDataError (createAction)', async c => {
    await expect(checkPlanData(ctx, mutate(LEAF, c), viewAtCreate)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it.each(CASES)('%s ⇒ ProfileDataError (signAction)', async c => {
    await expect(checkPlanData(ctx, mutate(LEAF, c), viewAtSign)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it('checkPlanData rejects a leaf whose linkage does not derive the output\'s pubkey hash', async () => {
    await expect(checkPlanData(ctx, LEAF, signView({ out0Pkh: OTHER_PKH })))
      .rejects.toMatchObject({ name: 'ProfileDataError', message: expect.stringMatching(/linkage does not match output 0/) })
  })

  it('a tampered encryptedLinkage is a linkage mismatch, not a raw decrypt error', async () => {
    const l = clone(LEAF) as any
    l.outputs[0].linkage.encryptedLinkage[l.outputs[0].linkage.encryptedLinkage.length - 1] ^= 1
    await expect(checkPlanData(ctx, l, viewAtSign))
      .rejects.toMatchObject({ name: 'ProfileDataError', message: expect.stringMatching(/linkage does not match output 0/) })
  })

  it('output 0 with 2 satoshis ⇒ ProfileParamsError', async () => {
    await expect(checkPlanData(ctx, LEAF, signView({ out0Sats: 2 }))).rejects.toMatchObject({ name: 'ProfileParamsError' })
  })

  it('a tx carrying another asset\'s token output ⇒ ProfileParamsError (D1)', async () => {
    await expect(checkPlanData(ctx, LEAF, signView({ extraOutput: tokenOut(OTHER_ID, 3n, OTHER_PKH) })))
      .rejects.toMatchObject({ name: 'ProfileParamsError' })
  })

  it('a tx spending another asset\'s token input ⇒ ProfileParamsError (D1)', async () => {
    await expect(checkPlanData(ctx, LEAF, signView({ extraInputParent: parent(OTHER_ID) })))
      .rejects.toMatchObject({ name: 'ProfileParamsError' })
  })

  it('a tx carrying a deploy output ⇒ ProfileParamsError (D1)', async () => {
    const deploy = { lockingScript: new OneColor().lock(null, 0n, OTHER_PKH), satoshis: 1 }
    await expect(checkPlanData(ctx, LEAF, signView({ extraOutput: deploy }))).rejects.toMatchObject({ name: 'ProfileParamsError' })
  })

  it('a tx input without its source transaction fails closed', async () => {
    const tx = signTx()
    tx.inputs[1].sourceTransaction = undefined
    tx.inputs[1].sourceTXID = '22'.repeat(32)
    await expect(checkPlanData(ctx, LEAF, { ...baseView(), tx })).rejects.toMatchObject({ name: 'ProfileParamsError' })
  })

  it('a malformed issuer-v1 descriptor ⇒ ProfileParamsError', async () => {
    const bad = { ...ctx, descriptor: { version: 1, params: { identityKey: k.toUpperCase() } } } as unknown as ProfileAssetContext
    await expect(checkPlanData(bad, LEAF, viewAtCreate)).rejects.toMatchObject({ name: 'ProfileParamsError' })
  })
})

describe('submissionData (C§5.1, G9)', () => {
  it('returns the leaf entries plus owner linkage for wallet-owned outputs', async () => {
    const env = decodeEnvelope(await submissionData(ctx, { ...viewAtSign, planLeaf: LEAF }))
    expect(env.outputs!.map(o => o.index)).toEqual([0, 1])
    expect(env.outputs![1].linkage.counterparty).toBe(a)
    expect('inputs' in env).toBe(false)
    expect(Object.keys(env)).toEqual(['outputs'])
    expect(env.outputs![0].linkage).toEqual(recipient.linkage)
    const own = env.outputs![1].linkage
    expect(own.prover).toBe(a)
    expect(own.verifier).toBe(k)
    expect(own.keyID).toBe('color')
    expect(own.protocolID).toEqual(changeProtocol)
    expect(own.proofType).toBe(0)
  })

  it('overlay-equivalent: K derives each output\'s pubkey hash from the envelope', async () => {
    const env = decodeEnvelope(await submissionData(ctx, viewAtSign))
    expect(await overlayDerivedHash(env.outputs![1].linkage)).toEqual(CHANGE_PKH)
    expect(await overlayDerivedHash(env.outputs![0].linkage)).toEqual(recipient.pubKeyHash)
  })

  it('an uncovered token output ⇒ ProfileDataError', async () => {
    const { planLeaf: _, ...noLeaf } = viewAtSign
    await expect(submissionData(ctx, noLeaf)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it('a leaf entry for an owned output ⇒ ProfileDataError', async () => {
    await expect(submissionData(ctx, { ...viewAtSign, planLeaf: mutate(LEAF, 'extra index 1') }))
      .rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it('an empty result ⇒ ProfileDataError', async () => {
    await expect(submissionData(ctx, { ...viewAtSign, outputs: [], planLeaf: { outputs: [] } }))
      .rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it('is structurally stable across calls (only the BRC-2 ciphertext IVs differ)', async () => {
    const strip = (bytes: number[]): unknown => decodeEnvelope(bytes).outputs!.map(o => ({
      index: o.index, linkage: { ...o.linkage, encryptedLinkage: [], encryptedLinkageProof: [] }
    }))
    expect(strip(await submissionData(ctx, viewAtSign))).toEqual(strip(await submissionData(ctx, viewAtSign)))
  })

  it('an owned output not locked to the revealed owner key ⇒ ProfileDataError', async () => {
    const tx = signTx()
    tx.outputs[1] = tokenOut(ID, 4n, OTHER_PKH) as any
    await expect(submissionData(ctx, { ...baseView(), tx }))
      .rejects.toMatchObject({ name: 'ProfileDataError', message: expect.stringMatching(/linkage does not match output 1/) })
  })

  it('custody naming another asset ⇒ ProfileDataError', async () => {
    const view = baseView()
    view.outputs[1] = { ...view.outputs[1], custody: { ...CHANGE_CUSTODY, assetId: OTHER_ID } }
    await expect(submissionData(ctx, view)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })
})

describe('createMandalaProfile wires the B1 hooks', () => {
  it('checkPlanData and submissionData delegate to profilePlanData', async () => {
    const h = createMandalaProfile({ overlays: [{ identityKey: k, url: 'https://o' }] })
    expect(typeof h.checkPlanData).toBe('function')
    expect(typeof h.submissionData).toBe('function')
    await expect(h.checkPlanData!(ctx, LEAF, viewAtSign)).resolves.toBeUndefined()
    const env = decodeEnvelope(await h.submissionData!(ctx, viewAtSign))
    expect(env.outputs!.map(o => o.index)).toEqual([0, 1])
    expect(await overlayDerivedHash(env.outputs![1].linkage)).toEqual(CHANGE_PKH)
  })
})
