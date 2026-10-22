/**
 * Offline local hop checks (C§4, G18, Review Focus 6): every unanchored hop
 * of a receipt graph must satisfy Mandala policy before the wallet may credit
 * it offline. Each refusal is the module's ProfileDataError, `hop <txid>: …`.
 */
import { describe, it, expect } from 'vitest'
import { Transaction, UnlockingScript, type WalletInterface } from '@bsv/sdk'
import { encodeStrictCbor } from '@bsv/templates'
import type { ProfileAssetContext } from '@bsv/color-permission-module'
import { checkOfflineHops } from './profileHopCheck.js'
import { MANDALA_PROFILE_ID } from './constants.js'
import {
  B_KEY, ID, K, OTHER_ID, P, PARENT_HOP, TIP_HOP, buildTx, envelope, hopOf, plainOut, tipWith, tokenOut, type Hop
} from './__fixtures__/colorHops.js'

const ctx = {
  assetId: ID,
  profileId: MANDALA_PROFILE_ID,
  descriptor: { version: 1, params: { identityKey: K } },
  req: new Map(),
  declarationTx: new Transaction(),
  wallet: {} as unknown as WalletInterface,
  identityKey: K,
  originator: 'app.example'
} as unknown as ProfileAssetContext

const refuses = (hops: Hop[], re?: RegExp): void => {
  let err: any
  try {
    checkOfflineHops(ctx, hops, K)
  } catch (e) {
    err = e
  }
  expect(err?.name).toBe('ProfileDataError')
  expect(err.message).toContain(`hop ${hops[hops.length - 1].txid}: `)
  if (re !== undefined) expect(err.message).toMatch(re)
}

describe('checkOfflineHops (C§4 local hop checks)', () => {
  it('a conserving 1-sat hop with a full envelope passes', () => {
    expect(() => checkOfflineHops(ctx, [PARENT_HOP, TIP_HOP], K)).not.toThrow()
  })

  it('a hop spending an authority input of the asset may mint (Σout > Σin) and passes', () => {
    const auth = buildTx([], [tokenOut({ amount: 0n }), plainOut(1000)])
    const mint = buildTx([[auth, 0], [auth, 1]], [tokenOut({ amount: 0n }), tokenOut({ amount: 500n }), plainOut(900)])
    expect(() => checkOfflineHops(ctx, [hopOf(mint, envelope([0, 1]))], K)).not.toThrow()
  })

  it('a burn (Σout < Σin, no authority input) does not conserve', () => {
    refuses([tipWith([tokenOut({ amount: 9n }), plainOut(800)])], /does not conserve/)
  })

  it('a mint without an authority input does not conserve', () => {
    const forged = buildTx([], [tokenOut({ amount: 10n }), plainOut(1000)])
    refuses([hopOf(forged, envelope([0]))], /does not conserve/)
  })

  it('a 2-sat token output is refused', () => {
    refuses([tipWith([tokenOut({ amount: 10n, sats: 2 }), plainOut(800)])], /1 satoshi/)
  })

  it('a 2-sat authority output is refused', () => {
    const auth = buildTx([], [tokenOut({ amount: 0n }), plainOut(1000)])
    const tx = buildTx([[auth, 0], [auth, 1]], [tokenOut({ amount: 0n, sats: 2 }), plainOut(900)])
    refuses([hopOf(tx, envelope([0]))], /1 satoshi/)
  })

  it("a second asset's token output is refused (D1)", () => {
    refuses([tipWith([tokenOut({ amount: 10n }), tokenOut({ id: OTHER_ID, amount: 3n }), plainOut(800)], [0])], /another asset/)
  })

  it("a second asset's token input is refused (D1)", () => {
    const other = buildTx([], [tokenOut({ id: OTHER_ID, amount: 3n })])
    const tx = buildTx([[P, 0], [P, 1], [other, 0]], [tokenOut({ amount: 10n }), plainOut(800)])
    refuses([hopOf(tx, envelope([0]))], /another asset/)
  })

  it('a deploy output in a hop is refused (D1)', () => {
    refuses([tipWith([tokenOut({ amount: 10n }), tokenOut({ id: null, amount: 1n }), plainOut(800)], [0])], /another asset/)
  })

  it('a non-deploy output whose payload map carries req is refused', () => {
    const payload = encodeStrictCbor({ req: {} } as any)
    refuses([tipWith([tokenOut({ amount: 10n, payload }), plainOut(800)])], /req and ext are deploy-only/)
  })

  it('a non-deploy output whose payload map carries ext is refused', () => {
    const payload = encodeStrictCbor({ ext: {} } as any)
    refuses([tipWith([tokenOut({ amount: 10n, payload }), plainOut(800)])], /req and ext are deploy-only/)
  })

  it('a linkage with verifier ≠ K is refused', () => {
    const tx = buildTx([[P, 0], [P, 1]], [tokenOut({ amount: 10n }), plainOut(800)])
    refuses([hopOf(tx, envelope([0], { verifier: B_KEY }))], /verifier/)
  })

  it("a linkage with keyID 'x' is refused", () => {
    const tx = buildTx([[P, 0], [P, 1]], [tokenOut({ amount: 10n }), plainOut(800)])
    refuses([hopOf(tx, envelope([0], { keyID: 'x' }))], /keyID/)
  })

  it('an envelope that misses a token output is refused', () => {
    refuses([tipWith([tokenOut({ amount: 6n }), tokenOut({ amount: 4n }), plainOut(800)], [0])], /envelope/)
  })

  it('an envelope that names a non-token output is refused', () => {
    refuses([tipWith([tokenOut({ amount: 10n }), plainOut(800)], [0, 1])], /envelope/)
  })

  it('empty or malformed offChainValues are refused', () => {
    refuses([{ ...TIP_HOP, offChainValues: [] }], /envelope/)
    refuses([{ ...TIP_HOP, offChainValues: [0x7b] }], /envelope/)
  })

  it('an input without sourceTransaction fails closed', () => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    tx.addOutput(tokenOut({ amount: 10n }))
    refuses([{ txid: tx.id('hex'), atomicBEEF: tx.toAtomicBEEF(true), offChainValues: envelope([0]) }], /source/)
  })

  it('AtomicBEEF whose subject is not the hop txid is refused (stale cache)', () => {
    refuses([{ ...TIP_HOP, txid: PARENT_HOP.txid }], /txid/)
  })

  it('bytes that are not AtomicBEEF are refused', () => {
    refuses([{ ...TIP_HOP, atomicBEEF: [1, 2, 3] }], /AtomicBEEF/)
  })

  it('checks every hop: a clean tip after a bad parent still fails on the parent', () => {
    const bad = { ...PARENT_HOP, offChainValues: envelope([0], { keyID: 'x' }) }
    let err: any
    try { checkOfflineHops(ctx, [bad, TIP_HOP], K) } catch (e) { err = e }
    expect(err?.name).toBe('ProfileDataError')
    expect(err.message).toContain(`hop ${PARENT_HOP.txid}: `)
  })
})
