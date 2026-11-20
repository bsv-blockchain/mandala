/**
 * The Mandala issuer-v1 handler on the REAL `@bsv/color-permission-module`
 * (0.2.0 at ts-stack 993c98b, B7 + #1338), registered on a wallet-toolbox
 * `WalletPermissionsManager` over the lib's FakeWallet (profileHolder.ts):
 *
 * - the handler is the module's `RequiredProfileHandler` (compile time);
 * - receipts: `admitReceipt` credits `settled` (host verified online, or its
 *   own submit), `pending` (offline COVER, `color_offline` until the host's
 *   `markSettled`), and nothing for a refused or unverifiable receipt;
 * - a plain-noSend hand-over keeps its token change inside the transaction,
 *   tagged `color_offline`, and is never submitted by the module;
 * - the Mandala provider answers spendability (and the asset's deploy) from
 *   the host ledger while the overlay is unreachable;
 * - #1338: every output the module files carries its `p color <sha256(suffix)>`
 *   tag, an output without it is never selected, and the module hands the
 *   wallet the selected inputs' source transactions in `inputBEEF`.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Beef, PrivateKey, Transaction, type CreateActionArgs } from '@bsv/sdk'
import { maybeDecryptMetadata } from '@bsv/wallet-toolbox-client'
import type { RequiredProfileHandler } from '@bsv/color-permission-module'
import { configureMandala, MANDALA_PROFILE_ID } from './constants.js'
import { configureStorage, memoryStorage } from './storage.js'
import { clearAdminAuthGates } from './adminAuthGate.js'
import { clearDeployTxCache } from './overlayLookup.js'
import { listAdminAssets } from './assets.js'
import { issueTokens, registerAsset } from './issuerOps.js'
import { payoutTokens } from './payout.js'
import { deliverHandover, sendHandover, settleHandover } from './handover.js'
import { receiveHandovers } from './receive.js'
import { settleReceipts } from './receiptSettle.js'
import { assetTag, colorBasket } from './naming.js'
import { decodeToken } from './brc162.js'
import { createMandalaProfile } from './profile.js'
import { createHostLedger } from './hostLedger.js'
import { FakeWallet } from './__fixtures__/fakeWallet.js'
import { fakeMandalaOverlay, type FakeMandalaOverlay } from './__fixtures__/fakeMandalaOverlay.js'
import { heldAmount, makeProfileHolder, messageBus, suffixTag, type ProfileHolder } from './__fixtures__/profileHolder.js'

const URL_ = 'https://mandala.test'
const PRIV = new PrivateKey(5555)
const K = PRIV.toPublicKey().toString()
const SUFFIX_TAG = /^p color [0-9a-f]{64}$/
const DESCRIPTOR = { version: 1, params: { identityKey: K } }

let overlay: FakeMandalaOverlay
let bus: ReturnType<typeof messageBus>

beforeEach(() => {
  configureStorage(memoryStorage())
  clearAdminAuthGates()
  clearDeployTxCache()
  overlay = fakeMandalaOverlay({ priv: PRIV })
  vi.stubGlobal('fetch', overlay.fetch)
  configureMandala({ overlayUrl: URL_, overlayIdentityKey: K })
  bus = messageBus()
})

afterEach(() => { vi.unstubAllGlobals() })

const holder = (): ProfileHolder => makeProfileHolder({ K, url: URL_, fetch: overlay.fetch })
const receive = async (h: ProfileHolder) => await receiveHandovers({ wallet: h.wallet, messageBoxClient: bus(h.identityKey), ledger: h.ledger, markSettled: h.markSettled })
const send = async (from: ProfileHolder, to: ProfileHolder, assetId: string, amount: bigint) => {
  const h = await sendHandover({ wallet: from.wallet, hostWallet: from.hostWallet, ledger: from.ledger, identityKey: from.identityKey, assetId, amount, recipientKey: to.identityKey })
  await deliverHandover({ messageBoxClient: bus(from.identityKey), recipientKey: to.identityKey, handover: h })
  return h
}

/** register → issue 1500 → pay 1000 to `to`, received online (settled). */
async function funded (to: ProfileHolder): Promise<string> {
  const issuer = new FakeWallet(new PrivateKey(1111))
  const wallet = issuer.asWallet()
  const { assetId } = await registerAsset({ wallet, identityKey: issuer.identityKey, label: 'Test Dollar', ticker: 'TUSD', decimals: 2 })
  await issueTokens({ wallet, identityKey: issuer.identityKey, asset: (await listAdminAssets(wallet)).find(a => a.assetId === assetId)!, amount: 1500n })
  const asset = (await listAdminAssets(wallet)).find(a => a.assetId === assetId)!
  await payoutTokens({ wallet, identityKey: issuer.identityKey, asset, amount: 1000n, recipientKey: to.identityKey, messageBoxClient: bus(issuer.identityKey) })
  const r = await receive(to)
  expect(r.failed).toEqual([])
  expect(r.accepted[0]).toMatchObject({ amount: 1000n, offline: false })
  return assetId
}

