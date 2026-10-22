# 1Color overlay-go (Mandala Issuance Platform Overlay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution for this run is **subagent-driven** (overnight, user unavailable: never ask, decide and record the decision in the commit body). Suggested tiers: sonnet for Tasks 0, 1, 4, 7, 12; opus for 2, 3, 5, 6, 8, 9, 10, 11 (codec, security, multi-file).

**Goal:** overlay-go reads and writes final BRC-162 (1Color) outputs and admits them under unchanged Mandala issuer policy, with uint64 amounts end to end, `tm_color_<assetId>` / `ls_color_<assetId>` per-asset topics, the BRC-207 attested admission signature, the Mandala deploy `req` policy and the additive `color-spendability` / `color-admission` lookups.

**Architecture:** Layer A (`internal/brc162`) becomes a byte-parity port of `@bsv/templates` at ts-stack `cbdccfe5b`: full strict DAG-CBOR and OneColor 32/36-byte ids. Mandala policy stays in `internal/mandala` (layers B-D). It gains a 65536-byte / depth-64 payload policy, a 36-byte-id refusal, the exact `req` check against this overlay's key, and a storage-range bound in place of the 2^53 caps. A new `internal/amount` package gives one exact amount type: Decimal128 in Mongo, a decimal string in JSON, `big.Int` inside. The admission signer keeps one interface and picks the scheme by topic: attested v1 (BRC-42 child) for `tm_color_*`, v3 with the bare key for `tm_mandala`, and no signature for KYC.

**Tech Stack:** Go 1.26.0, `github.com/bsv-blockchain/go-sdk` v1.7.1, `github.com/bsv-blockchain/go-overlay-services` v1.3.7, `go.mongodb.org/mongo-driver/v2` v2.9.1, Fiber v2.52.15, MongoDB 8 (`local-mongo-1` docker container) for tests.

