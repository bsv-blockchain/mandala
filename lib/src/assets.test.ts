import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hash, PrivateKey, Transaction, P2PKH, LockingScript, UnlockingScript } from '@bsv/sdk'
import { MandalaAdmin } from '@bsv/templates'
import {
  buildAdminActionArgs, buildGlobalAdminActionArgs, withReason, withBankRef, adminMarker,
  submitAdminAction, submitGlobalAdminAction
} from './assets.js'
import type { AdminAsset } from './assets.js'
import type { MandalaActionDetails } from './encoding.js'
import { BASKET } from './constants.js'
import { submitAndBroadcast } from './overlay.js'
import { clearAdminAuthGates, isAdminAuthInFlight, StaleAdminAuthError } from './adminAuthGate.js'
import { hasFreshIntent, journalClear } from './txJournal.js'

// Orchestrator tests stop at the overlay boundary (covered by overlay.test.ts).
vi.mock('./overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlay.js')>()),
  submitAndBroadcast: vi.fn()
}))

const fakeAsset: AdminAsset = {
  assetId: 'x'.repeat(64) + '.0',
  label: 'USD',
  authOutpoint: 'a'.repeat(64) + '.0',
  authDetails: { kind: 'issue', assetId: 'x'.repeat(64) + '.0', amount: 100, priorOutpoint: 'prev.0' },
  metadata: { decimals: 2 }
}

describe('buildAdminActionArgs (pure tx-shape builder)', () => {
  it('pause builds one prior-auth input + one next-auth output, no FT output', () => {
    const details: MandalaActionDetails = { kind: 'pause', assetId: fakeAsset.assetId, priorOutpoint: fakeAsset.authOutpoint }
    const args = buildAdminActionArgs(fakeAsset, details, 'fakeLockHex')

    // One prior-auth input
    expect(args.inputs).toHaveLength(1)
    expect(args.inputs[0]).toMatchObject({ outpoint: fakeAsset.authOutpoint, inputDescription: expect.stringContaining('auth') })

    // One next-auth output only (no FT output)
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0]).toMatchObject({
      lockingScript: 'fakeLockHex',
      outputDescription: expect.stringContaining('auth'),
      basket: BASKET
    })

    // Description includes the kind
    expect(args.description).toContain('pause')
    expect(args.description).toContain('USD')
  })

  it('reissue builds one prior-auth input + FT output at index 0 + next-auth output at index 1', () => {
    const details: MandalaActionDetails = { kind: 'reissue', assetId: fakeAsset.assetId, amount: 500, priorOutpoint: fakeAsset.authOutpoint, recipient: '02recip' }
    const ftOutput = { lockingScript: 'ftLockHex', amount: 500, recipient: '02recip' }
    const args = buildAdminActionArgs(fakeAsset, details, 'authLockHex', ftOutput)

    // One prior-auth input
    expect(args.inputs).toHaveLength(1)
    expect(args.inputs[0]).toMatchObject({ outpoint: fakeAsset.authOutpoint })

    // Two outputs: FT at index 0, auth at index 1
    expect(args.outputs).toHaveLength(2)
    expect(args.outputs[0]).toMatchObject({ lockingScript: 'ftLockHex', outputDescription: expect.stringContaining('FT') })
    expect(args.outputs[1]).toMatchObject({ lockingScript: 'authLockHex', basket: BASKET })
  })

  it('sets randomizeOutputs: false', () => {
    const details: MandalaActionDetails = { kind: 'pause', assetId: fakeAsset.assetId }
    const args = buildAdminActionArgs(fakeAsset, details, 'lockHex')
    expect(args.options?.randomizeOutputs).toBe(false)
  })

  it('includes mandala and action kind labels', () => {
    const details: MandalaActionDetails = { kind: 'setAccessMode', assetId: fakeAsset.assetId, mode: 'allowlist' }
    const args = buildAdminActionArgs(fakeAsset, details, 'lockHex')
    expect(args.labels).toContain('mandala')
    expect(args.labels).toContain('setAccessMode')
  })
})

