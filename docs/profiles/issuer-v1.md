# Mandala issuer-v1 processing profile

This document defines the Mandala issuer-enforcement processing profile for
BRC-162 1Color tokens handled by a BRC-207 wallet module. A Mandala asset is
issued and policed by one Mandala overlay. That overlay enforces issuer policy:
KYC membership, freezes, pauses, sanctions, ownership linkage and per-asset
conservation. This profile makes a wallet treat that overlay's signed
admission (σ) as the condition for credit.

Spec references by line: **0162** = BRC-162 (1Color), **0207** = BRC-207
(1Color wallet module), as pinned in `docs/design/brc-0162-1color.pinned.md`
and `docs/design/brc-0207-1color-wallet-module.pinned.md`. The reference
implementation is `createMandalaProfile` in `@bsv/mandala/profile`
(`lib/src/profile*.ts`), with the host-side evidence checks in the core
`@bsv/mandala` entry (`receive.ts`, `bundle.ts`, `hopCheck.ts`,
`receiptSettle.ts`, `hostLedger.ts`). Design: amendment B7 of
`docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md`.

## Identifier and version

- Identifier: `https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md`
  (80 UTF-8 bytes; the URI of this document).
- Version: `1`. A wallet that implements this document supports exactly
  version 1. Any other version is unsupported (0207 A.143).

## Parameters

`params` is a DAG-CBOR map with exactly one member:

| Member | Type | Value |
|---|---|---|
| `identityKey` | text | K: the Mandala overlay's identity key, 66 lowercase hex characters, a compressed point on secp256k1 |

Diagnostic: `{"identityKey": "02798b81…124046"}`. Any other shape is
`ProfileParamsError`: a missing or extra member, `null`, a non-map, bytes in
place of text, uppercase hex, an uncompressed key or a point that is not on
the curve.

## Required profiles

This profile stands alone. A Mandala deploy's `req` MUST contain exactly one
entry: this profile, version `1`, params exactly `{"identityKey": K}`. There
is no companion profile, in particular no BRC-207 attested-admission entry. A
second entry of any kind fails with `ProfileParamsError`.

Diagnostic of the `req` value (fixture F-REQ, K = the C.0 test signer
`02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046`;
`lib/src/__fixtures__/1color-deploy.json`, field `reqHex`, 181 bytes):

```
{
  "https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md": {"params": {"identityKey": K}, "version": 1}
}
```

The Mandala overlay refuses any deploy whose `req` is not exactly this map for
its own K, compared byte for byte after canonical re-encoding. It also refuses
`req` or `ext` on every non-deploy output.

## Replaced procedure

0207:126-141 allows a profile to replace the baseline *overlay evidence and
submission* procedure, provided the profile names the procedure it replaces.
This profile replaces the baseline **receipt admission** procedure of
0207:1476-1481, and only for receipts. That procedure requires the received
outpoint to already appear as admitted and unspent in its asset's spendability
lookup, forbids internalization from submitting an absent transaction, and
makes the sender responsible for submission before the receipt.

Under this profile the **recipient's host** submits, before it internalizes
the receipt, and the sender submits only after the recipient acknowledges the
hand-over. All other BRC-207 rules apply unchanged: lineage, amounts,
authority, custody recognition, spending, selection and inventory. When this
wallet spends a Mandala asset, it uses the overlay configured for K for every
spendability lookup, admission lookup and submit.

## Credit rule

The handler's `admitReceipt` credits a received Mandala output only from what
the wallet **host** itself verified and recorded in its host ledger:

- `settled`: the host verified a σ by K that covers the output;
- `pending`: the host accepted the output offline under the hand-over
  evidence rule below; the module tags it `color_offline` (pending balance)
  until the host's `markSettled(txid)`.

The host ledger is an in-process object the host passes to the handler at
construction and to its own receive and settle code. It is not a BRC-100
method: no application can write it, so no application can make the handler
credit anything.

For any receipt the ledger does not cover (for example an application that
internalizes over BRC-100), the handler submits the receipt's AtomicBEEF to
the overlay for K itself and requires a σ by K covering the output; the
overlay answers an already-admitted transaction with its σ (idempotent
replay). Anything else (a refusal, a transport failure, an uncovered output)
throws: no credit.

σ is the overlay's admission statement
`1color-admit:v1:tm_color_<assetId>:<txid>:<sorted outputs>`, signed by the
BRC-42 child of K under `[2, 'color admission attestation']`, key ID `'1'`,
counterparty `anyone`. It is verified only against that child (never the bare
key), and low-S and high-S signatures are both accepted (BSV Chronicle; S is
never normalized).

## Hand-over evidence

