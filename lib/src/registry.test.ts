import { describe, it, expect } from 'vitest'
import {
  parseRegistryCI,
  registryCustomInstructions,
  parseRegistryRows,
  registryIsLive,
  nextRegistryPlan,
  reconstructRegistryDetails,
  buildRegistrySpendArgs
} from './registry.js'

describe('registry customInstructions', () => {
  it('round-trips and is distinct from asset-admin CI', () => {
    const ci = registryCustomInstructions({ kind: 'admitIdentity', identityKey: '02aa' })
    const parsed = parseRegistryCI(ci)
    expect(parsed?.authDetails.kind).toBe('admitIdentity')
    expect(parseRegistryCI('{"type":"mandala-admin"}')).toBeNull()
    expect(parseRegistryCI({ type: 'mandala-registry', authDetails: { kind: 'register' } })?.authDetails.kind).toBe('register')
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
  const live = { authOutpoint: 'tx.0', authDetails: { kind: 'register' as const, issuer } }

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

describe('buildRegistrySpendArgs', () => {
  it('spends the live admin outpoint as the createAction input and emits the next auth output', () => {
    const prior = 'dc810603d764fd843fb979ad9b4412f0dbeb03eeaa6124a3af097f3316046179.0'
    const details = {
      kind: 'admitIdentity' as const,
      identityKey: '02' + '99'.repeat(32),
      priorOutpoint: prior
    }
    const args = buildRegistrySpendArgs({
      kind: 'admitIdentity',
      targetKey: details.identityKey,
      priorOutpoint: prior,
      nextLockHex: '76a91400',
      authDetails: details,
      inputBEEF: [1, 0, 1]
    })
    expect(args.inputs).toHaveLength(1)
    expect(args.inputs[0].outpoint).toBe(prior)
    expect(args.inputs[0].unlockingScriptLength).toBe(108)
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0].satoshis).toBe(1)
    expect(args.outputs[0].basket).toBe('mandala-tokens')
    expect(args.inputBEEF).toEqual([1, 0, 1])
    expect(args.options.noSend).toBe(true)
    expect(() => buildRegistrySpendArgs({
      kind: 'admitIdentity',
      targetKey: details.identityKey,
      priorOutpoint: '',
      nextLockHex: '76',
      authDetails: details,
      inputBEEF: [1]
    })).toThrow(/live admin outpoint/)
  })
})

describe('reconstructRegistryDetails', () => {
  const issuer = '02' + 'aa'.repeat(32)
  it('uses stored details, else treats the issuer row as register genesis', () => {
    expect(reconstructRegistryDetails({
      identityKey: issuer, status: 'admitted', txid: 't', outputIndex: 0, admitSeq: 1, createdAt: '',
      actionDetails: { kind: 'admitIdentity', identityKey: '02bb' }
    }, issuer).kind).toBe('admitIdentity')
    expect(reconstructRegistryDetails({
      identityKey: issuer, status: 'admitted', txid: 't', outputIndex: 0, admitSeq: 1, createdAt: ''
    }, issuer)).toEqual({ kind: 'register', issuer, identityKey: issuer })
  })
})
