# Mandala issuer-v1 processing profile

This document defines the Mandala issuer-enforcement processing profile for
BRC-162 1Color tokens handled by a BRC-207 wallet module. A Mandala asset is
issued and policed by one Mandala overlay. That overlay enforces issuer policy:
KYC membership, freezes, pauses, sanctions, ownership linkage and per-asset
conservation. This profile makes a wallet treat that overlay's signed
admission as the condition for credit.

Spec references by line: **0162** = BRC-162 (1Color), **0207** = BRC-207
(1Color wallet module), as pinned in `docs/design/brc-0162-1color.pinned.md`
and `docs/design/brc-0207-1color-wallet-module.pinned.md`. The reference
implementation is `createMandalaProfile` in `@bsv/mandala/profile`
(`lib/src/profile*.ts`).

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

## Companion requirement

This profile cannot stand alone. The same deploy `req` MUST contain exactly
two entries:

1. `https://brc.dev/207/attested`, version `1`, params exactly
   `{"trustMode": "identity", "identityKey": K}`.
2. This profile, version `1`, params exactly `{"identityKey": K}`.

Both entries name the same K. A third entry, a missing attested entry, another
trust mode, an extra attested member (such as `evidenceProfile`) or a
different key fails with `ProfileParamsError`.

Diagnostic of the `req` value (fixture F-REQ, K = the C.0 test signer
`02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046`;
`lib/src/__fixtures__/1color-deploy.json`, field `reqHex`):

```
{
  "https://brc.dev/207/attested": {"params": {"trustMode": "identity", "identityKey": K}, "version": 1},
  "https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md": {"params": {"identityKey": K}, "version": 1}
}
```

The Mandala overlay refuses any deploy whose `req` is not exactly this map,
compared byte for byte after canonical re-encoding. It also refuses `req` or
`ext` on every non-deploy output.

## Replaced procedure

0207:126-141 allows a profile to replace the baseline *overlay evidence and
submission* procedure, provided the profile names the procedure it replaces.
This profile replaces the baseline **receipt admission** procedure of
0207:1476-1481, and only for receipts. That procedure requires the received
outpoint to already appear as admitted and unspent in its asset's spendability
lookup, forbids internalization from submitting an absent transaction, and
makes the sender responsible for submission before the receipt.

Under this profile the recipient submits. On every receipt the wallet submits
each unattested transaction of the receipt graph to the overlay configured for
K, parents first and the tip last, using the exact AtomicBEEF and submission
data carried in the receipt. It credits an output only when that overlay
returns a verified attestation covering it. The sender does not submit before
the hand-over is acknowledged (see Send policy).

All other BRC-207 rules apply unchanged: lineage, amounts, authority, custody
recognition, spending, selection and inventory. When this wallet spends a
Mandala asset, it uses the overlay configured for K for every spendability
lookup, admission lookup, submit and settle.

## Credit rule

A wallet credits a received Mandala output only in one of these cases.

1. **Online.** The wallet's own submit of the tip to the overlay for K returns
   an attestation by K (attested v1, identity mode) that covers the output and
   verifies against the BRC-42 child `[2, 'color admission attestation']`,
   key ID `'1'`. The recipient always submits, even when the receipt's tip is
   already attested, and the submit is idempotent (D7).
2. **Offline, on transport failure only.** The overlay could not be reached or
   gave no verdict: network failure, timeout, 5xx, or a typed `ERR_UNAVAILABLE`.
   In that case the wallet may credit the output under the attested profile's
   offline evidence: a verified attestation by K for every frontier ancestor,
   plus local Mandala policy checks of every unattested hop (below), plus the
   user's `color_receive_offline` consent. The output is then tagged
   `color_offline` until a later settle obtains a verified attestation.

Any typed overlay verdict refuses the credit, with no offline fallback (D6).
This includes the retryable verdicts `ERR_FROZEN` and `ERR_PAUSED`. Otherwise
a wallet could offline-credit a payment that the issuer is actively blocking.

Exception (0207 attested profile, D34): when the receipt's attested evidence
already includes a verified attestation by K of the tip that covers every
received output, the credit rests on that attestation. A transport failure
then settles the receipt without the offline prompt and without the
`color_offline` tag.

**Local hop checks** (offline path only). Before an offline credit, every
unattested hop MUST satisfy Mandala policy, else `ProfileDataError` and no
credit:

- per-asset inputs equal outputs, unless an authority input is present;
- every token output carries exactly 1 satoshi;
- the hop moves a single asset;
- no non-deploy output carries `req` or `ext`;
- the hop's envelope covers exactly its token outputs, each with verifier K and
  key ID `'color'`.

A missing input source transaction in a hop's AtomicBEEF fails closed.

## Operations and transaction shape

- Holders may perform only the `transfer` operation. Each holder transaction
  conserves value per asset (inputs equal outputs). Mint, burn, redeem,
  reissue, freeze and authority changes are issuer or admin transactions. The
  issuer builds them with Mandala admin keys, outside the wallet module.
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
- is handed over to the recipient as a BRC-207 receipt (a plain noSend
  hand-over);
- is submitted by the sender only after the recipient acknowledges the
  hand-over (the module's `settle({ txids })`). A wallet never submits an own
  hand-over without that intent, unless the overlay already reports it
  admitted. This guards against resurrecting an aborted, undelivered
  hand-over.

## Submission data

Every transaction of a Mandala asset carries submission data for
`tm_color_<assetId>`. It is required and non-empty for every unattested
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
output is also `ProfileDataError`. At signing, the handler also checks the
following:

- each output of the asset carries 1 satoshi, else `ProfileParamsError`;
- no token of another asset is present, else `ProfileParamsError`;
- each linkage derives the output's public key hash, else
  `ProfileDataError`.

The handler produces the entries for wallet-owned outputs (token change,
`ownedOutputs`) itself, through the underlying wallet's
`revealSpecificKeyLinkage`.

**Carriage.** The issuer-v1 `profileData` leaf exists only in action plans.
In receipts and hand-overs the leaf MUST be absent. The envelope bytes travel
in the attested leaf's `submissions` entries (`offChainValues`, lowercase hex),
one per unattested transaction including the tip (D2).

**Submit framing.** POST `/submit` with
`x-includes-off-chain-values: true` and the body
`varint(len(beef)) ‖ beef ‖ offChainValues`.

## ext state

None. This profile defines no `ext` state. Its own `ext` entry MUST be
absent (`ProfileParamsError` otherwise), and a Mandala deploy carries no `ext`
at all.

## Service configuration

`params` carry only K. The overlay URL is wallet configuration
(0207 A.21: a plan cannot select a lookup service URL). A wallet registers
`createMandalaProfile({ overlays: [{ identityKey: K, url }] })` and routes
every query, submit and settle of an asset to the overlay configured for that
asset's K. It also asks the configured overlays, in order, for an unknown
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
| `ProfileParamsError` | malformed params or `req`, companion mismatch, own `ext` entry present, no overlay configured for K, a non-1-sat token output, a second asset, a disallowed operation or send option | the action or receipt is refused before any wallet mutation |
| `ProfileDataError` | an invalid plan leaf, uncovered token outputs, a linkage that does not derive the output, a receipt leaf for this profile, a failed local hop check on the offline path | refused; no credit |
| `ColorProviderError` (`code`, `retryable`, `transport`) | overlay refusal (`transport: false`, `code` = the overlay verdict, e.g. `ERR_CONSERVATION`, `ERR_LINKAGE`, `ERR_FROZEN`) or transport failure (`transport: true`, `ERR_UNAVAILABLE`); message `[ColorProviderError] mandala overlay refused (<CODE>[, retryable]): <description>` | a typed verdict refuses the credit; only a transport failure may take the offline path |
| `AttestationEvidenceError` | attestation, frontier or graph evidence fails verification | refused; no credit |
| `ColorConsentDeclinedError` | the user declines `color_receive_offline` (or another consent) | refused; no credit; the sender may retry later |

## Security notes

- A receipt's `senderIdentityKey` is the blinded key A′ when the sender blinds,
  while the envelope `prover` is the real key A. This mismatch is intended:
  the recipient derives with A′, and the overlay checks linkage against A.
- Double spends and stale proofs (S1) are covered by the attested profile's
  frontier validator: every offline-accepted ancestor needs a verified
  attestation by K, and the online path needs a fresh one.
- Attestations verify only against the BRC-42 child
  `[2, 'color admission attestation']`, key ID `'1'`, never against the bare
  key. Verifiers accept both low-S and high-S signatures (BSV Chronicle; S is
  never normalized).
- Offline credit is a declared, user-consented risk policy, never a claim of
  current global unspentness. A settle that obtains a final refusal marks the
  output restricted, and it no longer counts toward balances.
