/**
 * The Mandala issuer-v1 profile end to end with the real
 * `@bsv/color-permission-module` 0.2.0 (plan 04 Task 22; S1, S4, S5, D6,
 * unsupported wallet), plus the ENVELOPE seam fixture regeneration (C§10).
 *
 * Wallets: the issuer is a bare FakeWallet driven by the lib with
 * `configureMandala({ overlayUrl, overlayIdentityKey: K })` and
 * `globalThis.fetch` stubbed to the fake overlay. Each holder is a FakeWallet
 * under `new WalletPermissionsManager(fake, 'admin.test', { permissionModules: { color } })`;
 * the lib reaches it through `withOriginator(manager, 'admin.test')` (the lib
 * calls its wallet without an originator, which the manager would treat as an
 * unprivileged app). The module's own consent hook (`requestTokenAccess`)
 * still runs on every token operation and is recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  Hash, LockingScript, PrivateKey, Transaction, TransactionSignature, UnlockingScript, Utils,
  type WalletInterface, type WalletProtocol
} from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import {
  createAttestedProfile, createColorModule, type ColorOverlayProvider, type RequiredProfileHandler
} from '@bsv/color-permission-module'
import { createMandalaProfile } from './profile.js'
import { ATTESTED_PROFILE_ID, configureMandala, MESSAGEBOX, TOPIC } from './constants.js'
import { configureStorage, memoryStorage } from './storage.js'
import { clearAdminAuthGates } from './adminAuthGate.js'
import { clearDeployTxCache } from './overlayLookup.js'
import { listAdminAssets, type AdminAsset } from './assets.js'
import { issueTokens, registerAsset } from './issuerOps.js'
import { payoutTokens } from './payout.js'
import { deliverHandover, sendHandover, type HandoverResult } from './handover.js'
import { parseHandoverBody, receiveHandovers, type MessageBoxLike } from './receive.js'
import type { MessageBoxSender } from './receipt.js'
import { encodeEnvelope } from './encoding.js'
import { assetTag, colorBasket, colorProtocolID, colorTopic } from './naming.js'
import { FakeWallet, memoryColorStore, withOriginator, type MemoryColorStore } from './__fixtures__/fakeWallet.js'
import { fakeMandalaOverlay, type FakeMandalaOverlay } from './__fixtures__/fakeMandalaOverlay.js'

const URL_ = 'https://mandala.test'
const ADMIN = 'admin.test'
const OVERLAY_PRIV = new PrivateKey(5555)
const K = OVERLAY_PRIV.toPublicKey().toString()

// ---------------------------------------------------------------------------
// MessageBox (in memory, JSON round trip like the real client)
// ---------------------------------------------------------------------------

interface Bus { clientFor: (identityKey: string) => MessageBoxSender & MessageBoxLike }

function messageBus (): Bus {
  const boxes = new Map<string, Array<{ messageId: string, body: unknown, sender: string }>>()
  let n = 0
  return {
    clientFor (identityKey) {
      return {
        sendMessage: async ({ recipient, messageBox, body }) => {
          const key = `${recipient}|${messageBox}`
          boxes.set(key, [...(boxes.get(key) ?? []), { messageId: `m${n++}`, body: JSON.parse(JSON.stringify(body)), sender: identityKey }])
          return { status: 'success' }
        },
        listMessages: async ({ messageBox }) => [...(boxes.get(`${identityKey}|${messageBox}`) ?? [])],
        acknowledgeMessage: async ({ messageIds }) => {
          for (const [key, list] of boxes) boxes.set(key, list.filter(m => !messageIds.includes(m.messageId)))
          return { status: 'success' }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Holders (module-hosting wallets)
// ---------------------------------------------------------------------------

interface Holder {
  fake: FakeWallet
  identityKey: string
  store: MemoryColorStore
  color: ReturnType<typeof createColorModule>
  manager: WalletPermissionsManager
  /** The manager as the lib sees it (every call carries the admin originator). */
  wallet: WalletInterface
  prompts: string[]
}