/** The stored output `outpoint` of `h`'s underlying wallet, with its decrypted custody. */
async function stored (h: ProfileHolder, outpoint: string): Promise<{ tags: string[], basket?: string, custody: { assetId: string, derivationSuffix: string } }> {
  const o = h.fake.outputs.get(outpoint)
  if (o == null) throw new Error(`no stored output ${outpoint}`)
  const custody = JSON.parse(await maybeDecryptMetadata(h.hostWallet, o.customInstructions ?? ''))
  return { tags: [...o.tags], ...(o.basket != null ? { basket: o.basket } : {}), custody }
}

/** The balance view (`p color balance <assetTag>`), optionally only `color_offline`. */
async function balance (h: ProfileHolder, assetId: string, offlineOnly = false): Promise<string> {
  const r = await h.wallet.listOutputs({ basket: `p color balance ${assetTag(assetId)}`, ...(offlineOnly ? { tags: ['color_offline'] } : {}) })
  return String(r.totalOutputs)
}

const receiptArgs = (h: { tx: number[], receipt: unknown }, assetId: string) => ({
  tx: h.tx,
  description: 'Receive Mandala tokens',
  outputs: [{
    outputIndex: 0,
    protocol: 'basket insertion' as const,
    insertionRemittance: { basket: colorBasket(assetId), customInstructions: JSON.stringify(h.receipt) }
  }]
})

describe('the issuer-v1 handler is the module\'s RequiredProfileHandler', () => {
  it('createMandalaProfile returns a RequiredProfileHandler the module accepts', () => {
    const handler: RequiredProfileHandler = createMandalaProfile({ overlays: [{ identityKey: K, url: URL_ }], ledger: createHostLedger(memoryStorage()) })
    expectTypeOf(createMandalaProfile).returns.toEqualTypeOf<RequiredProfileHandler>()
    expectTypeOf(handler.admitReceipt).toEqualTypeOf<RequiredProfileHandler['admitReceipt']>()
    expect(handler).toMatchObject({ id: MANDALA_PROFILE_ID, versions: [1], sendPolicy: 'plain-nosend', operations: ['transfer'] })
    expect(typeof handler.admitReceipt).toBe('function')
    // The real module registers it (it throws on a key/id mismatch or a missing store).
    expect(holder().color.capabilities).toEqual({ 'brc207-color': '4' })
  })
})