**Spec:** `docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (incl. §8 B1-B6). The shared interface contract `docs/superpowers/plans/2026-10-22-1color-00-interfaces.md` is authoritative on every seam (§0, §3, §4, §5, §6 are this plan's). Pinned specs: `docs/design/brc-0162-1color.pinned.md` (cited **0162:n**) and `docs/design/brc-0207-1color-wallet-module.pinned.md` (cited **0207:n**). Audit: `docs/design/2026-10-21-brc162-brc207-conformance-audit.md`.

All paths below are relative to `/Users/personal/git/demos/mandala-wt/1color/overlay-go` unless absolute. Every command runs from that directory: `cd /Users/personal/git/demos/mandala-wt/1color/overlay-go && <command>`.

## Global Constraints

- Work only in worktree `/Users/personal/git/demos/mandala-wt/1color` on branch `feat/1color`, and only under `overlay-go/`. Never touch `/Users/personal/git/ts-stack`, `/Users/personal/git/bsv-wallet`, `/Users/personal/git/ts/bsv-desktop` or `/Users/personal/git/demos/mandala`. `/Users/personal/git/ts-stack-wt/1color` is read-only here (`git show` only).
- No push, no tag, no merge, no npm publish. Commit locally. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No new Go module dependencies and no version bumps in `go.mod`.
- Token amount per output: `0..2^64-1` (`uint64`; 0 = authority). Sums, supply, deltas and balances are exact (`*big.Int` / `amount.Amount`). No 2^53 cap on any amount, sum or supply (design §2 goal 2; 0162:140-143).
- Mongo stores every amount and aggregate as Decimal128 with exponent 0 (contract §6, D13). An aggregate whose magnitude exceeds `10^34-1` refuses the submit: ERR_SHAPE, reason `token <id>: amount aggregate exceeds storage range`.
- JSON token amounts are canonical decimal strings `0|[1-9][0-9]*`. A signed field (`delta`) may start with `-` and is never `-0`. `dec`, `vout`, `outputIndex`, `version`, `feeRatePerKb`, `actionCount` stay JSON numbers (contract §0).
- Asset id `^[0-9a-f]{64}_0$` for Mandala (32-byte wire id). Outpoints use the dot form `<64 lowercase hex>.<canonical decimal vout>` (contract §0).
- Per-asset topic `tm_color_<assetId>` and lookup `ls_color_<assetId>`. Registry `tm_mandala`/`ls_mandala` and KYC `tm_mandala_kyc`/`ls_mandala_kyc` keep their names. A deploy submit names exactly `["tm_mandala", "tm_color_<txid>_0"]` (contract §0).
- Attestation per contract §3, byte for byte: message `1color-admit:v1:tm_color_<assetId>:<txid>:<sorted outs>`, SHA-256 once, BRC-42 child `[2,"color admission attestation"]`, keyID `"1"`, counterparty anyone, overlay `SERVER_PRIVATE_KEY`. `tm_mandala` keeps σI v3 (`mandala-admit:v3:`) with the bare key. `tm_mandala_kyc` stays unsigned.
- BSV Chronicle: verifiers never normalize S and accept high-S. Attestation **signing** reproduces the C.0 low-S bytes (RFC 6979). Transaction-signature handling (`wiring/script_rules.go`) is not touched.
- Issuer policy unchanged (design §3): 1-sat token outputs, holder I==O, 32-byte ids only, trusted issuer + deploySig, KYC/membership, sanctions, freeze/pause/access, admin chain, whole-tx rejection. Verdict codes and HTTP mapping are unchanged (contract §6).
- The overlay never advertises itself as a conforming 1Color/`color` service: no SHIP/SLAP, and no "1Color service" wording in metadata or docs (design §3; 0207:775-786).
- No backward compatibility with old Mandala stores or wire formats. Every live boot uses a fresh `NODE_NAME`. Never drop or modify an existing Mongo database: tests use only `mandala3_test_*` (enforced by `internal/testmongo`).
- `@bsv/templates` `Bsv21Token.ts` is not modified by any change. It is not in this repo. Do not vendor or copy it.
- Mongo-backed tests prove nothing when skipped. Every verify step that names a Mongo-backed package needs `local-mongo-1` running, and its output must show `0` `--- SKIP` lines for that package.
- Stability mandate: each task's commit body states in 2-4 lines how the change behaves under crash mid-write, double-submit, concurrent submit, stale cache and retry. Anything not covered by a test is flagged.

## Review Focus

1. **An output of exactly 2^64-1, and an aggregate above 2^64**, e.g. an issue with two max outputs. Expected: admitted, stored exactly in Mongo, supply and balance exact, and JSON shows `"18446744073709551615"` / `"36893488147419103230"`. Pinned in Task 5 (`TestStoreAmountsAboveUint64Exact`) and Task 6 (`TestIssueTwoMaxOutputsAdmittedAndExact`).
2. **A double-submit of an admitted `tm_color_*` transaction.** Expected: the second 200 carries a byte-identical `admissionSignature` and the same `admissionIdentityKey`, and `/admin/admission/:txid` serves the same bytes. Pinned in Task 8 (`TestE2EReplayReturnsIdenticalAttestation`).
3. **`color-admission` on a spent output (the deploy `<txid>.0` after an issue).** Expected: it is returned with BEEF and `txid`, and `color-spendability` omits it. Uppercase or duplicate outpoints are refused. Pinned in Task 11 (`TestE2EColorLookupsSpentAndUnspent`, `TestColorQueryValidation`).
4. **A deploy whose `req` names another overlay key, has a reordered or extra member, or carries `ext`.** Expected: ERR_SHAPE final, and the refusal is persisted and replayed by payload hash. Pinned in Task 9 (`TestDeployReqPolicy`, `TestE2EDeployWrongReqIsFinalAndPersisted`).
5. **The new binary pointed at an old-format database** (BSON double/int amounts). Expected: every read of such an amount is an error (ERR_UNAVAILABLE on submit), never a silent 0 or a truncated value. Pinned in Task 4 (`TestAmountBSONRefusesOldShapes`) and Task 5 (`TestGetTokenRowRefusesOldDoubleAmount`).

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `internal/brc162/strictcbor.go` | Full strict DAG-CBOR, parity with templates `strictCbor.ts` at `cbdccfe5b` (depth 1024, no size cap) | 2 |
| `internal/brc162/codec.go`, `ledger.go` | OneColor codec: 32/36-byte ids, `<txid>_<vout>` strings | 3 |
| `testdata/brc162.json`, `testdata/README.md` | Re-pinned upstream vectors | 2 |
| `internal/amount/amount.go` (new) | `Amount`: exact, Decimal128 BSON, decimal-string JSON | 4 |
| `internal/colorprofile/colorprofile.go` (new) | Profile ids, `MandalaReq(K)`, `MandalaReqBytes(K)` (imported by `mandala` and `mandalatest`) | 9 |
| `internal/mandala/amount.go` | `type Amount = amount.Amount`; `MaxSafeAmount` deleted | 5, 6 |
| `internal/mandala/details.go` | Mandala CBOR policy (65536 B deploy, 4096 B details, depth 64), deploy `req`/`ext`/`icon` | 2, 9 |
| `internal/mandala/ownership.go`, `authority.go`, `reject.go` | Legacy-id refusal, cap removal, storage-range bound, non-deploy `req`/`ext` refusal | 3, 6, 9 |
| `internal/mandala/storage.go`, `records.go`, `interfaces.go`, `refold.go`, `reducer.go`, `reconcile.go`, `token_lookup.go` | Exact amounts through storage | 5, 6 |
| `internal/mandala/topics.go` | `tm_color_`/`ls_color_` names, `AdmissionSchemeOf` | 7 |
| `internal/mandala/admissions.go` | Attested v1 signer and verifier; v3 kept for `tm_mandala` | 8 |
| `internal/mandala/color_lookup.go` (new) | `color-*` query parsing and answers on `ls_color_<id>` | 11 |
| `internal/mandala/testdata/1color-deploy.json` (new) | F-REQ fixture (contract §4, 7 members). It is a byte-for-byte copy of P-LIB's `lib/src/__fixtures__/1color-deploy.json`, and `TestFREQFixtureMatchesLib` guards the copy. | 9 |
| `internal/mandalatest/*.go` | Kit: deploys with `req`, `p color` linkage, outputs-only envelopes | 9, 10 |
| `internal/activity/activity.go`, `internal/httpapi/*.go` | String amounts, topic predicates, `/lookup` `txid`, 503 on lookup store faults | 6, 7, 8, 11 |
| `internal/wiring/engine.go` | Passes the overlay identity key and engine reader to managers and lookups | 9, 11 |
| `README.md`, `.env.example`, `internal/mandala/docs.go` | Docs, fresh `NODE_NAME` guidance | 7, 12 |

---

### Task 0: Baseline

**Files:** none modified (empty commit records the counts).

**Interfaces:** Consumes nothing. Produces the baseline counts that every later task compares against.

- [ ] **Step 1: Start the test Mongo**

Run: `docker start local-mongo-1 && sleep 3 && nc -z localhost 27017 && echo MONGO_UP`
Expected: `MONGO_UP`. If the container is missing, run `docker run -d --name local-mongo-1 -p 27017:27017 mongo:8.0`. Never run `docker rm` on an existing container and never drop its volumes.

- [ ] **Step 2: Build and vet**

Run: `go build ./... && go vet ./...`
Expected: no output, exit 0.

- [ ] **Step 3: Run the full suite verbosely and count**

Run: `go test -count=1 ./... -v > "$TMPDIR/overlay-go-baseline.txt" 2>&1; echo exit=$?; for k in PASS FAIL SKIP; do printf "%s " $k; grep -c -- "--- $k" "$TMPDIR/overlay-go-baseline.txt"; done`
Expected: `exit=0`, `FAIL 0`, `SKIP 0`. For reference, the planning run without Mongo on 2026-10-22 gave 1025 PASS, 0 FAIL, 174 SKIP. With Mongo up, PASS should be about 1199. If any test fails or skips with Mongo up, record its name as **pre-existing** in the commit body. Later tasks must not add to that list.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore(overlay-go): record 1Color baseline

go test -count=1 ./... -v with local-mongo-1: <P> PASS, <F> FAIL, <S> SKIP.
Pre-existing failures: <none | names>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Vector replay seam for `mandala-rejects.json`

The TS parity file `testdata/mandala-rejects.json` (126 cases, sha256 `c13fb985…`) stays byte-for-byte pinned. 1Color deliberately changes some outcomes (design C9: the TS parity reference is now stale). This task adds a reviewed override table, which starts empty. Tasks 2, 3, 6, 7 and 9 add entries, each with a one-line reason.

**Files:**
- Modify: `internal/mandala/vectors_test.go`

**Interfaces:**
- Consumes: the existing `rejectVectors`, `rejectCase`, `rejectExpected` types.
- Produces (test-only, package `mandala`):
  - `func vectorTopic(topic string) string`: identity in this task. Task 7 makes it map `tm_<64hex>` to `tm_color_<64hex>_0`. It applies to `case.Topic` and to every `Topic` in `state.authorities` and `state.owners`.
  - `type vectorOverride struct{ Expected rejectExpected; Why string }`
  - `var vectorOverrides = map[string]vectorOverride{}`: keyed by case id. The replay uses `Expected` in place of the file's value.

- [ ] **Step 1: Write the failing test**

```go
func TestVectorOverridesAreLive(t *testing.T) {
	v := loadRejectVectors(t)
	byID := map[string]rejectCase{}
	for _, c := range v.Cases { byID[c.ID] = c }
	for id, o := range vectorOverrides {
		c, ok := byID[id]
		if !ok { t.Fatalf("override %q names no case", id) }
		if strings.TrimSpace(o.Why) == "" { t.Fatalf("override %q has no reason", id) }
		if reflect.DeepEqual(c.Expected, o.Expected) { t.Fatalf("override %q equals the file's expectation", id) }
	}
	if vectorTopic("tm_mandala") != "tm_mandala" { t.Fatal("registry topic must not be remapped") }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/mandala/ -run 'TestVectorOverridesAreLive' -count=1 -v`
Expected: FAIL to compile (`undefined: vectorOverrides`).

- [ ] **Step 3: Add `vectorTopic`, `vectorOverride`, `vectorOverrides`, and route the replay through them**

The replay loop resolves `want := c.Expected`, replaced by `vectorOverrides[c.ID].Expected` when present, and passes `vectorTopic(...)` wherever it uses a topic.

- [ ] **Step 4: Run the package**

Run: `go test ./internal/mandala/ -count=1 -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^ok|^FAIL'`
Expected: `ok`, no FAIL, no SKIP.

- [ ] **Step 5: Commit**

```bash
git add internal/mandala/vectors_test.go
git commit -m "test(overlay-go): add a reviewed override seam to the mandala-rejects replay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Full strict DAG-CBOR (codec parity) and the Mandala payload policy

Port `packages/helpers/ts-templates/src/strictCbor.ts` at ts-stack `cbdccfe5b` check for check: same check order, same messages, depth bound 1024, no size cap (0162:148). Read it with `git -C /Users/personal/git/ts-stack-wt/1color show cbdccfe5b:packages/helpers/ts-templates/src/strictCbor.ts`. Upstream removed the re-encode guard and enforces canonical form inline. Do the same: drop `"non-canonical encoding"` and the 4096-byte checks from the codec. The Mandala size and depth limits move into `internal/mandala` (contract §4 step 1, D14).

**Files:**
- Modify: `internal/brc162/strictcbor.go`, `internal/brc162/strictcbor_test.go`, `internal/brc162/vectors_test.go` (pin constants)
- Replace: `testdata/brc162.json`. Modify: `testdata/README.md`
- Modify: `internal/mandala/details.go`, `internal/mandala/details_test.go`, `internal/mandala/vectors_test.go` (overrides, if any)

**Interfaces:**
- Produces (`package brc162`):
  ```go
  const StrictCborMaxDepth = 1024
  type CborMap map[string]any
  type CborLink struct{ CID []byte } // tag 42; CID non-empty and CID[0] == 0x00
  // Decoded value set: uint64 (major 0), *big.Int (major 1; always < 0, = -1-arg, down to -2^64),
  // []byte, string, []any, CborMap, CborLink, float64 (finite, from 0xfb only), bool, nil.
  func DecodeStrictCbor(input []byte) (CborMap, error)                     // = DecodeStrictCborLimit(input, StrictCborMaxDepth)
  func DecodeStrictCborLimit(input []byte, maxDepth int) (CborMap, error)  // depth error text: fmt.Sprintf("nesting deeper than %d", maxDepth)
  func TryDecodeStrictCbor(input []byte) (CborMap, bool)
  func EncodeStrictCbor(m CborMap) ([]byte, error)
  func EncodeStrictCborValue(v any) ([]byte, error) // any decoded-set value, plus int, int64, uint32 for convenience
  ```
  Messages are the TS strings: `truncated input`, `indefinite length`, `reserved additional info`, `non-minimal header`, `length exceeds input`, `invalid UTF-8`, `non-finite float`, `float must be 64-bit`, `simple value not allowed`, `only tag 42 is allowed`, `invalid CID`, `map key must be text`, `map keys unsorted or duplicated`, `top level must be a map`, `trailing bytes`, `nesting deeper than N`. Go-only encoder errors: `integer outside -2^64..2^64-1`, `number must be a safe integer or a finite float` (NaN/Inf float64), `unsupported value type`. A `float64` always encodes as `0xfb` + 8 bytes, so every decoded value re-encodes to its input bytes.
- Produces (`package mandala`, `details.go`):
  ```go
  const (
  	MaxDeployPayloadBytes = 65536
  	MaxAdminDetailsBytes  = 4096
  	MandalaCborMaxDepth   = 64
  )
  // decodeMandalaCbor: len(b) > maxBytes -> *brc162.StrictCborError{fmt.Sprintf("input exceeds %d bytes", maxBytes)};
  // else brc162.DecodeStrictCborLimit(b, MandalaCborMaxDepth).
  func decodeMandalaCbor(b []byte, maxBytes int) (brc162.CborMap, error)
  ```
  `ParseDeployMetadata` uses `decodeMandalaCbor(payload, MaxDeployPayloadBytes)`. `DecodeAdminDetails` uses `MaxAdminDetailsBytes`, which keeps today's `input exceeds 4096 bytes` detail. `CommitmentOf` uses `MaxAdminDetailsBytes`, and any error there means no commitment.

- [ ] **Step 1: Re-pin the upstream vectors (the failing test)**

Run: `git -C /Users/personal/git/ts-stack-wt/1color show cbdccfe5b:packages/helpers/ts-templates/test/vectors/brc162.json > testdata/brc162.json && shasum -a 256 testdata/brc162.json && wc -c testdata/brc162.json`
Expected: `dec7003a7cf61a933574737228bc56d7fc902fedab0b21eddc28ab1042ef47f0`, `76656` bytes. Set `brc162VectorsSHA256` in `internal/brc162/vectors_test.go` to that hash. Update the `brc162.json` row in `testdata/README.md` (source path at `cbdccfe5b`, sha, size).

Add the unit tests to `strictcbor_test.go`:
```go
func TestDecodeStrictCborFullTypes(t *testing.T) {
	cases := []struct{ hex string; check func(any) bool }{
		{"a1616120", func(v any) bool { b, ok := v.(*big.Int); return ok && b.Cmp(big.NewInt(-1)) == 0 }},
		{"a161613bffffffffffffffff", func(v any) bool { b, ok := v.(*big.Int); want, _ := new(big.Int).SetString("-18446744073709551616", 10); return ok && b.Cmp(want) == 0 }},
		{"a16161fb3ff8000000000000", func(v any) bool { f, ok := v.(float64); return ok && f == 1.5 }},
		{"a16161d82a420001", func(v any) bool { l, ok := v.(CborLink); return ok && bytes.Equal(l.CID, []byte{0, 1}) }},
		{"a161618201a0", func(v any) bool { a, ok := v.([]any); return ok && len(a) == 2 && a[0] == uint64(1) }},
	}
	for _, c := range cases {
		in := mustHex(t, c.hex)
		m, err := DecodeStrictCbor(in)
		if err != nil || !c.check(m["a"]) { t.Fatalf("%s: %v %#v", c.hex, err, m) }
		again, err := EncodeStrictCbor(m)
		if err != nil || !bytes.Equal(again, in) { t.Fatalf("%s: re-encode %x %v", c.hex, again, err) }
	}
}

func TestDecodeStrictCborLimit(t *testing.T) {
	nest := func(n int) []byte { b := []byte{0xa1, 0x61, 0x61}; for i := 0; i < n-1; i++ { b = append(b, 0x81) }; return append(b, 0x01) }
	if _, err := DecodeStrictCborLimit(nest(64), 64); err != nil { t.Fatalf("depth 64: %v", err) }
	if _, err := DecodeStrictCborLimit(nest(65), 64); cborErr(t, err) != "nesting deeper than 64" { t.Fatal(err) }
}
```
(Depth counting matches TS: the top map is depth 1 and each array or map adds 1.)

In `internal/mandala/details_test.go`:
```go
func TestMandalaCborSizePolicy(t *testing.T) {
	big := mandalatest.Details(brc162.CborMap{"kind": "pause", "reason": strings.Repeat("x", 4090)}) // > 4096 bytes total
	_, _, err := DecodeAdminDetails(hex.EncodeToString(big), AdminKinds, 1)
	requireReject(t, err, "ERR_SHAPE", "output 1: admin details violate the schema (input exceeds 4096 bytes)")
	payload := deployPayloadOfSize(t, MaxDeployPayloadBytes+1) // valid map padded via a long "label"-irrelevant key
	_, err = ParseDeployMetadata(payload, true, true)
	requireReject(t, err, "ERR_SHAPE", "output 0: deploy payload is not a valid Mandala deploy map (input exceeds 65536 bytes)")
}
```
`deployPayloadOfSize` is a test helper that pads with an ignored key (`"zz": <text>`) until the encoding has the requested length. `requireReject` is the existing reject-assertion helper. Reuse it, or add one that compares `Code` and `Reason`.

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/brc162/ ./internal/mandala/ -run 'TestVector|TestDecodeStrictCbor|TestMandalaCborSizePolicy' -count=1 -v 2>&1 | grep -E -- '--- FAIL' | head`
Expected: FAIL. New `strictCbor` rows such as `array`, `depth-5`, `bytes-4091-no-size-limit` and `float16` disagree, and `DecodeStrictCborLimit` is undefined.

- [ ] **Step 3: Implement the codec port and the Mandala wrapper**

Port the TS reader 1:1 (`head`, `count`, `decodeSimpleOrFloat`, `decodeLink`, array/map bodies). UTF-8 validation stays `utf8.Valid`, the same accept set as before. Map keys compare encoded key bytes, as today. Major-1 values build `*big.Int` as `-1 - arg`. The encoder writes major 1 for a negative `*big.Int` with `|v| <= 2^64`. Remove the `StrictCborMaxBytes` constant and every reference to it. Replace each mandala call to `brc162.DecodeStrictCbor`/`TryDecodeStrictCbor` with `decodeMandalaCbor`.

- [ ] **Step 4: Run brc162 and mandala**

Run: `go test ./internal/brc162/ ./internal/mandala/ -count=1 -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^ok|^FAIL'`
Expected: `ok` for both. If a `TestVectorRejects…` case of `mandala-rejects.json` changes reason because the codec now accepts arrays, negatives or floats, add a `vectorOverrides` entry with `Why: "full strict DAG-CBOR (0162:148); Mandala payload policy 65536 B / depth 64 (contract §4.1)"` and the new exact expectation. Then rerun to green.

- [ ] **Step 5: Commit**

```bash
git add internal/brc162 testdata/brc162.json testdata/README.md internal/mandala/details.go internal/mandala/details_test.go internal/mandala/vectors_test.go
git commit -m "feat(overlay-go): full strict DAG-CBOR (templates cbdccfe5b parity) with Mandala size/depth policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: OneColor ids in the codec, 36-byte ids refused as Mandala policy

The codec follows `OneColor.ts` at `cbdccfe5b` (0162:113-120). Mandala refuses 36-byte ids as **policy** (design §4.2 overlay-go; audit C4). The refusal runs **before** `ScopeToToken`, otherwise a legacy output is scoped out as a foreign asset instead of refused.

**Files:**
- Modify: `internal/brc162/codec.go`, `codec_test.go`, `ledger.go`, `vectors_test.go`
- Modify: `internal/mandala/reject.go`, `ownership.go`, `token_topic.go`, `kyc_topic.go`, `reconcile.go`, `internal/activity/activity.go`, `internal/mandalatest/build.go` (callers of the changed signatures)
- Test: `internal/mandala/token_topic_test.go`, `internal/brc162/codec_test.go`

**Interfaces:**
- Produces (`brc162`):
  ```go
  type Decoded struct { /* … */ TokenID []byte /* nil = deploy; 32 bytes, or 36 = txid ‖ uint32 LE vout (vout != 0) */ }
  func TokenIDToString(id []byte) (string, error)   // "<64hex>_0" | "<64hex>_<vout>"; errors as OneColor.tokenIdToString
  func TokenIDFromString(s string) ([]byte, error)  // ^([0-9a-f]{64})_(0|[1-9][0-9]{0,9})$, vout <= 2^32-1; vout 0 -> 32 bytes
  func IsLegacyTokenID(id string) bool               // true iff a canonical id string with vout != 0
  ```
  Codec messages: `token id must be a direct 32- or 36-byte push`, `a 36-byte token id with vout 0 is non-canonical`, `token id must be <64 lowercase hex>_<vout>`, `token id vout exceeds uint32`, `token id must be 32 or 36 bytes`. `Lock` accepts any canonical id string.
- Produces (`mandala`):
  ```go
  func rLegacyTokenID(i uint32, tokenID string) *RejectError // CodeShape, "output %d: legacy 36-byte token id %s is refused by Mandala policy (32-byte ids only)"
  func RequireNoLegacyTokenIDs(outputs []brc162.Output) error // first output (index order) whose TokenID is legacy
  ```
  It is called in `TokenTopicManager.identify` right after `brc162.ClassifyOutputs(tx)` (so also in the registry dry run) and in the KYC manager at the same point.

- [ ] **Step 1: Write the failing tests**

```go
func TestOneColorLegacyIDs(t *testing.T) {
	txid := strings.Repeat("ab", 32)
	id, err := TokenIDFromString(txid + "_7")
	if err != nil || len(id) != 36 || binary.LittleEndian.Uint32(id[32:]) != 7 { t.Fatal(id, err) }
	if s, _ := TokenIDToString(id); s != txid+"_7" { t.Fatal(s) }
	if _, err := TokenIDFromString(txid + "_4294967296"); err == nil || err.Error() != "token id vout exceeds uint32" { t.Fatal(err) }
	script, _ := Lock(LockParams{TokenID: txid + "_7", Amount: 5, PubKeyHash: make([]byte, 20)})
	d, err := Decode(script)
	if err != nil || len(d.TokenID) != 36 { t.Fatal(err) }
	zero := append(append([]byte{}, id[:32]...), 0, 0, 0, 0)
	bad := append([]byte{36}, zero...)    // direct 36-byte push, vout 0
	bad = append(bad, 0x55, 0x6d)          // OP_5 amount, OP_2DROP (token-shaped; the id check fails first)
	if _, err := Decode(bad); err == nil || err.Error() != "a 36-byte token id with vout 0 is non-canonical" { t.Fatal(err) }
	if !IsLegacyTokenID(txid+"_7") || IsLegacyTokenID(txid+"_0") { t.Fatal("IsLegacyTokenID") }
}
```
In `internal/brc162/vectors_test.go`, add a `oneColorRejectMessages` map. Each `rejectScripts` row whose upstream message is the Bsv21Binary `token id must be a direct 32-byte push` maps to the OneColor result, e.g. `"id-33-bytes": "token id must be a direct 32- or 36-byte push"`. For `id-36-bytes`, decode the row's id bytes. If its vout is non-zero the row now **decodes**, so the remap is `""`, meaning valid. If its vout is 0, use the non-canonical message. Each entry gets a comment citing 0162:113-115. Keep these seven rows asserted, never skipped.

```go
func TestTokenTopicRefusesLegacyTokenID(t *testing.T) {
	// a holder tx whose output 0 carries <deploy txid>_1 (36-byte id) beside a valid output of the topic's token
	adm, err := runTokenTopic(t, legacyIDFixture(t))
	requireReject(t, err, "ERR_SHAPE", "output 0: legacy 36-byte token id "+legacyID+" is refused by Mandala policy (32-byte ids only)")
	_ = adm
}
```
`runTokenTopic` and `legacyIDFixture` are local helpers over `mandalatest.Build` and the memStore. `legacyID` is the test's `<txid>_1`.

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/brc162/ ./internal/mandala/ -run 'TestOneColorLegacyIDs|TestVectorRejectScripts|TestTokenTopicRefusesLegacyTokenID' -count=1 -v`
Expected: FAIL (compile errors on the new signatures, then the assertions).

