/**
 * issuer-v1 `admitReceipt` (goal 4, D6, D7, C§7.1, Review Focus 2 and 6).
 *
 * The recipient wallet credits a Mandala receipt only after its own submit to
 * the overlay for K returns a verified attestation covering the received
 * outputs. A typed verdict (any code, retryable or not) refuses credit. Only a
 * transport failure answers `unavailable`, and only after every unanchored hop
 * passes the local Mandala policy checks.
 */
import { describe, it, expect, vi } from 'vitest'
import { PrivateKey, Transaction, type WalletInterface } from '@bsv/sdk'
import { ColorProviderError, ProfileParamsError, type ColorOverlayProvider, type ProfileAssetContext, type ReceiptGraph } from '@bsv/color-permission-module'
import { admitReceipt } from './profileReceipt.js'
import { createMandalaProfile, MANDALA_PROFILE_ID } from './profile.js'
import { attestationFromSteak, type Attestation } from './attestation.js'
import { signedSteak } from './__fixtures__/overlaySigner.js'
import {
  B_KEY, ID, K, PARENT_HOP, PARENT_OFFCHAIN, TIP_HOP, TIP_OFFCHAIN, plainOut, tipWith, tokenOut, type Hop
} from './__fixtures__/colorHops.js'

const TOPIC = `tm_color_${ID}`
const PARENT_BEEF = PARENT_HOP.atomicBEEF
const TIP_BEEF = TIP_HOP.atomicBEEF

const descriptor = { version: 1, params: { identityKey: K } }
const ctx = {
  assetId: ID,
  profileId: MANDALA_PROFILE_ID,
  descriptor,
  req: new Map(),
  declarationTx: new Transaction(),
  wallet: {} as unknown as WalletInterface,
  identityKey: B_KEY,
  originator: 'app.example'
} as unknown as ProfileAssetContext

const steakFor = async (txid: string, outputs: number[], priv?: PrivateKey): Promise<Record<string, any>> =>
  await signedSteak(txid, { [TOPIC]: outputs }, priv)
const attOf = (txid: string, steak: Record<string, any>): Attestation => attestationFromSteak(txid, ID, steak) as Attestation

const PARENT_STEAK = await steakFor(PARENT_HOP.txid, [0])
const TIP_STEAK = await steakFor(TIP_HOP.txid, [0, 1])
const ATT_PARENT = attOf(PARENT_HOP.txid, PARENT_STEAK)
const ATT_TIP = attOf(TIP_HOP.txid, TIP_STEAK)

const GRAPH2: ReceiptGraph = {
  assetId: ID,
  tip: TIP_HOP,
  outputIndexes: [0, 1],
  pending: [PARENT_HOP, TIP_HOP],
  attestations: []
}
const ATTESTED_TIP: ReceiptGraph = { ...GRAPH2, pending: [], attestations: [ATT_TIP] }

type Submit = (topics: string[], beef: number[], offChainValues?: number[]) => Promise<Record<string, any>>
function fakeProvider (submit: Submit): ColorOverlayProvider & { submit: ReturnType<typeof vi.fn> } {
  return {
    spendability: vi.fn(async () => { throw new Error('unused') }),
    admission: vi.fn(async () => { throw new Error('unused') }),
    submit: vi.fn(submit)
  } as any
}
/** Answers each submit with the signed STEAK of the submitted hop. */
const answering = (steaks: Record<string, Record<string, any>>, hops: Hop[]): Submit => async (_t, beef) => {
  const hop = hops.find(h => h.atomicBEEF === beef || h.atomicBEEF.every((b, i) => b === beef[i]))
  if (hop === undefined) throw new Error('unknown beef')
  return steaks[hop.txid]
}
const transport = (): ColorProviderError => new ColorProviderError('ERR_UNAVAILABLE', true, true, 'mandala overlay unreachable: fetch failed')
const typed = (code: string, retryable: boolean): ColorProviderError =>
  new ColorProviderError(code, retryable, false, `mandala overlay refused (${code}${retryable ? ', retryable' : ''}): x`)

const STEAKS = { [PARENT_HOP.txid]: PARENT_STEAK, [TIP_HOP.txid]: TIP_STEAK }

