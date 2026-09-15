/**
 * FIX A, overlay half — reject-not-skip (wire contract v2 §6).
 *
 * These run through the REAL pinned `MandalaTopicManager` with REAL BRC-72
 * linkages (same construction as membership.test.ts), because the whole point
 * of the fix is what the pinned manager does with a sibling token output it
 * cannot verify: it SKIPS it, sums conservation only over the admitted subset,
 * and hands the engine a 200 for a transaction carrying a phantom coin.
 */
import { describe, it, expect } from 'vitest'
import { MandalaTopicManager, InMemoryScreeningProvider } from '@bsv/overlay-topics'
import { MandalaToken, ADMIN_PROTOCOL } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Hash, Utils, Transaction, UnlockingScript, WalletProtocol } from '@bsv/sdk'
import { withUnlinkedTokenReject, unlinkedTokenReason, findUnlinkedTokenOutput } from './tokenLinkageGuard.js'
import { InfraError, isInfraError } from './submitVerdict.js'

const tokenProtocolID: WalletProtocol = [2, 'mandala token']
const holder = new ProtoWallet(new PrivateKey(21))
const recipient = new ProtoWallet(new PrivateKey(22))
const thief = new ProtoWallet(new PrivateKey(23))
const overlay = new ProtoWallet(new PrivateKey(24))
const assetId = `${'ab'.repeat(32)}.0`

const identity = async (w: ProtoWallet): Promise<string> => (await w.getPublicKey({ identityKey: true })).publicKey
const encodePayload = (payload: unknown): number[] => Utils.toArray(JSON.stringify(payload), 'utf8')

const defaultAssetState = (id: string): any => ({
  assetId: id,
  issuerIdentityKey: '',
  isPaused: false,
  accessMode: 'denylist',
  blockedIdentities: [],
  allowedIdentities: [],
  frozenOutpoints: [],
  evictedOutpoints: [],
  lastProcessedHeight: 0,
  lastProcessedOffset: 0,
  lastAdmitSeq: 0
})

const rawManager = (): MandalaTopicManager => new MandalaTopicManager({
  verifierWallet: overlay as any,
  screeningProvider: new InMemoryScreeningProvider([]),
  adminWallet: overlay as any,
  adminProtocolID: ADMIN_PROTOCOL,
  stateStore: {
    getAssetState: async (id: string) => defaultAssetState(id),
    getTokenRow: async () => null
  } as any
})

/**
 * One 100-unit token input, spent to:
 *   output 0 — 100 units to `recipient`, with a real verifiable linkage;
 *   output 1 — `phantom` units to `thief`, whose linkage entry is controlled
 *              by `linkOutput1` ('none' | 'mismatched' | 'correct').
 * Conservation over the ADMITTED subset holds in every variant, which is
 * precisely why the skip is exploitable.
 */
const phantomSpend = async (opts: {
  phantom: number
  linkOutput1: 'none' | 'mismatched' | 'correct'
}): Promise<{ beef: number[], payload: number[] }> => {
  const holderKey = await identity(holder)
  const recipientKey = await identity(recipient)
  const thiefKey = await identity(thief)
  const verifierKey = await identity(overlay)

  const { publicKey: srcDerived } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'src', counterparty: holderKey })
  const source = new Transaction()
  source.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  source.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(srcDerived, 'hex'))) })

  const { publicKey: out0 } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'out0', counterparty: recipientKey })
  const { publicKey: out1 } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'out1', counterparty: thiefKey })

  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(out0, 'hex'))) })
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, opts.phantom, Hash.hash160(Utils.toArray(out1, 'hex'))) })

  const link0 = await holder.revealSpecificKeyLinkage({
    counterparty: recipientKey, verifier: verifierKey, protocolID: tokenProtocolID, keyID: 'out0'
  })
  const outputs: Array<{ index: number, linkage: unknown }> = [{ index: 0, linkage: link0 }]
  if (opts.linkOutput1 === 'correct') {
    outputs.push({
      index: 1,
      linkage: await holder.revealSpecificKeyLinkage({
        counterparty: thiefKey, verifier: verifierKey, protocolID: tokenProtocolID, keyID: 'out1'
      })
    })
  } else if (opts.linkOutput1 === 'mismatched') {
    // A structurally valid linkage that verifies to a DIFFERENT key than the
    // one output 1 is actually locked to — the pkh-mismatch branch the pinned
    // manager also silently skips.
    outputs.push({
      index: 1,
      linkage: await holder.revealSpecificKeyLinkage({
        counterparty: recipientKey, verifier: verifierKey, protocolID: tokenProtocolID, keyID: 'out0'
      })
    })
  }
  return { beef: tx.toBEEF(), payload: encodePayload({ inputs: [], outputs }) }
}

