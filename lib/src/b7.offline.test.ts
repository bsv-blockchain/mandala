/**
 * Offline parity with @bsv/mandala 0.4.1 under the B7 module (design §9 B7):
 * the Mandala provider vouches for host-recorded outputs when the overlay is
 * unreachable or has not admitted yet, so a holder hands over offline, its
 * pending change funds a second offline hand-over, recipients credit offline
 * on COVER evidence, and everything settles once online. An output the host
 * never recorded is refused offline (fail closed).
 *
 * Holders are FakeWallets behind the B7 module stand-in (fakeB7Color.ts) with
 * the real issuer-v1 handler; the overlay is the in-process fake (linkage,
 * conservation and spend rules, σ by the C.0 key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { configureMandala } from './constants.js'
import { configureStorage, memoryStorage } from './storage.js'
import { clearAdminAuthGates } from './adminAuthGate.js'
import { clearDeployTxCache } from './overlayLookup.js'
import { listAdminAssets } from './assets.js'
import { issueTokens, registerAsset } from './issuerOps.js'
import { payoutTokens } from './payout.js'
import { deliverHandover, sendHandover, settleHandover } from './handover.js'
import { receiveHandovers } from './receive.js'
import { settleReceipts } from './receiptSettle.js'
import { FakeWallet } from './__fixtures__/fakeWallet.js'
import { fakeMandalaOverlay, type FakeMandalaOverlay } from './__fixtures__/fakeMandalaOverlay.js'
import { heldAmount, makeB7Holder, messageBus, type B7Holder } from './__fixtures__/b7Holder.js'

const URL_ = 'https://mandala.test'
const PRIV = new PrivateKey(5555)
const K = PRIV.toPublicKey().toString()

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

const holder = (storage = memoryStorage()): B7Holder => makeB7Holder({ K, url: URL_, fetch: overlay.fetch, storage })
const receive = async (h: B7Holder) => await receiveHandovers({ wallet: h.wallet, messageBoxClient: bus(h.identityKey), ledger: h.ledger, markSettled: h.markSettled })
const send = async (from: B7Holder, to: B7Holder, assetId: string, amount: bigint) => {
  const h = await sendHandover({ wallet: from.wallet, hostWallet: from.hostWallet, ledger: from.ledger, identityKey: from.identityKey, assetId, amount, recipientKey: to.identityKey })
  await deliverHandover({ messageBoxClient: bus(from.identityKey), recipientKey: to.identityKey, handover: h })
  return h
}

/** register → issue 1500 → pay 1000 to `to`, received online (settled). */
async function funded (to: B7Holder): Promise<string> {
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

describe('B7 offline hand-overs through the host ledger', () => {
  it('a sender hands over offline; its pending change funds a second offline hand-over; recipients credit offline; all settle online', async () => {
    const a = holder()
    const b = holder()
    const c = holder()
    const assetId = await funded(a)
    overlay.offline = true

    // (1) offline hand-over A → B (input: the settled payout coin, vouched by A's ledger)
    const h1 = await send(a, b, assetId, 400n)
    expect(await a.ledger.get(h1.txid)).toMatchObject({ state: 'pending' })
    expect(h1.body.admissions.length).toBe(1) // σ of the payout tip, from A's ledger
    const r1 = await receive(b)
    expect(r1.failed).toEqual([])
    expect(r1.accepted[0]).toMatchObject({ txid: h1.txid, amount: 400n, offline: true })
    expect(await b.coins(assetId)).toEqual([expect.objectContaining({ amount: 400n, offline: true })])

    // (2) A's pending change (600) funds a second offline hand-over A → C
    const h2 = await send(a, c, assetId, 250n)
    expect(h2.body.linkage.map(l => l.txid)).toEqual([h1.txid, h2.txid]) // the unadmitted parent travels
    const r2 = await receive(c)
    expect(r2.failed).toEqual([])
    expect(r2.accepted[0]).toMatchObject({ txid: h2.txid, amount: 250n, offline: true })
    expect(await c.ledger.get(h2.txid)).toMatchObject({ state: 'pending' })
    expect((await c.ledger.get(h2.txid))?.submits?.map(s => s.txid)).toEqual([h1.txid, h2.txid])

    // (3) B forwards its pending coin offline to C
    const h3 = await send(b, c, assetId, 100n)
    const r3 = await receive(c)
    expect(r3.failed).toEqual([])
    expect(r3.accepted[0]).toMatchObject({ txid: h3.txid, offline: true })
    expect(overlay.submissions.length).toBe(3) // deploy, issue, payout only: nothing was submitted offline

    // (4) online: recipients settle their chains, senders settle after the ACK
    overlay.offline = false
    const sc = await settleReceipts({ ledger: c.ledger, markSettled: c.markSettled })
    expect(sc.map(x => x.status)).toEqual(['admitted', 'admitted'])
    expect((await settleReceipts({ ledger: b.ledger, markSettled: b.markSettled })).map(x => x.status)).toEqual(['admitted'])
    for (const [from, h] of [[a, h1], [a, h2], [b, h3]] as const) {
      const s = await settleHandover({ wallet: from.wallet, handover: h, assetId, overlayIdentityKey: K, ledger: from.ledger, markSettled: from.markSettled })
      expect(s.status).toBe('admitted')
    }
    for (const h of [a, b, c]) expect((await h.coins(assetId)).every(x => !x.offline)).toBe(true)
    expect(heldAmount(a, assetId)).toBe(350n)
    expect(heldAmount(b, assetId)).toBe(300n)
    expect(heldAmount(c, assetId)).toBe(350n)
    expect(overlay.admitted.has(`${h3.txid}.0`)).toBe(true)
  })

  it('an input the host never recorded is refused offline (fail closed), and nothing is held', async () => {
    const storage = memoryStorage()
    const a = holder(storage)
    const b = holder()
    const assetId = await funded(a)
    // The host forgets its records (e.g. a fresh ledger): the payout coin is unrecorded.
    for (const k of await storage.keys('')) await storage.removeItem(k)
    overlay.offline = true
    await expect(sendHandover({ wallet: a.wallet, hostWallet: a.hostWallet, ledger: a.ledger, identityKey: a.identityKey, assetId, amount: 400n, recipientKey: b.identityKey }))
      .rejects.toThrow(/not spendable/)
    expect(await a.coins(assetId)).toEqual([expect.objectContaining({ amount: 1000n })]) // still selectable later
    // Online, the overlay lists it and the same send works.
    overlay.offline = false
    const h = await send(a, b, assetId, 400n)
    expect(h.txid).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a refused hand-over is never vouched for again', async () => {
    const a = holder()
    const b = holder()
    const assetId = await funded(a)
    overlay.offline = true
    const h1 = await send(a, b, assetId, 400n)
    overlay.offline = false
    overlay.refuse('ERR_CONSERVATION', 400, false)
    const s = await settleHandover({ wallet: a.wallet, handover: h1, assetId, overlayIdentityKey: K, ledger: a.ledger, markSettled: a.markSettled })
    expect(s).toEqual({ status: 'refused', code: 'ERR_CONSERVATION' })
    expect((await a.ledger.get(h1.txid))?.state).toBe('refused')
  })
})
