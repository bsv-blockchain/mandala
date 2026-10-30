/**
 * issuer-v1 `admitReceipt` (design §9 B7): the handler credits only what the
 * host ledger recorded (settled / pending / refused), otherwise it submits the
 * receipt itself and requires a verified σ by K covering the output.
 */
import { describe, it, expect, vi } from 'vitest'
import { PrivateKey, Transaction, type WalletInterface } from '@bsv/sdk'
import type { ColorOverlayProvider, ProfileAssetContext } from '@bsv/color-permission-module'
import { ColorProviderError } from './providerError.js'
import { admitReceipt } from './profileReceipt.js'
import { MANDALA_PROFILE_ID } from './profile.js'
import { createHostLedger, type HostLedger } from './hostLedger.js'
import { memoryStorage } from './storage.js'
import { OVERLAY_KEY as K, signedSteak } from './__fixtures__/overlaySigner.js'
import { chain, ID } from './__fixtures__/signedChain.js'

const descriptor = { version: 1, params: { identityKey: K } }
const ctx = {
  assetId: ID,
  profileId: MANDALA_PROFILE_ID,
  descriptor,
  req: new Map([[MANDALA_PROFILE_ID, descriptor]]),
  declarationTx: new Transaction(),
  wallet: {} as unknown as WalletInterface,
  identityKey: new PrivateKey(2222).toPublicKey().toString(),
  originator: 'app.example'
} as unknown as ProfileAssetContext

const { T } = await chain()
const TXID = T.id('hex')
const view = (outputIndex = 0) => ({ assetId: ID, txid: TXID, outputIndex, tx: T, beef: T.toAtomicBEEF() })

function provider (submit: (topics: string[], beef: number[], ocv?: number[]) => Promise<Record<string, any>>): ColorOverlayProvider & { submit: ReturnType<typeof vi.fn> } {
  return {
    spendability: vi.fn(async () => { throw new Error('unused') }),
    admission: vi.fn(async () => { throw new Error('unused') }),
    submit: vi.fn(submit)
  } as any
}
const routed = (p: ColorOverlayProvider) => (k: string): ColorOverlayProvider => {
  expect(k).toBe(K)
  return p
}
const fresh = (): HostLedger => createHostLedger(memoryStorage())

describe('admitReceipt: host ledger', () => {
  it('a settled record credits settled without any submit', async () => {
    const ledger = fresh()
    await ledger.put({ v: 1, txid: TXID, assetId: ID, state: 'settled', outputs: [0], at: 1 })
    const p = provider(async () => ({}))
    expect(await admitReceipt(ctx, view(), routed(p), ledger)).toEqual({ credit: 'settled' })
    expect(p.submit).not.toHaveBeenCalled()
  })

  it('a pending record credits pending (color_offline) without any submit', async () => {
    const ledger = fresh()
    await ledger.put({ v: 1, txid: TXID, assetId: ID, state: 'pending', outputs: [0], at: 1 })
    const p = provider(async () => ({}))
    expect(await admitReceipt(ctx, view(), routed(p), ledger)).toEqual({ credit: 'pending' })
    expect(p.submit).not.toHaveBeenCalled()
  })

  it('a refused record throws', async () => {
    const ledger = fresh()
    await ledger.put({ v: 1, txid: TXID, assetId: ID, state: 'refused', outputs: [0], code: 'ERR_INPUT_SPENT', at: 1 })
    await expect(admitReceipt(ctx, view(), routed(provider(async () => ({}))), ledger)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it('a record for another output or another asset does not credit this one', async () => {
    const ledger = fresh()
    await ledger.put({ v: 1, txid: TXID, assetId: ID, state: 'pending', outputs: [1], at: 1 })
    const p = provider(async () => { throw new ColorProviderError('ERR_UNAVAILABLE', true, true, 'down') })
    await expect(admitReceipt(ctx, view(0), routed(p), ledger)).rejects.toMatchObject({ name: 'ColorProviderError' })
    expect(p.submit).toHaveBeenCalledTimes(1)
  })
})

describe('admitReceipt: not recorded by the host ⇒ own submit and σ', () => {
  it('a covering σ by K credits settled and is recorded', async () => {
    const ledger = fresh()
    const p = provider(async () => await signedSteak(TXID, { [`tm_color_${ID}`]: [0, 1] }))
    expect(await admitReceipt(ctx, view(), routed(p), ledger)).toEqual({ credit: 'settled' })
    expect(p.submit).toHaveBeenCalledWith([`tm_color_${ID}`], T.toAtomicBEEF())
    expect(await ledger.get(TXID)).toMatchObject({ state: 'settled', outputs: [0] })
  })

  it('σ that does not cover the output, σ by another key, or no σ ⇒ ProfileDataError', async () => {
    for (const steak of [
      await signedSteak(TXID, { [`tm_color_${ID}`]: [1] }),
      await signedSteak(TXID, { [`tm_color_${ID}`]: [0] }, new PrivateKey(9)),
      { [`tm_color_${ID}`]: { outputsToAdmit: [0], coinsToRetain: [] } }
    ]) {
      const ledger = fresh()
      await expect(admitReceipt(ctx, view(), routed(provider(async () => steak)), ledger)).rejects.toMatchObject({ name: 'ProfileDataError' })
      expect(await ledger.list()).toEqual([])
    }
  })

  it('a typed refusal or a transport failure propagates: no credit, never offline', async () => {
    for (const err of [new ColorProviderError('ERR_FROZEN', true, false, 'frozen'), new ColorProviderError('ERR_UNAVAILABLE', true, true, 'down')]) {
      await expect(admitReceipt(ctx, view(), routed(provider(async () => { throw err })), fresh())).rejects.toBe(err)
    }
  })

  it('S5: no overlay for K ⇒ the routing error, before anything else', async () => {
    const e = new Error('[ProfileParamsError] no Mandala overlay configured')
    await expect(admitReceipt(ctx, view(), () => { throw e }, fresh())).rejects.toBe(e)
  })

  it('a receipt for another asset is refused', async () => {
    await expect(admitReceipt(ctx, { ...view(), assetId: `${'ab'.repeat(32)}_0` }, routed(provider(async () => ({}))), fresh()))
      .rejects.toMatchObject({ name: 'ProfileDataError' })
  })
})