describe('receipts through admitReceipt', () => {
  it('a receipt the host verified online is credited settled, filed with its suffix tag', async () => {
    const a = holder()
    const assetId = await funded(a)
    const [coin] = await a.coins(assetId)
    expect(coin).toMatchObject({ amount: 1000n, offline: false })
    const s = await stored(a, coin.outpoint)
    expect(s.basket).toBe(colorBasket(assetId))
    expect(s.tags).not.toContain('color_offline')
    expect(s.tags.filter(t => SUFFIX_TAG.test(t))).toEqual([suffixTag(s.custody.derivationSuffix)])
    expect((await a.ledger.get(coin.outpoint.split('.')[0]))?.state).toBe('settled')
    expect(await balance(a, assetId)).toBe('1000')
    expect(await balance(a, assetId, true)).toBe('0')
  })

  it('an offline receipt is credited pending (color_offline) until the host settles and calls markSettled', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    overlay.offline = true
    const h1 = await send(a, b, assetId, 400n)
    const r = await receive(b)
    expect(r.failed).toEqual([])
    expect(r.accepted[0]).toMatchObject({ txid: h1.txid, amount: 400n, offline: true })
    expect(await b.coins(assetId)).toEqual([{ outpoint: `${h1.txid}.0`, amount: 400n, offline: true }])
    const s = await stored(b, `${h1.txid}.0`)
    expect(s.tags).toContain('color_offline')
    expect(s.tags.filter(t => SUFFIX_TAG.test(t))).toEqual([suffixTag(h1.receipt.derivationSuffix)])
    expect(await balance(b, assetId, true)).toBe('400')

    overlay.offline = false
    expect((await settleReceipts({ ledger: b.ledger, markSettled: b.markSettled })).map(x => x.status)).toEqual(['admitted'])
    expect(await b.coins(assetId)).toEqual([{ outpoint: `${h1.txid}.0`, amount: 400n, offline: false }])
    expect(await balance(b, assetId, true)).toBe('0')
    expect(await balance(b, assetId)).toBe('400')
    // markSettled is a module record: the wallet's stored tag is untouched, the views hide it.
    expect(b.fake.outputs.get(`${h1.txid}.0`)?.tags).toContain('color_offline')
    await b.markSettled(h1.txid) // idempotent
    expect(await balance(b, assetId, true)).toBe('0')
  })

  it('a receipt the host ledger records refused credits nothing', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    overlay.offline = true
    const h1 = await send(a, b, assetId, 400n)
    await b.ledger.put({ v: 1, txid: h1.txid, assetId, state: 'refused', outputs: [0], code: 'ERR_CONSERVATION', at: Date.now() })
    overlay.offline = false // the deploy resolves; the ledger verdict alone decides
    await expect(b.wallet.internalizeAction(receiptArgs(h1, assetId))).rejects.toThrow(/refused .* for good/)
    expect(await b.coins(assetId)).toEqual([])
    expect(heldAmount(b, assetId)).toBe(0n)
  })

  it('an unrecorded receipt credits nothing while the overlay cannot admit it', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    overlay.offline = true
    const h1 = await send(a, b, assetId, 400n)
    // Online, but the overlay never admitted the hand-over (the sender has not settled it).
    overlay.offline = false
    overlay.refuse('ERR_LINKAGE', 400, false)
    await expect(b.wallet.internalizeAction(receiptArgs(h1, assetId))).rejects.toThrow()
    expect(await b.coins(assetId)).toEqual([])
    expect(await b.ledger.get(h1.txid)).toBeUndefined()
  })

  it('an unrecorded receipt the overlay admitted is credited settled through the handler\'s own submit', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    const h1 = await send(a, b, assetId, 400n)
    expect((await settleHandover({ wallet: a.wallet, handover: h1, assetId, overlayIdentityKey: K, ledger: a.ledger, markSettled: a.markSettled })).status).toBe('admitted')
    // An app path: no lib receive, so nothing in b's ledger yet.
    await b.wallet.internalizeAction(receiptArgs(h1, assetId))
    expect(await b.coins(assetId)).toEqual([{ outpoint: `${h1.txid}.0`, amount: 400n, offline: false }])
    expect((await b.ledger.get(h1.txid))?.state).toBe('settled')
  })
})

describe('plain-noSend hand-over', () => {
  it('keeps token change inside the transaction, tagged color_offline with its suffix tag, and never submits', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    const [payout] = await a.coins(assetId)
    const created: CreateActionArgs[] = []
    const createAction = a.fake.createAction.bind(a.fake)
    a.fake.createAction = async args => { created.push(args); return await createAction(args) }
    const before = overlay.submissions.length

    const h = await send(a, b, assetId, 400n)
    const tx = Transaction.fromAtomicBEEF(h.tx)
    const tokens = tx.outputs.map((o, i) => decodeToken(o.lockingScript, h.txid, i)).map(d => d?.amount ?? null)
    expect(tokens.filter(t => t != null)).toEqual([400n, 600n])
    expect(tokens[0]).toBe(400n)
    // The change is kept in this tx (no split), filed and pending.
    const change = await stored(a, `${h.txid}.1`)
    expect(change.basket).toBe(colorBasket(assetId))
    expect(change.tags).toContain('color_offline')
    expect(change.tags.filter(t => SUFFIX_TAG.test(t))).toEqual([suffixTag(change.custody.derivationSuffix)])
    expect(await a.coins(assetId)).toEqual([{ outpoint: `${h.txid}.1`, amount: 600n, offline: true }])
    // Never submitted by the module; the wallet holds it as noSend.
    expect(overlay.submissions.length).toBe(before)
    expect([...a.fake.actions.values()].find(x => x.txid === h.txid)?.status).toBe('nosend')
    // One wallet createAction: noSend, the selected payout coin, its source in inputBEEF.
    expect(created).toHaveLength(1)
    expect(created[0].options?.noSend).toBe(true)
    expect(created[0].inputs?.map(i => i.outpoint)).toEqual([payout.outpoint])
    const source = Beef.fromBinary(created[0].inputBEEF!).findTxid(payout.outpoint.split('.')[0])
    expect(source != null && !source.isTxidOnly).toBe(true)

    // The host settles after the ACK; markSettled clears the pending view.
    expect((await settleHandover({ wallet: a.wallet, handover: h, assetId, overlayIdentityKey: K, ledger: a.ledger, markSettled: a.markSettled })).status).toBe('admitted')
    expect(overlay.submissions.length).toBe(before + 1)
    expect(await a.coins(assetId)).toEqual([{ outpoint: `${h.txid}.1`, amount: 600n, offline: false }])
  })

  it('an output without its suffix tag is never selected (#1338), and nothing is reserved', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    const [coin] = await a.coins(assetId)
    const o = a.fake.outputs.get(coin.outpoint)!
    o.tags = o.tags.filter(t => !SUFFIX_TAG.test(t))
    await expect(sendHandover({ wallet: a.wallet, hostWallet: a.hostWallet, ledger: a.ledger, identityKey: a.identityKey, assetId, amount: 400n, recipientKey: b.identityKey }))
      .rejects.toThrow(/insufficient spendable balance/)
    expect(o.reservedBy).toBeUndefined()
    expect(o.spent).toBe(false)
    expect(a.fake.pending.size).toBe(0)
  })
})

