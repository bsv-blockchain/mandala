// Emits golden vectors for the Go port. Run: npm install && node gen.mjs
//
// Adjustments vs. the original plan sketch (docs/superpowers/plans/2026-07-07-go-overlay-port.md
// Task 2), reconciled against the real @bsv/templates@1.9.0 source
// (app/node_modules/@bsv/templates/src/MandalaAdmin.ts):
//
//   - `commitment` is NOT a standalone export of @bsv/templates. It is the static
//     method `MandalaAdmin.commitment(actionDetails)`, defined in MandalaAdmin.ts
//     itself (not mandala-signing.ts, despite the appendix note). Appendix A §1.4
//     documents the same canonical-JSON-then-SHA256 algorithm; the static method
//     IS that function (verified by reading its source below).
//   - `MandalaAdmin.lock` is NOT `new MandalaAdmin().lock(pubKeyHash, publicData)`.
//     It is the static async `MandalaAdmin.lock({ wallet, data, counterparty?,
//     originator?, publicData? })`: the wallet derives the locking pubKeyHash via
//     BRC-42 (protocolID=ADMIN_PROTOCOL, keyID=commitment(data), counterparty
//     default 'self'). There is no entry point that takes a raw pubKeyHash
//     directly, so the vectors below drive the real wallet-derivation path with a
//     fixed deterministic private key and record whatever pubKeyHash results
//     (captured by decoding the real script back), rather than forcing a fixed
//     PKH constant the way the token vectors do.
//   - `MandalaToken.lock(assetId, amount, pubKeyHash)` and `ProtoWallet.
//     getPublicKey` / `revealSpecificKeyLinkage` matched the plan sketch exactly
//     — no adjustment needed there.
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  PrivateKey, ProtoWallet, Hash, Utils, Script,
  PublicKey, Curve, BigNumber
} from '@bsv/sdk'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'

const TXID = 'ab'.repeat(32)
const ASSET = `${TXID}.0`
const PKH = Array.from({ length: 20 }, (_, i) => i + 1)

// --- token scripts across amount encodings ---
const amounts = [1, 16, 17, 255, 256, 65535, 4294967296, 9007199254740991]
const tokenScripts = amounts.map(amount => {
  const scriptHex = new MandalaToken().lock(ASSET, amount, PKH).toHex()
  // Sanity: the emitted script must decode back through the same TS decoder
  // that Go's DecodeToken is golden-tested against.
  const decoded = MandalaToken.decode(Script.fromHex(scriptHex))
  assert.equal(decoded.assetId, ASSET, `token decode sanity: assetId mismatch @ amount ${amount}`)
  assert.equal(decoded.amount, amount, `token decode sanity: amount mismatch @ amount ${amount}`)
  assert.deepEqual(decoded.pubKeyHash, PKH, `token decode sanity: pubKeyHash mismatch @ amount ${amount}`)
  return { assetId: ASSET, amount, pubKeyHash: PKH, scriptHex }
})

// --- assetId encodings, incl. nonzero vout ---
const assetIds = [ASSET, `${'01'.repeat(32)}.7`, `${'ff'.repeat(32)}.4294967295`]

// --- admin scripts: plain + publicData variants ---
// MandalaAdmin.lock is wallet-derived (no raw-pubKeyHash entry point), so drive
// it with a fixed deterministic key and record the real derived pubKeyHash.
const adminWallet = new ProtoWallet(new PrivateKey(7))
const adminData = { kind: 'register', assetId: ASSET }
const adminPublicData = { label: 'Test Coin', decimals: 2 }

const adminScriptPlain = await MandalaAdmin.lock({ wallet: adminWallet, data: adminData })
const adminDecodedPlain = MandalaAdmin.decode(adminScriptPlain)
assert.equal(adminDecodedPlain.pubKeyHash.length, 20, 'admin plain: pubKeyHash must be 20 bytes')
assert.equal(adminDecodedPlain.publicData, undefined, 'admin plain: publicData must be absent for the 5-chunk form')

const adminScriptWithData = await MandalaAdmin.lock({ wallet: adminWallet, data: adminData, publicData: adminPublicData })
const adminDecodedWithData = MandalaAdmin.decode(adminScriptWithData)
assert.deepEqual(adminDecodedWithData.publicData, adminPublicData, 'admin publicData: round trip mismatch')
assert.deepEqual(adminDecodedWithData.pubKeyHash, adminDecodedPlain.pubKeyHash, 'admin publicData: same action/keyID must derive the same pubKeyHash')

// A09: the on-chain marker every admin-auth output now carries (lib/src/assets.ts,
// issuerOps.ts) so wallets cannot reclassify it as vanilla P2PKH. The 100-byte
// JSON needs OP_PUSHDATA1, which is the case Go's chunker must get right.
const adminMarker = { t: 'mandala-admin', assetId: ASSET }
const adminScriptWithMarker = await MandalaAdmin.lock({ wallet: adminWallet, data: adminData, publicData: adminMarker })
const adminDecodedWithMarker = MandalaAdmin.decode(adminScriptWithMarker)
assert.deepEqual(adminDecodedWithMarker.publicData, adminMarker, 'admin marker: round trip mismatch')
assert.deepEqual(adminDecodedWithMarker.pubKeyHash, adminDecodedPlain.pubKeyHash, 'admin marker: publicData must not change the derived key')