- [ ] **Step 3: Implement the codec change, update every caller of `TokenIDToString`/`*d.TokenID`, add the Mandala refusal**

Callers: `ledger.go` (`ClassifyOutputs`, `ClassifyAdmittedInputs`), `mandala/reconcile.go:171`, `activity.go:209`, `mandalatest/build.go` (`TokenIDOf`). `TokenIDToString` cannot fail on codec-validated bytes. Callers propagate its error anyway, never `_`.

- [ ] **Step 4: Run the whole tree**

Run: `go test -count=1 ./... 2>&1 | grep -E '^(ok|FAIL|---)'`
Expected: every package `ok`. If a `mandala-rejects` case changes, add an override with `Why: "OneColor 36-byte ids parse in the codec; Mandala refuses them as policy (0162:113-115, design §4.2)"`.

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "feat(overlay-go): OneColor 32/36-byte token ids; Mandala refuses legacy ids as policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `internal/amount`: one exact amount type

**Files:**
- Create: `internal/amount/amount.go`, `internal/amount/amount_test.go`, `internal/amount/amount_mongo_test.go`

**Interfaces:**
- Consumes: `go.mongodb.org/mongo-driver/v2/bson` (`ParseDecimal128FromBigInt`, `Decimal128.BigInt`, `IsNaN`, `IsInf`), `internal/testmongo`.
- Produces (`package amount`):
  ```go
  var ErrOutOfRange = errors.New("amount aggregate exceeds storage range")
  func MaxStorable() *big.Int                  // 10^34 - 1 (fresh copy)
  type Amount struct{ v *big.Int }             // immutable; zero value == 0; never mutate v after construction
  func FromUint64(u uint64) Amount
  func FromBig(b *big.Int) (Amount, error)     // copies b; |b| > MaxStorable -> ErrOutOfRange
  func Parse(s string) (Amount, error)         // ^(0|-?[1-9][0-9]*)$, "-0" refused, range-checked
  func (a Amount) Big() *big.Int               // fresh copy
  func (a Amount) Uint64() (uint64, bool)      // ok iff 0 <= a <= 2^64-1
  func (a Amount) Sign() int
  func (a Amount) Cmp(b Amount) int
  func (a Amount) Add(b Amount) (Amount, error) // ErrOutOfRange beyond storage range
  func (a Amount) Neg() Amount
  func (a Amount) IsZero() bool
  func (a Amount) String() string
  func (a Amount) MarshalBSONValue() (byte, []byte, error)    // Decimal128, exponent 0
  func (a *Amount) UnmarshalBSONValue(t byte, data []byte) error
  func (a Amount) MarshalJSON() ([]byte, error)               // "\"<decimal>\""
  func (a *Amount) UnmarshalJSON(b []byte) error              // canonical decimal string; also a bare JSON integer literal (pinned TS vector files only)
  ```
  `UnmarshalBSONValue` accepts **only** Decimal128 that is finite, integral (exponent > 0 is scaled; a negative exponent needs an exact integer value) and within the storage range. Any other BSON type gets the error `amount: stored as <bson type>, want decimal128 (old-format data: use a fresh NODE_NAME)`. NaN/Inf get `amount: non-finite decimal128`. A fractional value gets `amount: <s> is not an integer`.

- [ ] **Step 1: Write the failing tests**

```go
func TestAmountJSON(t *testing.T) {
	b, _ := json.Marshal(FromUint64(math.MaxUint64))
	if string(b) != `"18446744073709551615"` { t.Fatal(string(b)) }
	for _, bad := range []string{`"-0"`, `"01"`, `"1e3"`, `"1.0"`, `5.5`, `null`, `"+1"`} {
		var a Amount
		if json.Unmarshal([]byte(bad), &a) == nil { t.Fatalf("%s accepted", bad) }
	}
	var a Amount
	if err := json.Unmarshal([]byte(`-36893488147419103230`), &a); err != nil || a.String() != "-36893488147419103230" { t.Fatal(a, err) }
}

func TestAmountBSONRoundTrip(t *testing.T) {
	max := MaxStorable()
	for _, s := range []string{"0", "1", "18446744073709551615", "-18446744073709551615", max.String()} {
		a, err := Parse(s); if err != nil { t.Fatal(err) }
		typ, data, err := a.MarshalBSONValue()
		if err != nil || bson.Type(typ) != bson.TypeDecimal128 { t.Fatal(typ, err) }
		var back Amount
		if err := back.UnmarshalBSONValue(typ, data); err != nil || back.Cmp(a) != 0 { t.Fatal(s, back, err) }
	}
	if _, err := FromBig(new(big.Int).Add(max, big.NewInt(1))); !errors.Is(err, ErrOutOfRange) { t.Fatal(err) }
}

func TestAmountBSONRefusesOldShapes(t *testing.T) { // Review Focus 5
	for _, v := range []any{5.0, int32(5), int64(5), "5"} {
		typ, data, _ := bson.MarshalValue(v)
		var a Amount
		if err := a.UnmarshalBSONValue(byte(typ), data); err == nil || !strings.Contains(err.Error(), "want decimal128") { t.Fatalf("%T: %v", v, err) }
	}
	frac, _ := bson.ParseDecimal128("1.5")
	typ, data, _ := bson.MarshalValue(frac)
	var a Amount
	if a.UnmarshalBSONValue(byte(typ), data) == nil { t.Fatal("1.5 accepted") }
}
```
`amount_mongo_test.go` (`testmongo.DB(t, "mandala3_test_amount")`):
```go
func TestAmountMongoIncAndSortExact(t *testing.T) {
	// insert {k:"x", v: FromUint64(MaxUint64)}; $inc v by FromUint64(MaxUint64); read back == "36893488147419103230"
	// insert v = 5, 9007199254740993, 18446744073709551615 under k:"s"; Find sorted by v asc -> that order
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/amount/ -count=1 -v`
Expected: FAIL (package does not exist yet / undefined identifiers).

- [ ] **Step 3: Implement `internal/amount/amount.go`**

- [ ] **Step 4: Run (Mongo up)**

Run: `go test ./internal/amount/ -count=1 -v 2>&1 | grep -E -- '--- (PASS|FAIL|SKIP)'`
Expected: all PASS, 0 SKIP.

- [ ] **Step 5: Commit**

```bash
git add internal/amount
git commit -m "feat(overlay-go): exact amount type (Decimal128 BSON, decimal-string JSON)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Storage and record migration to exact amounts

**Files:**
- Modify: `internal/mandala/amount.go` (whole file becomes `type Amount = amount.Amount`; `MaxSafeAmount` survives until Task 6), `records.go`, `storage.go`, `interfaces.go`, `ownership.go` (`sameAmount`, `TakeBackRepair` debit, journal row build), `token_lookup.go` (`storeOwnerRow`; `lookupDelta` keeps its clamp for now but returns `Amount`), `refold.go`, `reducer.go`, `reconcile.go`, `kyc_lookup.go`
- Compile-only adaptations, same semantics: `authority.go` (reissue compare via `frozen.Amount.Big()`, keeping the 2^53 check until Task 6) and `internal/httpapi/tokens.go` (`summarizeAdminHistory` reads `r.Delta.Big()`; the totals stay `int64` until Task 6)
- Modify tests: `internal/mandala/fakes_test.go` (memStore is shared by most mandala tests), `storage_test.go`, `amount_test.go` (delete the double-shape tests that no longer apply), `vectors_test.go` (loader: `vectorToken.Amount` int64 → `amount.FromUint64`), `internal/httpapi/e2e_test.go` (`e2eBalance` parses a string), and every httpapi test asserting a record-sourced amount as a JSON number (`amount`, `delta`, `frozenAmount` in asset-state and admin-history bodies). These become decimal strings here because the record type changed.

**Interfaces:**
- Consumes: `amount.Amount` (Task 4).
- Produces (`mandala`):
  ```go
  type Amount = amount.Amount
  // StateStore and RepairUndoStore:
  AdjustBalance(ctx context.Context, identityKey string, delta Amount) error
  // Store:
  func (s *Store) GetBalance(ctx context.Context, identityKey string) (Amount, error)
  func (s *Store) CirculatingSupply(ctx context.Context, tokenID string) (*big.Int, error) // unchanged signature, exact sum of Decimal128 rows
  func (s *Store) RebuildBalances(ctx context.Context) (BalanceRebuild, error)          // Unsafe = sums beyond amount.MaxStorable()
  func sameAmount(stored Amount, amount uint64) bool                                     // stored.Uint64() == (amount, true)
  ```
  Record fields `OwnerRecord.Amount`, `TokenRecord.Amount`, `FrozenRef.Amount`, `AdminHistoryEntry.Delta`, `AdminHistoryEntry.FrozenAmount` keep their names, bson tags and json tags. Their type becomes `Amount`, so BSON is Decimal128 and JSON is a string. A credit is `AdjustBalance(ctx, k, amount.FromUint64(o.Amount))` and a debit is `row.Amount.Neg()`.

- [ ] **Step 1: Write the failing tests** (`storage_test.go`, Mongo `mandala3_test_storage_amounts`)

```go
func TestStoreAmountsAboveUint64Exact(t *testing.T) { // Review Focus 1
	s := newTestStore(t, "mandala3_test_storage_amounts")
	max := amount.FromUint64(math.MaxUint64)
	for i, txid := range []string{txidA, txidB} {
		ok, err := s.StoreTokenIfAbsent(ctx, TokenRecord{Txid: txid, OutputIndex: uint32(i), TokenID: tokenX, Amount: max, IdentityKey: holderKey})
		if err != nil || !ok { t.Fatal(err) }
		if err := s.AdjustBalance(ctx, holderKey, max); err != nil { t.Fatal(err) }
	}
	row, _ := s.GetTokenRow(ctx, txidA, 0)
	if row.Amount.String() != "18446744073709551615" { t.Fatal(row.Amount) }
	sup, _ := s.CirculatingSupply(ctx, tokenX)
	bal, _ := s.GetBalance(ctx, holderKey)
	if sup.String() != "36893488147419103230" || bal.String() != "36893488147419103230" { t.Fatal(sup, bal) }
	res, err := s.RebuildBalances(ctx)
	if err != nil || res.Changed != 0 || len(res.Unsafe) != 0 { t.Fatal(res, err) }
}

