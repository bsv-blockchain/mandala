import { describe, it, expect } from 'vitest'
import { Beef, LockingScript, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { AdmissionEntry, admissionMessageV2 } from './admission.js'
import { AdmissionBundle, canonicalBundleId, cover, CoverOptions, TransactionLike } from './bundle.js'

const OVERLAY = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000a1')
const OVERLAY_KEY = OVERLAY.toPublicKey().toString()
const IMPOSTOR = PrivateKey.fromHex('00000000000000000000000000000000000000000000000000000000000000b2')
const IMPOSTOR_KEY = IMPOSTOR.toPublicKey().toString()

/**
 * §9.10 — the verifier's OWN configured overlay identity key. Every `cover()`
 * call takes it as its third argument; nothing in the bundle can substitute.
 */
const TRUST: CoverOptions = { expectedSignerKey: OVERLAY_KEY }

const ASSET = `${'11'.repeat(32)}.0`
const OTHER_ASSET = `${'22'.repeat(32)}.0`

const PKH = (n: number): number[] => new Array(20).fill(n)

const token = (assetId: string, amount: number, pkh = 7): LockingScript =>
  new MandalaToken().lock(assetId, amount, PKH(pkh))

/** A plain (non-token) output — an ordinary BSV fee ancestor. */
const plain = (n: number): LockingScript =>
  LockingScript.fromASM(`OP_DUP OP_HASH160 ${Utils.toHex(PKH(n))} OP_EQUALVERIFY OP_CHECKSIG`)

interface InputSpec { src?: Transaction, srcTxid?: string, vout: number }

const mkTx = (inputs: InputSpec[], outputs: LockingScript[], nonce = 0): Transaction => {
  const tx = new Transaction()
  tx.lockTime = nonce
  for (const i of inputs) {
    tx.addInput({
      sourceTransaction: i.src,
      sourceTXID: i.srcTxid ?? i.src?.id('hex'),
      sourceOutputIndex: i.vout,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff
    })
  }
  for (const s of outputs) tx.addOutput({ lockingScript: s, satoshis: 1 })
  return tx
}

const id = (tx: Transaction): string => tx.id('hex')

const admit = (txid: string, outputsToAdmit: number[], key = OVERLAY): AdmissionEntry => {
  const der = key.sign(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8')).toDER()
  return {
    outputsToAdmit,
    signature: typeof der === 'string' ? der : Utils.toHex(der),
    signerKey: key.toPublicKey().toString()
  }
}

const bundleOf = (p: Partial<AdmissionBundle> & { tip: Transaction }): AdmissionBundle => ({
  assetId: ASSET,
  overlayIdentityKey: OVERLAY_KEY,
  beef: new Map<string, Transaction>(),
  linkage: new Map<string, number[]>(),
  admissions: new Map<string, AdmissionEntry>(),
  ...p
})

const beefOf = (...txs: Transaction[]): Map<string, Transaction> =>
  new Map(txs.map(t => [id(t), t]))

// ---------------------------------------------------------------------------
// §1.1 canonical bundle id
// ---------------------------------------------------------------------------

describe('canonicalBundleId (spec §1.1 — test-vector pinning only, never a wire field)', () => {
  const X = mkTx([], [token(ASSET, 10)])
  const T = mkTx([{ src: X, vout: 0 }], [token(ASSET, 10)], 1)

  const base = (): AdmissionBundle => bundleOf({
    tip: T,
    beef: beefOf(X, T),
    linkage: new Map([[id(X), [1, 2, 3]]]),
    admissions: new Map([[id(X), admit(id(X), [0])]])
  })

  it('is a deterministic 64-hex digest', () => {
    expect(canonicalBundleId(base())).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalBundleId(base())).toBe(canonicalBundleId(base()))
  })

  it('does not depend on Map insertion order (entries are sorted by txid)', () => {
    const A = mkTx([], [token(ASSET, 1)], 11)
    const B = mkTx([], [token(ASSET, 2)], 12)
    const forward = bundleOf({
      tip: T,
      linkage: new Map([[id(A), [1]], [id(B), [2]]]),
      admissions: new Map([[id(A), admit(id(A), [0])], [id(B), admit(id(B), [0])]])
    })
    const reverse = bundleOf({
      tip: T,
      linkage: new Map([[id(B), [2]], [id(A), [1]]]),
      admissions: new Map([[id(B), admit(id(B), [0])], [id(A), admit(id(A), [0])]])
    })
    expect(canonicalBundleId(forward)).toBe(canonicalBundleId(reverse))
  })

  it('changes when the tip, the overlay key, a linkage payload or an admitted set changes', () => {
    const baseline = canonicalBundleId(base())
    expect(canonicalBundleId({ ...base(), tip: X })).not.toBe(baseline)
    expect(canonicalBundleId({ ...base(), overlayIdentityKey: IMPOSTOR.toPublicKey().toString() })).not.toBe(baseline)
    expect(canonicalBundleId({ ...base(), linkage: new Map([[id(X), [9, 9, 9]]]) })).not.toBe(baseline)
    expect(canonicalBundleId({ ...base(), admissions: new Map([[id(X), admit(id(X), [0, 1])]]) })).not.toBe(baseline)
  })
})

// ---------------------------------------------------------------------------
// §1.6 worked examples
// ---------------------------------------------------------------------------

describe('cover — §1.6 worked examples', () => {
  it('0-hop: the only token input is already admitted; mustSubmit is just the tip', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ src: X, vout: 0 }], [token(ASSET, 10)], 1)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(X, T),
      admissions: new Map([[id(X), admit(id(X), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [id(T)] })
  })

  it('1-hop: an unadmitted parent whose own parent is admitted; parents-first order', () => {
    const G = mkTx([], [token(ASSET, 10)])
    const X = mkTx([{ src: G, vout: 0 }], [token(ASSET, 10)], 1)
    const T = mkTx([{ src: X, vout: 0 }], [token(ASSET, 10)], 2)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(G, X, T),
      linkage: new Map([[id(X), [0xaa]]]),
      admissions: new Map([[id(G), admit(id(G), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [id(X), id(T)] })
  })

  it('3-hop chained offline: the whole chain is submittable, topologically ordered, tip last', () => {
    const X0 = mkTx([], [token(ASSET, 10)])
    const T1 = mkTx([{ src: X0, vout: 0 }], [token(ASSET, 10)], 1)
    const T2 = mkTx([{ src: T1, vout: 0 }], [token(ASSET, 10)], 2)
    const T3 = mkTx([{ src: T2, vout: 0 }], [token(ASSET, 10)], 3)
    const res = cover(T3, bundleOf({
      tip: T3,
      beef: beefOf(X0, T1, T2, T3),
      linkage: new Map([[id(T1), [1]], [id(T2), [2]]]),
      admissions: new Map([[id(X0), admit(id(X0), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [id(T1), id(T2), id(T3)] })
  })

  it('phantom coin: a sibling token output the overlay never admitted is UNCOVERED (FIX A)', () => {
    // X is genuinely admitted — but only for output 0. Output 1 is the hostile
    // sibling that rode along unlinked. σ_I(X) must not license it.
    const X = mkTx([], [token(ASSET, 10), token(ASSET, 1_000_000)])
    const T = mkTx([{ src: X, vout: 1 }], [token(ASSET, 1_000_000)], 1)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(X, T),
      admissions: new Map([[id(X), admit(id(X), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })
})

// ---------------------------------------------------------------------------
// FIX K / FIX B / holes
// ---------------------------------------------------------------------------

describe('cover — coverage rules', () => {
  it('pure issuance (no token ancestor at all) is the trivial base case', () => {
    const T = mkTx([], [token(ASSET, 10)])
    expect(cover(T, bundleOf({ tip: T, beef: beefOf(T) }), TRUST)).toEqual({ ok: true, mustSubmit: [id(T)] })
  })

  it('FIX K: an unconfirmed BSV fee parent is ignored — never walked, never a hole', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const FEE = mkTx([], [plain(3)], 5) // fresh unconfirmed change, no admission, no σ_I
    const T = mkTx([{ src: X, vout: 0 }, { src: FEE, vout: 0 }], [token(ASSET, 10)], 1)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(X, FEE, T),
      admissions: new Map([[id(X), admit(id(X), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [id(T)] })
  })

  it('FIX K: a token input of a DIFFERENT asset is not this bundle’s concern', () => {
    const OTHER = mkTx([], [token(OTHER_ASSET, 10)])
    const X = mkTx([], [token(ASSET, 10)], 4)
    const T = mkTx([{ src: X, vout: 0 }, { src: OTHER, vout: 0 }], [token(ASSET, 10)], 1)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(X, OTHER, T),
      admissions: new Map([[id(X), admit(id(X), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [id(T)] })
  })

  it('FIX B: a token ancestor with neither σ_I nor bytes is a hole (mined ≠ admitted)', () => {
    const X = mkTx([], [token(ASSET, 10)])
    // Bundle carries only the tip — X is absent (no bytes anywhere) and unadmitted.
    const T = mkTx([{ srcTxid: id(X), vout: 0 }], [token(ASSET, 10)], 1)
    const res = cover(T, bundleOf({ tip: T, beef: beefOf(T) }), TRUST)
    expect(res).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('an ancestor present only as a txid in a Beef is a hole, not a bottom', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ srcTxid: id(X), vout: 0 }], [token(ASSET, 10)], 1)
    const beef = new Beef()
    beef.mergeTransaction(T)
    beef.mergeTxidOnly(id(X))
    expect(cover(T, bundleOf({ tip: T, beef }), TRUST)).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('resolves ancestors out of a Beef as readily as out of a Map', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ srcTxid: id(X), vout: 0 }], [token(ASSET, 10)], 1)
    const beef = new Beef()
    beef.mergeTransaction(X)
    beef.mergeTransaction(T)
    const res = cover(T, bundleOf({
      tip: T,
      beef,
      admissions: new Map([[id(X), admit(id(X), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [id(T)] })
  })

  it('a σ_I signed by anyone other than the bundle’s overlay key proves nothing', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ srcTxid: id(X), vout: 0 }], [token(ASSET, 10)], 1)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(T), // no bytes for X, so an unusable σ_I leaves a hole
      admissions: new Map([[id(X), admit(id(X), [0], IMPOSTOR)]])
    }), TRUST)
    expect(res).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('a tampered admitted set fails verification and therefore covers nothing', () => {
    const X = mkTx([], [token(ASSET, 10), token(ASSET, 5)])
    const T = mkTx([{ srcTxid: id(X), vout: 1 }], [token(ASSET, 5)], 1)
    const forged = { ...admit(id(X), [0]), outputsToAdmit: [0, 1] } // claim vout 1 too
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(T),
      admissions: new Map([[id(X), forged]])
    }), TRUST)
    expect(res).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('a diamond (two inputs, one shared unadmitted parent) lists that parent once', () => {
    const G = mkTx([], [token(ASSET, 10)])
    const X = mkTx([{ src: G, vout: 0 }], [token(ASSET, 6), token(ASSET, 4)], 1)
    const T = mkTx([{ src: X, vout: 0 }, { src: X, vout: 1 }], [token(ASSET, 10)], 2)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(G, X, T),
      admissions: new Map([[id(G), admit(id(G), [0])]])
    }), TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [id(X), id(T)] })
  })
})

// ---------------------------------------------------------------------------
// Termination / hostile input
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structural typing (a second, nested @bsv/sdk copy never needs a cast)
// ---------------------------------------------------------------------------

describe('cover — TransactionLike is structural', () => {
  it('accepts a plain object shaped like a Transaction (e.g. from a duplicated @bsv/sdk copy) with no cast', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const TIP_TXID = 'c'.repeat(64)
    // Not an instance of this package's Transaction class at all — a bare
    // object with only the members `cover` reads. If `cover`/`AdmissionBundle`
    // required the nominal Transaction type, this would fail to typecheck.
    const plainTip: TransactionLike = {
      id: (enc: 'hex') => TIP_TXID,
      inputs: [{ sourceTXID: id(X), sourceOutputIndex: 0 }],
      outputs: [{ lockingScript: token(ASSET, 10), satoshis: 1 }]
    }
    const bundle: AdmissionBundle = {
      assetId: ASSET,
      overlayIdentityKey: OVERLAY_KEY,
      tip: plainTip,
      beef: beefOf(X),
      linkage: new Map<string, number[]>(),
      admissions: new Map([[id(X), admit(id(X), [0])]])
    }
    const res = cover(plainTip, bundle, TRUST)
    expect(res).toEqual({ ok: true, mustSubmit: [TIP_TXID] })
  })
})

describe('cover — malformed and hostile bundles terminate', () => {
  it('an input naming neither a source txid nor a source transaction is a shape error', () => {
    const T = mkTx([], [token(ASSET, 10)])
    ;(T.inputs as any[]).push({ sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    expect(cover(T, bundleOf({ tip: T }), TRUST)).toEqual({ ok: false, reason: 'shape' })
  })

  it('a beef entry filed under a txid that is not its own hash is treated as absent', () => {
    // The hostile shape a cycle would need: a map key pointing at unrelated bytes.
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ srcTxid: id(X), vout: 0 }], [token(ASSET, 10)], 1)
    const lying = new Map<string, Transaction>([[id(X), T], [id(T), T]])
    expect(cover(T, bundleOf({ tip: T, beef: lying }), TRUST)).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('a self-referential input terminates instead of recursing forever', () => {
    const T = mkTx([], [token(ASSET, 10)])
    const self = id(T)
    ;(T.inputs as any[]).push({ sourceTXID: self, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    // The map key now lies about T's own (post-mutation) id, so the lookup fails.
    const res = cover(T, bundleOf({ tip: T, beef: new Map([[self, T]]) }), TRUST)
    expect(res).toEqual({ ok: false, reason: 'shape' })
  })

  it('refuses a bundle with no asset or an unusable overlay identity key', () => {
    const T = mkTx([], [token(ASSET, 10)])
    expect(cover(T, bundleOf({ tip: T, assetId: '' }), TRUST)).toEqual({ ok: false, reason: 'unsafe_asset' })
    expect(cover(T, bundleOf({ tip: T, overlayIdentityKey: 'not-a-key' }), TRUST)).toEqual({ ok: false, reason: 'unsafe_asset' })
  })
})

// ---------------------------------------------------------------------------
// §9.10 — the trust anchor is the CALLER's key, never the bundle's
// ---------------------------------------------------------------------------

describe('cover — expectedSignerKey is the only trust anchor (§9.10)', () => {
  /** The attack: the payer names their own key AND self-signs σ_I with it. */
  const forgedBundle = (): { tip: Transaction, bundle: AdmissionBundle } => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ src: X, vout: 0 }], [token(ASSET, 10)], 1)
    return {
      tip: T,
      bundle: bundleOf({
        tip: T,
        overlayIdentityKey: IMPOSTOR_KEY,
        beef: beefOf(X, T),
        // Internally consistent: this σ_I really does verify against the key
        // the bundle names. Only an EXTERNAL anchor catches it.
        admissions: new Map([[id(X), admit(id(X), [0], IMPOSTOR)]])
      })
    }
  }

  it('an attacker-keyed bundle with self-signed σ_I is unsafe_asset, not a cover', () => {
    const { tip, bundle } = forgedBundle()
    // Self-consistent by construction — it would pass a verifier that read the
    // key out of the bundle.
    expect(cover(tip, bundle, { expectedSignerKey: IMPOSTOR_KEY })).toEqual({ ok: true, mustSubmit: [id(tip)] })
    // Against the real overlay key this session trusts, it is refused outright.
    expect(cover(tip, bundle, TRUST)).toEqual({ ok: false, reason: 'unsafe_asset' })
  })

  it('a bundle naming the right key but carrying an impostor σ_I leaves a hole, not a cover', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ srcTxid: id(X), vout: 0 }], [token(ASSET, 10)], 1)
    const res = cover(T, bundleOf({
      tip: T,
      beef: beefOf(T),
      admissions: new Map([[id(X), admit(id(X), [0], IMPOSTOR)]])
    }), TRUST)
    expect(res).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('is case-insensitive about the key but still requires the bundle to name it', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ src: X, vout: 0 }], [token(ASSET, 10)], 1)
    const b = bundleOf({
      tip: T,
      overlayIdentityKey: OVERLAY_KEY.toUpperCase(),
      beef: beefOf(X, T),
      admissions: new Map([[id(X), admit(id(X), [0])]])
    })
    expect(cover(T, b, { expectedSignerKey: OVERLAY_KEY })).toEqual({ ok: true, mustSubmit: [id(T)] })
  })

  it('refuses when the caller supplies no usable expectedSignerKey at all', () => {
    const X = mkTx([], [token(ASSET, 10)])
    const T = mkTx([{ src: X, vout: 0 }], [token(ASSET, 10)], 1)
    const b = bundleOf({ tip: T, beef: beefOf(X, T), admissions: new Map([[id(X), admit(id(X), [0])]]) })
    for (const bad of [undefined, '', 'not-a-key', OVERLAY_KEY.slice(0, 64)]) {
      expect(cover(T, b, { expectedSignerKey: bad as string })).toEqual({ ok: false, reason: 'unsafe_asset' })
    }
    expect(cover(T, b, undefined as unknown as CoverOptions)).toEqual({ ok: false, reason: 'unsafe_asset' })
  })
})
