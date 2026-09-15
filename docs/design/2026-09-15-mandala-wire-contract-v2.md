> Source: `/private/tmp/claude-502/-Users-personal-git-demos-mandala/1d8c5cb1-3448-49bc-b255-3df7840f24b8/scratchpad/wire-contract-v2.md` · Copied 2026-09-15. Spec of record; companion: `2026-09-15-mandala-offline-settlement-design.md`.

# Offline-settlement wire contract v2 (binding for overlay TS, overlay Go, lib, wallet)

Companion to 2026-09-15-mandala-offline-settlement-design.md (§3). Where that spec leaves a choice, THIS file decides it. Both engines must be byte/JSON identical on everything below.

## 1. Admission digest v2
digest = SHA-256( "mandala-admit:" + txid + ":" + outputsToAdmit.sort(asc).join(",") )
- txid: 64 lowercase hex. outputsToAdmit: the tm_mandala topic's own admitted output indexes (decimal, ascending, comma-joined, e.g. "0,2,3"; single "0"; never empty — no admitted outputs ⇒ no signature).
- Signature: ECDSA over the digest bytes with the overlay identity key, DER hex, RFC6979 deterministic (as today). Registry-only admissions NEVER yield a token σI.
- Old digest ("mandala-admit:"+txid) is removed everywhere (no live traffic).

## 2. POST /submit responses
Success (≥1 tm_mandala output admitted, or already-admitted dupe): HTTP 200, STEAK shape as today; the `tm_mandala` entry carries
  { outputsToAdmit: number[], admissionSignature: <DER hex>, admissionIdentityKey: <66 hex> }
Errors: body always { status: "error", code, retryable: boolean, description: string, spendTxid?: string }
| code | HTTP | retryable | when |
| ERR_CONSERVATION | 400 | false | manager reject: conservation |
| ERR_LINKAGE      | 400 | false | manager reject: missing/mismatched linkage, un-linked MandalaToken-decodable output (reject-not-skip) |
| ERR_SHAPE        | 400 | false | manager reject: any other deterministic content reason (malformed payload, bad admin chain, unknown kind, etc.) |
| ERR_SATOSHIS     | 400 | false | manager reject: 1-satoshi rule |
| ERR_INPUT_SPENT  | 400 | false | input already marked spent by a different still-admitted tx; spendTxid = competitor |
| ERR_PAUSED / ERR_FROZEN / ERR_SANCTIONED / ERR_ACCESS / ERR_MEMBERSHIP | 409 | true | liftable policy refusals (asset paused; frozen input; sanctions/screening; access-mode; registry membership) |
| ERR_EVICTED      | 410 | false | txid was admitted then evicted (inputs restored) |
| ERR_UNAVAILABLE  | 503 | true | anything not a manager verdict: SPV/chaintracker, storage, broadcast/Arcade, sanctions-provider fault, unknown internal error |
Mapping rule: a code from the 400/409 rows may ONLY come from the topic manager's own reject(...) reason. Everything else → ERR_UNAVAILABLE. Manager reasons are matched by a shared substring table (document it in code on both stacks, same strings):
  "conservation" → ERR_CONSERVATION; "linkage" or "no verified linkage" → ERR_LINKAGE; "satoshi" → ERR_SATOSHIS; "paused" → ERR_PAUSED; "frozen" → ERR_FROZEN; "sanction" → ERR_SANCTIONED; "access mode" or "allowlist"/"denylist" → ERR_ACCESS; "not admitted"/"membership"/"sanctioned party" → ERR_MEMBERSHIP (note: TS upstream string for membership is "sanctioned party involved in transfer" — map that to ERR_MEMBERSHIP, not ERR_SANCTIONED); "spent" → ERR_INPUT_SPENT; otherwise → ERR_SHAPE.
"Verdict wins": the first FINAL verdict (400-row or ERR_EVICTED) for a txid is persisted on the admission record and served identically to every later /submit of the same txid and to GET /admin/admission/:txid.
Idempotent dupe: if the engine's applied-transaction store proves txid went through tm_mandala, re-sign (digest v2 over the persisted/derived outputsToAdmit) and return 200 with no side effects, even when the admission record row is missing (derive outputsToAdmit from the engine's own stored outputs for that txid + topic tm_mandala).