func TestGetTokenRowRefusesOldDoubleAmount(t *testing.T) { // Review Focus 5
	s, db := newTestStoreDB(t, "mandala3_test_storage_old")
	_, _ = db.Collection(TokensCollection).InsertOne(ctx, bson.D{{"txid", txidA}, {"outputIndex", 0}, {"tokenId", tokenX}, {"amount", 5.0}, {"identityKey", holderKey}})
	if row, err := s.GetTokenRow(ctx, txidA, 0); err == nil { t.Fatalf("old double read as %v", row) }
	if _, err := s.CirculatingSupply(ctx, tokenX); err == nil { t.Fatal("supply read an old double") }
}
```
Use the existing store test helpers where they exist. `txidA`, `txidB`, `tokenX` and `holderKey` are fixed test constants.

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/mandala/ -run 'TestStoreAmountsAboveUint64Exact|TestGetTokenRowRefusesOldDoubleAmount' -count=1 -v`
Expected: FAIL (compile: `AdjustBalance` takes `int64`; then assertion failures).

- [ ] **Step 3: Migrate the types, the store methods, the interfaces and memStore**

The memStore in `fakes_test.go` mirrors the Store: balances are `map[string]Amount`, supply sums `Big()`. `RebuildBalances` compares the stored value via `Amount.UnmarshalBSONValue`, and an undecodable document is rewritten as today.

- [ ] **Step 4: Run every package (Mongo up)**

Run: `go test -count=1 ./... -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^(ok|FAIL)'`
Expected: all `ok`, 0 FAIL, 0 SKIP. Behaviour is unchanged apart from the representation. The 2^53 caps still exist until Task 6, so no override is expected here.

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "refactor(overlay-go): store every amount exactly (Decimal128), balances and supply via amount.Amount

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Remove 2^53 caps; storage-range bound; exact deltas; string amounts on every JSON surface

**Files:**
- Modify: `internal/mandala/ownership.go` (drop the amount-cap rule from `RequireValidTokenOutputs`), `authority.go` (`authRequireCaps` → `authRequireStorageRange`; exact reissue compare), `reject.go`, `amount.go` (delete `MaxSafeAmount`), `details.go` (`detFeeRate` bound becomes `maxSafeInteger`; fee rate is a sats rate, not a token amount), `token_lookup.go` (`lookupDelta`)
- Modify: `internal/activity/activity.go` (amounts exact), `internal/httpapi/tokens.go` (`adminSummary.TotalIssued/TotalRedeemed`)
- Test: `internal/mandala/authority_test.go`, `engine_flow_test.go`, `internal/activity/activity_test.go`, `internal/httpapi/tokens_test.go`, `internal/mandala/vectors_test.go` (overrides)

**Interfaces:**
- Consumes: `amount.Amount`, `amount.MaxStorable()`.
- Produces:
  ```go
  // mandala/reject.go: removed rAmountCap, rSumCap, rSupplyCap; added
  func rAggregateRange(tokenID string) *RejectError // CodeShape, "token %s: amount aggregate exceeds storage range"
  // mandala/authority.go: step 9 = for each ledger with Δ > 0: supply + Δ > MaxStorable -> rAggregateRange; with Δ < 0: |Δ| > MaxStorable -> rAggregateRange
  func lookupDelta(a *lookupAdmitted) (Amount, error) // exact Δ; error only if out of storage range (layer C already bounds it)
  // activity: FtInput.Amount, FtOutput.Amount uint64; Entry.Amount amount.Amount (JSON string)
  // httpapi: adminSummary{TotalIssued, TotalRedeemed amount.Amount; ActionCount int64}
  ```
  Holder conservation (`rHolderConservation`) and the delta rules are unchanged. They already use `big.Int`.

- [ ] **Step 1: Write the failing tests**

```go
func TestIssueTwoMaxOutputsAdmittedAndExact(t *testing.T) { // Review Focus 1; engine_flow_test.go, Mongo-backed engineFlow
	f := newEngineFlow(t, "mandala3_test_flow_uint64")
	d := mt.Deploy(t, mt.Issuer, "MAX")
	topic := f.hostWithLookup(mt.TokenIDOf(d, 0)) // ls_color_<id> then tm_color_<id>, registered once
	f.mustSubmit(d, MandalaTopic, topic)
	is := mt.Build(t, []mt.In{{Src: d, Vout: 0}}, []mt.Out{
		{Owner: mt.Issuer, Prover: mt.Issuer, TokenID: mt.TokenIDOf(d, 0), Payload: mt.AdmPayload(issueCommit), HasPayload: true, Details: issueDetails},
		{Owner: mt.Holder, Prover: mt.Issuer, TokenID: mt.TokenIDOf(d, 0), Amount: math.MaxUint64},
		{Owner: mt.Holder, Prover: mt.Issuer, TokenID: mt.TokenIDOf(d, 0), Amount: math.MaxUint64},
	}, nil)
	steak := f.mustSubmit(is, topic)
	if !slices.Equal(steak[topic].OutputsToAdmit, []uint32{0, 1, 2}) { t.Fatal(steak) }
	if sup, _ := f.store.CirculatingSupply(f.ctx, mt.TokenIDOf(d, 0)); sup.String() != "36893488147419103230" { t.Fatal(sup) }
	tr := mt.Transfer(t, is, 1, mt.Receiver, math.MaxUint64) // full max coin moves holder -> receiver
	if steak := f.mustSubmit(tr, topic); !slices.Equal(steak[topic].OutputsToAdmit, []uint32{0}) { t.Fatal(steak) }
}

func TestIssueBeyondStorageRangeRefused(t *testing.T) {
	// memStore supply preset to MaxStorable() - 1 for the token; an issue minting 2 -> ERR_SHAPE,
	// reason "token <id>: amount aggregate exceeds storage range", RejectError.Final() true
}

func TestReissueMatchesFrozenAmountExactly(t *testing.T) {
	// frozen row amount 2^64-1 (FrozenRef.Amount = amount.FromUint64(math.MaxUint64)); reissue Δ = 2^64-1 -> admitted;
	// Δ = 2^64-2 -> ERR_SHAPE "token <id>: reissue amount does not match the frozen row"
}
```
`internal/activity/activity_test.go`:
```go
func TestEntryAmountIsDecimalString(t *testing.T) {
	e := SummarizeTx(SummarizeParams{Txid: tx1, FtOutputs: []FtOutput{{OutputIndex: 1, IdentityKey: k, Amount: math.MaxUint64, TokenID: id, Role: brc162.RoleValue}}})
	b, _ := json.Marshal(e)
	if !strings.Contains(string(b), `"amount":"18446744073709551615"`) { t.Fatal(string(b)) }
}
```
`internal/httpapi/tokens_test.go`: `TestAdminSummaryTotalsAreStrings`. History rows with deltas `18446744073709551615` (issue) and `-5` (redeem) produce `"totalIssued":"18446744073709551615","totalRedeemed":"5"` and `"actionCount":2` (a number). `TestAssetStateFrozenAmountIsString` asserts `"amount":"18446744073709551615"` inside `frozenOutpoints`. Task 5 already made it a string, so this test pins the value above 2^53.

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/mandala/ ./internal/activity/ ./internal/httpapi/ -run 'TestIssueTwoMaxOutputs|TestIssueBeyondStorageRange|TestReissueMatchesFrozen|TestEntryAmountIsDecimalString|TestAdminSummaryTotalsAreStrings|TestAssetStateFrozenAmountIsString' -count=1 -v`
Expected: FAIL (`output 1: token amount exceeds 2^53-1`, int JSON numbers).

- [ ] **Step 3: Implement the cap removal, the storage-range bound, exact `lookupDelta`, exact reissue compare and the JSON types**

- [ ] **Step 4: Run the whole tree (Mongo up)**

Run: `go test -count=1 ./... -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^(ok|FAIL)'`
Expected: 0 FAIL, 0 SKIP. Each `mandala-rejects` case that expected `exceeds 2^53-1` gets an override with its new exact outcome and `Why: "uint64 end to end (design §2 goal 2, 0162:140-143); caps removed"`. Also confirm `grep -rn 'MaxSafeAmount\|2^53' internal cmd | grep -v _test.go` prints only the envelope/lookup `maxSafeInteger` uses (indices, limits, fee rate).

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "feat(overlay-go): uint64 per output, no sum/supply caps, Decimal128 storage-range bound, string amounts in JSON

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Topic rename to `tm_color_<assetId>` / `ls_color_<assetId>` and the admission-scheme predicate

**Files:**
- Modify: `internal/mandala/topics.go`, `topics_test.go`, `token_registry_lookup.go:112`, `token_registry_topic.go:52`, `docs.go` (topic names in the strings)
- Modify: `internal/httpapi/submit.go` (pairing rule at :539/:547, `namesSigmaTopic`, `serveKnownVerdict`, `admittedEntries`, `emptyUncoveredSigmaEntry`), `verdict.go` (`Persistable`), `admin.go` (`admissionHandler`)
- Modify tests: every test that spells `"tm_"+hex`, `"ls_"+hex` or a literal `tm_<64hex>` (found with `grep -rln 'tm_[0-9a-f]\{64\}\|"tm_" *+\|"ls_" *+' internal`). Replace each with `mandala.TokenTopic`/`TokenLookup`/`TokenTopicOfTxid`.
- Modify: `internal/mandala/vectors_test.go` (`vectorTopic` now remaps)

**Interfaces:**
- Produces (`mandala`; contract §6 renames):
  ```go
  func TokenTopic(tokenID string) (string, error)  // "tm_color_" + tokenID; non-canonical -> "not a canonical Mandala token id: <id>"
  func TokenLookup(tokenID string) (string, error) // "ls_color_" + tokenID
  func TokenTopicOfTxid(txid string) string         // "tm_color_<txid>_0"; "" unless txid is 64 lowercase hex
  func IsColorTopic(name string) bool               // ^tm_color_([0-9a-f]{64})_0$
  func IsTokenTopic(name string) bool               // = IsColorTopic (kept: contract §6 names both)
  func TokenIDOfTopic(name string) (string, bool)
  func DeployTokenOf(topics []string, txid string) (string, bool) // needs MandalaTopic and TokenTopicOfTxid(txid)
  type AdmissionScheme int
  const ( SchemeNone AdmissionScheme = iota; SchemeAttestedV1; SchemeMandalaV3 )
  func AdmissionSchemeOf(topic string) AdmissionScheme // IsColorTopic -> AttestedV1; MandalaTopic -> MandalaV3; else None
  // IsSigmaTopic is deleted; every caller uses AdmissionSchemeOf(t) != SchemeNone.
  ```
  The pairing refusal text becomes `X-Topics naming tm_mandala must also name tm_color_<txid>_0`.

- [ ] **Step 1: Write the failing tests**