const adminScripts = [
  { publicData: null, pubKeyHash: adminDecodedPlain.pubKeyHash, scriptHex: adminScriptPlain.toHex() },
  { publicData: adminPublicData, pubKeyHash: adminDecodedWithData.pubKeyHash, scriptHex: adminScriptWithData.toHex() },
  { publicData: adminMarker, pubKeyHash: adminDecodedWithMarker.pubKeyHash, scriptHex: adminScriptWithMarker.toHex() }
]

// --- commitment canonical-JSON cases ---
const commitmentCases = [
  { kind: 'register', assetId: ASSET },
  { kind: 'issue', assetId: ASSET, amount: 1000, priorOutpoint: `${TXID}.0` },
  { z: 1, a: [3, { b: 'x', A: null }], nested: { deep: { key: 'väl' } } },
  { kind: 'freezeOutput', outpoint: `${TXID}.3`, amount: 0 },
  { memo: 'a<b&c>d', bankRef: 'Smith & Sons <wire>' },
  { amount: 2.5, tiny: 5e-7, big: 1e21, mixed: 123456789012345.6 },
  { zero: -0, list: [1e-6, 1e-7, 0.000001] }
]
// Use the real static method that MandalaAdmin.lock/unlock use internally for
// keyID derivation (MandalaAdmin.ts, not a standalone `commitment` export).
const commitments = commitmentCases.map(details => ({ details, hash: MandalaAdmin.commitment(details) }))

// Sanity: confirm we're exercising the real canonicalizing commitment function
// (key-order independent), not e.g. a naive JSON.stringify of insertion order.
assert.equal(
  MandalaAdmin.commitment({ b: 2, a: 1 }),
  MandalaAdmin.commitment({ a: 1, b: 2 }),
  'commitment sanity: must be key-order independent (real canonicalize, not raw JSON.stringify)'
)
for (const c of commitments) {
  assert.match(c.hash, /^[0-9a-f]{64}$/, `commitment sanity: hash must be 64 lowercase hex chars (got ${c.hash})`)
}

// --- linkage fixture: prover reveals, Go verifier must decrypt + match pkh ---
const proverPriv = new PrivateKey(42)
const verifierPriv = new PrivateKey(69)
const holderPriv = new PrivateKey(1337) // counterparty the child key was derived FOR
const prover = new ProtoWallet(proverPriv)
const protocolID = [2, 'mandala token']
const keyID = 'xfer-golden-1'
const counterparty = holderPriv.toPublicKey().toString()
const { publicKey: derived } = await prover.getPublicKey({ protocolID, keyID, counterparty })
const reveal = await prover.revealSpecificKeyLinkage({
  counterparty, verifier: verifierPriv.toPublicKey().toString(), protocolID, keyID
})
const linkage = {
  verifierPrivHex: verifierPriv.toHex(),
  proverIdentityKey: proverPriv.toPublicKey().toString(),
  counterparty, protocolID, keyID,
  encryptedLinkage: reveal.encryptedLinkage,
  encryptedLinkageProof: reveal.encryptedLinkageProof,
  proofType: reveal.proofType,
  expectedDerivedKey: derived,
  expectedPubKeyHash: Hash.hash160(Utils.toArray(derived, 'hex'))
}

// Sanity: replay the verifier side end-to-end (Appendix A §2.5) — decrypt the
// revealed linkage exactly as a real verifier ProtoWallet would (wrapper
// protocolID `[2, "specific linkage revelation <level> <name>"]`, original
// keyID, counterparty = prover), then reconstruct the derived child key as
// `counterpartyPoint + L·G` (the same formula PublicKey.deriveChild uses) and
// confirm it equals the prover-computed `derived`/`expectedPubKeyHash`. This
// proves encryptedLinkage is genuine BRC-2-decryptable ProtoWallet output tied
// to this exact fixture, not just an opaque blob.
const verifierWallet = new ProtoWallet(verifierPriv)
const { plaintext: sharedSecretL } = await verifierWallet.decrypt({
  ciphertext: reveal.encryptedLinkage,
  protocolID: [2, `specific linkage revelation ${protocolID[0]} ${protocolID[1]}`],
  keyID,
  counterparty: linkage.proverIdentityKey
})
const counterpartyPoint = PublicKey.fromString(counterparty)
const offset = new Curve().g.mul(new BigNumber(sharedSecretL))
const reconstructedPoint = counterpartyPoint.add(offset)
const reconstructed = new PublicKey(reconstructedPoint.x, reconstructedPoint.y)
assert.equal(reconstructed.toString(), derived, 'linkage sanity: verifier-reconstructed key must equal prover-derived key')
assert.deepEqual(
  Hash.hash160(Utils.toArray(reconstructed.toString(), 'hex')),
  linkage.expectedPubKeyHash,
  'linkage sanity: reconstructed pkh must equal expectedPubKeyHash'
)
assert.equal(linkage.expectedPubKeyHash.length, 20, 'linkage sanity: expectedPubKeyHash must be a 20-byte array')

writeFileSync('../vectors.json', JSON.stringify(
  { tokenScripts, assetIds, adminScripts, commitments, linkage }, null, 2))
console.log('wrote ../vectors.json')
