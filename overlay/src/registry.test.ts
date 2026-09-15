import { describe, it, expect } from 'vitest'
import { Transaction, UnlockingScript, P2PKH, PrivateKey, ProtoWallet, Hash, Utils } from '@bsv/sdk'
import { MandalaAdmin } from '@bsv/templates'
import { foldRegistry, RegistryTopicManager, REGISTRY_PROTOCOL } from './registry.js'

describe('foldRegistry', () => {
  it('admits, revokes, and registers the issuer', () => {
    expect(foldRegistry({ kind: 'admitIdentity', identityKey: '02aa' }, 'tx', 0, 1)?.status).toBe('admitted')
    expect(foldRegistry({ kind: 'revokeIdentity', identityKey: '02aa' }, 'tx', 1, 2)?.status).toBe('revoked')
    expect(foldRegistry({ kind: 'register', issuer: '02bb' }, 'tx', 0, 1)?.identityKey).toBe('02bb')
    expect(foldRegistry({ kind: 'register' }, 'tx', 0, 1)).toBeNull()
  })
})

describe('RegistryTopicManager — chain anchoring', () => {
  const ISSUER = new PrivateKey(4)
  const TARGET = '02' + 'aa'.repeat(32)

  const build = async (kind: string, opts: { active: boolean, spendsChain: boolean }) => {
    const wallet = new ProtoWallet(ISSUER)
    const src = new Transaction()
    src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(ISSUER.toAddress()) })

    const details: any = { kind, identityKey: TARGET }
    if (kind !== 'register') details.priorOutpoint = `${src.id('hex')}.0`

    const { publicKey } = await wallet.getPublicKey({
      protocolID: REGISTRY_PROTOCOL,
      keyID: MandalaAdmin.commitment(details),
      counterparty: 'self',
      forSelf: false
    })
    const lock = new P2PKH().lock(Hash.hash160(Utils.toArray(publicKey, 'hex')))

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: lock })

    const tm = new RegistryTopicManager(wallet as any, { isActive: async () => opts.active })
    const offChain = Utils.toArray(JSON.stringify({ admin: [{ index: 0, actionDetails: details }] }), 'utf8')
    return await tm.identifyAdmissibleOutputs(tx.toBEEF(), opts.spendsChain ? [0] : [], offChain)
  }

  it('refuses an admit that does not spend a previously admitted registry output', async () => {
    await expect(build('admitIdentity', { active: true, spendsChain: false })).rejects.toThrow(/no admissible/)
  })

  it('admits when the action spends the live chain output', async () => {
    const res = await build('admitIdentity', { active: true, spendsChain: true })
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('refuses a revoke that does not spend the chain', async () => {
    await expect(build('revokeIdentity', { active: true, spendsChain: false })).rejects.toThrow(/no admissible/)
  })

  it('allows register only as genesis', async () => {
    const res = await build('register', { active: false, spendsChain: false })
    expect(res.outputsToAdmit).toEqual([0])
    await expect(build('register', { active: true, spendsChain: false })).rejects.toThrow(/genesis-only/)
  })
})