```go
func TestColorTopicNames(t *testing.T) {
	h := strings.Repeat("c7", 32)
	if s, _ := TokenTopic(h + "_0"); s != "tm_color_"+h+"_0" { t.Fatal(s) }
	if s, _ := TokenLookup(h + "_0"); s != "ls_color_"+h+"_0" { t.Fatal(s) }
	if _, err := TokenTopic(h + "_1"); err == nil || err.Error() != "not a canonical Mandala token id: "+h+"_1" { t.Fatal(err) }
	for _, n := range []string{"tm_" + h, "tm_color_" + h + "_1", "tm_color_" + h + "_0\n", "tm_color_" + strings.ToUpper(h) + "_0"} {
		if IsColorTopic(n) { t.Fatalf("%q", n) }
	}
	if id, ok := TokenIDOfTopic("tm_color_" + h + "_0"); !ok || id != h+"_0" { t.Fatal(id) }
	if _, ok := DeployTokenOf([]string{MandalaTopic, "tm_" + h}, h); ok { t.Fatal("old pairing accepted") }
	if id, ok := DeployTokenOf([]string{"tm_color_" + h + "_0", MandalaTopic}, h); !ok || id != h+"_0" { t.Fatal(id) }
	want := map[string]AdmissionScheme{"tm_color_" + h + "_0": SchemeAttestedV1, MandalaTopic: SchemeMandalaV3, KYCTopic: SchemeNone, "tm_" + h: SchemeNone}
	for n, s := range want { if AdmissionSchemeOf(n) != s { t.Fatal(n) } }
}
```
`internal/httpapi/submit_hook_test.go`:
```go
func TestSubmitUnhostedVoutOneColorTopic(t *testing.T) {
	// submit any built tx with X-Topics ["tm_color_<deploy txid>_1"] -> 400, code ERR_SHAPE, description "unknown-topic: tm_color_<deploy txid>_1"
}
func TestSubmitPairingRuleNamesColorTopic(t *testing.T) {
	// deploy submitted with ["tm_mandala"] only -> 400 ERR_SHAPE, description "X-Topics naming tm_mandala must also name tm_color_<txid>_0"
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/mandala/ ./internal/httpapi/ -run 'TestColorTopicNames|TestSubmitUnhostedVoutOneColorTopic|TestSubmitPairingRuleNamesColorTopic' -count=1 -v`
Expected: FAIL.

- [ ] **Step 3: Rename in production code, then mechanically update tests and the vector remap**

`vectorTopic` maps `^tm_([0-9a-f]{64})$` → `tm_color_$1_0` and leaves everything else alone. A case whose expected `reason` embeds a topic name gets an override with `Why: "topic rename tm_<txid> -> tm_color_<assetId> (contract §0, design C1)"`.

- [ ] **Step 4: Run everything (Mongo up)**

Run: `go test -count=1 ./... -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^(ok|FAIL)'; grep -rn '"tm_" *+\|"ls_" *+\|IsSigmaTopic' internal cmd`
Expected: 0 FAIL, 0 SKIP; the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "feat(overlay-go)!: per-asset topics tm_color_<assetId> / ls_color_<assetId>; admission scheme by topic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: BRC-207 attested admission signature on `tm_color_*`

Statement per contract §3 and 0207:240-275. Vectors: 0207:10224-10264 (C.0; HMAC tweak row 0207:10230). Contract §3 requires every C.0 suite to assert all five values plus the HMAC tweak. The tweak separates an invoice/HMAC error from a point-addition error, so a wrong child key can be traced to one of the two.

**Files:**
- Modify: `internal/mandala/admissions.go`, `admissions_test.go`
- Modify: `internal/httpapi/e2e_test.go` (`e2eSigma` verifies by scheme), `admission_flow_test.go`, `admin_test.go` (assertions that used `VerifyAdmission` on token topics)

**Interfaces:**
- Consumes: `AdmissionSchemeOf` (Task 7); go-sdk `wallet.NewProtoWallet`, `ProtoWallet.CreateSignature`, `ec.PublicKey.DeriveChild`, `wallet.AnyoneKey`, `ec.ParseDERSignature`.
- Produces (`mandala`):
  ```go
  const AttestationPrefix = "1color-admit:v1:"
  var AttestationProtocol = wallet.Protocol{SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, Protocol: "color admission attestation"} // level 2
  const AttestationKeyID = "1"
  var ErrUnsignedTopic = errors.New("admission: topic carries no admission signature")
  // AttestationMessage: topic IsColorTopic, txid 64 lowercase hex, outputs non-empty and strictly ascending, else error.
  func AttestationMessage(topic, txid string, outputs []uint32) (string, error)
  // AttestationSigningKey: signer.DeriveChild(anyonePriv (scalar 1), "2-color admission attestation-1").
  func AttestationSigningKey(signer *ec.PublicKey) (*ec.PublicKey, error)
  // VerifyAttestation never errors: strict DER (ec.ParseDERSignature; trailing bytes refused), lowercase hex only,
  // canonical outputs, signer a lowercase compressed on-curve key; verifies SHA-256(message) against the DERIVED child;
  // accepts low- and high-S; never the bare key.
  func VerifyAttestation(topic, txid string, outputs []uint32, sigDERHex, signerHex string) bool
  // ECAdmissionSigner.SignAdmission(topic, txid, outs) dispatch:
  //   SchemeAttestedV1 -> ProtoWallet{priv}.CreateSignature({Data: []byte(AttestationMessage(topic, txid, CanonicalOutputs(outs))),
  //                       ProtocolID: AttestationProtocol, KeyID: "1", Counterparty: anyone}); hex(sig.Serialize())
  //   SchemeMandalaV3  -> unchanged (AdmissionDigestV3, bare key)
  //   SchemeNone       -> ErrUnsignedTopic
  //   identityKeyHex is always the ROOT compressed key (contract §2.1 admissionIdentityKey).
  ```
  `VerifyAdmission` (v3) stays for `tm_mandala` only. `serveKnownVerdict`, `admittedEntries` and `/admin/admission` go through `SignAdmission`, so they need no logic change beyond Task 7's predicate.

- [ ] **Step 1: Write the failing tests** (`admissions_test.go`)

```go
const (
	c0Topic  = "tm_color_c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0"
	c0Txid   = "05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931"
	c0Signer = "02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046"
	c0Tweak  = "6ef21748a4f6f5034842184e25f68e8df8663e036622ad9b3d061c6dd81ea93b" // 0207:10230
	c0Child  = "033520aaa77b6914019796e974d1737acc890c5283c0921ddcfc2d5c815db8fb90"
	c0Digest = "9f61b417ec979c3c057313fe56f3c6056d2962b6bceaaa8272377bb9a80d8f9d"
	c0Low    = "3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a"
	c0High   = "3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7"
)

func c0Priv(t *testing.T) *ec.PrivateKey { // public test integer 5555 (0207:10224); never for funds
	b := make([]byte, 32); b[30], b[31] = 0x15, 0xb3
	p, _ := ec.PrivateKeyFromBytes(b); return p
}

func TestAttestationC0Vectors(t *testing.T) {
	priv := c0Priv(t)
	if priv.PubKey().ToDERHex() != c0Signer { t.Fatal("signer") }
	// BRC-42 HMAC tweak, asserted on its own: key = compressed shared secret of (anyone = scalar 1, signer),
	// which is the signer point itself; msg = utf8 invoice "2-color admission attestation-1".
	anyPriv, _ := wallet.AnyoneKey()
	shared, err := anyPriv.DeriveSharedSecret(priv.PubKey())
	if err != nil || !shared.IsEqual(priv.PubKey()) { t.Fatal("shared secret with scalar 1 must be the signer point", err) }
	mac := hmac.New(sha256.New, shared.Compressed())
	mac.Write([]byte("2-color admission attestation-1"))
	if got := hex.EncodeToString(mac.Sum(nil)); got != c0Tweak { t.Fatalf("HMAC tweak %s (invoice or HMAC key wrong)", got) }
	child, err := AttestationSigningKey(priv.PubKey())
	if err != nil || child.ToDERHex() != c0Child { t.Fatal(child, err) }
	msg, _ := AttestationMessage(c0Topic, c0Txid, []uint32{0, 2})
	if msg != "1color-admit:v1:"+c0Topic+":"+c0Txid+":0,2" { t.Fatal(msg) }
	if d := sha256.Sum256([]byte(msg)); hex.EncodeToString(d[:]) != c0Digest { t.Fatal("digest") }
	s := &ECAdmissionSigner{priv: priv}
	sig, ident, err := s.SignAdmission(c0Topic, c0Txid, []uint32{2, 0, 2}) // canonicalised by the signer
	if err != nil || sig != c0Low || ident != c0Signer { t.Fatal(sig, ident, err) }
	if !VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low, c0Signer) { t.Fatal("low-S") }
	if !VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0High, c0Signer) { t.Fatal("high-S") }
}

func TestAttestationC0Negatives(t *testing.T) {
	other := "tm_color_" + strings.Repeat("00", 32) + "_0"
	for name, ok := range map[string]bool{
		"reordered":   VerifyAttestation(c0Topic, c0Txid, []uint32{2, 0}, c0Low, c0Signer),
		"missing 2":   VerifyAttestation(c0Topic, c0Txid, []uint32{0}, c0Low, c0Signer),
		"other topic": VerifyAttestation(other, c0Txid, []uint32{0, 2}, c0Low, c0Signer),
		"uppercase":   VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, strings.ToUpper(c0Low), c0Signer),
		"trailing":    VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low+"00", c0Signer),
		"keyID 2":     VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, signWith(t, c0Priv(t), "2", msgC0), c0Signer),
		"newline":     VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, signWith(t, c0Priv(t), "1", msgC0+"\n"), c0Signer),
		"bare key":    VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, bareSign(t, c0Priv(t), msgC0), c0Signer),
	} { if ok { t.Fatalf("%s verified", name) } }
	der, _ := hex.DecodeString(c0Low); sig, _ := ec.ParseDERSignature(der)
	if d := sha256.Sum256([]byte(msgC0)); sig.Verify(d[:], c0Priv(t).PubKey()) { t.Fatal("C.0 signature verifies against the bare key") }
	if _, _, err := (&ECAdmissionSigner{priv: c0Priv(t)}).SignAdmission(KYCTopic, c0Txid, []uint32{0}); !errors.Is(err, ErrUnsignedTopic) { t.Fatal(err) }
}
```
Imports added to `admissions_test.go`: `crypto/hmac`, `crypto/sha256`, `encoding/hex`. go-sdk v1.7.1 provides `PrivateKey.DeriveSharedSecret`, `PublicKey.IsEqual`, `PublicKey.Compressed` and `wallet.AnyoneKey` (checked in the module cache). If the tweak assertion passes and the child assertion fails, the fault is in point addition. If the tweak assertion fails, the fault is in the invoice string or the HMAC key.
`signWith` signs through `ProtoWallet.CreateSignature` with the given keyID and data. `bareSign` signs `sha256(msg)` with the root key. `msgC0` is the exact C.0 message.

`internal/httpapi/e2e_test.go` (Mongo; Review Focus 2):
```go
func TestE2EReplayReturnsIdenticalAttestation(t *testing.T) {
	// boot; deploy (both topics); issue; submit the issue twice with the same body
	// both 200; tm_color_<id> entries: same outputsToAdmit, admissionSignature byte-identical,
	// admissionIdentityKey == mandalatest.Overlay.Identity; VerifyAttestation(topic, txid, outs, sig, Overlay.Identity) true;
	// GET /admin/admission/<txid> -> admissions[tm_color_<id>].admissionSignature identical;
	// deploy's tm_mandala entry verifies with VerifyAdmission (v3), its tm_color entry with VerifyAttestation.
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/mandala/ ./internal/httpapi/ -run 'TestAttestation|TestE2EReplayReturnsIdenticalAttestation' -count=1 -v`
Expected: FAIL (undefined identifiers; then the attestation assertions).

- [ ] **Step 3: Implement the message, the child key, the verifier and the signer dispatch; update `e2eSigma` to verify by scheme**

Encode the signature with `Signature.Serialize()` (canonical strict DER). The exact-hex assertion against `c0Low` is the arbiter. Verification never normalizes the input bytes: it parses them strictly and verifies (r, s) as given.

- [ ] **Step 4: Run everything (Mongo up)**

Run: `go test -count=1 ./... -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^(ok|FAIL)'`
Expected: 0 FAIL, 0 SKIP.

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "feat(overlay-go): BRC-207 attested admission signature on tm_color_* (C.0 vectors); tm_mandala keeps v3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Mandala deploy `req` policy (F-REQ), `ext`/`icon` rules, non-deploy `req`/`ext` refusal

Contract §4 (deploy policy steps 1-5, F-REQ) and design §4.2.

**Files:**
- Create: `internal/colorprofile/colorprofile.go`, `colorprofile_test.go`, `internal/mandala/testdata/1color-deploy.json`
- Modify: `internal/mandala/details.go`, `authority.go` (`authRequireDeploys` takes `AuthorityDeps`), `token_topic.go`, `token_registry_topic.go` (deps with the key), `ownership.go` (`RequireValidTokenOutputs` last rule), `reject.go`, `internal/wiring/engine.go` (`OverlayIdentityKey: overlayPriv.PubKey().ToDERHex()`)
- Modify: `internal/mandalatest/flows.go` (`DeployPayload` writes `req`), `internal/mandala/vectors_test.go` (deps key from `verifierPrivateKey`; overrides), and every test helper that builds `TokenTopicDeps` (`internal/mandala/fakes_test.go` and the flow helpers in `engine_*_test.go`, `token_topic_test.go`) to set `OverlayIdentityKey: mt.Overlay.Identity`
- Test: `internal/mandala/details_test.go`, `token_topic_test.go`, `internal/httpapi/e2e_test.go`

