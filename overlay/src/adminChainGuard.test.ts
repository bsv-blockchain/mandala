import { describe, it, expect } from 'vitest'
import { Transaction, UnlockingScript, P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import {
  adminEntryAnchored, parseAdminEntries, withAdminChainAnchor, freezeTargetHasRow, FREEZE_NO_ROW,
  type AdminChainStore
} from './adminChainGuard.js'
import { isInfraError } from './submitVerdict.js'

const ASSET = 'ab'.repeat(32) + '.0'

const store = (recorded: string[], liveTokens: string[] = []): AdminChainStore => ({
  isAdminOutpoint: async (assetId, txid, vout) => recorded.includes(`${assetId}|${txid}.${vout}`),
  hasTokenRow: async (txid, vout) => liveTokens.includes(`${txid}.${vout}`)
})

describe('adminEntryAnchored', () => {
  const prior = 'cd'.repeat(32) + '.0'
  const recorded = store([`${ASSET}|${prior}`])

  it('accepts an action that spends a recorded admin output of the asset', async () => {
    const ok = await adminEntryAnchored(
      { kind: 'unpause', assetId: ASSET, priorOutpoint: prior }, new Set([prior]), recorded
    )
    expect(ok).toBe(true)
  })

  it('accepts delegation: the next output may be locked to anyone', async () => {
    // counterparty names whoever holds authority next; the spend is the proof.
    const ok = await adminEntryAnchored(
      { kind: 'unpause', assetId: ASSET, priorOutpoint: prior, counterparty: '02' + 'ee'.repeat(32) },
      new Set([prior]), recorded
    )
    expect(ok).toBe(true)
  })

  it('refuses a prior that is not a recorded admin output', async () => {
    const other = 'ef'.repeat(32) + '.1'
    const ok = await adminEntryAnchored(
      { kind: 'unpause', assetId: ASSET, priorOutpoint: other }, new Set([other]), recorded
    )
    expect(ok).toBe(false)
  })

  it('refuses a recorded prior that this transaction does not spend', async () => {
    const ok = await adminEntryAnchored(
      { kind: 'unpause', assetId: ASSET, priorOutpoint: prior }, new Set(), recorded
    )
    expect(ok).toBe(false)
  })

  it('refuses a prior belonging to a different asset', async () => {
    const ok = await adminEntryAnchored(
      { kind: 'unpause', assetId: 'ff'.repeat(32) + '.0', priorOutpoint: prior }, new Set([prior]), recorded
    )
    expect(ok).toBe(false)
  })

  it('lets a genesis register through without a prior', async () => {
    expect(await adminEntryAnchored({ kind: 'register' }, new Set(), recorded)).toBe(true)
  })
})

describe('withAdminChainAnchor', () => {
  const buildTx = (): { beef: number[], outpoint: string } => {
    const key = PrivateKey.fromRandom()
    const src = new Transaction()
    src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
    return { beef: tx.toBEEF(), outpoint: `${src.id('hex')}.0` }
  }
  const payload = (details: Record<string, unknown>): number[] =>
    Utils.toArray(JSON.stringify({ admin: [{ index: 0, actionDetails: details }] }), 'utf8')

  const inner = { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [0], coinsToRetain: [0] }) } as any

  it('rejects a forged admin action before the inner manager sees it', async () => {
    const { beef, outpoint } = buildTx()
    const tm = withAdminChainAnchor(inner, store([]))
    await expect(
      tm.identifyAdmissibleOutputs(beef, [0], payload({ kind: 'unpause', assetId: ASSET, priorOutpoint: outpoint }))
    ).rejects.toThrow(/not anchored to the asset admin chain/)
  })

  it('passes a properly chained admin action through', async () => {
    const { beef, outpoint } = buildTx()
    const tm = withAdminChainAnchor(inner, store([`${ASSET}|${outpoint}`]))
    const res = await tm.identifyAdmissibleOutputs(
      beef, [0], payload({ kind: 'unpause', assetId: ASSET, priorOutpoint: outpoint })
    )
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('leaves transactions with no admin payload untouched', async () => {
    const { beef } = buildTx()
    const tm = withAdminChainAnchor(inner, store([]))
    const res = await tm.identifyAdmissibleOutputs(beef, [0], undefined)
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('ignores a malformed payload rather than throwing', () => {
    expect(parseAdminEntries(Utils.toArray('not json', 'utf8'))).toEqual([])
  })
})

// A16 — a freeze whose target has no token row folds to {amount: 0, owner: ''}
// and can never be reissued. Refuse it at admission instead (parity with Go
// TopicManager: same error string).
describe('freezeOutput requires a token row for the target', () => {
  const target = 'ef'.repeat(32) + '.1'

  it('freezeTargetHasRow answers from the store and fails closed on a malformed outpoint', async () => {
    const s = store([], [target])
    expect(await freezeTargetHasRow({ kind: 'freezeOutput', outpoint: target }, s)).toBe(true)
    expect(await freezeTargetHasRow({ kind: 'freezeOutput', outpoint: 'ff'.repeat(32) + '.0' }, s)).toBe(false)
    expect(await freezeTargetHasRow({ kind: 'freezeOutput', outpoint: 'not-an-outpoint' }, s)).toBe(false)
    expect(await freezeTargetHasRow({ kind: 'freezeOutput' }, s)).toBe(false)
  })

  it('does not apply to other kinds', async () => {
    expect(await freezeTargetHasRow({ kind: 'unfreezeOutput', outpoint: target }, store([]))).toBe(true)
  })

  const buildTx = (): { beef: number[], outpoint: string } => {
    const key = PrivateKey.fromRandom()
    const src = new Transaction()
    src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
    return { beef: tx.toBEEF(), outpoint: `${src.id('hex')}.0` }
  }
  const payload = (details: Record<string, unknown>): number[] =>
    Utils.toArray(JSON.stringify({ admin: [{ index: 0, actionDetails: details }] }), 'utf8')
  const inner = { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [0], coinsToRetain: [0] }) } as any

  it('refuses an anchored freeze of an outpoint with no token row (already spent)', async () => {
    const { beef, outpoint } = buildTx()
    const tm = withAdminChainAnchor(inner, store([`${ASSET}|${outpoint}`], []))
    await expect(
      tm.identifyAdmissibleOutputs(beef, [0], payload({ kind: 'freezeOutput', assetId: ASSET, priorOutpoint: outpoint, outpoint: target }))
    ).rejects.toThrow(FREEZE_NO_ROW(target))
  })

  it('still admits a freeze of a live coin', async () => {
    const { beef, outpoint } = buildTx()
    const tm = withAdminChainAnchor(inner, store([`${ASSET}|${outpoint}`], [target]))
    const res = await tm.identifyAdmissibleOutputs(
      beef, [0], payload({ kind: 'freezeOutput', assetId: ASSET, priorOutpoint: outpoint, outpoint: target })
    )
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('the error string matches the Go overlay byte for byte', () => {
    expect(FREEZE_NO_ROW(target)).toBe(`tm_mandala: freezeOutput targets an outpoint with no token row: ${target}`)
  })
})

// ──────────────────── §9.5 — the guard fails CLOSED, retryably ───────────────

describe('withAdminChainAnchor — a store fault is an InfraError, never a verdict', () => {
  const buildTx = (): { beef: number[], outpoint: string } => {
    const key = PrivateKey.fromRandom()
    const src = new Transaction()
    src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
    return { beef: tx.toBEEF(), outpoint: `${src.id('hex')}.0` }
  }
  const payload = (details: Record<string, unknown>): number[] =>
    Utils.toArray(JSON.stringify({ admin: [{ index: 0, actionDetails: details }] }), 'utf8')

  it('a throwing isAdminOutpoint refuses retryably instead of failing open on admin forgery', async () => {
    const calls = { n: 0 }
    const inner = { identifyAdmissibleOutputs: async () => { calls.n++; return { outputsToAdmit: [0], coinsToRetain: [] } } } as any
    const { beef, outpoint } = buildTx()
    const faulty: AdminChainStore = {
      isAdminOutpoint: async () => { throw new Error('mongo down') },
      hasTokenRow: async () => true
    }
    const err = await withAdminChainAnchor(inner, faulty)
      .identifyAdmissibleOutputs(beef, [0], payload({ kind: 'unpause', assetId: ASSET, priorOutpoint: outpoint }))
      .catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    // …and it is NOT the ERR_SHAPE the unanchored-admin reason would produce.
    expect((err as Error).message).not.toMatch(/not anchored to the asset admin chain/)
    expect(calls.n).toBe(0)
  })

  it('a throwing hasTokenRow on a freeze is infrastructure, not a content refusal', async () => {
    const inner = { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [0], coinsToRetain: [] }) } as any
    const { beef, outpoint } = buildTx()
    const target = 'ee'.repeat(32) + '.1'
    const faulty: AdminChainStore = {
      isAdminOutpoint: async () => true,
      hasTokenRow: async () => { throw new Error('mongo down') }
    }
    const err = await withAdminChainAnchor(inner, faulty)
      .identifyAdmissibleOutputs(beef, [0], payload({ kind: 'freezeOutput', assetId: ASSET, priorOutpoint: outpoint, outpoint: target }))
      .catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect((err as Error).message).not.toBe(FREEZE_NO_ROW(target))
  })

  it('a malformed outpoint stays a CONTENT refusal — bad data is not a fault', async () => {
    const inner = { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [0], coinsToRetain: [] }) } as any
    const { beef, outpoint } = buildTx()
    const err = await withAdminChainAnchor(inner, store([`${ASSET}|${outpoint}`], []))
      .identifyAdmissibleOutputs(beef, [0], payload({ kind: 'freezeOutput', assetId: ASSET, priorOutpoint: outpoint, outpoint: 'nonsense' }))
      .catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(false)
    expect((err as Error).message).toBe(FREEZE_NO_ROW('nonsense'))
  })
})
