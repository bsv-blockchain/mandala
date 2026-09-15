/**
 * End-to-end over the exact wrapper stack index.ts wires, with the REAL pinned
 * MandalaTopicManager underneath: a phantom-coin transaction must come back
 * from /submit as 400 ERR_LINKAGE, not as the pinned engine's 200 with an empty
 * STEAK. This is FIX A + FIX D + the σ_I gate meeting in one place.
 */
import { describe, it, expect } from 'vitest'
import { MandalaTopicManager, InMemoryScreeningProvider } from '@bsv/overlay-topics'
import { MandalaToken, ADMIN_PROTOCOL } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Hash, Utils, Transaction, UnlockingScript, WalletProtocol } from '@bsv/sdk'
import { withVerdictCapture, SubmitSideChannel } from './submitSideChannel.js'
import { withUnlinkedTokenReject } from './tokenLinkageGuard.js'
import { withSpentInputGuard, InFlightOutpoints, IN_FLIGHT_DESCRIPTION, type SpentInputStore } from './spentGuard.js'
import { admissionResponse } from './admissionRoute.js'
import {
  withPersistedVerdict, wrapSubmitJson, signAdmissionV2Sync, EVICTED_DESCRIPTION, payloadHashOfValues,
  type AdmissionRecord, type AdmissionStore, type AppliedProof
} from './admission.js'

const tokenProtocolID: WalletProtocol = [2, 'mandala token']
const holder = new ProtoWallet(new PrivateKey(41))
const recipient = new ProtoWallet(new PrivateKey(42))
const thief = new ProtoWallet(new PrivateKey(43))
const overlay = new ProtoWallet(new PrivateKey(44))
const priv = PrivateKey.fromRandom()
const assetId = `${'ab'.repeat(32)}.0`

const identity = async (w: ProtoWallet): Promise<string> => (await w.getPublicKey({ identityKey: true })).publicKey

const assetState = (id: string): any => ({
  assetId: id, issuerIdentityKey: '', isPaused: false, accessMode: 'denylist',
  blockedIdentities: [], allowedIdentities: [], frozenOutpoints: [], evictedOutpoints: [],
  lastProcessedHeight: 0, lastProcessedOffset: 0, lastAdmitSeq: 0
})

const memStore = (rows: Record<string, AdmissionRecord> = {}): AdmissionStore & { rows: Record<string, AdmissionRecord> } => ({
  rows,
  get: async (txid) => rows[txid] ?? null,
  // Mirrors index.ts: an admission clears the refusal fields (§9.1).
  putAdmitted: async (rec) => {
    const merged: AdmissionRecord = { ...(rows[rec.txid] ?? {}), ...rec, pending: false }
    delete merged.refusedCode
    delete merged.refusedDescription
    delete merged.refusedAt
    delete merged.refusedPayloadHash
    delete merged.refusedSpendTxid
    rows[rec.txid] = merged
  },
  putRefusal: async (rec) => { rows[rec.txid] = { ...(rows[rec.txid] ?? { txid: rec.txid }), ...rec } },
  markEvicted: async (txid, at) => { rows[txid] = { ...(rows[txid] ?? { txid }), evictedAt: at } }
})

const noApplied: AppliedProof = { wasApplied: async () => false, storedOutputs: async () => [] }

const liveInputs: SpentInputStore = {
  spendStateOf: async () => ({ spent: false, consumedBy: [] }),
  wasEvicted: async () => false
}

/** The stack from index.ts, outermost first — §9.6 order for the inner three. */
const stack = (
  channel: SubmitSideChannel,
  store: AdmissionStore,
  inputs: SpentInputStore = liveInputs,
  inFlight?: InFlightOutpoints
) =>
  withVerdictCapture(
    withPersistedVerdict(
      withUnlinkedTokenReject(
        withSpentInputGuard(
          new MandalaTopicManager({
            verifierWallet: overlay as any,
            screeningProvider: new InMemoryScreeningProvider([]),
            adminWallet: overlay as any,
            adminProtocolID: ADMIN_PROTOCOL,
            stateStore: { getAssetState: async (id: string) => assetState(id), getTokenRow: async () => null } as any
          }) as any,
          inputs,
          inFlight
        ),
        { verifierWallet: overlay as any }
      ),
      store
    ),
    { channel }
  )

