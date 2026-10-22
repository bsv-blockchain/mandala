# Bsv21Token issue (draft)

> **DRAFT, not filed.** File with `gh issue create --repo bsv-blockchain/ts-stack` only at the draft-PR stage, after the user reviews it.
>
> Source: design `docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` §4.1 I1. Evidence: `packages/helpers/ts-templates/src/Bsv21Token.ts` at ts-stack `cbdccfe5b` (226 lines; unchanged on `feat/1color-profiles`), pinned BRC-161 (`docs/design/brc-0161-bsv21-json.pinned.md`, BRCs `5119a9b`) and pinned BRC-162 (`docs/design/brc-0162-1color.pinned.md`). Every example below was run against the built package on 2026-10-22, and the "Current" results are the observed output.

---

## Title

`@bsv/templates Bsv21Token: decode accepts BRC-161 outputs the spec calls invalid`

## Body

`Bsv21Token.decode` (`packages/helpers/ts-templates/src/Bsv21Token.ts:193-225`) is looser than BRC-161 (JSON / legacy BSV-21) in several places. An indexer or wallet that uses `decode` / `isBsv21` as its validity gate admits outputs that the spec calls invalid. In one case (5) it also reports a token that BRC-162 says is not a JSON token.

All examples use the same envelope and a P2PKH tail:

```
OP_0 OP_IF "ord" OP_1 "application/bsv-20" OP_0 <json> OP_ENDIF
OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
```

`T` below stands for 64 lowercase hex characters (`aaaa…aaaa`).

### 1. `amt`: no uint64 bound and no canonical form

- **Spec:** BRC-161:239: `amt` is a "Decimal string of uint64 (max 18446744073709551615)". BRC-161:86 says the same for `deploy+mint`.
- **Current:** `Bsv21Token.ts:206` checks only `/^\d+$/`. Values above 2^64-1 and leading zeros are accepted and returned unchanged.
- **Expected:** canonical decimal `0|[1-9][0-9]*` with value ≤ 18446744073709551615. Otherwise the output is not a valid BSV-21 output, so `decode` throws and `isBsv21` returns `false`.
- **Failing examples:**
  - `{"p":"bsv-20","op":"transfer","id":"T_0","amt":"18446744073709551616"}` (2^64). Current result: decodes, `amt: "18446744073709551616"`.
  - `{"p":"bsv-20","op":"transfer","id":"T_0","amt":"007"}`. Current result: decodes, `amt: "007"`. Two spellings of one amount can then compare unequal as strings.
- **Question for the spec authors:** BRC-161 does not say whether `amt: "0"` is valid on `transfer`, `mint` or `burn`. Today `{"p":"bsv-20","op":"transfer","id":"T_0","amt":"0"}` decodes. BRC-162 says a value output has amount `> 0` (BRC-162:91). Should BRC-161 value ops also require `> 0`? The template should follow whatever the spec answers.

### 2. `dec`: JSON numbers accepted, numbers not range-checked

- **Spec:** BRC-161:87, :112 and :241: `dec` is a **string** integer 0–18, and "Numeric JSON numbers are **not** valid". BRC-161:135: missing or malformed display fields do **not** invalidate the deploy or the token id.
- **Current:** `parseDecimals` (`Bsv21Token.ts:89-97`). Line 91 returns any finite JSON number as is. Only the string branch (:92-95) checks 0..18.
- **Expected:** only a JSON string that is an integer 0..18 yields `dec`. Any other value (a number, out of range, not a string) is reported as absent, so the caller uses the default 0. Because of BRC-161:135, a bad `dec` must **not** make `decode` throw. The token stays valid and only the display field is dropped.
- **Failing examples** (each a `deploy+mint` with `"amt":"100"`):
  - `"dec": 2` gives `dec: 2` (should be absent).
  - `"dec": 99` gives `dec: 99`. Out of range, and passed to display code as 99 decimal places.
  - `"dec": 2.5` gives `dec: 2.5`, and `"dec": -1` gives `dec: -1`.
  - For contrast, `"dec": "19"` already gives `dec` absent (correct).
- **Question for the spec authors:** is `"02"` canonical? Today it decodes as `dec: 2`. BRC-161 says only "string integer 0–18".
- **Related display-field note (not a validity issue):** BRC-161:156-166 says `icon` MUST be an outpoint (`<txid>_<vout>` or the relative `_N`) and is "not an HTTP(S) URL". `decode` (`Bsv21Token.ts:218`) returns any string. For example, `"icon":"https://x/y.png"` is returned as `icon: "https://x/y.png"`, and the `Bsv21TokenDecoded.icon` doc comment (:40) says "Icon outpoint / URL". The same rule as `dec` would apply: report a malformed `icon` as absent, never throw.

### 3. `id` on non-deploy ops: neither required nor validated

- **Spec:** BRC-161:240: `id` is required for `mint`, `auth`, `transfer` and `burn` (also the op tables at :190, :203, :221, :232). BRC-161:52: its form is `<txid>_<vout>`, 64 **lowercase** hex characters, underscore, non-negative decimal `vout`.
- **Current:** `Bsv21Token.ts:210`. For a non-deploy op, a missing or non-string `id` becomes `id: ''`, and any string is returned unchanged.
- **Expected:** on a non-deploy op `id` is required and must match `^[0-9a-f]{64}_(0|[1-9][0-9]*)$` (vout ≤ 2^32-1). Otherwise `decode` throws. `id: ''` stays reserved for the two deploy ops.
- **Failing examples:**
  - `{"p":"bsv-20","op":"transfer","amt":"5"}` gives `id: ""`, `op: "transfer"`.
  - `{"p":"bsv-20","op":"mint","amt":"5"}` and `{"p":"bsv-20","op":"auth"}` give `id: ""`.
  - `{"p":"bsv-20","op":"transfer","id":"hello","amt":"5"}` gives `id: "hello"`.
  - `{"p":"bsv-20","op":"transfer","id":"AAAA…AAAA_0","amt":"5"}` (uppercase hex) gives the uppercase id. It then fails to match the same token's lowercase id.

