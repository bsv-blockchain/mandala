/**
 * End-to-end over the exact tm_mandala wrapper stack index.ts wires, with the
 * REAL @bsv/overlay-topics 2.0.0 MandalaTopicManager underneath on a real
 * MandalaStorageManager (local Mongo): capture → persisted verdict → spent
 * guard → package manager. A package refusal must come back from /submit as
 * the package's own code and reason (never the pinned engine's 200 with an
 * empty STEAK), the spent guard must refuse before the package runs, and a
 * persisted final verdict must replay without reaching the package at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MandalaTopicManager, MandalaStorageManager, InMemoryScreeningProvider, Reasons } from '@bsv/overlay-topics'
import { PrivateKey, Utils } from '@bsv/sdk'
import { withVerdictCapture, SubmitSideChannel, snapshotRestore } from './submitSideChannel.js'
import { withSpentInputGuard, EVICTED_HEAL_DESCRIPTION, type SpentInputStore } from './spentGuard.js'
import { admissionResponse } from './admissionRoute.js'
import {
  withPersistedVerdict, wrapSubmitJson, signAdmissionV2Sync, EVICTED_DESCRIPTION, payloadHashOfValues,
  type AdmissionRecord, type AdmissionStore, type AppliedProof
} from './admission.js'
import { connectTestMongo, mongoAvailable, type TestMongo } from './testkit/mongo.js'
import {
  deploy, issue, tokenOf, envelopeOf, memEngineOutputs, verifierWallet, ISSUER, OVERLAY, type Built
} from './testkit/brc162.js'

const up = await mongoAvailable()

const priv = PrivateKey.fromRandom()

const memStore = (rows: Record<string, AdmissionRecord> = {}): AdmissionStore & { rows: Record<string, AdmissionRecord> } => ({
  rows,
  get: async (txid) => rows[txid] ?? null,
  // Mirrors mongoAdmissionStore: an admission clears the refusal fields (§9.1).
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

/**
 * The engine's `outputs` table as the spent guard reads it: only the listed
 * outpoints are topic coins; everything else (the funding input) has no row,
 * which the guard skips.
 */
const coins = (rows: Record<string, { spent: boolean, spentBy: string | null }> = {}): SpentInputStore & { released: string[], evicted: Set<string> } => {
  const released: string[] = []
  const evicted = new Set<string>()
  return {
    released,
    evicted,
    spendStateOf: async (txid, vout) => {
      const r = rows[`${txid}.${vout}`]
      return r == null ? null : { spent: r.spent, spentBy: r.spentBy, consumedBy: r.spentBy == null ? [] : [{ txid: r.spentBy, outputIndex: 0 }] }
    },
    wasEvicted: async (txid) => evicted.has(txid),
    releaseSpend: async (txid, vout, spender) => {
      released.push(`${txid}.${vout}:${spender}`)
      const r = rows[`${txid}.${vout}`]
      if (r == null || !r.spent || r.spentBy !== spender) return 0
      rows[`${txid}.${vout}`] = { spent: false, spentBy: null }
      return 1
    }
  }
}

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
 * The engine call happens INSIDE `next()`, where `wrapSubmitJson` enters the
 * request's capture scope (§9.7).
 */
const submitThrough = async (
  tm: any, deps: Parameters<typeof wrapSubmitJson>[0], beef: number[], payload: number[], previousCoins: number[]
): Promise<{ status: number, body: any }> => {
  let statusCode = 200
  let resolveSend: (c: { status: number, body: any }) => void = () => {}
  const sent = new Promise<{ status: number, body: any }>(r => { resolveSend = r })
  const res: any = { status (n: number) { statusCode = n; return res }, json (b: unknown) { resolveSend({ status: statusCode, body: b }); return res } }
  const req = {
    path: '/submit',
    method: 'POST',
    body: framedBody(beef, payload),
    headers: { 'x-topics': JSON.stringify(['tm_mandala']), 'x-includes-off-chain-values': 'true' }
  }
  wrapSubmitJson(deps)(req as any, res as any, () => {
    void (async () => {
      // Engine.submit: a manager throw collapses into an empty STEAK entry.
      let steak: Record<string, unknown>
      try {
        steak = { tm_mandala: await tm.identifyAdmissibleOutputs(beef, previousCoins, payload) }
      } catch {
        steak = { tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } }
      }
      res.json(steak)
    })()
  })
  return await sent
}

