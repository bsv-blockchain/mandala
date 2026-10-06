import { describe, it, expect } from 'vitest'
import {
  parseRegistryCI,
  registryCustomInstructions,
  parseRegistryRows,
  registryIsLive,
  nextRegistryPlan
} from './registry.js'

describe('registry customInstructions', () => {
  it('round-trips and is distinct from asset-admin CI', () => {
    const ci = registryCustomInstructions('ab'.repeat(32) + '_0', 'cd'.repeat(32))
    const parsed = parseRegistryCI(ci)
    expect(parsed?.authKeyID).toBe('cd'.repeat(32))
    expect(parsed?.tokenId).toBe('ab'.repeat(32) + '_0')
    expect(parseRegistryCI('{"type":"mandala-admin"}')).toBeNull()
    expect(parseRegistryCI({ type: 'mandala-registry', tokenId: '', authKeyID: 'deploy' })?.authKeyID).toBe('deploy')
  })
})

describe('parseRegistryRows / registryIsLive', () => {
  it('keeps admitted and revoked rows, drops junk', () => {
    const rows = parseRegistryRows([
      { identityKey: '02aa', status: 'admitted', txid: 't', outputIndex: 0, admitSeq: 1, createdAt: '2026-01-01' },
      { identityKey: '02bb', status: 'revoked', txid: 'u', outputIndex: 0, admitSeq: 2, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { identityKey: '', status: 'admitted' },
      { status: 'admitted' },
      null
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].status).toBe('admitted')
    expect(rows[1].status).toBe('revoked')
    expect(rows[1].createdAt).toBe('2026-01-02T00:00:00.000Z')
    expect(registryIsLive(rows)).toBe(true)
    expect(registryIsLive([])).toBe(false)
    expect(parseRegistryRows({ nope: true })).toEqual([])
  })
})

describe('nextRegistryPlan', () => {
  const issuer = '02' + 'aa'.repeat(32)
  const peer = '03' + 'bb'.repeat(32)
  const live = { authOutpoint: 'tx.0', authKeyID: 'deploy', tokenId: 'tx_0' }

  it('opens the chain for the issuer, then admits a peer', () => {
    expect(nextRegistryPlan(null, issuer, issuer)).toBe('register')
    expect(nextRegistryPlan(null, issuer, peer)).toBe('register-then-admit')
    expect(nextRegistryPlan(live, issuer, peer)).toBe('admit')
    expect(nextRegistryPlan(live, issuer, issuer)).toBe('admit')
  })

  it('recovers instead of opening a second genesis when the overlay is already live', () => {
    expect(nextRegistryPlan(null, issuer, issuer, true)).toBe('recover')
    expect(nextRegistryPlan(null, issuer, peer, true)).toBe('recover-then-admit')
  })
})