### 4. Unknown or missing `op` accepted as a value op

- **Spec:** BRC-161 defines exactly six operations: `deploy+mint` (:85), `deploy+auth` (:111), `mint` (:189), `auth` (:202), `transfer` (:220) and `burn` (:231).
- **Current:** `Bsv21Token.ts:201` turns a missing or non-string `op` into `''`, and every string other than `auth` / `deploy+auth` is treated as a value op (:202-209). `isMint` is `false` for all of them.
- **Expected:** `decode` throws when `op` is absent or not one of the six strings above.
- **Failing examples:**
  - `{"p":"bsv-20","amt":"5"}` (no `op`) gives `op: ""`, `amt: "5"`.
  - `{"p":"bsv-20","op":"","amt":"5"}` gives `op: ""`.
  - `{"p":"bsv-20","op":"foo","id":"T_0","amt":"5"}` gives `op: "foo"`.
  - `{"p":"bsv-20","op":"deploy","amt":"5"}` (the deprecated BSV-20 v1 op) gives `op: "deploy"`, `id: ""`, `isMint: false`.

### 5. Binary wins: `decode` reads a JSON inscription that sits behind a valid 1Color prefix

- **Spec:** BRC-162:106: "when a script carries a valid binary prefix, it is a 1Color output, even if the remainder of the script also parses as a BRC-161 JSON inscription. Such a JSON inscription is locking-script content and is ignored for token purposes."
- **Current:** `Bsv21Token.envelope` (`Bsv21Token.ts:170-187`) finds the first `OP_0 OP_IF "ord"` **anywhere** in the script, and `decode` (:193-225) never checks for a 1Color prefix. Nothing in the package or its README says which decoder to call first.
- **Expected:** one of these (the maintainers choose):
  - (a) a precedence helper, for example a function that runs `OneColor.decode` first and only falls back to `Bsv21Token.decode` when there is no valid binary prefix; or
  - (b) at minimum, a README section that documents the call order (`OneColor.decode` first) and states that `Bsv21Token.isBsv21` alone is not a token classifier.
- **Failing example** (ASM):

  ```
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa OP_5 OP_2DROP
  OP_DUP OP_HASH160 1111111111111111111111111111111111111111 OP_EQUALVERIFY OP_CHECKSIG
  OP_0 OP_IF 6f7264 OP_1 6170706c69636174696f6e2f6273762d3230 OP_0
  7b2270223a226273762d3230222c226f70223a227472616e73666572222c226964223a22616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161615f30222c22616d74223a22393939227d
  OP_ENDIF
  ```

  The pushed JSON is `{"p":"bsv-20","op":"transfer","id":"aaaa…aaaa_0","amt":"999"}`.
  - `OneColor.decode` gives `role: "value"`, `amount: 5n` (a valid 1Color value output).
  - `Bsv21Token.decode` gives `op: "transfer"`, `amt: "999"`, and `Bsv21Token.isBsv21` returns `true`.

  A caller that tries the JSON decoder first credits 999 units of a JSON token instead of 5 units of the 1Color token.

### 6. PUSHDATA-form ambiguity (question for the spec authors)

- **Current (BRC-161 envelope):** `fieldTag` (`Bsv21Token.ts:69-75`) treats `OP_1` and a one-byte data push of `0x01` as the same envelope tag. The one-byte push can be the direct form (`01 01`) or a non-minimal `OP_PUSHDATA1 01 01`. `pushedBytes` (:77-83) accepts any push form for a value, so non-minimal pushes are read. Example: a `deploy+mint` envelope whose content-type tag is `OP_PUSHDATA1 0x01 0x01` instead of `OP_1` decodes normally. BRC-161 defers envelope rules to BRC-160 and does not say whether non-minimal pushes are valid.
- **Matching 1Color question:** BRC-162:101 says the payload is "any push opcode: `OP_0`, `OP_1NEGATE`, `OP_1`–`OP_16`, or a data push", with no minimality rule. The existing `OneColor` decoder already treats the two fields differently. A non-minimal **amount** push is rejected ("amounts 0..16 must use OP_0/OP_1..OP_16"). A non-minimal **payload** push (for example `OP_PUSHDATA1 01 a0 OP_DROP`) is accepted as the payload and reported with `payloadCanonical: false`.
- **Ask:** the spec authors should pin one rule for each spec, saying whether non-minimal pushes are valid, valid but non-canonical, or invalid, and add a test vector for it. The template can then follow. This item is a question, not a request to change the template now.

### Scope note

This issue proposes no code. `Bsv21Token.ts` is unchanged by the 1Color attribute-reader work (`@bsv/templates` 2.2.0) on purpose, under a maintainer rule for that change. A fix for items 1-5 is a separate change, and it needs its own compatibility review, because 1, 3 and 4 make `decode` throw on inputs it accepts today.