**Interfaces:**
- Produces (`package colorprofile`, imports only `brc162`):
  ```go
  const AttestedProfileID = "https://brc.dev/207/attested"
  const MandalaProfileID  = "https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md"
  // {AttestedProfileID: {"params": {"identityKey": K, "trustMode": "identity"}, "version": uint64(1)},
  //  MandalaProfileID:  {"params": {"identityKey": K}, "version": uint64(1)}}
  func MandalaReq(identityKey string) brc162.CborMap
  func MandalaReqBytes(identityKey string) ([]byte, error) // brc162.EncodeStrictCborValue(MandalaReq(K))
  ```
- Produces (`mandala`):
  ```go
  type DeployIcon struct{ MediaType string; Bytes []byte }
  type DeployMetadata struct { Sym string; Dec int64; Label string; FeeRatePerKb *int64; Icon *DeployIcon; ReqBytes []byte /* nil = absent */ }
  // ParseDeployMetadata order (unchanged first, new checks after fee rate so existing reasons do not churn):
  //   missing payload, non-canonical push, size > 65536, strict decode (depth 64), sym, dec, label, fee rate,
  //   icon present and not exactly []any{string, []byte} -> "icon must be [mediaType, bytes]",
  //   ext present -> "ext is not allowed on a Mandala deploy",
  //   req present and not a CborMap -> "req must be a map"; else ReqBytes = EncodeStrictCborValue(m["req"]).
  func ParseDeployMetadata(payload []byte, hasPayload, canonical bool) (DeployMetadata, error)
  // RequireMandalaReq: ReqBytes nil -> rDeployPayload("missing key req");
  //   !bytes.Equal(ReqBytes, MandalaReqBytes(K)) -> rDeployPayload("req does not match this overlay's Mandala profiles").
  func RequireMandalaReq(md DeployMetadata, overlayIdentityKey string) error
  type AuthorityDeps struct { Trusted map[string]bool; Store StateStore; Registry bool; OverlayIdentityKey string }
  type TokenTopicDeps struct { /* existing */ ; OverlayIdentityKey string } // compressed lowercase; NewTokenTopicManager and
  //   NewTokenRegistryTopicManager refuse anything else: "TokenTopicManager: OverlayIdentityKey must be a compressed lowercase identity key"
  func rProfileKeysOnNonDeploy(i uint32) *RejectError // CodeShape, "output %d: req and ext are deploy-only under Mandala policy"
  ```
  `authRequireDeploys` calls `RequireMandalaReq` right after `ParseDeployMetadata` when `!d.Registry`. KYC deploys are not color assets, so `req` is neither required nor checked there, but the shared `ext`/`icon` rules apply. `RequireValidTokenOutputs` gains a final rule: for a non-deploy output with a payload that `decodeMandalaCbor(payload, MaxDeployPayloadBytes)` accepts and that contains `req` or `ext`, it returns `rProfileKeysOnNonDeploy`. An authority `{adm}` payload passes.
- Produces (`mandalatest`): `DeployPayload(sym string, dec uint64, label string) []byte` now includes `"req": colorprofile.MandalaReq(Overlay.Identity)`. Added `DeployPayloadWith(m brc162.CborMap) []byte` and `DeployWithPayload(t testing.TB, issuer Party, payload []byte) *Built` for the negatives.
- Fixture `internal/mandala/testdata/1color-deploy.json`. Contract §4 fixes its schema at 7 members, `{identityKey, sym, dec, label, reqHex, payloadHex, lockingScriptHex}`. P-LIB owns the file (contract §10).
  - If `lib/src/__fixtures__/1color-deploy.json` exists in the worktree, copy it byte for byte: `cp ../lib/src/__fixtures__/1color-deploy.json internal/mandala/testdata/1color-deploy.json`. Do not reformat it.
  - Otherwise, write the same 7-member schema, in the contract's member order, as 2-space-indented JSON with a trailing newline:
  ```json
  {
    "identityKey": "02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046",
    "sym": "TUSD",
    "dec": 2,
    "label": "Test Dollar",
    "reqHex": "<contract §4 req value, 328 bytes>",
    "payloadHex": "a4636465630263726571<reqHex>6373796d6454555344656c6162656c6b5465737420446f6c6c6172",
    "lockingScriptHex": "00006d4d6d01<payloadHex>7576a914a1d8edf2f9ebd6d2fe4728e0eb3bd369ab78d76a88ac"
  }
  ```
    Copy the hex verbatim from contract §4 (F-REQ block). Do not regenerate it. If P-LIB later lands its file, `TestFREQFixtureMatchesLib` reports the mismatch, and the fix is to re-copy P-LIB's file (Decisions §1).

- [ ] **Step 1: Write the failing tests**

```go
const goFREQ, libFREQ = "../mandala/testdata/1color-deploy.json", "../../../lib/src/__fixtures__/1color-deploy.json"

type freq struct {
	IdentityKey      string `json:"identityKey"`
	Sym              string `json:"sym"`
	Dec              uint64 `json:"dec"`
	Label            string `json:"label"`
	ReqHex           string `json:"reqHex"`
	PayloadHex       string `json:"payloadHex"`
	LockingScriptHex string `json:"lockingScriptHex"`
}

func TestMandalaReqMatchesFREQ(t *testing.T) { // colorprofile_test.go
	raw, err := os.ReadFile(goFREQ)
	if err != nil { t.Fatal(err) }
	var members map[string]json.RawMessage
	if err := json.Unmarshal(raw, &members); err != nil || len(members) != 7 { t.Fatalf("F-REQ must have exactly the 7 contract §4 members: %d %v", len(members), err) }
	var f freq
	dec := json.NewDecoder(bytes.NewReader(raw)); dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil { t.Fatal(err) }
	if f.IdentityKey != "02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046" || f.Sym != "TUSD" || f.Dec != 2 || f.Label != "Test Dollar" { t.Fatal(f) }
	req, err := MandalaReqBytes(f.IdentityKey)
	if err != nil || hex.EncodeToString(req) != f.ReqHex || len(req) != 328 { t.Fatal(len(req), err) }
	payload, _ := brc162.EncodeStrictCbor(brc162.CborMap{"dec": f.Dec, "req": MandalaReq(f.IdentityKey), "sym": f.Sym, "label": f.Label})
	if hex.EncodeToString(payload) != f.PayloadHex || len(payload) != 365 { t.Fatal(len(payload)) }
	k, _ := hex.DecodeString(f.IdentityKey)
	script, _ := brc162.Lock(brc162.LockParams{Amount: 0, PubKeyHash: hash.Hash160(k), Payload: payload, HasPayload: true})
	if hex.EncodeToString(script) != f.LockingScriptHex { t.Fatal("locking script") }
}

// TestFREQFixtureMatchesLib: contract §4 says P-GO copies P-LIB's file byte for byte. When both files are
// present their sha256 must be equal. When P-LIB's file is absent (P-LIB has not landed in this worktree)
// the test logs and passes. It does not call t.Skip, so the "0 SKIP" gate still holds.
func TestFREQFixtureMatchesLib(t *testing.T) {
	lib, err := os.ReadFile(libFREQ)
	if errors.Is(err, fs.ErrNotExist) { t.Logf("%s absent; byte-equality with P-LIB not checked yet", libFREQ); return }
	if err != nil { t.Fatal(err) }
	gof, err := os.ReadFile(goFREQ)
	if err != nil { t.Fatal(err) }
	if a, b := sha256.Sum256(lib), sha256.Sum256(gof); a != b {
		t.Fatalf("F-REQ drift: sha256 lib %x != go %x; re-copy with `cp ../lib/src/__fixtures__/1color-deploy.json internal/mandala/testdata/`", a, b)
	}
}
```
Imports added to `colorprofile_test.go`: `bytes`, `crypto/sha256`, `encoding/json`, `errors`, `io/fs`, `os`. The relative paths resolve from `overlay-go/internal/colorprofile`, the package directory in which `go test` runs.
`token_topic_test.go` (memStore + kit; the reason prefix is `output 0: deploy payload is not a valid Mandala deploy map (` … `)`):
```go
func TestDeployReqPolicy(t *testing.T) { // Review Focus 4
	K := mt.Overlay.Identity
	good := colorprofile.MandalaReq(K)
	extra := colorprofile.MandalaReq(K); extra["https://example.com/p"] = brc162.CborMap{"version": uint64(1), "params": nil}
	anyMode := colorprofile.MandalaReq(K); anyMode[colorprofile.AttestedProfileID].(brc162.CborMap)["params"].(brc162.CborMap)["trustMode"] = "any"
	base := func(extraKV brc162.CborMap) brc162.CborMap { m := brc162.CborMap{"sym": "TUSD", "dec": uint64(2), "label": "Test Dollar"}; for k, v := range extraKV { m[k] = v }; return m }
	cases := []struct{ name string; m brc162.CborMap; reason string }{
		{"no req", base(nil), "missing key req"},
		{"other key", base(brc162.CborMap{"req": colorprofile.MandalaReq(mt.Rogue.Identity)}), "req does not match this overlay's Mandala profiles"},
		{"extra profile", base(brc162.CborMap{"req": extra}), "req does not match this overlay's Mandala profiles"},
		{"trustMode any", base(brc162.CborMap{"req": anyMode}), "req does not match this overlay's Mandala profiles"},
		{"req text", base(brc162.CborMap{"req": "x"}), "req must be a map"},
		{"ext", base(brc162.CborMap{"req": good, "ext": brc162.CborMap{}}), "ext is not allowed on a Mandala deploy"},
		{"bad icon", base(brc162.CborMap{"req": good, "icon": []any{"image/png"}}), "icon must be [mediaType, bytes]"},
	}
	for _, c := range cases {
		_, err := identifyDeploy(t, mt.DeployWithPayload(t, mt.Issuer, mt.DeployPayloadWith(c.m)))
		requireReject(t, err, "ERR_SHAPE", "output 0: deploy payload is not a valid Mandala deploy map ("+c.reason+")")
	}
	for _, ok := range []brc162.CborMap{base(brc162.CborMap{"req": good}), base(brc162.CborMap{"req": good, "icon": []any{"image/png", []byte{0x89, 0x50}}})} {
		adm, err := identifyDeploy(t, mt.DeployWithPayload(t, mt.Issuer, mt.DeployPayloadWith(ok)))
		if err != nil || !slices.Equal(adm.OutputsToAdmit, []uint32{0}) { t.Fatal(adm, err) }
	}
	unsorted := append([]byte{}, mt.DeployPayloadWith(base(brc162.CborMap{"req": good}))...) // swap two top-level keys by hand
	_, err := identifyDeploy(t, mt.DeployWithPayload(t, mt.Issuer, swapFirstTwoKeys(t, unsorted)))
	requireReject(t, err, "ERR_SHAPE", "output 0: deploy payload is not a valid Mandala deploy map (map keys unsorted or duplicated)")
}

func TestNonDeployOutputWithReqRefused(t *testing.T) {
	// issue whose value output 1 carries payload {"req":{}} -> ERR_SHAPE "output 1: req and ext are deploy-only under Mandala policy"
}

func TestNewTokenTopicManagerNeedsOverlayKey(t *testing.T) {
	_, err := NewTokenTopicManager(strings.Repeat("ab", 32)+"_0", TokenTopicDeps{ /* valid deps */ OverlayIdentityKey: ""})
	if err == nil || err.Error() != "TokenTopicManager: OverlayIdentityKey must be a compressed lowercase identity key" { t.Fatal(err) }
}
```
`identifyDeploy` runs the token registry manager's dry run plus the deploy's own token topic, as the HTTP deploy path does. `swapFirstTwoKeys` re-serializes the map with its first two entries swapped (a small hand-built byte splice for the test).

`internal/httpapi/e2e_test.go` (Mongo):
```go
func TestE2EDeployWrongReqIsFinalAndPersisted(t *testing.T) { // Review Focus 4
	// deploy with req for mandalatest.Rogue -> 400 {"code":"ERR_SHAPE","retryable":false,"description":"output 0: deploy payload is not a valid Mandala deploy map (req does not match this overlay's Mandala profiles)"}
	// resubmit identical body -> identical 400 served from the persisted refusal (assert no engine applied record and no registry row)
	// GET /admin/admission/<txid>?payloadHash=<sha256 hex of offChainValues> -> same 400 body
	// the same deploy with req for Overlay is a different tx (txid differs) and is admitted on both topics
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/colorprofile/ ./internal/mandala/ ./internal/httpapi/ -run 'TestMandalaReqMatchesFREQ|TestFREQFixtureMatchesLib|TestDeployReqPolicy|TestNonDeployOutputWithReqRefused|TestNewTokenTopicManagerNeedsOverlayKey|TestE2EDeployWrongReqIsFinalAndPersisted' -count=1 -v`
Expected: FAIL.