/** No default color overlay: Mandala assets route only through the issuer-v1 handler's provider (S5). */
const NO_DEFAULT_PROVIDER: ColorOverlayProvider = {
  spendability: async () => { throw new Error('no default color overlay configured') },
  admission: async () => { throw new Error('no default color overlay configured') },
  submit: async () => { throw new Error('no default color overlay configured') }
}

function makeHolder (priv: PrivateKey, profiles: RequiredProfileHandler[]): Holder {
  const fake = new FakeWallet(priv)
  const store = memoryColorStore()
  const prompts: string[] = []
  const color = createColorModule({
    wallet: fake.asWallet(),
    provider: NO_DEFAULT_PROVIDER,
    requestTokenAccess: async (_app, message) => {
      prompts.push(String(JSON.parse(message).type))
      return true
    },
    profiles: Object.fromEntries(profiles.map(p => [p.id, p])),
    store
  })
  const manager = new WalletPermissionsManager(fake.asWallet(), ADMIN, { permissionModules: { color } })
  return { fake, identityKey: fake.identityKey, store, color, manager, wallet: withOriginator(manager as unknown as WalletInterface, ADMIN), prompts }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface World {
  overlay: FakeMandalaOverlay
  bus: Bus
  issuer: FakeWallet
  mandala: () => RequiredProfileHandler
  holder: (priv: PrivateKey, profiles?: RequiredProfileHandler[]) => Holder
}

function world (): World {
  const overlay = fakeMandalaOverlay({ priv: OVERLAY_PRIV })
  vi.stubGlobal('fetch', overlay.fetch)
  configureMandala({ overlayUrl: URL_, overlayIdentityKey: K })
  const mandala = (): RequiredProfileHandler => createMandalaProfile({ overlays: [{ identityKey: K, url: URL_ }], fetch: overlay.fetch })
  return {
    overlay,
    bus: messageBus(),
    issuer: new FakeWallet(new PrivateKey(1111)),
    mandala,
    holder: (priv, profiles) => makeHolder(priv, profiles ?? [createAttestedProfile(), mandala()])
  }
}

beforeEach(() => {
  configureStorage(memoryStorage())
  clearAdminAuthGates()
  clearDeployTxCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** register → issue `issue` → the live admin asset. */
async function issued (w: World, issue: bigint): Promise<{ assetId: string, asset: AdminAsset }> {
  const wallet = w.issuer.asWallet()
  const identityKey = w.issuer.identityKey
  const { assetId } = await registerAsset({ wallet, identityKey, label: 'Test Dollar', ticker: 'TUSD', decimals: 2 })
  const deployAsset = (await listAdminAssets(wallet)).find(a => a.assetId === assetId)!
  await issueTokens({ wallet, identityKey, asset: deployAsset, amount: issue })
  const asset = (await listAdminAssets(wallet)).find(a => a.assetId === assetId)!
  return { assetId, asset }
}

/** The issuer pays `amount` to `to` (receipt on MESSAGEBOX). */
async function payout (w: World, asset: AdminAsset, to: Holder, amount: bigint, blind = false): Promise<{ txid: string }> {
  return await payoutTokens({
    wallet: w.issuer.asWallet(),
    identityKey: w.issuer.identityKey,
    asset,
    amount,
    recipientKey: to.identityKey,
    blind,
    messageBoxClient: w.bus.clientFor(w.issuer.identityKey)
  })
}

async function balance (h: Holder, assetId: string): Promise<string> {
  const r = await h.wallet.listOutputs({ basket: `p color balance ${assetTag(assetId)}` })
  return String(r.totalOutputs)
}

/** The outpoints the `p color assets` view tags `color_offline`. */
async function offlineTagged (h: Holder): Promise<string[]> {
  const r = await h.wallet.listOutputs({ basket: 'p color assets', includeTags: true, limit: 1000 })
  return r.outputs.filter(o => o.tags?.includes('color_offline') === true).map(o => o.outpoint)
}

async function receiveAll (w: World, h: Holder): Promise<Awaited<ReturnType<typeof receiveHandovers>>> {
  return await receiveHandovers({ wallet: h.wallet, messageBoxClient: w.bus.clientFor(h.identityKey) })
}

describe('issuer-v1 with @bsv/color-permission-module (integration)', () => {
  it('online payout receive: credited settled, balance equals the amount', async () => {
    const w = world()
    const b = w.holder(new PrivateKey(2222))
    const { assetId, asset } = await issued(w, 1500n)
    await payout(w, asset, b, 1000n)
    const r = await receiveAll(w, b)
    expect(r.failed).toEqual([])
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]).toMatchObject({ assetId, amount: 1000n, outputIndex: 0, offline: false })
    expect(await balance(b, assetId)).toBe('1000')
    expect(await offlineTagged(b)).toEqual([])
    // Deploy, issue and payout went through the overlay's linkage and
    // conservation rules; B's receipt resubmitted the attested tip (D7).
    expect(w.overlay.submissions.map(s => s.topics)).toEqual([[TOPIC, colorTopic(assetId)], [colorTopic(assetId)], [colorTopic(assetId)]])
    expect(w.overlay.requests.map(q => q.txid).slice(-2)).toEqual([w.overlay.submissions[2].txid, w.overlay.submissions[2].txid])
  })

  it('offline hand-over then settle: credited color_offline with consent, then admitted', async () => {
    const w = world()
    const b = w.holder(new PrivateKey(2222))
    const c = w.holder(new PrivateKey(3333))
    const { assetId, asset } = await issued(w, 1500n)
    await payout(w, asset, b, 1000n)
    expect((await receiveAll(w, b)).failed).toEqual([])

    const h = await handover(w, b, c, assetId, 400n)
    w.overlay.offline = true
    const r = await receiveAll(w, c)
    expect(r.failed).toEqual([])
    expect(r.accepted).toEqual([expect.objectContaining({ txid: h.txid, assetId, amount: 400n, outputIndex: 0, offline: true })])
    // Online first (D6): the profile's own submit met the transport failure.
    expect(w.overlay.offlineAttempts).toContain('/submit')
    expect(c.prompts).toContain('color_receive_offline')
    expect(await balance(c, assetId)).toBe('400')
    expect(await offlineTagged(c)).toEqual([`${h.txid}.0`])

    w.overlay.offline = false
    const report = await c.color.settle()
    expect(report.results).toEqual(expect.arrayContaining([expect.objectContaining({ txid: h.txid, assetId, status: 'admitted' })]))
    expect(await offlineTagged(c)).toEqual([])
    expect(await balance(c, assetId)).toBe('400')
    expect(w.overlay.admitted.has(`${h.txid}.0`)).toBe(true)
    expect(w.overlay.admitted.has(`${h.txid}.1`)).toBe(true)
  })
})


describe('issuer-v1 failure paths (integration)', () => {
  it('unsupported wallet: a module without issuer-v1 refuses the payout receipt (UnsupportedProfileError, 0207 A.148)', async () => {
    const w = world()
    const c = w.holder(new PrivateKey(3333), [createAttestedProfile()])
    const { assetId, asset } = await issued(w, 1500n)
    await payout(w, asset, c, 1000n)
    const [body] = await inbox(w, c)
    await expect(internalize(c, body)).rejects.toMatchObject({ name: 'UnsupportedProfileError' })
    expect(c.fake.outputs.size).toBe(0)
    expect(await assetsView(c)).toEqual([])
    // Unacknowledged for a later pass (a wallet upgrade may add the profile).
    const r = await receiveAll(w, c)
    expect(r.accepted).toEqual([])
    expect((r.failed[0].error as Error).name).toBe('UnsupportedProfileError')
    expect(await inbox(w, c)).toHaveLength(1)
    // No balance of the unsupported asset can be read at all (the module refuses to resolve it).
    await expect(balance(c, assetId)).rejects.toMatchObject({ name: 'UnsupportedProfileError' })
  })

  it('D6: a typed retryable verdict (ERR_FROZEN) refuses credit; no offline fallback, no color_offline', async () => {
    const w = world()
    const b = w.holder(new PrivateKey(2222))
    const c = w.holder(new PrivateKey(3333))
    const { assetId, asset } = await issued(w, 1500n)
    await payout(w, asset, b, 1000n)
    expect((await receiveAll(w, b)).failed).toEqual([])
    await handover(w, b, c, assetId, 400n)
    w.overlay.refuse('ERR_FROZEN', 409, true)
    const [body] = await inbox(w, c)
    const e = await internalize(c, body).then(() => undefined, (x: unknown) => x as Error)
    expect(e?.name).toBe('ColorProviderError')
    expect(e?.message).toContain('(ERR_FROZEN, retryable)')
    expect(c.prompts).not.toContain('color_receive_offline')
    expect(c.fake.outputs.size).toBe(0)
    expect(await balance(c, assetId)).toBe('0')
    expect(await offlineTagged(c)).toEqual([])
    // The receive path leaves the message unacknowledged for a retry.
    const r = await receiveAll(w, c)
    expect(r.accepted).toEqual([])
    expect(r.failed[0].code).toBe('ERR_FROZEN')
    expect(await inbox(w, c)).toHaveLength(1)
  })

  it('S5: no Mandala overlay configured for K: internalize rejects ProfileParamsError, no credit, nothing sent', async () => {
    const w = world()
    const b = w.holder(new PrivateKey(2222))
    const c = w.holder(new PrivateKey(3333), [createAttestedProfile(), createMandalaProfile({ overlays: [] })])
    const { assetId, asset } = await issued(w, 1500n)
    await payout(w, asset, b, 1000n)
    expect((await receiveAll(w, b)).failed).toEqual([])
    await handover(w, b, c, assetId, 400n)
    const before = w.overlay.requests.length
    const [body] = await inbox(w, c)
    await expect(internalize(c, body)).rejects.toMatchObject({ name: 'ProfileParamsError', message: expect.stringMatching(/no Mandala overlay configured/) })
    expect(w.overlay.requests.length).toBe(before)
    expect(c.fake.outputs.size).toBe(0)
    expect(await offlineTagged(c)).toEqual([])
  })

  it('S1 forged mint (unanchored, policy-clean): the frontier validator refuses it offline (AttestationEvidenceError)', async () => {
    const { w, b, c, assetId, handoverBody } = await handedOver()

    // G′.0: a 1-sat 1000-unit coin of the asset owned by B, never submitted
    // or attested. P′ spends it into one 1-sat 1000-unit output with a full
    // envelope (conserves, passes every local hop check).
    const gPrime = new Transaction()
    gPrime.addOutput({ lockingScript: await ownedLock(b, assetId, 1000n, FORGED_G), satoshis: 1 })
    const pPrime = new Transaction()
    pPrime.addInput({ sourceTransaction: gPrime, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    pPrime.addOutput({ lockingScript: await ownedLock(b, assetId, 1000n, FORGED_P), satoshis: 1 })
    await signCoin(b, pPrime, 0, ownedCoin(b, assetId, FORGED_G))
    const parentEnvelope = await ownedEnvelope(b, assetId, [[0, FORGED_P]])
    w.overlay.offline = true

    // (a) As planned: G′ travels only inside P′'s AtomicBEEF (not in
    // `transactions`). T2's frontier walks into G′ and refuses the value it
    // creates from nothing, before the profile's admitReceipt runs.
    const forged = await forgeReceipt(b, handoverBody, pPrime, parentEnvelope)
    expect(forged.receipt.profileData).toBeDefined()
    await expect(internalize(c, forged)).rejects.toMatchObject({
      name: 'AttestationEvidenceError', message: expect.stringMatching(/value outputs exceed inputs/)
    })

    // (b) G′ withheld entirely (P′'s input is a bare txid): G′.0 is anchored
    // by no attestation and has no body, so the frontier cannot be completed.
    const pBare = Transaction.fromHex(pPrime.toHex())
    const forgedBare = await forgeReceipt(b, handoverBody, pBare, parentEnvelope, { allowPartial: true })
    await expect(internalize(c, forgedBare)).rejects.toMatchObject({
      name: 'AttestationEvidenceError', message: expect.stringContaining(`missing source ${gPrime.id('hex')}`)
    })
    // Neither forgery reached the profile's admitReceipt: nothing was submitted.
    expect(w.overlay.offlineAttempts).toEqual([])

    expect(c.prompts).not.toContain('color_receive_offline')
    expect(c.fake.outputs.size).toBe(0)
    expect(await balance(c, assetId)).toBe('0')
    expect(await offlineTagged(c)).toEqual([])
  })

  it('offline policy breach (layer order): T2 refuses a non-conserving parent; the lib hop checks refuse an anchored 2-sat parent', async () => {
    const { w, b, c, assetId, payoutBody, handoverBody } = await handedOver()
    w.overlay.offline = true

    // (a) P″ creates 1000 units of the asset from nothing (no token inputs).
    // T2's frontier validator checks conservation before admitReceipt, so the
    // refusal is AttestationEvidenceError (not the lib's ProfileDataError).
    const pForged = new Transaction()
    pForged.addOutput({ lockingScript: await ownedLock(b, assetId, 1000n, FORGED_P), satoshis: 1 })
    const forged = await forgeReceipt(b, handoverBody, pForged, await ownedEnvelope(b, assetId, [[0, FORGED_P]]))
    await expect(internalize(c, forged)).rejects.toMatchObject({
      name: 'AttestationEvidenceError', message: expect.stringMatching(/value outputs exceed inputs/)
    })

    // (b) A conserving parent anchored at the attested payout output whose
    // token output carries 2 satoshis: T2's frontier accepts it, the profile's
    // admitReceipt meets a transport failure, and the lib's local hop checks
    // refuse it before any offline credit (C§4, Task 21).
    const payoutTx = Transaction.fromAtomicBEEF(payoutBody.tx)
    const p2 = new Transaction()
    p2.addInput({ sourceTransaction: payoutTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    p2.addOutput({ lockingScript: await ownedLock(b, assetId, 1000n, FORGED_P), satoshis: 2 })
    await signCoin(b, p2, 0, receivedCoin(payoutBody))
    const breach = await forgeReceipt(b, handoverBody, p2, await ownedEnvelope(b, assetId, [[0, FORGED_P]]), { keepAttestations: true })
    const attempts = w.overlay.offlineAttempts.length
    await expect(internalize(c, breach)).rejects.toMatchObject({
      name: 'ProfileDataError', message: expect.stringContaining(`hop ${p2.id('hex')}: `)
    })
    await expect(internalize(c, breach)).rejects.toThrow(/1 satoshi/)
    // admitReceipt ran: it tried to submit P2 (one transport failure per attempt) and stopped there.
    expect(w.overlay.offlineAttempts.slice(attempts)).toEqual(['/submit', '/submit'])

    expect(c.prompts).not.toContain('color_receive_offline')
    expect(c.fake.outputs.size).toBe(0)
    expect(await balance(c, assetId)).toBe('0')
    expect(await offlineTagged(c)).toEqual([])
  })
})

/** Issuer → B payout (received online), then B → C hand-over of 400 delivered to C's inbox (not yet received). */
async function handedOver (): Promise<{ w: World, b: Holder, c: Holder, assetId: string, payoutBody: Body, handoverBody: Body }> {
  const w = world()
  const b = w.holder(new PrivateKey(2222))
  const c = w.holder(new PrivateKey(3333))
  const { assetId, asset } = await issued(w, 1500n)
  await payout(w, asset, b, 1000n)
  const [payoutBody] = await inbox(w, b)
  expect((await receiveAll(w, b)).failed).toEqual([])
  await handover(w, b, c, assetId, 400n)
  const [handoverBody] = await inbox(w, c)
  return { w, b, c, assetId, payoutBody, handoverBody }
}

// ---------------------------------------------------------------------------
// Receipt helpers (inbox, direct internalize, forgeries)
// ---------------------------------------------------------------------------

type Body = ReturnType<typeof parseHandoverBody>

/** The parsed v3 bodies waiting in `h`'s MESSAGEBOX inbox. */
async function inbox (w: World, h: Holder): Promise<Body[]> {
  const listed = await w.bus.clientFor(h.identityKey).listMessages({ messageBox: MESSAGEBOX }) as Array<{ body: unknown }>
  return listed.map(m => parseHandoverBody(m.body))
}

/** The receive path's internalize, without the MessageBox bookkeeping. */
async function internalize (h: Holder, body: Body): Promise<unknown> {
  return await h.wallet.internalizeAction({
    tx: body.tx,
    description: 'Receive Mandala tokens',
    labels: ['mandala', 'receive'],
    outputs: [{
      outputIndex: body.outputIndex,
      protocol: 'basket insertion',
      insertionRemittance: { basket: colorBasket(body.assetId), customInstructions: JSON.stringify(body.receipt) }
    }]
  })
}

async function assetsView (h: Holder): Promise<string[]> {
  const r = await h.wallet.listOutputs({ basket: 'p color assets', limit: 1000 })
  return r.outputs.map(o => o.outpoint)
}

/** Remittances of the forged B-owned coins. */
const FORGED_G = { prefix: 'Rw==', suffix: 'Rw==' }
const FORGED_P = { prefix: 'UA==', suffix: 'UA==' }

/** A `p color` key the holder can sign for: its protocol and counterparty. */
interface Coin { protocolID: WalletProtocol, counterparty: string }

/** B's own `p color` key for a remittance pair (counterparty B). */
function ownedCoin (b: Holder, assetId: string, r: { prefix: string, suffix: string }): Coin {
  return { protocolID: colorProtocolID(assetId, r.prefix, r.suffix), counterparty: b.identityKey }
}

/** The key of a received output: the receipt's remittances, counterparty = the receipt's sender. */
function receivedCoin (body: Body): Coin {
  const r = body.receipt
  return { protocolID: colorProtocolID(r.assetId, r.derivationPrefix, r.derivationSuffix), counterparty: r.senderIdentityKey }
}

async function coinKey (h: Holder, coin: Coin): Promise<string> {
  return (await h.fake.proto.getPublicKey({ protocolID: coin.protocolID, keyID: 'color', counterparty: coin.counterparty, forSelf: true })).publicKey
}

async function ownedLock (b: Holder, assetId: string, amount: bigint, r: { prefix: string, suffix: string }): Promise<LockingScript> {
  const publicKey = await coinKey(b, ownedCoin(b, assetId, r))
  return new OneColor().lock(assetId, amount, Hash.hash160(Utils.toArray(publicKey, 'hex')))
}

/** Signs input `i` of `tx` (a `p color` coin of `h`) as `h`, SIGHASH_ALL|FORKID; S as the wallet returns it. */
async function signCoin (h: Holder, tx: Transaction, i: number, coin: Coin): Promise<void> {
  const publicKey = await coinKey(h, coin)
  const input = tx.inputs[i]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, k) => k !== i),
    inputIndex: i,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope
  })
  const { signature } = await h.fake.proto.createSignature({
    hashToDirectlySign: Hash.hash256(preimage), protocolID: coin.protocolID, keyID: 'color', counterparty: coin.counterparty
  })
  const sig = [...signature, scope]
  const pub = Utils.toArray(publicKey, 'hex')
  input.unlockingScript = new UnlockingScript([{ op: sig.length, data: sig }, { op: pub.length, data: pub }])
}

/** A full envelope for B-owned outputs (revealed by B, counterparty = owner B, verifier K). */
async function ownedEnvelope (b: Holder, assetId: string, outs: Array<[number, { prefix: string, suffix: string }]>): Promise<number[]> {
  const outputs = []
  for (const [index, r] of outs) {
    const protocolID = colorProtocolID(assetId, r.prefix, r.suffix)
    const rev = await b.fake.proto.revealSpecificKeyLinkage({ counterparty: b.identityKey, verifier: K, protocolID, keyID: 'color' })
    outputs.push({
      index,
      linkage: {
        prover: rev.prover, verifier: K, counterparty: b.identityKey, protocolID, keyID: 'color',
        encryptedLinkage: Array.from(rev.encryptedLinkage), encryptedLinkageProof: Array.from(rev.encryptedLinkageProof), proofType: 0 as const
      }
    })
  }
  return encodeEnvelope({ outputs })
}

/**
 * The genuine hand-over `body` with its token input 0 rewired to `parent.0`
 * and re-signed as B (the funding input too: SIGHASH_ALL commits to every
 * prevout). `parent` joins the receipt's `transactions` and `submissions`;
 * its own ancestors travel only inside the tip's AtomicBEEF.
 */
async function forgeReceipt (
  b: Holder, body: Body, parent: Transaction, parentEnvelope: number[],
  o: { keepAttestations?: boolean, allowPartial?: boolean } = {}
): Promise<Body> {
  const genuine = Transaction.fromAtomicBEEF(body.tx)
  const tip = new Transaction(genuine.version, [], genuine.outputs.map(o => ({ lockingScript: o.lockingScript, satoshis: o.satoshis })), genuine.lockTime)
  tip.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  for (const input of genuine.inputs.slice(1)) {
    tip.addInput({ sourceTransaction: input.sourceTransaction, sourceOutputIndex: input.sourceOutputIndex, unlockingScript: new UnlockingScript(), sequence: input.sequence ?? 0xffffffff })
  }
  await signCoin(b, tip, 0, ownedCoin(b, body.assetId, FORGED_P))
  await b.fake.signFunding(tip)
  const leaf = (body.receipt.profileData as any)[ATTESTED_PROFILE_ID][body.assetId]
  const tipSubmission = leaf.submissions.find((s: { txid: string }) => s.txid === genuine.id('hex'))
  expect(tipSubmission).toBeDefined()
  const forgedLeaf = {
    ...leaf,
    transactions: [...leaf.transactions, parent.toHex()],
    // Unless the parent spends the genuine anchor, the payout's attestation
    // names an output the forged graph no longer reaches, which T2 refuses
    // for that alone; drop it so the refusal is about the forgery.
    attestations: o.keepAttestations === true ? leaf.attestations : [],
    submissions: [
      ...leaf.submissions.filter((s: { txid: string }) => s.txid !== genuine.id('hex')),
      { txid: parent.id('hex'), offChainValues: Utils.toHex(parentEnvelope) },
      { txid: tip.id('hex'), offChainValues: tipSubmission.offChainValues }
    ]
  }
  return {
    ...body,
    tx: tip.toAtomicBEEF(o.allowPartial === true),
    receipt: { ...body.receipt, profileData: { ...body.receipt.profileData, [ATTESTED_PROFILE_ID]: { [body.assetId]: forgedLeaf } } }
  }
}

/** B hands `amount` to C (sendHandover, then deliverHandover on MESSAGEBOX); never submitted by B. */
async function handover (
  w: World, from: Holder, to: Holder, assetId: string, amount: bigint,
  extra: { derivationPrefix?: string, derivationSuffix?: string } = {}
): Promise<HandoverResult> {
  const h = await sendHandover({ wallet: from.wallet, identityKey: from.identityKey, assetId, amount, recipientKey: to.identityKey, ...extra })
  await deliverHandover({ messageBoxClient: w.bus.clientFor(from.identityKey), recipientKey: to.identityKey, handover: h })
  return h
}

// ---------------------------------------------------------------------------
// ENVELOPE seam fixture (C§10). Run once with MANDALA_REGEN_ENVELOPE=1, commit
// the file, never regenerate unless the C§5 envelope format changes; any
// regeneration must be reported to P-GO, who re-copies the file.
// ---------------------------------------------------------------------------

describe.skipIf(process.env.MANDALA_REGEN_ENVELOPE == null || process.env.MANDALA_REGEN_ENVELOPE === '')('envelope fixture regeneration', () => {
  it('writes __fixtures__/1color-envelope.json', async () => {
    const w = world()
    const holder = w.holder(new PrivateKey(2222))
    const recipient = w.holder(new PrivateKey(3333))
    const { assetId, asset } = await issued(w, 1500n)
    await payout(w, asset, holder, 1000n, false)
    expect((await receiveAll(w, holder)).failed).toEqual([])
    const topic = colorTopic(assetId)
    expect(w.overlay.submissions.map(s => s.topics)).toEqual([[TOPIC, topic], [topic], [topic]])

    // The hand-over bytes, taken before any submit (blind by default).
    const h = await sendHandover({
      wallet: holder.wallet,
      identityKey: holder.identityKey,
      assetId,
      amount: 400n,
      recipientKey: recipient.identityKey,
      derivationPrefix: 'AQ==',
      derivationSuffix: 'Ag=='
    })
    const tip = Transaction.fromAtomicBEEF(h.tx)
    expect(tip.id('hex')).toBe(h.txid)
    const handoverEntry = {
      name: 'handover' as const,
      txid: h.txid,
      topics: [topic],
      rawTxHex: tip.toHex(),
      atomicBeefHex: Utils.toHex(h.tx),
      offChainValuesHex: Utils.toHex(h.offChainValues),
      outputsToAdmit: { [topic]: [0, 1] }
    }
    // Sanity: the fake overlay (linkage.go rule, conservation) admits it as [0, 1].
    const steak = await createMandalaProfile({ overlays: [{ identityKey: K, url: URL_ }], fetch: w.overlay.fetch })
      .provider!(assetId, { version: 1, params: { identityKey: K } } as any)
      .submit([topic], h.tx, h.offChainValues)
    expect(steak[topic].outputsToAdmit).toEqual([0, 1])

    const names = ['deploy', 'issue', 'payout'] as const
    const fixture = {
      version: 1,
      keys: {
        issuer: w.issuer.identityKey,
        holder: holder.identityKey,
        recipient: recipient.identityKey,
        overlay: K
      },
      privateKeys: { issuer: 1111, holder: 2222, recipient: 3333, overlay: 5555 },
      assetId,
      amounts: { issue: '1500', payout: '1000', handover: '400', handoverChange: '600' },
      txs: [
        ...w.overlay.submissions.slice(0, 3).map((s, i) => ({
          name: names[i],
          txid: s.txid,
          topics: s.topics,
          rawTxHex: Transaction.fromAtomicBEEF(s.beef).toHex(),
          atomicBeefHex: Utils.toHex(s.beef),
          offChainValuesHex: Utils.toHex(s.offChainValues),
          outputsToAdmit: Object.fromEntries(Object.entries(s.steak).map(([t, e]) => [t, (e as { outputsToAdmit: number[] }).outputsToAdmit]))
        })),
        handoverEntry
      ]
    }
    writeFileSync(fileURLToPath(new URL('./__fixtures__/1color-envelope.json', import.meta.url)), JSON.stringify(fixture, null, 2) + '\n')
  })
})
