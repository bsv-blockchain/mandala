/**
 * The P2 proof that the overlay admits BRC-162 (spec §4, §4.2a, §5.1a): the
 * REAL @bsv/overlay Engine (in-memory sqlite, SPV in 'scripts only' mode, so
 * every input's script is verified) over the index.ts tm_mandala stack
 * (withVerdictCapture → withSpentInputGuard → the 2.0.0 MandalaTopicManager,
 * reading the engine's own outputs through knexEngineOutputs), with the real
 * ls_mandala lookup on a throwaway Mongo db.
 *
 * Every transaction is signed for real: token inputs are unlocked with the
 * owner's BRC-42 child key, and the chain is funded from the harness `root`,
 * which carries a merkle path.
 *
 * The engine only logs lookup-service errors, so every admitted step checks
 * its own index rows, and the inline-repair hook must stay silent on the
 * happy path (a broken index would otherwise be masked by repair).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MandalaTopicManager, MandalaStorageManager, InMemoryScreeningProvider, Reasons,
  createMandalaLookupService, reconcileOwnerIndex
} from '@bsv/overlay-topics'
import type { TopicManager } from '@bsv/overlay'
import { createHarness, type Harness } from './testkit/engineHarness.js'
import { connectTestMongo, mongoAvailable, type TestMongo } from './testkit/mongo.js'
import {
  chainFunder, coinOf, envelopeOf, fixturesWith, tokenOf, verifierWallet,
  holder, rogue, HOLDER, ISSUER, OVERLAY, RECEIVER, ROGUE, type Built
} from './testkit/brc162.js'
import { knexEngineOutputs } from './engineOutputs.js'
import { knexSpentInputStore, withSpentInputGuard } from './spentGuard.js'
import { SubmitSideChannel, snapshotRestore, withVerdictCapture, TOKEN_TOPIC } from './submitSideChannel.js'

const up = await mongoAvailable()

/** Unsigned token reads use a page large enough for every test here. */
const ALL = 100