const spend = async (
  opts: { phantom?: number, keyID?: string } = {}
): Promise<{ beef: number[], payload: number[], txid: string, sourceOutpoint: string }> => {
  const keyID = opts.keyID ?? 'out0'
  const holderKey = await identity(holder)
  const recipientKey = await identity(recipient)
  const thiefKey = await identity(thief)
  const verifierKey = await identity(overlay)
  const { publicKey: srcDerived } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'src', counterparty: holderKey })
  const source = new Transaction()
  source.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  source.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(srcDerived, 'hex'))) })

  const { publicKey: out0 } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID, counterparty: recipientKey })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 100, Hash.hash160(Utils.toArray(out0, 'hex'))) })
  if (opts.phantom != null) {
    const { publicKey: out1 } = await holder.getPublicKey({ protocolID: tokenProtocolID, keyID: 'out1', counterparty: thiefKey })
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, opts.phantom, Hash.hash160(Utils.toArray(out1, 'hex'))) })
  }
  const payload = Utils.toArray(JSON.stringify({
    inputs: [],
    outputs: [{ index: 0, linkage: await holder.revealSpecificKeyLinkage({ counterparty: recipientKey, verifier: verifierKey, protocolID: tokenProtocolID, keyID }) }]
  }), 'utf8')
  return { beef: tx.toBEEF(), payload, txid: tx.id('hex'), sourceOutpoint: `${source.id('hex')}.0` }
}

/** A payload that parses but carries no linkage — the poisoning submission. */
const STRIPPED_PAYLOAD = Utils.toArray(JSON.stringify({ inputs: [], outputs: [] }), 'utf8')

/**
 * The raw /submit body as the pinned overlay-express route frames it:
 * `varint(beefLength) ++ beef ++ offChainValues`.
 */
const framedBody = (beef: number[], payload: number[]): Buffer => {
  const w = new Utils.Writer()
  w.writeVarIntNum(beef.length)
  w.write(beef)
  w.write(payload)
  return Buffer.from(w.toArray())
}

/**
 * Replays what the pinned Engine + OverlayExpress route do around the manager.
 *
 * The engine call happens INSIDE `next()`, which is where `wrapSubmitJson`
 * enters the request's capture scope (§9.7) — running it outside would put every
 * manager's verdict in the process-wide fallback and quietly defeat the
 * isolation these tests are here to pin.
 */
const submitThrough = async (
  tm: any, deps: Parameters<typeof wrapSubmitJson>[0], beef: number[], payload: number[]
): Promise<{ status: number, body: any }> => {
  let statusCode = 200
  let resolveSend: (c: { status: number, body: any }) => void = () => {}
  const sent = new Promise<{ status: number, body: any }>(r => { resolveSend = r })
  const res: any = { status (n: number) { statusCode = n; return res }, json (b: unknown) { resolveSend({ status: statusCode, body: b }); return res } }
  // req.body is a Buffer by the time the engine responds, exactly as
  // bodyParser.raw leaves it.
  const req = {
    path: '/submit',
    method: 'POST',
    body: framedBody(beef, payload),
    headers: { 'x-topics': JSON.stringify(['tm_mandala']), 'x-includes-off-chain-values': 'true' }
  }
  wrapSubmitJson(deps)(req as any, res as any, () => {
    void (async () => {
      // Engine.submit: per-topic try/catch collapses a manager throw into an
      // empty STEAK entry and the route answers 200.
      let steak: Record<string, unknown>
      try {
        steak = { tm_mandala: await tm.identifyAdmissibleOutputs(beef, [0], payload) }
      } catch {
        steak = { tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } }
      }
      res.json(steak)
    })()
  })
  return await sent
}