describe.skipIf(!up)('composed wrapper stack — index.ts wiring over the real 2.0.0 manager', () => {
  let mongo: TestMongo
  let storage: MandalaStorageManager
  beforeAll(async () => {
    mongo = (await connectTestMongo('wrapper'))!
    storage = new MandalaStorageManager(mongo.db)
  })
  afterAll(async () => { await mongo?.close() })

  /** The stack from index.ts, outermost first, with a handle on the package manager. */
  const stack = (channel: SubmitSideChannel, store: AdmissionStore, inputs: SpentInputStore = coins()) => {
    const manager = new MandalaTopicManager({
      verifierWallet,
      trustedIssuers: [ISSUER],
      stateStore: storage,
      engineOutputs: memEngineOutputs(),
      screeningProvider: new InMemoryScreeningProvider([]),
      membershipExempt: [OVERLAY]
    })
    const inner = vi.spyOn(manager, 'identifyAdmissibleOutputs')
    const tm = withVerdictCapture(
      withPersistedVerdict(
        withSpentInputGuard(manager as any, inputs),
        store),
      { channel, putPending: async rec => { await store.putPending?.(rec) }, snapshotRestore })
    return { tm, inner }
  }

  const send = async (tm: any, store: AdmissionStore, channel: SubmitSideChannel, b: Built, payload = envelopeOf(b)) =>
    await submitThrough(tm, { priv, store, channel }, b.tx.toBEEF(), payload, b.previousCoins)

  /** The deploy with its linkage stripped: the package refuses output 0. */
  const unlinked = (d: Built): number[] => envelopeOf({ ...d, env: { ...d.env, outputs: [] } })

  it('(a) an unlinked token output is refused 400 ERR_LINKAGE with the package reason, captured with its code', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const { tm } = stack(channel, store)
    const d = await deploy()
    const reason = Reasons.noLinkage(0).reason

    // Straight through the stack (no /submit wrapper): the side channel holds the
    // package's verbatim reason and its typed code.
    const err = await tm.identifyAdmissibleOutputs(d.tx.toBEEF(), d.previousCoins, unlinked(d)).catch((e: unknown) => e)
    expect((err as any).code).toBe('ERR_LINKAGE')
    const captured = channel.take(d.txid)
    expect(captured?.reason).toBe(reason)
    expect(captured?.code).toBe('ERR_LINKAGE')

    const out = await send(tm, store, channel, d, unlinked(d))
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ status: 'error', code: 'ERR_LINKAGE', retryable: false, description: reason, message: reason })
    // A typed final code: persisted for THIS payload.
    expect(store.rows[d.txid].refusedCode).toBe('ERR_LINKAGE')
    expect(store.rows[d.txid].refusedPayloadHash).toBe(payloadHashOfValues(unlinked(d)))
  })

  it('(b) an input already spent by another tx is refused ERR_INPUT_SPENT by the guard, before the package runs', async () => {
    const d = await deploy()
    const issueTx = await issue(tokenOf(d), { tx: d.tx, vout: 0 }, 100n)
    const competitor = 'dd'.repeat(32)
    const channel = new SubmitSideChannel()
    const store = memStore()
    const { tm, inner } = stack(channel, store, coins({ [`${d.txid}.0`]: { spent: true, spentBy: competitor } }))
    const out = await send(tm, store, channel, issueTx)
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('ERR_INPUT_SPENT')
    expect(out.body.spendTxid).toBe(competitor)
    expect(inner).not.toHaveBeenCalled()
    // §9.2: never persisted, so an eviction of the competitor can still rescue it.
    expect(store.rows[issueTx.txid]).toBeUndefined()
  })

  it('(c) a persisted final verdict replays identically without calling the package', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const { tm, inner } = stack(channel, store)
    const d = await deploy()
    const first = await send(tm, store, channel, d, unlinked(d))
    expect(first.body.code).toBe('ERR_LINKAGE')
    expect(inner).toHaveBeenCalledTimes(1)
    const second = await send(tm, store, channel, d, unlinked(d))
    expect(second).toEqual(first)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('a signed deploy by a trusted issuer is admitted and σ_I binds to the admitted set', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const { tm } = stack(channel, store)
    const d = await deploy()
    const out = await send(tm, store, channel, d)
    expect(out.status).toBe(200)
    expect(out.body.tm_mandala.outputsToAdmit).toEqual([0])
    expect(out.body.tm_mandala.admissionSignature).toBe(signAdmissionV2Sync(priv, d.txid, [0]).admissionSignature)
    expect(store.rows[d.txid].outputsToAdmit).toEqual([0])
    expect(await storage.getOwnerJournal(d.txid, 0, 'tm_mandala')).toMatchObject({ role: 'deploy', identityKey: ISSUER })
  })

  it('an evicted txid is refused 410 and never reaches the package', async () => {
    const channel = new SubmitSideChannel()
    const d = await deploy()
    const store = memStore({ [d.txid]: { txid: d.txid, evictedAt: '2026-09-14T10:00:00.000Z' } })
    const { tm, inner } = stack(channel, store)
    const out = await send(tm, store, channel, d)
    expect(out.status).toBe(410)
    expect(out.body).toEqual({
      status: 'error', code: 'ERR_EVICTED', retryable: false,
      description: EVICTED_DESCRIPTION(d.txid), message: EVICTED_DESCRIPTION(d.txid)
    })
    expect(inner).not.toHaveBeenCalled()
  })

  it('an input whose competitor was evicted: 503 heal, nothing persisted, before the package runs', async () => {
    const d = await deploy()
    const issueTx = await issue(tokenOf(d), { tx: d.tx, vout: 0 }, 100n)
    const competitor = 'dd'.repeat(32)
    const inputs = coins({ [`${d.txid}.0`]: { spent: true, spentBy: competitor } })
    inputs.evicted.add(competitor)
    const channel = new SubmitSideChannel()
    const store = memStore()
    const { tm, inner } = stack(channel, store, inputs)
    const out = await send(tm, store, channel, issueTx)
    expect(out.status).toBe(503)
    expect(out.body.code).toBe('ERR_UNAVAILABLE')
    expect(out.body.description).toBe(EVICTED_HEAL_DESCRIPTION(`${d.txid}.0`, competitor))
    expect(inputs.released).toEqual([`${d.txid}.0:${competitor}`])
    expect(inner).not.toHaveBeenCalled()
    expect(store.rows[issueTx.txid]).toBeUndefined()
  })

  // §9.1 — anyone holding the BEEF can submit it with the linkage stripped.
  it('a stripped payload cannot poison the txid: refused for that payload, then admitted with the real one', async () => {
    const channel = new SubmitSideChannel()
    const store = memStore()
    const { tm } = stack(channel, store)
    const d = await deploy()

    const poison = await send(tm, store, channel, d, unlinked(d))
    expect(poison.status).toBe(400)
    expect(poison.body.code).toBe('ERR_LINKAGE')
    // §9.3 — a bare GET is NOT served that refusal…
    expect((await admissionResponse(d.txid, { store, applied: noApplied, priv })).status).toBe(404)
    // …though the submitter who names its own payload still gets its answer.
    const named = await admissionResponse(d.txid, { store, applied: noApplied, priv }, payloadHashOfValues(unlinked(d)))
    expect(named.status).toBe(400)

    const real = await send(tm, store, channel, d)
    expect(real.status).toBe(200)
    expect(real.body.tm_mandala.outputsToAdmit).toEqual([0])
    expect(store.rows[d.txid].refusedCode).toBeUndefined()
  })

  describe('§9.5 — infra faults are never final', () => {
    const boom = async (): Promise<never> => { throw new Error('ECONNREFUSED') }

    it('a throwing output store is 503 with no record written', async () => {
      const channel = new SubmitSideChannel()
      const store = memStore()
      const { tm } = stack(channel, store, { spendStateOf: boom, wasEvicted: async () => false, releaseSpend: async () => 0 })
      const d = await deploy()
      const out = await send(tm, store, channel, d)
      expect(out.status).toBe(503)
      expect(out.body.code).toBe('ERR_UNAVAILABLE')
      expect(out.body.retryable).toBe(true)
      expect(store.rows[d.txid]?.refusedCode).toBeUndefined()
    })

    it('a throwing admission store is 503 with no record written', async () => {
      const channel = new SubmitSideChannel()
      const store = memStore()
      const faulty: AdmissionStore = { ...store, get: boom }
      const { tm } = stack(channel, faulty)
      const d = await deploy()
      const out = await submitThrough(tm, { priv, store: faulty, channel }, d.tx.toBEEF(), envelopeOf(d), d.previousCoins)
      expect(out.status).toBe(503)
      expect(out.body.code).toBe('ERR_UNAVAILABLE')
      expect(store.rows[d.txid]?.refusedCode).toBeUndefined()
    })
  })
})