describe('buildGlobalAdminActionArgs (multi-asset pure builder)', () => {
  const assetA: AdminAsset = { ...fakeAsset, assetId: 'aaa.0', label: 'AAA', authOutpoint: 'aaOut.0', authDetails: { kind: 'issue' } }
  const assetB: AdminAsset = { ...fakeAsset, assetId: 'bbb.0', label: 'BBB', authOutpoint: 'bbOut.0', authDetails: { kind: 'issue' } }

  it('produces one input per asset and one output per asset', () => {
    const detailsFor = (a: AdminAsset): MandalaActionDetails => ({ kind: 'pause', assetId: a.assetId })
    const lockScripts = ['lockA', 'lockB']
    const args = buildGlobalAdminActionArgs([assetA, assetB], detailsFor, lockScripts)

    expect(args.inputs).toHaveLength(2)
    expect(args.inputs[0]).toMatchObject({ outpoint: assetA.authOutpoint })
    expect(args.inputs[1]).toMatchObject({ outpoint: assetB.authOutpoint })

    expect(args.outputs).toHaveLength(2)
    expect(args.outputs[0]).toMatchObject({ lockingScript: 'lockA', basket: BASKET })
    expect(args.outputs[1]).toMatchObject({ lockingScript: 'lockB', basket: BASKET })
  })

  it('uses the first asset kind in description and labels', () => {
    const detailsFor = (a: AdminAsset): MandalaActionDetails => ({ kind: 'unpause', assetId: a.assetId })
    const args = buildGlobalAdminActionArgs([assetA, assetB], detailsFor, ['lockA', 'lockB'])
    expect(args.description).toContain('unpause')
    expect(args.labels).toContain('unpause')
  })
})

describe('withReason', () => {
  it('adds a trimmed reason when present', () => {
    expect(withReason({ kind: 'freezeOutput' }, '  court order  ')).toEqual({ kind: 'freezeOutput', reason: 'court order' })
  })

  it('omits the key entirely when empty/whitespace (commitment stays identical)', () => {
    expect(withReason({ kind: 'pause' }, '')).toEqual({ kind: 'pause' })
    expect(withReason({ kind: 'pause' }, '   ')).toEqual({ kind: 'pause' })
    expect(withReason({ kind: 'pause' }, undefined)).toEqual({ kind: 'pause' })
  })
})

describe('withBankRef (A14 omit-when-empty discipline)', () => {
  it('adds a trimmed bankRef when present', () => {
    expect(withBankRef({ kind: 'issue' }, ' ' + 'ab'.repeat(32) + ' ')).toEqual({ kind: 'issue', bankRef: 'ab'.repeat(32) })
  })

  it('omits the key entirely when empty/whitespace/undefined (commitment stays identical)', () => {
    expect(withBankRef({ kind: 'issue' }, '')).toEqual({ kind: 'issue' })
    expect(withBankRef({ kind: 'issue' }, '   ')).toEqual({ kind: 'issue' })
    expect(withBankRef({ kind: 'issue' }, undefined)).toEqual({ kind: 'issue' })
    expect(Object.keys(withBankRef({ kind: 'issue' }, undefined))).toEqual(['kind'])
  })
})

// ---------------------------------------------------------------------------
// Orchestrators with wallet + templates stubbed (A09 marker, A15 composed gate).
// ---------------------------------------------------------------------------

const ISSUER = '02' + 'ab'.repeat(32)
const TXID = 'c'.repeat(64)

function signableBeef (n: number): number[] {
  const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
  const src = new Transaction()
  for (let i = 0; i < n; i++) src.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  for (let i = 0; i < n; i++) {
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: i, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(pkh) })
  return tx.toBEEF(true)
}

const mkWallet = (spendable: string[], inputs: number) => ({
  listOutputs: vi.fn().mockResolvedValue({ outputs: spendable.map(outpoint => ({ outpoint })), BEEF: [1] }),
  createAction: vi.fn().mockResolvedValue({ signableTransaction: { tx: signableBeef(inputs), reference: 'ref-1' } }),
  signAction: vi.fn().mockResolvedValue({ tx: [9, 9, 9], txid: TXID }),
  revealSpecificKeyLinkage: vi.fn().mockResolvedValue({ keyID: 'k' }),
  abortAction: vi.fn().mockResolvedValue({ aborted: true })
})