describe('composed wrapper stack — index.ts wiring, real pinned manager', () => {
  it('a phantom-coin transaction is refused 400 ERR_LINKAGE instead of quietly admitted', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const tm = stack(channel, store)
    const { beef, payload, txid } = await spend({ phantom: 1_000_000 })
    const out = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(out.status).toBe(400)
    expect(out.body).toEqual({
      status: 'error',
      code: 'ERR_LINKAGE',
      retryable: false,
      description: 'output 1: MandalaToken-decodable output with no verified linkage',
      message: 'output 1: MandalaToken-decodable output with no verified linkage'
    })
    // …and the verdict is persisted, so the next submitter converges on it.
    expect(store.rows[txid].refusedCode).toBe('ERR_LINKAGE')
  })

  it('the same transaction is refused identically on re-submit, from the persisted verdict', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const tm = stack(channel, store)
    const { beef, payload } = await spend({ phantom: 1_000_000 })
    const first = await submitThrough(tm, { priv, store, channel }, beef, payload)
    const second = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(second).toEqual(first)
  })

  it('a clean transfer is admitted and σ_I binds to the admitted set', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const tm = stack(channel, store)
    const { beef, payload, txid } = await spend()
    const out = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(out.status).toBe(200)
    expect(out.body.tm_mandala.outputsToAdmit).toEqual([0])
    expect(out.body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, txid, [0]).admissionSignature)
    expect(store.rows[txid].outputsToAdmit).toEqual([0])
  })

  it('an evicted txid is refused 410 and never reaches the pinned manager again', async () => {
    const channel = new SubmitSideChannel()
    const { beef, payload, txid } = await spend()
    const store = memStore({ [txid]: { txid, evictedAt: '2026-09-14T10:00:00.000Z' } })
    const tm = stack(channel, store)
    const out = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(out.status).toBe(410)
    expect(out.body).toEqual({
      status: 'error', code: 'ERR_EVICTED', retryable: false,
      description: EVICTED_DESCRIPTION(txid), message: EVICTED_DESCRIPTION(txid)
    })
  })

  it('a conflicting spend is refused 400 ERR_INPUT_SPENT naming the competitor', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const competitor = 'dd'.repeat(32)
    const tm = stack(channel, store, {
      spendStateOf: async () => ({ spent: true, consumedBy: [{ txid: competitor, outputIndex: 0 }] }),
      wasEvicted: async () => false
    })
    const { beef, payload } = await spend()
    const out = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('ERR_INPUT_SPENT')
    expect(out.body.spendTxid).toBe(competitor)
  })

  it('a conflicting spend whose competitor was evicted is admitted (contract §7 rescue)', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const tm = stack(channel, store, {
      spendStateOf: async () => ({ spent: true, consumedBy: [{ txid: 'dd'.repeat(32), outputIndex: 0 }] }),
      wasEvicted: async () => true
    })
    const { beef, payload } = await spend()
    const out = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(out.status).toBe(200)
    expect(out.body.tm_mandala.outputsToAdmit).toEqual([0])
  })
})

// ───────── §9.1 — verdict poisoning, end to end over the real stack ──────────

describe('§9.1 — a stripped payload cannot poison the txid', () => {
  it('refuses the stripped submission, then admits the SAME BEEF with its real payload', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const tm = stack(channel, store)
    const { beef, payload, txid } = await spend()

    // Anyone holding the BEEF can submit it with the payload stripped. The
    // refusal is real and deterministic — for THAT submission.
    const poison = await submitThrough(tm, { priv, store, channel }, beef, STRIPPED_PAYLOAD)
    expect(poison.status).toBe(400)
    expect(poison.body.code).toBe('ERR_LINKAGE')
    expect(store.rows[txid].refusedCode).toBe('ERR_LINKAGE')
    expect(store.rows[txid].refusedPayloadHash).toBe(payloadHashOfValues(STRIPPED_PAYLOAD))

    // §9.3 — and a bare GET is NOT served that refusal…
    const bare = await admissionResponse(txid, { store, applied: noApplied, priv })
    expect(bare.status).toBe(404)
    // …though the submitter who names its own payload still gets its answer.
    const named = await admissionResponse(txid, { store, applied: noApplied, priv }, payloadHashOfValues(STRIPPED_PAYLOAD))
    expect(named.status).toBe(400)
    expect((named.body as any).code).toBe('ERR_LINKAGE')

    // The rightful submission is evaluated FRESH and admitted, with σ_I.
    const real = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(real.status).toBe(200)
    expect(real.body.tm_mandala.outputsToAdmit).toEqual([0])
    expect(real.body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, txid, [0]).admissionSignature)

    // …and the admission CLEARED the refusal, so the route stops serving it.
    expect(store.rows[txid].refusedCode).toBeUndefined()
    expect(store.rows[txid].refusedPayloadHash).toBeUndefined()
    const after = await admissionResponse(txid, { store, applied: noApplied, priv }, payloadHashOfValues(STRIPPED_PAYLOAD))
    expect(after.status).toBe(200)
  })

  it('the SAME payload is still refused identically on re-submit', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const tm = stack(channel, store)
    const { beef } = await spend()
    const first = await submitThrough(tm, { priv, store, channel }, beef, STRIPPED_PAYLOAD)
    const second = await submitThrough(tm, { priv, store, channel }, beef, STRIPPED_PAYLOAD)
    expect(second).toEqual(first)
  })
})

// ───────── §9.2 + §7 — the eviction rescue survives, because nothing persists ─

describe('§9.2 — an evicted competitor frees the coin for the loser', () => {
  it('refuses ERR_INPUT_SPENT, persists nothing, then admits the re-submit once the competitor is evicted', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const competitor = 'dd'.repeat(32)
    let competitorEvicted = false
    const tm = stack(channel, store, {
      spendStateOf: async () => ({ spent: true, consumedBy: [{ txid: competitor, outputIndex: 0 }] }),
      wasEvicted: async () => competitorEvicted
    })
    const { beef, payload, txid } = await spend()

    const refused = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe('ERR_INPUT_SPENT')
    expect(refused.body.spendTxid).toBe(competitor)
    // The whole point of §9.2: NOTHING is written, so no record can outrank the
    // rescue below.
    expect(store.rows[txid]).toBeUndefined()

    competitorEvicted = true

    const admitted = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(admitted.status).toBe(200)
    expect(admitted.body.tm_mandala.outputsToAdmit).toEqual([0])
    expect(admitted.body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, txid, [0]).admissionSignature)
  })
})