describe('the phantom-coin hole this closes (pinned manager, unwrapped)', () => {
  it('REGRESSION WITNESS: the pinned manager admits output 0 and silently skips a 1,000,000-unit un-linked sibling', async () => {
    const { beef, payload } = await phantomSpend({ phantom: 1_000_000, linkOutput1: 'none' })
    const res = await rawManager().identifyAdmissibleOutputs(beef, [0], payload)
    // The transaction is ACCEPTED — the engine broadcasts it, and output 1 is a
    // 1,000,000-unit coin nobody ever authorised. This is EB-1/SM-1.
    expect(res.outputsToAdmit).toEqual([0])
  })
})

describe('withUnlinkedTokenReject — FIX A (contract §6)', () => {
  it('rejects the WHOLE submission when a MandalaToken output has no linkage entry', async () => {
    const tm = withUnlinkedTokenReject(rawManager() as any, { verifierWallet: overlay as any })
    const { beef, payload } = await phantomSpend({ phantom: 1_000_000, linkOutput1: 'none' })
    await expect(tm.identifyAdmissibleOutputs(beef, [0], payload)).rejects.toThrow(
      'output 1: MandalaToken-decodable output with no verified linkage'
    )
  })

  it('uses the exact contract reason string', () => {
    expect(unlinkedTokenReason(1)).toBe('output 1: MandalaToken-decodable output with no verified linkage')
  })

  it('rejects on a pkh mismatch too (linkage present, wrong key)', async () => {
    const tm = withUnlinkedTokenReject(rawManager() as any, { verifierWallet: overlay as any })
    const { beef, payload } = await phantomSpend({ phantom: 1_000_000, linkOutput1: 'mismatched' })
    await expect(tm.identifyAdmissibleOutputs(beef, [0], payload)).rejects.toThrow(
      'output 1: MandalaToken-decodable output with no verified linkage'
    )
  })

  it('rejects before delegating — the pinned manager is never consulted', async () => {
    let delegated = false
    const inner = {
      identifyAdmissibleOutputs: async () => { delegated = true; return { outputsToAdmit: [], coinsToRetain: [] } },
      getDocumentation: async () => '',
      getMetaData: async () => ({ name: 'x', shortDescription: 'x' })
    }
    const tm = withUnlinkedTokenReject(inner as any, { verifierWallet: overlay as any })
    const { beef, payload } = await phantomSpend({ phantom: 1_000_000, linkOutput1: 'none' })
    await expect(tm.identifyAdmissibleOutputs(beef, [0], payload)).rejects.toThrow(/no verified linkage/)
    expect(delegated).toBe(false)
  })

  it('admits a fully linked transfer unchanged (conservation still enforced by the inner manager)', async () => {
    const tm = withUnlinkedTokenReject(rawManager() as any, { verifierWallet: overlay as any })
    // Every output linked, and the amounts conserve (100 in → 60 + 40 out).
    const holderKey = await identity(holder)
    const recipientKey = await identity(recipient)
    const thiefKey = await identity(thief)
    const verifierKey = await identity(overlay)
    const { publicKey: srcDerived } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'src', counterparty: holderKey })
    const source = new Transaction()
    source.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    source.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(srcDerived, 'hex'))) })
    const { publicKey: a } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'out0', counterparty: recipientKey })
    const { publicKey: b } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'out1', counterparty: thiefKey })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 60, Hash.hash160(Utils.toArray(a, 'hex'))) })
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 40, Hash.hash160(Utils.toArray(b, 'hex'))) })
    const payload = encodePayload({
      inputs: [],
      outputs: [
        { index: 0, linkage: await holder.revealSpecificKeyLinkage({ counterparty: recipientKey, verifier: verifierKey, protocolID: tokenProtocolID, keyID: 'out0' }) },
        { index: 1, linkage: await holder.revealSpecificKeyLinkage({ counterparty: thiefKey, verifier: verifierKey, protocolID: tokenProtocolID, keyID: 'out1' }) }
      ]
    })
    const res = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [0], payload)
    expect(res.outputsToAdmit).toEqual([0, 1])
  })

  it('ignores non-token outputs (ordinary change is not a token output)', async () => {
    const tm = withUnlinkedTokenReject(rawManager() as any, { verifierWallet: overlay as any })
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '33'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 500, lockingScript: new MandalaToken().lock(assetId, 7, Hash.hash160(Utils.toArray('02' + 'ff'.repeat(32), 'hex'))) })
    // sanity: the above IS token-shaped, so it must be rejected …
    await expect(tm.identifyAdmissibleOutputs(tx.toBEEF(), [], encodePayload({ inputs: [], outputs: [] }))).rejects.toThrow(/no verified linkage/)
    // … while a plain P2PKH-only transaction passes straight through.
    const plain = new Transaction()
    plain.addInput({ sourceTXID: '33'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    plain.addOutput({ satoshis: 500, lockingScript: new (await import('@bsv/sdk')).P2PKH().lock(new PrivateKey(99).toAddress()) })
    const res = await tm.identifyAdmissibleOutputs(plain.toBEEF(), [], encodePayload({ inputs: [], outputs: [] }))
    expect(res.outputsToAdmit).toEqual([])
  })

  it('findUnlinkedTokenOutput reports the first offending index, lowest first', async () => {
    const { beef, payload } = await phantomSpend({ phantom: 5, linkOutput1: 'none' })
    expect(await findUnlinkedTokenOutput(beef, payload, { verifierWallet: overlay as any })).toBe(1)
  })

  it('findUnlinkedTokenOutput returns null when every token output is linked', async () => {
    const { beef, payload } = await phantomSpend({ phantom: 5, linkOutput1: 'correct' })
    expect(await findUnlinkedTokenOutput(beef, payload, { verifierWallet: overlay as any })).toBeNull()
  })

  it('a missing off-chain payload still rejects a token output (no linkage at all)', async () => {
    const tm = withUnlinkedTokenReject(rawManager() as any, { verifierWallet: overlay as any })
    const { beef } = await phantomSpend({ phantom: 5, linkOutput1: 'none' })
    await expect(tm.identifyAdmissibleOutputs(beef, [0], undefined)).rejects.toThrow(
      'output 0: MandalaToken-decodable output with no verified linkage'
    )
  })

  it('preserves the inner manager documentation/metadata', async () => {
    const inner = rawManager()
    const tm = withUnlinkedTokenReject(inner as any, { verifierWallet: overlay as any })
    expect(await tm.getMetaData?.()).toEqual(await inner.getMetaData())
    expect(typeof await tm.getDocumentation()).toBe('string')
  })
})