Evidence travels in the issuer's hand-over body (MessageBox box
`mandala-color`, body `v: 4`; the nearby rail carries the same members), never
in BRC-207 carriers. Receipts are plain custody JSON
`{version, assetId, derivationPrefix, derivationSuffix, senderIdentityKey}`
(under 1000 bytes), and any receipt `profileData` is rejected. The body
carries the AtomicBEEF of the tip (every unconfirmed ancestor inside), the
decimal amount (checked against the script), the receipt fields
(`senderIdentityKey` A or the blinded A′), `admission` (σ of the tip, when the
sender holds it), `admissions[]` (σ per admitted ancestor) and `linkage[]`
(the envelope of every unadmitted transaction, the tip included).

The recipient host:

1. **Online**: submits the unadmitted chain to the overlay for K, parents
   first and the tip last, each with its envelope as `offChainValues`;
   verifies each σ; requires the tip's σ to cover the received output; records
   `settled`; then internalizes the plain receipt.
2. **Offline, on transport failure only** (network failure, timeout, 5xx,
   `ERR_UNAVAILABLE`): a verified σ of the tip covering the output is enough
   (`settled`). Otherwise it runs COVER over `admissions[]`: every token input
   of the asset (value, authority, deploy) must be covered by a verified σ
   whose admitted set contains the spent output, or be an output of an
   unadmitted ancestor present in the AtomicBEEF, which is walked the same
   way. Every walked transaction and the tip must pass the local hop checks
   below, and no outpoint may be spent twice anywhere in the graph. Accepted
   ⇒ records `pending` with the exact submit chain, internalizes, submits when
   online and calls `markSettled(txid)` after a verified σ.

Any typed overlay verdict refuses the credit, with no offline fallback (D6),
including the retryable verdicts `ERR_FROZEN` and `ERR_PAUSED`.

**Local hop checks** (offline path). Each unadmitted hop MUST satisfy:

- every input's unlocking script verifies against the output it spends;
- per-asset inputs equal outputs, unless an authority (or the asset's deploy)
  is spent;
- a hop that spends an authority spends exactly one, creates exactly one
  authority of amount 0, and that authority's `{adm}` commitment is the
  SHA-256 of strict admin details carried in the envelope's `admin` entry;
- a deploy input is the asset's own deploy (`<asset txid>.0`) and is covered
  by σ (a deploy is never an unanchored hop);
- every token output carries exactly 1 satoshi;
- the hop moves a single asset and creates no deploy;
- no non-deploy output carries `req` or `ext`;
- the hop's envelope covers exactly its token outputs, each with verifier K
  (and key ID `'color'` on a holder hop).

A missing input source transaction fails closed.

## Operations and transaction shape

- Holders may perform only the `transfer` operation. Each holder transaction
  conserves value per asset (inputs equal outputs). Mint, burn, redeem,
  reissue, freeze and authority changes are issuer or admin transactions. The
  issuer builds them with Mandala admin keys, outside the wallet module,
  overlay-first.
- A holder transaction moves exactly one Mandala asset (D1).
- Every token output carries exactly 1 satoshi.
- Holder transactions are submitted to the single topic
  `tm_color_<assetId>`.

## Send policy

`plain-nosend`. Every holder action that moves a Mandala asset:

- is created with `options.noSend: true` and carries no BRC-177
  `p nosend expiry ` label;
- keeps token change inside the same transaction (no pre-split), and that
  change is tagged `color_offline` until settled;
- is handed over with the v4 body (receipt fields plus evidence);
- is submitted by the sender host only after the recipient acknowledges the
  hand-over (an idempotent submit of the exact bytes), which then records σ
  and calls `markSettled(txid)`. A host never submits an own hand-over before
  that acknowledgement.

## Submission data

Every transaction of a Mandala asset carries submission data for
`tm_color_<assetId>`. It is required and non-empty for every unadmitted
transaction (C42).

**Bytes.** The data is the UTF-8 JSON of the Mandala envelope. For holder
transactions it is exactly `{"outputs": [...]}`, with entries sorted by
`index` and no `inputs` member:

```
{"outputs": [{"index": n, "linkage": {
  "prover": A, "verifier": K, "counterparty": <owner identity key>,
  "protocolID": [2, "p color <assetTag> <hex(prefix)> <hex(suffix)>"], "keyID": "color",
  "encryptedLinkage": [bytes], "encryptedLinkageProof": [bytes], "proofType": 0 }}]}
```

`prover` is the real identity key of the deriving party (the sender A, even
when the receipt names a blinded A′). `counterparty` is the output owner's
identity key: the recipient, or the sender for its own change. The prover
encrypts `encryptedLinkage` to K under
`[2, 'specific linkage revelation 2 <protocol name>']`, key ID `'color'`. The
overlay derives `hash160(counterparty + L·G)` and requires it to equal the
output's P2PKH hash. Remittance strings are at most 48 UTF-8 bytes each, so
the protocol name stays within 280 characters.

**Action plans.** The sending application supplies the entries for outputs
that the wallet does not own in
`plan.profileData["<this profile id>"]["<assetId>"] = {"outputs": [...]}`.
The entries must cover exactly the plan's non-owned token outputs of that
asset. The handler checks this leaf and does not trust it (0207 A.157). It
rejects with `ProfileDataError` an extra or missing index, a verifier other
than K, a prover other than the wallet's identity key, a key ID other than
`'color'`, a protocol ID that is not a valid `p color <assetTag of this asset>`
name, `proofType` other than 0, empty byte arrays or arrays longer than 1024
entries, and unknown members. An absent leaf with at least one non-owned token
output is also `ProfileDataError`. At signing, the handler also checks that
each output of the asset carries 1 satoshi and that no token of another asset
is present (`ProfileParamsError`), and that each linkage derives the output's
public key hash (`ProfileDataError`).

The handler produces the entries for wallet-owned outputs (token change,
`ownedOutputs`) itself, through the underlying wallet's
`revealSpecificKeyLinkage`, and records the final envelope in the host ledger
under the transaction's unsigned layout key, so the sending host can put the
tip's envelope into the hand-over body.

**Carriage.** The issuer-v1 `profileData` leaf exists only in action plans.
Envelopes reach recipients only in the hand-over body's `linkage[]`.

**Submit framing.** POST `/submit` with
`x-includes-off-chain-values: true` and the body
`varint(len(beef)) ‖ beef ‖ offChainValues`.

## ext state

None. This profile defines no `ext` state. Its own `ext` entry MUST be
absent (`ProfileParamsError` otherwise), and a Mandala deploy carries no `ext`
at all.

## Service configuration

`params` carry only K. The overlay URL is wallet configuration
(0207 A.21: a plan cannot select a lookup service URL). A wallet host
registers `createMandalaProfile({ overlays: [{ identityKey: K, url }], ledger })`
and routes every query and submit of an asset to the overlay configured for
that asset's K. It also asks the configured overlays, in order, for an unknown
asset's deploy (`color-admission` of `<txid>.0`).

The wallet fails closed when no endpoint is configured for K (S5): the
handler's provider routing throws `ProfileParamsError`
(`no Mandala overlay configured for <K>`), and the asset can be neither sent
nor received. There is no fallback to a default or discovered service.

## Failure behaviour

Errors are matched by `name`, then by the `[ClassName] ` message prefix, never
by `instanceof` across bundles. BRC-100 HTTP bridges forward
`{message, name, code?, retryable?, transport?}` (D22).

| Error | When | Effect |
|---|---|---|
| `UnsupportedProfileError` | the wallet does not register this profile, or not version 1 | the asset is unsupported; no action, no credit |
| `ProfileParamsError` | malformed params or `req`, a second `req` entry, own `ext` entry present, no overlay configured for K, a non-1-sat token output, a second asset, a disallowed operation or send option | the action or receipt is refused before any wallet mutation |
| `ProfileDataError` | an invalid plan leaf, uncovered token outputs, a linkage that does not derive the output, a receipt the host did not record and the overlay does not admit with a covering σ, a ledger record refused for good | refused; no credit |
| `ColorProviderError` (`code`, `retryable`, `transport`) | the handler's own submit: overlay refusal or transport failure | refused; no credit (the handler never credits offline itself) |
| host receive (`InvalidTransferError`) | malformed body, script mismatch, evidence refused (`ERR_EVIDENCE`), output not admitted (`ERR_NOT_ADMITTED`) | acknowledged and dropped; `ERR_NOT_COVERED` (offline, the evidence does not reach σ yet) and `ERR_BODY_UNREADABLE` are kept for a later pass |

## Security notes

- A receipt's `senderIdentityKey` is the blinded key A′ when the sender blinds,
  while the envelope `prover` is the real key A. This mismatch is intended:
  the recipient derives with A′, and the overlay checks linkage against A.
- S1 (value from nothing): offline acceptance requires every unadmitted hop
  to verify its input scripts, conserve (or perform a valid authority
  transition) and bottom out at σ by K; a fabricated mint or authority parent
  and a duplicate spend inside the graph are refused.
- Offline credit is a declared risk policy, never a claim of current global
  unspentness: a σ-covered ancestor may have been spent elsewhere since. A
  later settle that meets a final refusal marks the ledger record `refused`,
  and the host surfaces it.
- The handler credits only what the host ledger records or what its own
  submit proves; an application can widen neither.