- [ ] **Step 3: Implement `colorprofile`, the fixture (copied from P-LIB if present, as above), the metadata rules, `RequireMandalaReq`, the deps key and its wiring, the non-deploy rule, and the kit changes**

In the vector replay, set `TokenTopicDeps.OverlayIdentityKey` to the public key of `verifierPrivateKey`. TS deploys carry no `req`, so each deploy case gets an override with `Why: "Mandala deploys must declare req = attested(identity K) + issuer-v1(K) (contract §4, design C3)"`.

- [ ] **Step 4: Run everything (Mongo up)**

Run: `go test -count=1 ./... -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^(ok|FAIL)'`
Expected: 0 FAIL, 0 SKIP. KYC suites pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "feat(overlay-go): require the Mandala req (attested identity + issuer-v1, this overlay's key) on deploys; ext/icon/non-deploy rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `p color` linkage and outputs-only holder envelopes

The overlay's envelope semantics are unchanged (contract §5.1, D3). This task proves the 1Color shapes are admitted: holder outputs derived under `[2,"p color <assetTag> <hex(prefix)> <hex(suffix)>"]` with keyID `color`, and the holder envelope carried as `{"outputs":[…]}` only, through `/submit` with `x-includes-off-chain-values`. Issuer and admin outputs keep Mandala derivations (design B4).

**Files:**
- Modify: `internal/mandalatest/build.go`, `parties.go`, `flows.go`
- Test: `internal/mandala/engine_flow_test.go` (uses the existing `newEngineFlow(t, db)`, `f.hostWithLookup(tokenID) string` (registers lookup then topic; call once per token), `f.mustSubmit(b, topics...) overlay.Steak`, `f.store`, `f.ctx`), `internal/httpapi/e2e_test.go`
- Modify only if a test proves it necessary: `internal/mandala/linkage.go` (it must not pin a protocol name)

**Interfaces:**
- Produces (`mandalatest`):
  ```go
  type ColorRemittance struct{ Prefix, Suffix string } // UTF-8 remittance strings (base64 of 16 bytes in production; <= 48 bytes each)
  type Out struct { /* existing */ ; Color *ColorRemittance } // set: lock derives under ColorProtocol(TokenID, r), keyID "color"; linkage revealed with that tuple
  func AssetTag(tokenID string) string                         // "<64hex>v<vout>"
  func ColorProtocol(tokenID string, r ColorRemittance) wallet.Protocol // {SecurityLevel 2, "p color " + AssetTag + " " + hex(prefix) + " " + hex(suffix)}
  type BuildOptions struct{ OutputsOnlyEnvelope bool }          // env = {"outputs":[…]} sorted by index; no inputs/admin keys
  func BuildWith(t testing.TB, ins []In, outs []Out, deploySigBy *Party, o BuildOptions) *Built
  // Build(t, ins, outs, by) == BuildWith(t, ins, outs, by, BuildOptions{})
  // In.Src.Outs[Vout].Color != nil -> the spend key derives with the same tuple (owner side, counterparty = prover)
  // IssueTo: like Issue (spends auth:authVout, output 0 = new authority committing {kind:"issue"}), but output 1 pays `amount`
  // to `to` under ColorProtocol(tokenID, *r), keyID "color", prover = issuer.
  func IssueTo(t testing.TB, auth *Built, authVout uint32, issuer, to Party, amount uint64, r *ColorRemittance) *Built
  ```

- [ ] **Step 1: Write the failing tests**

