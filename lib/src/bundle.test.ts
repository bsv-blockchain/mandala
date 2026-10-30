/**
 * COVER with the S1 hop checks (design §9 B7, audit S1): restored 0.4.1 walk
 * rules (FIX A/B/K) plus the regressions that close "COVER accepts value
 * minted from nothing": forged spends, fabricated mint and authority parents,
 * fabricated deploys, an authority chain that does not reach σ, and a
 * duplicate spend across hops.
 *
 * Every transaction here is really signed (P2PKH under the 1Color prefix), so
 * the script check is exercised, not stubbed.
 */
import { describe, expect, it } from 'vitest'
import { PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { cover } from './bundle.js'
import type { Attestation } from './attestation.js'
import { encodeAdminDetails } from './brc162.js'
import { encodeEnvelope } from './encoding.js'
import { OVERLAY_KEY as K } from './__fixtures__/overlaySigner.js'
import { linkage } from './__fixtures__/colorHops.js'
import { A, auth, B, chain, env, ID, ISSUER, pkh, root, sats, sigma, signed, tok } from './__fixtures__/signedChain.js'

const run = (tip: Transaction, admissions: Attestation[], linkage: Array<[Transaction, number[]]>) =>
  cover({
    assetId: ID,
    tip: Transaction.fromAtomicBEEF(tip.toAtomicBEEF()),
    admissions: new Map(admissions.map(a => [a.txid, a])),
    linkage: new Map(linkage.map(([t, b]) => [t.id('hex'), b]))
  }, { expectedSignerKey: K })

describe('COVER (restored 0.4.1 walk)', () => {
  it('accepts a chain that bottoms out at σ; mustSubmit is parents first, tip last', async () => {
    const { P, T, gSigma } = await chain()
    const r = run(T, [gSigma], [[P, env([0])], [T, env([0, 1])]])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mustSubmit).toEqual([P.id('hex'), T.id('hex')])
  })

  it('a σ-covered parent ends the walk (only the tip is submitted)', async () => {
    const { P, T } = await chain()
    const r = run(T, [await sigma(P, [0])], [[T, env([0, 1])]])
    expect(r.ok && r.mustSubmit).toEqual([T.id('hex')])
  })

  it('FIX A: a parent σ that does not admit the spent vout is a hole', async () => {
    const { P, T, G } = await chain()
    const r = run(T, [await sigma(G, [1])], [[P, env([0])], [T, env([0, 1])]])
    expect(r).toMatchObject({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('FIX B: σ by another key is no proof', async () => {
    const { P, T, G } = await chain()
    const r = run(T, [await sigma(G, [0], new PrivateKey(9999))], [[P, env([0])], [T, env([0, 1])]])
    expect(r).toMatchObject({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('FIX K: a non-token fee parent is neither walked nor a hole', async () => {
    const { T, P } = await chain()
    const r = run(T, [await sigma(P, [0])], [[T, env([0, 1])]])
    expect(r.ok).toBe(true)
  })

  it('an unadmitted ancestor without an envelope cannot be submitted: uncovered', async () => {
    const { T, gSigma } = await chain()
    expect(run(T, [gSigma], [[T, env([0, 1])]])).toMatchObject({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('fails closed without a configured key', async () => {
    const { T } = await chain()
    const r = cover({ assetId: ID, tip: T, admissions: new Map(), linkage: new Map() }, { expectedSignerKey: '' })
    expect(r).toMatchObject({ ok: false, reason: 'unsafe_asset' })
  })
})

describe('COVER S1 regressions (B7)', () => {
  it('value minted from nothing in the tip (I < O, no authority) is refused', async () => {
    const { P, gSigma } = await chain()
    const T = await signed([[P, 0, A], [P, 1, A]], [tok(6n, B), tok(9n, A), sats(A, 800)])
    const r = run(T, [gSigma], [[P, env([0])], [T, env([0, 1])]])
    expect(r).toMatchObject({ ok: false, reason: 'hop' })
    expect(!r.ok && r.detail).toMatch(/does not conserve/)
  })

  it('a fabricated mint parent (a token output from a fee-only tx) is refused', async () => {
    const F = root([sats(A)])
    const P = await signed([[F, 0, A]], [tok(1000n, A), sats(A, 900)]) // mint from nothing
    const T = await signed([[P, 0, A], [P, 1, A]], [tok(1000n, B), sats(A, 800)])
    const r = run(T, [], [[P, env([0])], [T, env([0])]])
    expect(r).toMatchObject({ ok: false, reason: 'hop' })
    expect(!r.ok && r.detail).toContain(P.id('hex'))
  })

  it('a fabricated authority parent (an authority output created without spending one) is refused', async () => {
    const details = encodeAdminDetails({ kind: 'issue' })
    const F = root([sats(A)])
    const fakeAuth = await signed([[F, 0, A]], [auth(A, details), sats(A, 900)])
    const mint = await signed([[fakeAuth, 0, A], [fakeAuth, 1, A]], [tok(1_000_000n, B), auth(A, details), sats(A, 800)])
    const adminEnv = (i: number[], a: number): number[] => env(i, { admin: [{ index: a, details: Utils.toHex(details) }] })
    const r = run(mint, [], [[fakeAuth, adminEnv([0], 0)], [mint, adminEnv([0, 1], 1)]])
    expect(r).toMatchObject({ ok: false, reason: 'hop' })
    expect(!r.ok && r.detail).toMatch(/without spending an authority/)
  })

  it('an authority chain that does not reach σ is uncovered (the authority input is walked)', async () => {
    const details = encodeAdminDetails({ kind: 'issue' })
    // The authority's parent is not in the bundle at all.
    const unseen = root([auth(ISSUER, details)])
    const mint = await signed([[unseen, 0, ISSUER]], [tok(50n, B), auth(ISSUER, details)])
    const tip = Transaction.fromAtomicBEEF(mint.toAtomicBEEF())
    tip.inputs[0].sourceTransaction = undefined
    tip.inputs[0].sourceTXID = unseen.id('hex')
    const r = cover({ assetId: ID, tip, admissions: new Map(), linkage: new Map([[mint.id('hex'), env([0, 1])]]) }, { expectedSignerKey: K })
    expect(r).toMatchObject({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('a valid authority transition from a σ-covered authority passes; a wrong commitment does not', async () => {
    const details = encodeAdminDetails({ kind: 'issue' })
    const head = root([auth(ISSUER, details), sats(ISSUER)])
    const headSigma = await sigma(head, [0])
    const mint = await signed([[head, 0, ISSUER], [head, 1, ISSUER]], [tok(50n, B), auth(ISSUER, details), sats(ISSUER, 900)])
    const ok = run(mint, [headSigma], [[mint, env([0, 1], { admin: [{ index: 1, details: Utils.toHex(details) }] })]])
    expect(ok.ok).toBe(true)
    const other = encodeAdminDetails({ kind: 'redeem' })
    const bad = run(mint, [headSigma], [[mint, env([0, 1], { admin: [{ index: 1, details: Utils.toHex(other) }] })]])
    expect(bad).toMatchObject({ ok: false, reason: 'hop' })
    expect(!bad.ok && bad.detail).toMatch(/does not commit/)
  })

  it('a fabricated deploy input (not the asset\'s own deploy) is refused', async () => {
    const fakeDeploy = root([{ lockingScript: new OneColor().lock(null, 0n, pkh(A), [0xa0]), satoshis: 1 }, sats(A)])
    const T = await signed([[fakeDeploy, 0, A], [fakeDeploy, 1, A]], [tok(100n, B), sats(A, 900)])
    expect(run(T, [], [[T, env([0])]])).toMatchObject({ ok: false, reason: 'hop' })
  })

  it('a forged spend (a covered coin signed by the wrong key) is refused', async () => {
    const G = root([tok(10n, A), sats(B)])
    const T = await signed([[G, 0, B], [G, 1, B]], [tok(10n, B), sats(B, 900)]) // B cannot spend A's coin
    const r = run(T, [await sigma(G, [0])], [[T, env([0])]])
    expect(r).toMatchObject({ ok: false, reason: 'hop' })
    expect(!r.ok && r.detail).toMatch(/does not verify/)
  })

  it('a duplicate spend across hops is refused', async () => {
    const G = root([tok(10n, A), sats(A), sats(A)])
    const P1 = await signed([[G, 0, A], [G, 1, A]], [tok(10n, A), sats(A, 900)])
    const P2 = await signed([[G, 0, A], [G, 2, A]], [tok(10n, A), sats(A, 950)])
    const T = await signed([[P1, 0, A], [P2, 0, A], [P1, 1, A]], [tok(20n, B), sats(A, 800)])
    const r = run(T, [await sigma(G, [0])], [[P1, env([0])], [P2, env([0])], [T, env([0])]])
    expect(r).toMatchObject({ ok: false, reason: 'double_spend' })
  })

  it('a 2-sat token output, a foreign asset output and a wrong verifier are refused', async () => {
    const { P, gSigma } = await chain()
    const t1 = await signed([[P, 0, A], [P, 1, A]], [tok(10n, B, ID, 2), sats(A, 800)])
    expect(run(t1, [gSigma], [[P, env([0])], [t1, env([0])]])).toMatchObject({ ok: false, reason: 'hop' })
    const t2 = await signed([[P, 0, A], [P, 1, A]], [tok(10n, B), tok(1n, B, `${'ab'.repeat(32)}_0`), sats(A, 800)])
    expect(run(t2, [gSigma], [[P, env([0])], [t2, env([0, 1])]])).toMatchObject({ ok: false, reason: 'hop' })
    const t3 = await signed([[P, 0, A], [P, 1, A]], [tok(10n, B), sats(A, 800)])
    const wrongVerifier = encodeEnvelope({ outputs: [{ index: 0, linkage: linkage({ verifier: B.toPublicKey().toString() }) }] })
    expect(run(t3, [gSigma], [[P, env([0])], [t3, wrongVerifier]])).toMatchObject({ ok: false, reason: 'hop' })
  })
})