describe.skipIf(!up)('BRC-162 on the real engine — deploy, issue, transfer, refusals, owner-index repair', () => {
  let mongo: TestMongo
  let storage: MandalaStorageManager
  let h: Harness
  let channel: SubmitSideChannel
  let repairs: Array<[string, boolean]>
  let fx: ReturnType<typeof fixturesWith>

  beforeEach(async () => {
    mongo = (await connectTestMongo('brc162flow'))!
    storage = new MandalaStorageManager(mongo.db)
    channel = new SubmitSideChannel()
    repairs = []
    const lookup = createMandalaLookupService(verifierWallet, storage)(mongo.db)
    h = await createHarness({
      topics: [TOKEN_TOPIC],
      lookupServices: { ls_mandala: lookup },
      // index.ts's tm_mandala stack minus the persisted verdict (which needs
      // the admission store): capture → spent guard → the package manager.
      topicManagers: knex => ({
        [TOKEN_TOPIC]: withVerdictCapture(
          withSpentInputGuard(
            new MandalaTopicManager({
              verifierWallet,
              trustedIssuers: [ISSUER],
              stateStore: storage,
              engineOutputs: knexEngineOutputs(knex),
              screeningProvider: new InMemoryScreeningProvider([]),
              membershipExempt: [OVERLAY],
              onOwnerRepair: (outpoint, inserted) => { repairs.push([outpoint, inserted]) }
            }) as unknown as TopicManager,
            knexSpentInputStore(knex, TOKEN_TOPIC, async () => false)),
          { channel, snapshotRestore })
      })
    })
    fx = fixturesWith(chainFunder(h.root, h.key))
  })
  afterEach(async () => {
    await h?.close()
    await mongo?.close()
  })

  /** Submits through the engine with the envelope as off-chain values. */
  const submit = async (b: Built, offChainValues = envelopeOf(b)) => {
    const out = await h.submit(b.tx, offChainValues)
    expect(out.error).toBeUndefined()
    return { admitted: (out.steak as any)?.[TOKEN_TOPIC]?.outputsToAdmit as number[] | undefined, captured: channel.take(b.txid) }
  }

  /** An admitted step: exactly these outputs, and no refusal captured. */
  const admit = async (b: Built, expected: number[]): Promise<void> => {
    const { admitted, captured } = await submit(b)
    expect(captured?.reason).toBeUndefined()
    expect(captured?.code).toBeUndefined()
    expect(admitted).toEqual(expected)
  }

  /** A refused step: the package's own code and verbatim reason, and nothing written anywhere. */
  const refuse = async (b: Built, reject: { code: string, reason: string }, offChainValues = envelopeOf(b)): Promise<void> => {
    const { admitted, captured } = await submit(b, offChainValues)
    expect(captured?.code).toBe(reject.code)
    expect(captured?.reason).toBe(reject.reason)
    expect(admitted).toEqual([])
    expect(await h.knex('outputs').where({ txid: b.txid })).toHaveLength(0)
    expect(await mongo.db.collection('mandalaOwners').countDocuments({ txid: b.txid })).toBe(0)
    expect(await mongo.db.collection('mandalaTokens').countDocuments({ txid: b.txid })).toBe(0)
    expect(await mongo.db.collection('mandalaAuthorities').countDocuments({ txid: b.txid })).toBe(0)
    expect(await mongo.db.collection('mandalaAdminHistory').countDocuments({ txid: b.txid })).toBe(0)
  }

  /** deploy → issue `amount` to HOLDER, each admitted and indexed. */
  const deployAndIssue = async (amount = 1000n): Promise<{ d: Built, i: Built, tid: string }> => {
    const d = await fx.deploy()
    const tid = tokenOf(d)
    await admit(d, [0])
    expect(await storage.getOwnerJournal(d.txid, 0, TOKEN_TOPIC)).toMatchObject({ role: 'deploy', tokenId: tid, amount: 0, identityKey: ISSUER })
    expect(await storage.getAuthorityRow(d.txid, 0)).toMatchObject({ tokenId: tid, identityKey: ISSUER })
    expect(await storage.findMetadata(tid)).toMatchObject({ txid: d.txid, outputIndex: 0 })

    const i = await fx.issue(tid, coinOf(d, 0), amount)
    await admit(i, [0, 1])
    expect(await storage.getTokenRow(i.txid, 0)).toMatchObject({ tokenId: tid, amount: Number(amount), identityKey: HOLDER })
    expect(await storage.getAuthorityRow(i.txid, 1)).toMatchObject({ tokenId: tid, identityKey: ISSUER })
    // The spent deploy authority left the index.
    expect(await storage.getAuthorityRow(d.txid, 0)).toBeNull()
    return { d, i, tid }
  }

  it('deploy → issue 1000 → transfer 400/600: admitted, rows indexed, journal written', async () => {
    const { d, i, tid } = await deployAndIssue(1000n)

    const t = await fx.transfer(tid, coinOf(i, 0), holder, [[RECEIVER, 400n], [HOLDER, 600n]])
    await admit(t, [0, 1])

    expect((await storage.findTokensByTokenId(tid, ALL, 0)).map(r => r.amount)).toEqual([400, 600])
    expect((await storage.findTokensByTokenId(tid, ALL, 0)).map(r => r.identityKey)).toEqual([RECEIVER, HOLDER])
    expect(await storage.getTokenRow(i.txid, 0)).toBeNull()
    const authorities = await storage.listAuthorities(TOKEN_TOPIC, tid)
    expect(authorities).toHaveLength(1)
    expect(authorities[0]).toMatchObject({ txid: i.txid, outputIndex: 1, identityKey: ISSUER })
    expect(await storage.circulatingSupply(tid)).toBe(1000n)

    // One journal row per admitted output: deploy 0, issue 0/1, transfer 0/1.
    const journal = await mongo.db.collection('mandalaOwners').find({ tokenId: tid }, { projection: { _id: 0, txid: 1, outputIndex: 1, role: 1 } }).toArray()
    expect(journal.map(j => `${j.txid}.${j.outputIndex}:${j.role}`).sort()).toEqual([
      `${d.txid}.0:deploy`, `${i.txid}.0:value`, `${i.txid}.1:authority`, `${t.txid}.0:value`, `${t.txid}.1:value`
    ].sort())

    const history = await storage.findAdminHistory(tid)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ kind: 'issue', delta: 1000, txid: i.txid, outputIndex: 1 })

    // Engine side: exactly the three live coins remain unspent on tm_mandala.
    const live = await h.knex('outputs').where({ topic: TOKEN_TOPIC, spent: false }).select('txid', 'outputIndex')
    expect(live.map((r: any) => `${r.txid}.${r.outputIndex}`).sort()).toEqual([`${i.txid}.1`, `${t.txid}.0`, `${t.txid}.1`].sort())
    // A healthy index never needed an inline repair.
    expect(repairs).toEqual([])
  })

  it('untrusted deploy → ERR_UNTRUSTED, nothing admitted, nothing journaled', async () => {
    // Correctly signed by rogue, so the deploySig step passes and the trust step decides.
    const d = await fx.deploy(rogue, ROGUE)
    await refuse(d, Reasons.untrustedOwner(0, ROGUE))
    expect(await storage.findMetadata(tokenOf(d))).toBeNull()
    expect(repairs).toEqual([])
  })

  it('deploy without deploySig → ERR_AUTHORITY', async () => {
    const d = await fx.deploy()
    const { deploySig: _dropped, ...env } = d.env
    await refuse(d, Reasons.deploySig(), envelopeOf({ ...d, env }))
    expect(await storage.findMetadata(tokenOf(d))).toBeNull()
  })

  it('holder implicit burn (I > O) → ERR_CONSERVATION', async () => {
    const { i, tid } = await deployAndIssue(1000n)
    const burn = await fx.transfer(tid, coinOf(i, 0), holder, [[RECEIVER, 400n], [HOLDER, 200n]])
    await refuse(burn, Reasons.holderConservation(tid, 1000n, 600n))
    // The holder's coin is untouched: still live on the engine and in the index.
    const coin = await h.knex('outputs').where({ txid: i.txid, outputIndex: 0, topic: TOKEN_TOPIC }).first()
    expect(Boolean(coin.spent)).toBe(false)
    expect(await storage.getTokenRow(i.txid, 0)).toMatchObject({ amount: 1000, identityKey: HOLDER })
    expect(repairs).toEqual([])
  })

  it('missing owner row is repaired inline and the spend is admitted (§4.2a rule 3)', async () => {
    const { i, tid } = await deployAndIssue(1000n)
    // A lost index write: the value row never landed (and so never credited).
    const lost = await storage.takeToken(i.txid, 0)
    expect(lost).not.toBeNull()
    await storage.adjustBalance(HOLDER, -1000)
    expect(await storage.getBalance(HOLDER)).toBe(0)

    // Observe the repaired row at the moment of repair: the transfer's own
    // spend notification takes it again in the engine's phase 3.
    const repairedRows: unknown[] = []
    const repair = storage.repairOwnerRow.bind(storage)
    const spy = vi.spyOn(storage, 'repairOwnerRow').mockImplementation(async journal => {
      const result = await repair(journal)
      repairedRows.push({ result, row: await storage.getTokenRow(journal.txid, journal.outputIndex) })
      return result
    })

    const t = await fx.transfer(tid, coinOf(i, 0), holder, [[RECEIVER, 400n], [HOLDER, 600n]])
    await admit(t, [0, 1])

    expect(spy).toHaveBeenCalledTimes(1)
    expect(repairs).toEqual([[`${i.txid}.0`, true]])
    expect(repairedRows).toEqual([{
      result: { inserted: true },
      row: expect.objectContaining({ txid: i.txid, outputIndex: 0, tokenId: tid, amount: 1000, identityKey: HOLDER })
    }])
    // The spend took the repaired row back out; the transfer's rows are indexed.
    expect(await storage.getTokenRow(i.txid, 0)).toBeNull()
    expect((await storage.findTokensByTokenId(tid, ALL, 0)).map(r => r.amount)).toEqual([400, 600])
    // Credited once on repair, debited once by the spend: the balance is just the new coin.
    expect(await storage.getBalance(HOLDER)).toBe(600)
    expect(await storage.getBalance(RECEIVER)).toBe(400)
  })

  it('reconciler restores a deleted row; an orphan output with no journal is reported unrepairable', async () => {
    const { i, tid } = await deployAndIssue(1000n)
    const t = await fx.transfer(tid, coinOf(i, 0), holder, [[RECEIVER, 400n], [HOLDER, 600n]])
    await admit(t, [0, 1])

    // (a) a lost row with its journal intact: repairable.
    await mongo.db.collection('mandalaTokens').deleteOne({ txid: t.txid, outputIndex: 0 })
    // (b) a lost row whose journal is gone too: the engine still holds the
    // output, but nothing can say who owns it.
    await mongo.db.collection('mandalaTokens').deleteOne({ txid: t.txid, outputIndex: 1 })
    await mongo.db.collection('mandalaOwners').deleteOne({ txid: t.txid, outputIndex: 1, topic: TOKEN_TOPIC })

    const reconciled: string[] = []
    const result = await reconcileOwnerIndex({
      storage,
      engine: knexEngineOutputs(h.knex),
      topic: TOKEN_TOPIC,
      onRepair: (outpoint, inserted) => { reconciled.push(`${outpoint}:${String(inserted)}`) }
    })

    // issue.1 (authority, row intact), transfer.0 (repaired), transfer.1 (unrepairable).
    expect(result).toEqual({ scanned: 3, repaired: 1, unrepairable: [`${t.txid}.1`] })
    expect(reconciled).toEqual([`${t.txid}.0:true`])
    expect(await storage.getTokenRow(t.txid, 0)).toMatchObject({ tokenId: tid, amount: 400, identityKey: RECEIVER })
    expect(await storage.getTokenRow(t.txid, 1)).toBeNull()
    expect(await storage.getAuthorityRow(i.txid, 1)).toMatchObject({ tokenId: tid, identityKey: ISSUER })

    // A rerun is idempotent: nothing more to repair, the orphan still reported.
    expect(await reconcileOwnerIndex({ storage, engine: knexEngineOutputs(h.knex), topic: TOKEN_TOPIC, onRepair: () => {} }))
      .toEqual({ scanned: 3, repaired: 0, unrepairable: [`${t.txid}.1`] })
  })
}, 30_000)