## 3. GET /admin/admission/:txid
200 { txid, outputsToAdmit, admissionSignature, admissionIdentityKey, at }   (admitted; re-sign if record missing but applied-store proves admission)
410 { status:"error", code:"ERR_EVICTED", retryable:false, description }
400 { status:"error", code:<final code>, retryable:false, description }      (persisted final refusal)
404 { status:"error", message:"no admission on record for <txid>" }          (unknown txid) — keep existing TS 404 shape
CORS/auth: gated like /admin/registry (A13).

## 4. Admission record (internal, both stores; TS Mongo `mandalaAdmissions`, Go Mongo `mandalaAdmissions`)
{ txid, topics: string[], outputsToAdmit: number[], admissionSignature, admissionIdentityKey, at,
  refusedCode?, refusedAt?, evictedAt?,
  restore?: { spentOutpoints: string[] /* "txid.vout" inputs marked spent by this tx */, tokenRows: TokenRow[] /* pre-spend snapshot */ } }
Written synchronously BEFORE the /submit response is sent (Go and TS). Unique index on txid.

## 5. Eviction (FIX E), both engines
On /arc-ingest terminal status (and any other post-hoc eviction trigger): UnmarkSpent for restore.spentOutpoints, restore tokenRows, stamp evictedAt, delete the evicted outputs as today. /arc-ingest MUST NOT be mounted when the callback token is empty (log an error and skip mounting; server still starts).

## 6. Reject-not-skip (FIX A overlay half), both engines
Any output that decodes as MandalaToken and has no linkage entry at its index, or whose linkage-derived pkh mismatches, rejects the whole submission with reason exactly:
  "output <idx>: MandalaToken-decodable output with no verified linkage"   → ERR_LINKAGE
Existing tests that pin the skip (Go TestWrongPKHLinkageSilentlySkipsOutput / TestMissingOutputLinkageBreaksConservation and TS equivalents) flip to expect rejection.

## 7. Conflicting spend (FIX L), both engines
Mark-spent is compare-and-swap on spent=false with a rows-affected check; the manager consults the live token row and refuses ERR_INPUT_SPENT{spendTxid} when the row is already spent by a different still-admitted tx. A row missing because the spending tx's record carries evictedAt counts as live.

