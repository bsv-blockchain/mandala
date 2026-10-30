/**
 * End to end against a live overlay-go (plan 04 Task 23, C§10 optional E2E):
 * register → issue MAX_UINT64 → payout MAX_UINT64 - 1 → the holder host's
 * receive (own submit, ledger, then the issuer-v1 `admitReceipt` through the
 * real color module on a WalletPermissionsManager, profileHolder.ts) → holder `sendHandover` (host-built
 * envelope) → recipient host receive → sender `settleHandover` + markSettled.
 *
 * Live run (skipped unless the URL is set; never wipes overlay state):
 *   MANDALA_E2E_OVERLAY_URL=http://localhost:8081 \
 *   MANDALA_E2E_OVERLAY_KEY=<the overlay's 66-hex identity key> \
 *   npx vitest run src/e2e.overlay-go.test.ts
 *
 * Every wallet is a FakeWallet with fresh random keys (the overlay's Mongo
 * persists between runs). FakeWallet funding is synthetic and carries no
 * BUMPs (plan 04 R1): the live overlay must run with a permissive chain
 * tracker and must accept the issuer and holders under its policy.
 *
 * The same flow also runs always-on against the in-process fake overlay
 * (`e2e flow dry run`), so the live script is known to execute and the uint64
 * boundary is pinned end to end.
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
import { verifyAttestation, type Attestation } from './attestation.js'
import { MAX_UINT64 } from './amount.js'
import { colorTopic } from './naming.js'
import type { AdmissionReceipt } from './overlay.js'
import { FakeWallet } from './__fixtures__/fakeWallet.js'
import { fakeMandalaOverlay } from './__fixtures__/fakeMandalaOverlay.js'
import { heldAmount, makeProfileHolder, messageBus } from './__fixtures__/profileHolder.js'

const LIVE_URL = process.env.MANDALA_E2E_OVERLAY_URL ?? ''
const LIVE_KEY = process.env.MANDALA_E2E_OVERLAY_KEY ?? ''

/** The v1 attestation a lib pipeline's admission receipt carries (C§3). */
function receiptAttestation (txid: string, r: AdmissionReceipt): Attestation {
  return { txid, outputs: r.outputsToAdmit ?? [], signer: r.admissionIdentityKey ?? '', signature: r.admissionSignature ?? '' }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

interface FlowEnv {
  url: string
  overlayKey: string
  /** Injected into the holders' Mandala providers; the lib's own calls use `globalThis.fetch`. */
  fetch?: typeof fetch
}

async function e2eFlow (env: FlowEnv): Promise<void> {
  const K = env.overlayKey
  expect(K, 'MANDALA_E2E_OVERLAY_KEY must be the overlay\'s 66-hex compressed identity key').toMatch(/^0[23][0-9a-f]{64}$/)
  configureMandala({ overlayUrl: env.url, overlayIdentityKey: K })
  const holderOf = () => makeProfileHolder({ K, url: env.url, ...(env.fetch != null ? { fetch: env.fetch } : {}) })
  const bus = messageBus()
  const issuer = new FakeWallet(PrivateKey.fromRandom())
  const holder = holderOf()
  const recipient = holderOf()
  const wallet = issuer.asWallet()
  const identityKey = issuer.identityKey

  // register → issue MAX_UINT64 (into the treasury)
  const reg = await registerAsset({ wallet, identityKey, label: 'E2E Dollar', ticker: 'E2E', decimals: 2 })
  const assetId = reg.assetId
  const topic = colorTopic(assetId)
  expect(reg.admissionIdentityKey).toBe(K)
  if (reg.topic === topic) expect(verifyAttestation(receiptAttestation(assetId.slice(0, 64), reg), assetId, K)).toBe(true)
  const deployAsset = (await listAdminAssets(wallet)).find(a => a.assetId === assetId)
  expect(deployAsset).toBeDefined()
  const issue = await issueTokens({ wallet, identityKey, asset: deployAsset!, amount: MAX_UINT64 })
  expect(issue.topic).toBe(topic)
  expect(verifyAttestation(receiptAttestation(issue.txid, issue), assetId, K)).toBe(true)

  // payout MAX_UINT64 - 1 to the holder (treasury change 1)
  const asset = (await listAdminAssets(wallet)).find(a => a.assetId === assetId)!
  const payoutAmount = MAX_UINT64 - 1n
  const pay = await payoutTokens({
    wallet, identityKey, asset, amount: payoutAmount, recipientKey: holder.identityKey, blind: false, messageBoxClient: bus(identityKey)
  })
  expect(pay.notified).toBe(true)
  expect(verifyAttestation(receiptAttestation(pay.txid, pay), assetId, K)).toBe(true)
  expect(Object.keys(pay.receipt)).toEqual(['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey'])

  // the holder host submits, records settled, then the handler credits from the ledger
  const got = await receiveHandovers({ wallet: holder.wallet, messageBoxClient: bus(holder.identityKey), ledger: holder.ledger, markSettled: holder.markSettled })
  expect(got.failed).toEqual([])
  expect(got.accepted).toEqual([expect.objectContaining({ txid: pay.txid, assetId, amount: payoutAmount, offline: false })])
  expect(heldAmount(holder, assetId)).toBe(payoutAmount)

  // holder → recipient hand-over (blinded by default), delivered, received online
  const handAmount = 400n
  const h = await sendHandover({ wallet: holder.wallet, hostWallet: holder.hostWallet, ledger: holder.ledger, identityKey: holder.identityKey, assetId, amount: handAmount, recipientKey: recipient.identityKey })
  await deliverHandover({ messageBoxClient: bus(holder.identityKey), recipientKey: recipient.identityKey, handover: h })
  const recv = await receiveHandovers({ wallet: recipient.wallet, messageBoxClient: bus(recipient.identityKey), ledger: recipient.ledger, markSettled: recipient.markSettled })
  expect(recv.failed).toEqual([])
  expect(recv.accepted).toEqual([expect.objectContaining({ txid: h.txid, assetId, amount: handAmount, offline: false })])
  expect(heldAmount(recipient, assetId)).toBe(handAmount)

  // the sender settles (idempotent re-submit of the exact bytes), then markSettled clears its change
  const settled = await settleHandover({ wallet: holder.wallet, handover: h, assetId, overlayIdentityKey: K, ledger: holder.ledger, markSettled: holder.markSettled })
  expect(settled.status).toBe('admitted')
  if (settled.status !== 'admitted') return
  expect(settled.attestation.txid).toBe(h.txid)
  expect(settled.attestation.outputs).toEqual([0, 1])
  expect(verifyAttestation(settled.attestation, assetId, K)).toBe(true)
  // The holder keeps exactly the change; nothing was created or lost.
  expect(heldAmount(holder, assetId)).toBe(payoutAmount - handAmount)
  expect(heldAmount(holder, assetId) + heldAmount(recipient, assetId) + 1n).toBe(MAX_UINT64)
  expect((await holder.coins(assetId)).every(c => !c.offline)).toBe(true)
  expect((await holder.ledger.get(h.txid))?.state).toBe('settled')
}

beforeEach(() => {
  configureStorage(memoryStorage())
  clearAdminAuthGates()
  clearDeployTxCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('e2e flow dry run (in-process fake overlay)', () => {
  it('register → issue MAX_UINT64 → payout MAX_UINT64-1 → host receive → hand-over → receive → settle', async () => {
    const priv = new PrivateKey(5555)
    const overlay = fakeMandalaOverlay({ priv })
    vi.stubGlobal('fetch', overlay.fetch)
    await e2eFlow({ url: 'https://mandala.test', overlayKey: priv.toPublicKey().toString(), fetch: overlay.fetch })
  })
})

describe.skipIf(LIVE_URL === '')('e2e against a live overlay-go (MANDALA_E2E_OVERLAY_URL)', () => {
  it('register → issue MAX_UINT64 → payout MAX_UINT64-1 → admitReceipt → hand-over → receive → settle', async () => {
    expect(LIVE_KEY, 'set MANDALA_E2E_OVERLAY_KEY to the overlay identity key').not.toBe('')
    await e2eFlow({ url: LIVE_URL.replace(/\/+$/, ''), overlayKey: LIVE_KEY })
  }, 120_000)
})