// ──────────────────── §9.5 — a verifier that cannot ANSWER ───────────────────

describe('withUnlinkedTokenReject — a wallet fault is not a linkage verdict', () => {
  /**
   * The verifier wallet is local, in-process crypto, so a throw from it is a
   * malformed linkage — content, and an absent linkage never passes. The one
   * exception is an InfraError: a verifier that could not answer has not told us
   * the linkage is bad, and turning that into a final, PERSISTED 400 ERR_LINKAGE
   * would deny a valid transaction forever over a transient fault.
   */
  /** Every wallet method this verifier is asked for throws `err`. */
  const throwingWallet = (err: Error): any =>
    new Proxy({}, { get: () => async () => { throw err } })

  it('an ordinary verifier throw is still a final ERR_LINKAGE refusal', async () => {
    const { beef, payload } = await phantomSpend({ phantom: 5, linkOutput1: 'mismatched' })
    const offending = await findUnlinkedTokenOutput(beef, payload, {
      verifierWallet: throwingWallet(new Error('malformed DER'))
    })
    expect(offending).toBe(0)
  })

  it('an InfraError from the verifier propagates instead of becoming ERR_LINKAGE', async () => {
    const { beef, payload } = await phantomSpend({ phantom: 5, linkOutput1: 'mismatched' })
    const err = await findUnlinkedTokenOutput(beef, payload, {
      verifierWallet: throwingWallet(new InfraError('the verifier wallet is unavailable'))
    }).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
  })
})