```go
func TestHolderColorTransferOutputsOnlyEnvelope(t *testing.T) { // engine_flow_test.go, Mongo-backed engineFlow
	f := newEngineFlow(t, "mandala3_test_flow_color")
	d := mt.Deploy(t, mt.Issuer, "TUSD"); id := mt.TokenIDOf(d, 0)
	topic := f.hostWithLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)
	r1 := &mt.ColorRemittance{Prefix: "AAAAAAAAAAAAAAAAAAAAAA==", Suffix: "BBBBBBBBBBBBBBBBBBBBBB=="}
	is := mt.IssueTo(t, d, 0, mt.Issuer, mt.Holder, 1000, r1) // B4: issuer-proved p color output to Holder
	f.mustSubmit(is, topic)
	r2 := &mt.ColorRemittance{Prefix: strings.Repeat("p", 48), Suffix: strings.Repeat("s", 48)} // max lengths (contract §0)
	r3 := &mt.ColorRemittance{Prefix: "CCCCCCCCCCCCCCCCCCCCCC==", Suffix: "DDDDDDDDDDDDDDDDDDDDDD=="}
	tr := mt.BuildWith(t, []mt.In{{Src: is, Vout: 1}}, []mt.Out{
		{Owner: mt.Receiver, Prover: mt.Holder, TokenID: id, Amount: 600, Color: r2},
		{Owner: mt.Holder, Prover: mt.Holder, TokenID: id, Amount: 400, Color: r3},
	}, nil, mt.BuildOptions{OutputsOnlyEnvelope: true})
	if string(tr.OffChain[:12]) != `{"outputs":[` || bytes.Contains(tr.OffChain, []byte(`"inputs"`)) { t.Fatal(string(tr.OffChain)) }
	steak := f.mustSubmit(tr, topic) // f.submit frames tr.OffChain exactly as /submit does
	if !slices.Equal(steak[topic].OutputsToAdmit, []uint32{0, 1}) { t.Fatal(steak) }
	// owner rows: output 0 -> Receiver, output 1 -> Holder
}

func TestHolderColorTransferMissingOutputLinkage(t *testing.T) {
	// as above but Out[1].NoLinkage = true -> ERR_LINKAGE "output 1: token output with no verified linkage"
}
```
`internal/httpapi/e2e_test.go` (Mongo):
```go
func TestE2EColorHolderFlow(t *testing.T) {
	// boot; deploy [tm_mandala, tm_color_<txid>_0] (tm_mandala entry: VerifyAdmission v3; tm_color entry: VerifyAttestation);
	// issue to Holder with Color; holder transfer as above via /submit with X-Topics ["tm_color_<id>"] and the framed body
	// -> 200; tm_color entry outputsToAdmit [0,1], VerifyAttestation(..., Overlay.Identity) true;
	// e2eBalance(Receiver) == "600", e2eBalance(Holder) == "400"
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/mandala/ ./internal/httpapi/ -run 'TestHolderColorTransfer|TestE2EColorHolderFlow' -count=1 -v`
Expected: FAIL (`ColorRemittance` / `BuildWith` undefined).

- [ ] **Step 3: Implement the kit additions**

If a test shows `linkage.go` refusing the long protocol name, fix only that check, and quote the failure in the commit body. go-sdk allows names up to 400 chars, and `specific linkage revelation …` up to 430. The maximum here is about 298.

- [ ] **Step 4: Run everything (Mongo up)**

Run: `go test -count=1 ./... -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^(ok|FAIL)'`
Expected: 0 FAIL, 0 SKIP.

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "test(overlay-go): p color linkage and outputs-only holder envelopes admitted end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `color-spendability` / `color-admission` on `ls_color_<assetId>`, and `txid` on `/lookup` items

Contract §6 and 0207:741-775. These query shapes exist for interface compatibility only, not as a conforming service. Answers stay **formulas**. The engine hydrates them with `FindOutput(outpoint, nil topic, nil spent, true)`, and `GetUTXOHistory(nil selector)` returns the output as-is, so spent outputs that Mandala retains (`coinsToRetain`) hydrate. The Mongo test below proves it.

**Files:**
- Create: `internal/mandala/color_lookup.go`, `color_lookup_test.go`
- Modify: `internal/mandala/token_lookup.go` (constructor + discriminator), `interfaces.go`, `internal/wiring/engine.go` (`tokenTopicFactory` passes `es` and `store`), `internal/httpapi/lookup.go`, `lookup_test.go`, `internal/httpapi/e2e_test.go`; every caller of `NewTokenLookupService` in tests (`engine_flow_test.go` `hostWithLookup` passes `f.es`, `token_lookup_test.go`)

**Interfaces:**
- Consumes: `EngineOutputReader.AdmittedOutputState`, `(*Store).GetAdmission`, `(*Store).GetAssetState`.
- Produces (`mandala`):
  ```go
  type AdmissionReader interface { GetAdmission(ctx context.Context, txid string) (*AdmissionRecord, error) } // *Store
  func NewTokenLookupService(tokenID string, v LinkageVerifier, store *Store, eng EngineOutputReader) (*TokenLookupService, error)
  var ErrLookupUnavailable = errors.New("lookup unavailable") // wrapped around every store/engine read fault of a lookup
  type ColorQuery struct { Type string /* "color-spendability" | "color-admission" */; Outpoints []Outpoint }
  // ParseColorQuery validates, in this order, with these exact errors (prefix "Invalid lookup query: "):
  //   unexpected field <k> | missing field <k> (members exactly type, version, assetId, topic, outpoints)
  //   type must be color-spendability or color-admission
  //   version must be 1                         (JSON number 1 exactly)
  //   assetId must be <id>, the asset ls_color_<id> serves
  //   topic must be tm_color_<id>
  //   outpoints must be an array of 1-1000 outpoints
  //   outpoints[<i>] must be <64 lowercase hex txid>.<vout 0..4294967295>   (^[0-9a-f]{64}\.(0|[1-9][0-9]{0,9})$, <= 2^32-1)
  //   outpoints[<i>] duplicates an earlier outpoint
  func ParseColorQuery(q *lookup.LookupQuestion, service, assetID string) (ColorQuery, error)
  ```
  The discriminator: `Lookup` reads the top-level keys. If `type` is present it takes the color branch only. Mixing in a legacy key fails as `unexpected field <k>`. Without `type`, the legacy keys behave exactly as today (D15).
  Answer rule, formulas in query order:
  - admitted(op) = `AdmittedOutputState(op, topic)` found **and** `GetAdmission(op.Txid)` is non-nil with `EvictedAt == ""`. A provisional (`Pending`) record still counts, because the engine already committed.
  - `color-admission`: every admitted op, spent or not.
  - `color-spendability`: admitted **and** not spent **and** not in the asset state's `evictedOutpoints` (reissued) **and** not in `frozenOutpoints` (frozen coins are excluded; Decisions §3). The asset state is read once per query.
  Any read fault returns `fmt.Errorf("%w: …", ErrLookupUnavailable)`.
- Produces (`httpapi`):
  ```go
  type wireOutput struct { Beef mandala.NumBytes `json:"beef"`; OutputIndex uint32 `json:"outputIndex"`; Txid string `json:"txid"` }
  // txid = display hex of the AtomicBEEF subject (bytes 0..3 == 01 01 01 01, subject = reverse(bytes 4..36)); an item whose
  // BEEF is not AtomicBEEF -> 500 {"status":"error","message":"lookup answer: output is not AtomicBEEF"} (fail closed).
  // An error wrapping mandala.ErrLookupUnavailable -> 503 {"status":"error","code":"ERR_UNAVAILABLE","retryable":true,…}; every other error keeps 400.
  ```

- [ ] **Step 1: Write the failing tests**

`color_lookup_test.go` (fakes: memStore + fake engine reader + fake admissions):
```go
func TestColorQueryValidation(t *testing.T) { // Review Focus 3 (validation half)
	id := strings.Repeat("ab", 32) + "_0"; svc := "ls_color_" + id; topic := "tm_color_" + id
	op := strings.Repeat("cd", 32) + ".1"
	q := func(body string) error { _, err := ParseColorQuery(&lookup.LookupQuestion{Service: svc, Query: json.RawMessage(body)}, svc, id); return err }
	ok := `{"type":"color-admission","version":1,"assetId":"` + id + `","topic":"` + topic + `","outpoints":["` + op + `"]}`
	if err := q(ok); err != nil { t.Fatal(err) }
	for body, msg := range map[string]string{
		strings.Replace(ok, `"version":1,`, `"version":1,"tokenId":"`+id+`",`, 1): "unexpected field tokenId",
		strings.Replace(ok, `"version":1,`, ``, 1):                              "missing field version",
		strings.Replace(ok, `color-admission`, `color-balance`, 1):              "type must be color-spendability or color-admission",
		strings.Replace(ok, `"version":1`, `"version":2`, 1):                    "version must be 1",
		strings.Replace(ok, `"topic":"`+topic, `"topic":"tm_`+id[:64], 1):       "topic must be " + topic,
		strings.Replace(ok, op, strings.ToUpper(op[:64])+".1", 1):              "outpoints[0] must be <64 lowercase hex txid>.<vout 0..4294967295>",
		strings.Replace(ok, op, op[:64]+".01", 1):                              "outpoints[0] must be <64 lowercase hex txid>.<vout 0..4294967295>",
		strings.Replace(ok, `["`+op+`"]`, `["`+op+`","`+op+`"]`, 1):            "outpoints[1] duplicates an earlier outpoint",
		strings.Replace(ok, `["`+op+`"]`, `[]`, 1):                             "outpoints must be an array of 1-1000 outpoints",
	} { if err := q(body); err == nil || err.Error() != "Invalid lookup query: "+msg { t.Fatalf("%s: %v", msg, err) } }
}

func TestColorAnswersFollowAdmissionSpendFreezeEviction(t *testing.T) {
	// fake engine: A unspent, B spent, C unspent+frozen, D unspent+reissued(evictedOutpoints), E unspent but record evicted, F absent
	// admission    [A..F] -> formulas A,B,C,D (query order)
	// spendability [A..F] -> formula A only
	// engine reader fault -> errors.Is(err, ErrLookupUnavailable)
}
```
`internal/httpapi/e2e_test.go` (Mongo; Review Focus 3):
```go
func TestE2EColorLookupsSpentAndUnspent(t *testing.T) {
	// boot; deploy d; issue is (spends d.0, outputs 0 authority, 1 value to Holder)
	// POST /lookup ls_color_<id> color-admission [d.0, is.0, is.1] -> 3 outputs in that order; each item's txid matches,
	//   transaction.ParseBeef(item.beef) yields that txid, and its output[outputIndex] script equals the built script
	// color-spendability [d.0, is.0, is.1] -> [is.0, is.1] (d.0 spent)
	// holder transfer spends is.1 -> spendability [is.1] -> []; admission [is.1] -> [is.1]
	// legacy {"tokenId":"<id>"} still answers and every item carries txid
	// POST /lookup service "ls_color_<id>_1" -> 400
}
func TestLookupStoreFaultIs503(t *testing.T) { /* stub Lookuper returning fmt.Errorf("%w: x", mandala.ErrLookupUnavailable) -> 503 ERR_UNAVAILABLE retryable true */ }
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/mandala/ ./internal/httpapi/ -run 'TestColorQueryValidation|TestColorAnswers|TestE2EColorLookupsSpentAndUnspent|TestLookupStoreFaultIs503' -count=1 -v`
Expected: FAIL.

- [ ] **Step 3: Implement the parser, the answers, the constructor change and its wiring, `wireOutput.Txid` and the 503 mapping**

Retention evidence for the formula path: go-overlay-services v1.3.7 `separateRetainedCoins` deletes retained vins from the deletion set, Mandala retains every token input (`retainedInputIndices`), `hydrateOneFormula` calls `FindOutput(op, nil, nil, true)`, and `GetUTXOHistory` with a nil selector returns the output unchanged. **Fallback:** if `TestE2EColorLookupsSpentAndUnspent` shows a spent output is not hydrated, answer `color-admission` as an `output-list` built from `enginestore.OutputBeefBytes(topic, txid, vout)` converted to AtomicBEEF of that txid. Record the switch in the commit body. Do not weaken the test.

Batch reads: deduplicate txids before `GetAdmission`. Read the asset state once. Never return more outputs than were queried.

- [ ] **Step 4: Run everything (Mongo up)**

Run: `go test -count=1 ./... -v 2>&1 | grep -E -- '--- (FAIL|SKIP)|^(ok|FAIL)'`
Expected: 0 FAIL, 0 SKIP.

- [ ] **Step 5: Commit**

```bash
git add internal
git commit -m "feat(overlay-go): color-spendability / color-admission on ls_color_<assetId>; txid on lookup items; 503 on lookup store faults

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docs, environment guidance, final gate

**Files:**
- Modify: `README.md` (status line; topics table `tm_color_<assetId>` / `ls_color_<assetId>`; the deploy pairing; σI paragraph → "`tm_color_*` entries carry the BRC-207 attested signature (child key `[2,"color admission attestation"]`, keyID `1`), `tm_mandala` keeps σI v3, KYC unsigned"; `/lookup` row → legacy keys, `color-spendability` / `color-admission`, `txid` per item, 503 on store faults; a "Mandala policy" paragraph: 1-sat, I==O, 32-byte ids, deploy `req` = attested(identity K) + issuer-v1(K), `ext` refused, payload ≤ 65536 B / depth 64; "not a conforming 1Color `color` service, not advertised"; the amounts paragraph: uint64 per output, Decimal128 storage, decimal-string JSON; env row `NODE_NAME`)
- Modify: `.env.example` (`NODE_NAME=mandala_1color`; comment: never reuse `mandala`, `mandala162`, `mandala_q3`, and never drop an existing database; an old-format database fails closed on every amount read)
- Modify: `internal/mandala/docs.go` (all six doc strings name the new topics and the attested signature, without claiming 1Color conformance)
- Modify: `testdata/README.md` (mandala-rejects section: "replayed with a topic remap and a reviewed override table in `internal/mandala/vectors_test.go`; the file is unchanged")

**Interfaces:** none new.

- [ ] **Step 1: Write the failing doc test**

```go
func TestDocsNameColorTopicsWithoutConformanceClaim(t *testing.T) { // internal/mandala/docs_test.go
	for _, d := range []string{docTokenTopic, docTokenRegistryTopic, docTokenLookup, docTokenRegistryLookup, docKYCTopic, docKYCLookup} {
		if strings.Contains(d, "tm_<deploy txid>") || strings.Contains(d, "ls_<deploy txid>") { t.Fatal(d) }
		if strings.Contains(strings.ToLower(d), "conforming") { t.Fatal("conformance claim: " + d) }
	}
	if !strings.Contains(docTokenTopic, "tm_color_<assetId>") || !strings.Contains(docTokenLookup, "color-spendability") { t.Fatal("missing names") }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/mandala/ -run TestDocsNameColorTopicsWithoutConformanceClaim -count=1 -v`
Expected: FAIL.

- [ ] **Step 3: Update `docs.go`, `README.md`, `.env.example`, `testdata/README.md`**

- [ ] **Step 4: Final gate (Mongo up)**

Run, in order:
1. `gofmt -l . ; go vet ./...` → no output.
2. `go test -count=1 ./... -v > "$TMPDIR/overlay-go-final.txt" 2>&1; echo exit=$?; for k in PASS FAIL SKIP; do printf "%s " $k; grep -c -- "--- $k" "$TMPDIR/overlay-go-final.txt"; done` → `exit=0`, `FAIL 0`, `SKIP 0`, PASS ≥ the Task 0 baseline.
3. `grep -rn 'MaxSafeAmount\|exceeds 2^53\|IsSigmaTopic\|"tm_" *+\|"ls_" *+\|StrictCborMaxBytes' internal cmd | grep -v '_test.go'` → no output.
4. Optional local smoke boot. Use a **fresh** database name and never drop anything afterwards: `NODE_NAME=mandala_1color_smoke SERVER_PRIVATE_KEY=$(openssl rand -hex 32) HOSTING_URL=http://localhost:8091 MONGO_URL=mongodb://localhost:27017 NETWORK=test MANDALA_ISSUER_KEYS='["02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046"]' PORT=8091 go run ./cmd/overlay`, run in the background. Then `curl -fsS localhost:8091/health/ready` returns 200. Stop the process. Do not boot against `mandala`, `mandala162` or `mandala_q3`.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example internal/mandala/docs.go internal/mandala/docs_test.go testdata/README.md
git commit -m "docs(overlay-go): 1Color topics, attested admission, color lookups, fresh NODE_NAME guidance

Final gate: go test -count=1 ./... -v -> <P> PASS, 0 FAIL, 0 SKIP (baseline <P0>).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Decisions recorded for morning review

These are planner calls on points the contract leaves open. Each is also listed in the run's contractGaps.

1. F-REQ fixture: contract §4 (Revision 2) fixes the 7-member schema `{identityKey, sym, dec, label, reqHex, payloadHex, lockingScriptHex}`. Task 9 copies P-LIB's `lib/src/__fixtures__/1color-deploy.json` byte for byte when it exists. Otherwise it writes the same schema, 2-space indented with a trailing newline. `TestFREQFixtureMatchesLib` compares sha256 when both files are present. When P-LIB's file is absent, the test logs and passes rather than skipping, so the 0-SKIP gate still holds. Any later drift fails the test, and the fix is to re-copy P-LIB's file.
2. `lookup.OutputListItem` (go-sdk) has no `txid`. `/lookup` derives it from the AtomicBEEF header on every item, legacy queries included.
3. `color-spendability` excludes frozen and reissued (`evictedOutpoints`) outpoints. Paused assets are not filtered. The contract says literally "admitted and unspent".
4. `color-admission` = engine doc on the topic, spent or not, plus an admission record that is not evicted. A provisional (`Pending`) record counts.
5. The D13 storage bound (`10^34-1`) is checked at submit on supply and Δ only. A per-identity cross-token balance cannot be bounded at submit and is reported by `RebuildBalances.Unsafe`.
6. Codec depth is 1024 for TS parity (`STRICT_CBOR_MAX_DEPTH`). Depth 64 and the 65536-byte / 4096-byte limits are Mandala policy. The contract's "depth policy 64" is read as policy.
7. `IsTokenTopic` is kept beside `IsColorTopic` (same predicate). The internal `AdmissionSchemeOf` replaces every `IsSigmaTopic` call site.
8. New deploy checks (`icon`, `ext`, `req`) run after sym/dec/label/fee rate, so existing reasons do not change. The exact reason strings are pinned by this plan.
9. The non-deploy `req`/`ext` refusal lives in the shared `RequireValidTokenOutputs`, so it also applies on `tm_mandala_kyc`. KYC deploys do not require `req`.
10. `mandala-rejects.json` stays byte-pinned. The replay uses a topic remap and a reviewed override table.
11. Admin details keep a 4096-byte policy limit. `feeRatePerKb` keeps the JS safe-integer bound because it is not a token amount.
12. The Bsv21Binary `id-*` rows of `brc162.json` are remapped to OneColor messages, because the upstream vector file was not updated for 36-byte ids.
13. Lookup store faults answer 503 `ERR_UNAVAILABLE` (retryable) instead of 400. Classification is by type (review fix): only a `*mandala.LookupQueryError` (invalid or unsupported query, wrong service) or `engine.ErrUnknownTopic` answers 400; every other lookup error, including `ls_mandala` store faults and the engine's unwrapped hydration faults (`FindOutput`, `LoadAncillaryBeef`), answers 503.
14. The `color-*` query validation strings are pinned by this plan (Task 11).
15. A 36-byte id is refused as ERR_SHAPE `rLegacyTokenID` before token scoping.

## Self-review notes (planner)

- **Spec coverage (design §4.2 overlay-go):**
  - codec final BRC-162 → Tasks 2 and 3
  - 32-byte ids as policy → Task 3
  - strict DAG-CBOR able to read `req`, with a size limit as policy → Task 2
  - uint64 per output, big.Int sums, exact Mongo storage, JSON strings → Tasks 4-6
  - topic rename → Task 7
  - attested admission signature → Task 8
  - additive color lookups → Task 11
  - deploy `req` policy → Task 9
  - envelope via offChainValues per contract §5 → Task 10
  - TS `overlay/` untouched (out of scope)
  - S5 overlay side: managers refuse construction without the overlay key → Task 9
  - README and route docs → Task 12
  - gate `go test ./...` → every task, and Task 12
  - fresh NODE_NAME → Task 12 and Global Constraints
  - fuelkeeper and `feeRatePerKb` parsing kept (B6) → Task 6 keeps the fee-rate rule
- **Type consistency:** `amount.Amount` / `mandala.Amount` alias from Task 5 on. `AdjustBalance(ctx, string, Amount)` in `StateStore`, `RepairUndoStore` and memStore. `TokenIDToString([]byte) (string, error)` from Task 3. `AdmissionSchemeOf` from Task 7, used in Tasks 8 and 11. `OverlayIdentityKey` on both deps structs from Task 9. `NewTokenLookupService(…, eng)` from Task 11, wired in `wiring/engine.go`.
- **Contract Revision 2 seams (§3, §4):**
  - The Go C.0 suite (Task 8) asserts the signer, the HMAC tweak `6ef21748…ea93b` (0207:10230), the child, the digest, low-S (reproduced) and high-S (verify only), plus all six negatives.
  - The F-REQ fixture (Task 9) has the fixed 7-member schema, is copied from P-LIB when present, and is sha256-compared by `TestFREQFixtureMatchesLib`.
- **Order dependencies:** Task 1 before any override. Task 4 before 5 before 6. Task 7 before 8 and 11. Task 9's kit change (`DeployPayload` with `req`) lands in the same commit as the policy, so no intermediate tree has deploys that the policy refuses.