// ───────── §9.7 — two concurrent spends of one coin, exactly one winner ──────

describe('§9.7 — the in-flight outpoint set', () => {
  it('two concurrent conflicting spends produce exactly one 200; the loser gets a retryable 503', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const inFlight = new InFlightOutpoints()
    // Committed state says the coin is UNSPENT for both — which it is, until the
    // winner's spend-mark lands in the engine's PHASE 3, after both have already
    // been answered. That is the window the in-flight set closes.
    const tm = stack(channel, store, liveInputs, inFlight)
    const a = await spend({ keyID: 'outA' })
    const b = await spend({ keyID: 'outB' })
    expect(a.txid).not.toBe(b.txid)
    expect(a.sourceOutpoint).toBe(b.sourceOutpoint) // same coin

    const [ra, rb] = await Promise.all([
      submitThrough(tm, { priv, store, channel, inFlight }, a.beef, a.payload),
      submitThrough(tm, { priv, store, channel, inFlight }, b.beef, b.payload)
    ])

    const statuses = [ra.status, rb.status].sort((x, y) => x - y)
    expect(statuses).toEqual([200, 503])

    const winner = ra.status === 200 ? ra : rb
    const loser = ra.status === 200 ? rb : ra
    expect(winner.body.tm_mandala.admissionSignature).toBeTypeOf('string')
    expect(loser.body).toEqual({
      status: 'error',
      code: 'ERR_UNAVAILABLE',
      retryable: true,
      description: IN_FLIGHT_DESCRIPTION(a.sourceOutpoint),
      message: IN_FLIGHT_DESCRIPTION(a.sourceOutpoint)
    })
    // Exactly one σ_I was minted over that coin…
    expect(Object.values(store.rows).filter(r => r.admissionSignature != null)).toHaveLength(1)
    // …the 503 was never persisted…
    expect(Object.values(store.rows).filter(r => r.refusedCode != null)).toHaveLength(0)
    // …and both requests released their claims when they settled.
    expect(inFlight.outpoints()).toEqual([])
  })

  it('a second spend of the coin is fine once the first request has settled', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const inFlight = new InFlightOutpoints()
    const tm = stack(channel, store, liveInputs, inFlight)
    const a = await spend({ keyID: 'outA' })
    const b = await spend({ keyID: 'outB' })
    expect((await submitThrough(tm, { priv, store, channel, inFlight }, a.beef, a.payload)).status).toBe(200)
    // Sequential, not concurrent: the claim is gone, so the committed spend
    // state (the ordinary guard) is what answers — and here it says unspent.
    expect((await submitThrough(tm, { priv, store, channel, inFlight }, b.beef, b.payload)).status).toBe(200)
  })
})

// ───────── §9.5 — a store fault anywhere in the stack is 503, never a 400 ────

describe('§9.5 — infra faults are never final, end to end', () => {
  const boom = async (): Promise<never> => { throw new Error('ECONNREFUSED') }

  it('the spent-input guard: a throwing output store is 503 with no record written', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const tm = stack(channel, store, { spendStateOf: boom, wasEvicted: async () => false })
    const { beef, payload, txid } = await spend()
    const out = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(out.status).toBe(503)
    expect(out.body.code).toBe('ERR_UNAVAILABLE')
    expect(out.body.retryable).toBe(true)
    expect(store.rows[txid]).toBeUndefined()
  })

  it('the persisted-verdict guard: a throwing admission store is 503 with no record written', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const faulty: AdmissionStore = { ...store, get: boom }
    const tm = stack(channel, faulty)
    const { beef, payload, txid } = await spend()
    const out = await submitThrough(tm, { priv, store: faulty, channel }, beef, payload)
    expect(out.status).toBe(503)
    expect(out.body.code).toBe('ERR_UNAVAILABLE')
    expect(store.rows[txid]).toBeUndefined()
  })

  it('a store fault is NEVER classified through the substring table into a 400', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    // A message the table would read as a final 400 ERR_INPUT_SPENT.
    const tm = stack(channel, store, {
      spendStateOf: async () => { throw new Error('row already spent by the connection pool') },
      wasEvicted: async () => false
    })
    const { beef, payload } = await spend()
    const out = await submitThrough(tm, { priv, store, channel }, beef, payload)
    expect(out.status).toBe(503)
    expect(out.body.code).toBe('ERR_UNAVAILABLE')
  })
})