describe('the Mandala provider answers from the host ledger offline', () => {
  it('spendability lists recorded pending and settled outputs, never unrecorded or refused ones', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    const [payout] = await a.coins(assetId)
    overlay.offline = true
    const h1 = await send(a, b, assetId, 400n)
    const provider = a.handler.provider!(assetId, DESCRIPTOR)
    const unknown = `${'ab'.repeat(32)}.0`
    const listed = (await provider.spendability(assetId, [`${h1.txid}.1`, `${h1.txid}.0`, unknown, payout.outpoint])) as any
    expect(listed.outputs.map((x: any) => `${String(x.txid)}.${String(x.outputIndex)}`)).toEqual([`${h1.txid}.1`, payout.outpoint])
    await a.ledger.put({ v: 1, txid: h1.txid, assetId, state: 'refused', own: true, outputs: [], code: 'ERR_CONSERVATION', at: Date.now() })
    const after = (await provider.spendability(assetId, [`${h1.txid}.1`])) as any
    expect(after.outputs).toEqual([])
  })

  it('a chained offline hand-over: pending change funds the next one, every input vouched by the ledger', async () => {
    const a = holder()
    const b = holder()
    const c = holder()
    const assetId = await funded(a)
    overlay.offline = true
    const h1 = await send(a, b, assetId, 400n)
    const h2 = await send(a, c, assetId, 250n)
    expect(Transaction.fromAtomicBEEF(h2.tx).inputs[0].sourceTXID ?? Transaction.fromAtomicBEEF(h2.tx).inputs[0].sourceTransaction?.id('hex')).toBe(h1.txid)
    expect(await a.coins(assetId)).toEqual([{ outpoint: `${h2.txid}.1`, amount: 350n, offline: true }])
    expect((await receive(c)).accepted[0]).toMatchObject({ txid: h2.txid, amount: 250n, offline: true })
    expect(overlay.offlineAttempts.length).toBeGreaterThan(0)
  })

  it('a first offline receipt of an unseen asset resolves its deploy from the ledger; nothing else is served', async () => {
    const a = holder()
    const c = holder()
    const assetId = await funded(a)
    overlay.offline = true
    const h1 = await send(a, c, assetId, 300n)
    expect((await receive(c)).accepted[0]).toMatchObject({ txid: h1.txid, offline: true })
    const provider = c.handler.provider!(assetId, DESCRIPTOR)
    const [txid, vout] = assetId.split('_')
    const deploy = (await provider.admission(assetId, [`${txid}.${vout}`])) as any
    expect(deploy.outputs).toHaveLength(1)
    expect(Transaction.fromBEEF(deploy.outputs[0].beef, txid).id('hex')).toBe(txid)
    await expect(provider.admission(assetId, [`${h1.txid}.0`])).rejects.toThrow(/ColorProviderError/)
    // A fresh host with an empty ledger cannot resolve it offline (fail closed).
    const d = holder()
    await expect(d.handler.provider!(assetId, DESCRIPTOR).admission(assetId, [`${txid}.${vout}`])).rejects.toThrow(/ColorProviderError/)
  })
})