## 8. Lib (@bsv/mandala) public API additions
- admissionDigestV2(txid, outputsToAdmit): number[] ; verifyAdmission({txid, outputsToAdmit, signature, signerKey}): boolean
- OverlayAdmitResult gains outputsToAdmit; submitToOverlay throws OverlayRefusedError {code, retryable, spendTxid?, httpStatus} for the error shape above (parse JSON body; non-JSON/network → code 'ERR_UNAVAILABLE', retryable true)
- AdmissionBundle types + canonicalBundleId() (spec §1.1) + pure COVER(tip, bundle) over an in-memory BEEF map (spec §1.2, FIX K: only MandalaToken-decodable inputs of the bundle's assetId are walked). No SQLite, no network.
- configureMandala({ basket }) — BASKET becomes `export let`, default 'mandala-tokens'.

## 9. Amendment v2.1 (2026-09-15, after adversarial review)

Binding on both engines, the lib and the wallet. Supersedes the conflicting sentences above.

9.1 **Payload-scoped final verdicts.** A persisted final refusal is keyed by `(txid, payloadHash)` where `payloadHash = sha256(offChainValues bytes exactly as submitted)` (lowercase hex; an absent/empty payload hashes the empty byte string). The record stores it as `refusedPayloadHash`. `/submit` applies a persisted refusal only when the submitted payload's hash matches; otherwise the transaction is evaluated fresh (a later refusal overwrites the refusal fields; an admission clears them). Reason: the txid does not commit to the off-chain payload, so a txid-keyed refusal let any BEEF holder poison a transaction (review finding, both engines).
9.2 **`ERR_INPUT_SPENT` is never persisted.** It is re-derived from live state on every submit (the manager's live-token-row guard). On the wire it stays `400 retryable:false` with `spendTxid`; the wallet confirms the competitor via `GET /admin/admission/<spendTxid>` before treating it as terminal, as before.
9.3 **`GET /admin/admission/:txid?payloadHash=<hex>`.** A persisted refusal is served (400) only when the query's `payloadHash` equals `refusedPayloadHash`; without a matching hash the route falls through to the applied-proof check and then 404. Malformed txid (not 64 hex, after lowercasing) → `400 {status:"error", code:"ERR_SHAPE", retryable:false, description, message}` on both engines. A stored admitted set that is empty → 404, never a 200 with an empty set.
9.4 **Provisional admission record.** Before the engine broadcasts, both engines write the record with `{txid, topics, restore, at, pending:true}`; after admission they finalize `{outputsToAdmit, admissionSignature, admissionIdentityKey, pending:false}`. If the finalize write fails the response is `503 ERR_UNAVAILABLE` (the client retries and the dupe path re-signs from the applied proof; the snapshot is already durable). A crash between the two leaves a pending record that the dupe path finalizes.
9.5 **Infra faults are never final.** Any store, provider, chaintracker or unexpected error raised inside a repo-local guard or the manager (token-row lookup, spent lookup, admin-outpoint lookup, registry/screening provider, asset-state) is `503 ERR_UNAVAILABLE`, never a 400/409, and never persisted. A guard that cannot read the state it gates on fails CLOSED (503), never open.
9.6 **Canonical guard order** (first refusal wins, both engines): unlinked-token reject → conflicting-spend (live token row; a competitor record carrying `evictedAt` counts as live) → admin-chain anchoring → topic manager. Unanchored admin actions REJECT the whole submission on both engines (reason: `admin action is not anchored to the asset admin chain`), never a silent skip.
9.7 **Concurrent submits.** Per-request verdict capture must be request-scoped (two concurrent submits of the same txid each see their own manager verdict). Outpoints that passed the conflicting-spend guard are held in an in-process in-flight set until the engine's spend-mark has run (or the request ends); a concurrent submit touching an in-flight outpoint answers `503 ERR_UNAVAILABLE`.
9.8 **Eviction ordering.** `evictedAt` is stamped only after the input restore succeeded; on any restore failure the ingest answers 503 (Arcade retries) and nothing is stamped.
9.9 **Boot.** Index creation failures abort startup on both engines.
9.10 **`cover()` trust anchor.** The verifier takes `expectedSignerKey` from its own configuration (the session's / wallet's configured overlay identity key); `bundle.overlayIdentityKey` is data and must equal it or COVER fails with `unsafe_asset`.
9.11 **Lib journal.** A retryable overlay refusal writes a `'retryable'` journal entry (txid, reference, code, attempts) so reconcile can retry and, after `RETRY_CAP`, abort; an `'accepted'` entry whose broadcast keeps failing becomes `'stranded'` after `BROADCAST_RETRY_CAP` and is surfaced, never retried silently forever. `abortStuckRegistryActions` never aborts an action that has an `'accepted'` journal entry.
9.12 **/arc-ingest terminal 200 body** on both engines: `{status:"success", message:"Terminal transaction status processed", data:{txid, txStatus, reason, restoredOutpoints, restoredTokenRows, alreadyEvicted}}`. Go answering 404 on an unmounted route vs TS's 503 stub is an accepted divergence (Arcade is the only caller).
9.13 **MessageBox body v2 (2026-09-15 maintainer decision).** Every rail is hand-over-first at send time — no rail contacts the overlay before handing the payment over. The handle (MessageBox) rail's `'mandala-payments'` box body is therefore versioned:

```json
{
  "v": 2,
  "kind": "handover",
  "assetId": "<hex>",
  "amount": "<base-units>",
  "sender": "<A' — blinded, per the wire's existing A' convention>",
  "senderMode": "<per existing wire enum>",
  "keyID": "<per existing wire convention>",
  "protocolID": "<per existing wire convention>",
  "transaction": "<AtomicBEEF>",
  "outputIndex": 0,
  "linkage": [{ "txid": "<hex>", "payload": "<...>" }],
  "admissions": [
    {
      "txid": "<hex>",
      "outputsToAdmit": [0],
      "signature": "<hex>",
      "signerKey": "<hex>"
    }
  ]
}
```

No `/submit` call and no broadcast happen at send time, and the body carries no σ_I for the tip — only whatever admission evidence (`admissions[]`) the sender already holds locally for the transfer's ancestors, exactly as assembled for the AdmissionBundle (§1.1 of the offline-settlement spec). The recipient runs `COVER` against its own configured overlay key (§9.10), credits the payment, then submits via `mustSubmit` (ancestors first, tip last — the overlay broadcasts what it admits); the sender's own drain/reconcile may submit the same bytes later, harmlessly, since `/submit` is idempotent (§2). Legacy v1 bodies (sender submitted online before handing over) remain accepted by the recipient. This supersedes any earlier text in this document or the UX/settlement specs implying the handle rail submits or contacts the overlay before hand-over.