describe('admin-auth outputs carry the on-chain marker (A09)', () => {
  beforeEach(async () => {
    clearAdminAuthGates()
    await journalClear()
    vi.spyOn(MandalaAdmin, 'lock').mockResolvedValue(new LockingScript([]))
    vi.spyOn(MandalaAdmin, 'unlock').mockReturnValue({ sign: async () => new UnlockingScript([]), estimateLength: async () => 108 })
    vi.mocked(submitAndBroadcast).mockReset().mockResolvedValue({ outputsToAdmit: [0] })
  })
  afterEach(() => vi.restoreAllMocks())

  it('adminMarker is the fixed {t, assetId} shape', () => {
    expect(adminMarker('x.0')).toEqual({ t: 'mandala-admin', assetId: 'x.0' })
  })

  it('submitAdminAction locks the next auth output with publicData {t: mandala-admin, assetId}', async () => {
    const details: MandalaActionDetails = { kind: 'pause', assetId: fakeAsset.assetId, priorOutpoint: fakeAsset.authOutpoint }
    const wallet = mkWallet([fakeAsset.authOutpoint], 1)
    await submitAdminAction({ wallet: wallet as any, asset: fakeAsset, details, identityKey: ISSUER })
    expect(MandalaAdmin.lock).toHaveBeenCalledTimes(1)
    expect(MandalaAdmin.lock).toHaveBeenCalledWith(expect.objectContaining({
      data: details,
      publicData: { t: 'mandala-admin', assetId: fakeAsset.assetId }
    }))
  })

  it('submitGlobalAdminAction marks each next-auth output with its own assetId, under the composed gate + intent, priors asserted spendable', async () => {
    const assetA: AdminAsset = { ...fakeAsset, assetId: 'aaa.0', label: 'AAA', authOutpoint: 'aaOut.0' }
    const assetB: AdminAsset = { ...fakeAsset, assetId: 'bbb.0', label: 'BBB', authOutpoint: 'bbOut.0' }
    const wallet = mkWallet([assetA.authOutpoint, assetB.authOutpoint], 2)
    let gatedAtCreate: boolean[] = []
    let intentAtCreate = false
    wallet.createAction.mockImplementation(async () => {
      gatedAtCreate = [isAdminAuthInFlight('aaa.0'), isAdminAuthInFlight('bbb.0')]
      intentAtCreate = await hasFreshIntent()
      return { signableTransaction: { tx: signableBeef(2), reference: 'ref-g' } }
    })
    const detailsFor = (a: AdminAsset): MandalaActionDetails => ({ kind: 'pause', assetId: a.assetId, priorOutpoint: a.authOutpoint })

    // Input order is B, A — the gate must still acquire in sorted order and the outputs stay in input order.
    const res = await submitGlobalAdminAction({ wallet: wallet as any, assets: [assetB, assetA], detailsFor, identityKey: ISSUER })

    expect(res.txid).toBe(TXID)
    expect(gatedAtCreate).toEqual([true, true])
    expect(intentAtCreate).toBe(true)
    expect(isAdminAuthInFlight('aaa.0')).toBe(false)
    expect(isAdminAuthInFlight('bbb.0')).toBe(false)
    expect(await hasFreshIntent()).toBe(false)
    expect(MandalaAdmin.lock).toHaveBeenNthCalledWith(1, expect.objectContaining({ publicData: { t: 'mandala-admin', assetId: 'bbb.0' } }))
    expect(MandalaAdmin.lock).toHaveBeenNthCalledWith(2, expect.objectContaining({ publicData: { t: 'mandala-admin', assetId: 'aaa.0' } }))
  })

  it('submitGlobalAdminAction refuses when any prior is no longer spendable — before createAction', async () => {
    const assetA: AdminAsset = { ...fakeAsset, assetId: 'aaa.0', authOutpoint: 'aaOut.0' }
    const assetB: AdminAsset = { ...fakeAsset, assetId: 'bbb.0', authOutpoint: 'bbOut.0' }
    const wallet = mkWallet([assetA.authOutpoint], 2) // B's prior already spent
    await expect(submitGlobalAdminAction({
      wallet: wallet as any, assets: [assetA, assetB], detailsFor: a => ({ kind: 'pause', assetId: a.assetId }), identityKey: ISSUER
    })).rejects.toBeInstanceOf(StaleAdminAuthError)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(isAdminAuthInFlight('aaa.0')).toBe(false)
    expect(isAdminAuthInFlight('bbb.0')).toBe(false)
  })
})

describe('MandalaAdmin marker keeps every existing chain spendable (A09)', () => {
  it('commitment and locking key are byte-identical with and without publicData', async () => {
    const pub = PrivateKey.fromRandom().toPublicKey().toString()
    const wallet = { getPublicKey: vi.fn().mockResolvedValue({ publicKey: pub }) }
    const details: MandalaActionDetails = { kind: 'freezeOutput', assetId: 'x.0', outpoint: 'y.1', priorOutpoint: 'p.0' }

    const bare = await MandalaAdmin.lock({ wallet: wallet as any, data: details })
    const marked = await MandalaAdmin.lock({ wallet: wallet as any, data: details, publicData: adminMarker('x.0') })

    // Same keyID (= commitment(details)) requested from the wallet both times.
    const keyIds = wallet.getPublicKey.mock.calls.map(c => c[0].keyID)
    expect(keyIds).toEqual([MandalaAdmin.commitment(details), MandalaAdmin.commitment(details)])
    // Same P2PKH core; the marker only adds a pushed-and-dropped prefix.
    expect(MandalaAdmin.decode(marked).pubKeyHash).toEqual(MandalaAdmin.decode(bare).pubKeyHash)
    expect(MandalaAdmin.decode(bare).publicData).toBeUndefined()
    expect(MandalaAdmin.decode(marked).publicData).toEqual({ t: 'mandala-admin', assetId: 'x.0' })
    expect(marked.chunks).toHaveLength(7)
    expect(bare.chunks).toHaveLength(5)
  })
})