describe('admitReceipt (issuer-v1, D6/D7)', () => {
  it('submits parents first, tip last, and returns the verified attestations', async () => {
    const prov = fakeProvider(answering(STEAKS, [PARENT_HOP, TIP_HOP]))
    const r = await admitReceipt(ctx, GRAPH2, () => prov)
    expect(prov.submit.mock.calls.map(c => c[0])).toEqual([[TOPIC], [TOPIC]])
    expect(prov.submit.mock.calls.map(c => c[1])).toEqual([PARENT_BEEF, TIP_BEEF])
    expect(prov.submit.mock.calls[0][2]).toEqual(PARENT_OFFCHAIN)
    expect(prov.submit.mock.calls[1][2]).toEqual(TIP_OFFCHAIN)
    expect(r).toEqual({ status: 'admitted', attestations: [ATT_PARENT, ATT_TIP] })
  })

  it('a transport failure stops submitting and answers unavailable (policy-clean hops)', async () => {
    const prov = fakeProvider(async () => { throw transport() })
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).resolves.toEqual({ status: 'unavailable' })
    expect(prov.submit).toHaveBeenCalledTimes(1)
  })

  it('a transport failure on the tip after an admitted parent answers unavailable', async () => {
    let n = 0
    const prov = fakeProvider(async () => { if (n++ === 0) return PARENT_STEAK; throw transport() })
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).resolves.toEqual({ status: 'unavailable' })
    expect(prov.submit).toHaveBeenCalledTimes(2)
  })

  it('typed retryable verdict refuses credit (ERR_FROZEN)', async () => {
    const prov = fakeProvider(async () => { throw typed('ERR_FROZEN', true) })
    const err = await admitReceipt(ctx, GRAPH2, () => prov).catch(e => e)
    expect(err.name).toBe('ColorProviderError')
    expect(err.message).toContain('(ERR_FROZEN, retryable)')
    expect(prov.submit).toHaveBeenCalledTimes(1)
  })

  it('a typed final verdict (ERR_CONSERVATION) refuses credit', async () => {
    const prov = fakeProvider(async () => { throw typed('ERR_CONSERVATION', false) })
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).rejects.toMatchObject({ name: 'ColorProviderError', code: 'ERR_CONSERVATION' })
  })

  it('a non-provider error from submit refuses credit (never treated as transport)', async () => {
    const prov = fakeProvider(async () => { throw new TypeError('boom') })
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).rejects.toThrow('boom')
  })

  it('a STEAK attestation signed by another key ⇒ AttestationEvidenceError', async () => {
    const forged = await steakFor(PARENT_HOP.txid, [0], new PrivateKey(7777))
    const prov = fakeProvider(answering({ ...STEAKS, [PARENT_HOP.txid]: forged }, [PARENT_HOP, TIP_HOP]))
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).rejects.toMatchObject({ name: 'AttestationEvidenceError' })
    expect(prov.submit).toHaveBeenCalledTimes(1)
  })

  it('a STEAK with no signed entry for the topic ⇒ AttestationEvidenceError', async () => {
    const prov = fakeProvider(async () => ({ [TOPIC]: { outputsToAdmit: [], coinsToRetain: [] } }))
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).rejects.toMatchObject({ name: 'AttestationEvidenceError' })
  })

  it('a STEAK attestation for another txid does not verify ⇒ AttestationEvidenceError', async () => {
    const prov = fakeProvider(async () => TIP_STEAK)
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).rejects.toMatchObject({ name: 'AttestationEvidenceError' })
  })

  it('tip attestation covers [0] but graph.outputIndexes [0, 1] ⇒ AttestationEvidenceError', async () => {
    const partial = await steakFor(TIP_HOP.txid, [0])
    const prov = fakeProvider(answering({ ...STEAKS, [TIP_HOP.txid]: partial }, [PARENT_HOP, TIP_HOP]))
    await expect(admitReceipt(ctx, GRAPH2, () => prov)).rejects.toMatchObject({ name: 'AttestationEvidenceError' })
  })

  it('pending [] (attested tip) ⇒ the tip is resubmitted once; verified ⇒ admitted', async () => {
    const prov = fakeProvider(async () => TIP_STEAK)
    const r = await admitReceipt(ctx, ATTESTED_TIP, () => prov)
    expect(prov.submit).toHaveBeenCalledTimes(1)
    expect(prov.submit.mock.calls[0]).toEqual([[TOPIC], TIP_HOP.atomicBEEF, TIP_HOP.offChainValues])
    expect(r).toEqual({ status: 'admitted', attestations: [ATT_TIP] })
  })

  it('pending [] and the tip resubmit answers ERR_FROZEN ⇒ no credit despite graph.attestations (D6)', async () => {
    const prov = fakeProvider(async () => { throw typed('ERR_FROZEN', true) })
    await expect(admitReceipt(ctx, ATTESTED_TIP, () => prov)).rejects.toMatchObject({ name: 'ColorProviderError', code: 'ERR_FROZEN' })
  })

  it('pending [] and a transport failure ⇒ hop checks run on the tip ⇒ unavailable', async () => {
    const prov = fakeProvider(async () => { throw transport() })
    await expect(admitReceipt(ctx, ATTESTED_TIP, () => prov)).resolves.toEqual({ status: 'unavailable' })
    const bad = { ...ATTESTED_TIP, tip: { ...TIP_HOP, offChainValues: PARENT_OFFCHAIN } }
    await expect(admitReceipt(ctx, bad, () => prov)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it('verified graph.attestations for the tip complete the coverage', async () => {
    const att1 = attOf(TIP_HOP.txid, await steakFor(TIP_HOP.txid, [1]))
    const only0 = await steakFor(TIP_HOP.txid, [0])
    const prov = fakeProvider(async () => only0)
    const r = await admitReceipt(ctx, { ...ATTESTED_TIP, attestations: [att1] }, () => prov)
    expect(r).toEqual({ status: 'admitted', attestations: [attOf(TIP_HOP.txid, only0), att1] })
  })

  it('an unverifiable graph attestation never completes the coverage', async () => {
    const att1 = attOf(TIP_HOP.txid, await steakFor(TIP_HOP.txid, [1], new PrivateKey(7777)))
    const prov = fakeProvider(async () => await steakFor(TIP_HOP.txid, [0]))
    await expect(admitReceipt(ctx, { ...ATTESTED_TIP, attestations: [att1] }, () => prov))
      .rejects.toMatchObject({ name: 'AttestationEvidenceError' })
  })

  it('unconfigured K ⇒ ProfileParamsError, submit not called (S5)', async () => {
    const prov = fakeProvider(async () => TIP_STEAK)
    const none = (k: string): ColorOverlayProvider => { throw new ProfileParamsError(`no Mandala overlay configured for ${k}`) }
    await expect(admitReceipt(ctx, GRAPH2, none)).rejects.toMatchObject({ name: 'ProfileParamsError' })
    const handler = createMandalaProfile({ overlays: [] })
    await expect(handler.admitReceipt!(ctx, GRAPH2)).rejects.toMatchObject({ name: 'ProfileParamsError' })
    expect(prov.submit).not.toHaveBeenCalled()
  })

  it('a graph for another asset ⇒ ProfileDataError, no submit', async () => {
    const prov = fakeProvider(async () => TIP_STEAK)
    await expect(admitReceipt(ctx, { ...GRAPH2, assetId: `${'ab'.repeat(32)}_0` }, () => prov)).rejects.toMatchObject({ name: 'ProfileDataError' })
    expect(prov.submit).not.toHaveBeenCalled()
  })

  it('pending entry with offChainValues [] ⇒ ProfileDataError before any submit (C42)', async () => {
    const prov = fakeProvider(async () => PARENT_STEAK)
    const g = { ...GRAPH2, pending: [PARENT_HOP, { ...TIP_HOP, offChainValues: [] }], tip: { ...TIP_HOP, offChainValues: [] } }
    await expect(admitReceipt(ctx, g, () => prov)).rejects.toMatchObject({ name: 'ProfileDataError' })
    expect(prov.submit).not.toHaveBeenCalled()
  })

  it('offline burn hop ⇒ ProfileDataError', async () => {
    const burn = tipWith([tokenOut({ amount: 9n }), plainOut(800)])
    const prov = fakeProvider(async () => { throw transport() })
    const g: ReceiptGraph = { assetId: ID, tip: burn, outputIndexes: [0], pending: [PARENT_HOP, burn], attestations: [] }
    await expect(admitReceipt(ctx, g, () => prov)).rejects.toThrow(/does not conserve/)
    await expect(admitReceipt(ctx, g, () => prov)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })

  it('offline 2-sat hop ⇒ ProfileDataError', async () => {
    const fat = tipWith([tokenOut({ amount: 10n, sats: 2 }), plainOut(800)])
    const prov = fakeProvider(async () => { throw transport() })
    const g: ReceiptGraph = { assetId: ID, tip: fat, outputIndexes: [0], pending: [PARENT_HOP, fat], attestations: [] }
    const err = await admitReceipt(ctx, g, () => prov).catch(e => e)
    expect(err.name).toBe('ProfileDataError')
    expect(err.message).toMatch(/1 satoshi/)
  })

  it('offline envelope missing an output ⇒ ProfileDataError', async () => {
    const short = tipWith([tokenOut({ amount: 6n }), tokenOut({ amount: 4n }), plainOut(800)], [0])
    const prov = fakeProvider(async () => { throw transport() })
    const g: ReceiptGraph = { assetId: ID, tip: short, outputIndexes: [0, 1], pending: [PARENT_HOP, short], attestations: [] }
    await expect(admitReceipt(ctx, g, () => prov)).rejects.toMatchObject({ name: 'ProfileDataError' })
  })
})
