/**
 * A04 — one membership gate, issuer-exempt, TS ≡ Go.
 *
 * The registry membership check is enforced on TS through the sanctions
 * screening seam of the upstream MandalaTopicManager. Go's membershipHolds
 * exempts asset issuers; without the same exemption here a revoke of the
 * issuer row (or a registry index loss) locks the issuer out of every admin
 * action including `unpause`. These tests pin the exemption on both the
 * provider and the real upstream manager.
 */
import { describe, it, expect } from 'vitest'
import { MandalaTopicManager, InMemoryScreeningProvider } from '@bsv/overlay-topics'
import { MandalaToken, ADMIN_PROTOCOL } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Hash, Utils, Transaction, UnlockingScript, WalletProtocol } from '@bsv/sdk'
import { registryScreening, type RegistryMembership } from './registry.js'

const encodeLinkagePayload = (payload: unknown): number[] => Utils.toArray(JSON.stringify(payload), 'utf8')
const defaultAssetState = (assetId: string): any => ({
  assetId,
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

const membership = (opts: { active: boolean, admitted: string[] }): RegistryMembership => ({
  isActive: async () => opts.active,
  isAdmitted: async (key: string) => opts.admitted.includes(key)
})

const ISSUER = '02' + 'aa'.repeat(32)
const PEER = '03' + 'bb'.repeat(32)
const OVERLAY = '02' + 'cc'.repeat(32)

describe('registryScreening — issuer exemption (A04)', () => {
  const issuers = { issuerIdentityKeys: async () => [ISSUER] }

  it('is a no-op while the registry has no rows', async () => {
    const s = registryScreening(membership({ active: false, admitted: [] }), [], { issuers })
    expect(await s.isSanctioned(PEER)).toBe(false)
  })

  it('refuses a non-admitted peer once the registry is live', async () => {
    const s = registryScreening(membership({ active: true, admitted: [] }), [], { issuers })
    expect(await s.isSanctioned(PEER)).toBe(true)
  })

  it('passes an admitted peer', async () => {
    const s = registryScreening(membership({ active: true, admitted: [PEER] }), [], { issuers })
    expect(await s.isSanctioned(PEER)).toBe(false)
  })

  it('exempts every asset issuer the state store knows, admitted or not (the brick case)', async () => {
    const s = registryScreening(membership({ active: true, admitted: [] }), [], { issuers })
    expect(await s.isSanctioned(ISSUER)).toBe(false)
  })

  it('exempts the overlay identity key', async () => {
    const s = registryScreening(membership({ active: true, admitted: [] }), [], { issuers, identityKeys: [OVERLAY] })
    expect(await s.isSanctioned(OVERLAY)).toBe(false)
  })

  it('reads the issuer set live on every check (no stale cache)', async () => {
    let known: string[] = []
    const s = registryScreening(membership({ active: true, admitted: [] }), [], {
      issuers: { issuerIdentityKeys: async () => known }
    })
    expect(await s.isSanctioned(ISSUER)).toBe(true)
    known = [ISSUER]
    expect(await s.isSanctioned(ISSUER)).toBe(false)
  })

  it('keeps the explicit ban list above the exemption (sanctions are a separate concern)', async () => {
    const s = registryScreening(membership({ active: true, admitted: [] }), [ISSUER], { issuers })
    expect(await s.isSanctioned(ISSUER)).toBe(true)
  })

  it('still works with no exemption source configured', async () => {
    const s = registryScreening(membership({ active: true, admitted: [PEER] }))
    expect(await s.isSanctioned(PEER)).toBe(false)
    expect(await s.isSanctioned(ISSUER)).toBe(true)
  })
})

// Parity with Go TestMembershipHolds through the REAL upstream manager: a
// live registry that does not list the issuer must still admit tokens moving
// to the issuer, and must refuse a non-admitted peer.
describe('MandalaTopicManager + registryScreening — parity with Go membershipHolds', () => {
  const tokenProtocolID: WalletProtocol = [2, 'mandala token']
  const holder = new ProtoWallet(new PrivateKey(11))
  const issuer = new ProtoWallet(new PrivateKey(12))
  const peer = new ProtoWallet(new PrivateKey(13))
  const overlay = new ProtoWallet(new PrivateKey(14))
  const assetId = `${'ab'.repeat(32)}.0`

  const identity = async (w: ProtoWallet): Promise<string> => (await w.getPublicKey({ identityKey: true })).publicKey

  const manager = async (screening: { isSanctioned: (k: string) => Promise<boolean> }): Promise<MandalaTopicManager> => {
    const issuerKey = await identity(issuer)
    return new MandalaTopicManager({
      verifierWallet: overlay as any,
      screeningProvider: screening,
      adminWallet: overlay as any,
      adminProtocolID: ADMIN_PROTOCOL,
      stateStore: {
        getAssetState: async (id: string) => ({ ...defaultAssetState(id), issuerIdentityKey: issuerKey }),
        getTokenRow: async () => null
      }
    })
  }

  // One previously admitted 100-unit token input (holder's own child key),
  // spent in full to `recipient` with a real BRC-72 linkage.
  const transferTo = async (recipient: ProtoWallet): Promise<{ beef: number[], payload: number[] }> => {
    const holderKey = await identity(holder)
    const recipientKey = await identity(recipient)
    const verifierKey = await identity(overlay)
    const { publicKey: srcDerived } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'src', counterparty: holderKey })
    const source = new Transaction()
    source.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    source.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(srcDerived, 'hex'))) })

    const { publicKey: outDerived } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'out', counterparty: recipientKey })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(outDerived, 'hex'))) })
    const linkage = await holder.revealSpecificKeyLinkage({
      counterparty: recipientKey, verifier: verifierKey, protocolID: tokenProtocolID, keyID: 'out'
    })
    return {
      beef: tx.toBEEF(),
      payload: encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkage as any }] })
    }
  }

  const liveRegistryWithoutIssuer = async (): Promise<ReturnType<typeof registryScreening>> =>
    registryScreening(
      membership({ active: true, admitted: ['02' + 'ee'.repeat(32)] }),
      [],
      { issuers: { issuerIdentityKeys: async () => [await identity(issuer)] }, identityKeys: [await identity(overlay)] }
    )

  it('admits a transfer to the issuer although the issuer holds no registry row', async () => {
    const tm = await manager(await liveRegistryWithoutIssuer())
    const { beef, payload } = await transferTo(issuer)
    const res = await tm.identifyAdmissibleOutputs(beef, [0], payload)
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('refuses the same transfer to a non-admitted peer', async () => {
    const tm = await manager(await liveRegistryWithoutIssuer())
    const { beef, payload } = await transferTo(peer)
    await expect(tm.identifyAdmissibleOutputs(beef, [0], payload)).rejects.toThrow(/sanctioned party/)
  })

  it('sanity: with an empty sanctions list the peer transfer is admitted', async () => {
    const tm = await manager(new InMemoryScreeningProvider([]))
    const { beef, payload } = await transferTo(peer)
    const res = await tm.identifyAdmissibleOutputs(beef, [0], payload)
    expect(res.outputsToAdmit).toEqual([0])
  })
})
