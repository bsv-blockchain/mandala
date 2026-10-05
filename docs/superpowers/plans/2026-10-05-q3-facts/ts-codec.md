# Q3 fact sheet — BRC-162 codec in ts-stack (`Bsv21Binary.ts` + `strictCbor.ts`), for the Go port

## 0. Provenance and citation keys

All ts-stack paths are repo-relative, at ts-stack commit `87a14c9b5ad36a0e89ed7b19a81ab683ac793cb2` ("fix(ci): release follow-ups…", HEAD of the `ts-stack-main` checkout this sheet was read from; that checkout lives in a session scratchpad and will NOT exist later). The codec files and vectors were last changed in ts-stack commit `0211fd9650ffdacd42704836e3386eb949670aaf` (2026-10-02 12:31 -0500). Package: `@bsv/templates` version `2.0.0` (`packages/helpers/ts-templates/package.json:3`).

| Key | Path |
|---|---|
| **B** | `packages/helpers/ts-templates/src/Bsv21Binary.ts` (268 lines) |
| **C** | `packages/helpers/ts-templates/src/strictCbor.ts` (277 lines) |
| **BT** | `packages/helpers/ts-templates/src/__tests/Bsv21Binary.test.ts` |
| **CT** | `packages/helpers/ts-templates/src/__tests/strictCbor.test.ts` |
| **G** | `packages/helpers/ts-templates/test/vectors/generate.test.ts` (vector generator + `--check`) |
| **J** | `packages/helpers/ts-templates/test/vectors/brc162.json` (68 364 bytes; appended VERBATIM in §12) |
| **M** | `packages/helpers/ts-templates/mod.ts` (public exports) |
| **S** | `packages/sdk/src/script/Script.ts` (TS SDK chunk parser/serializer the codec sits on) |
| **P** | mandala `docs/design/brc-0162-bsv21-binary.pinned.md` (BRC-162 verbatim) |
| **D** | mandala `docs/superpowers/specs/2026-10-01-mandala-brc162-design.md` (Mandala policy; the code's "spec §3.1/§3.5/§3.3/§8.3/§5.3" refs resolve here) |
| **GS** | `~/go/pkg/mod/github.com/bsv-blockchain/go-sdk@v1.7.1/script/script_chunk.go` (overlay-go pins go-sdk v1.7.1, `overlay-go/go.mod:7`; Go 1.26.0, `overlay-go/go.mod:3`) |

Design target paths: Go strict CBOR port goes in `overlay-go/internal/brc162/strictcbor.go` (D:169, "a line-for-line port"). Vector files "are copied to `overlay-go/testdata/`, and the Go tests read them" (D:450). The existing `overlay-go/internal/mandala/token.go` is the OLD codec (36-byte asset id `len(chunks[0].Data) != 36`, exactly 8 chunks, `int64` amounts; token.go:115-149, own `encodeScriptNum` token.go:90) — it is what this port replaces.

Public exports (M:5-24): `Bsv21Binary, Bsv21BinaryError, BSV21_MAX_AMOUNT, encodeAmountChunk, decodeAmountChunk, tokenIdToString, tokenIdFromString, isTokenShaped`; types `Bsv21BinaryDecoded, Bsv21Role`; `encodeStrictCbor, decodeStrictCbor, tryDecodeStrictCbor, StrictCborError, STRICT_CBOR_MAX_BYTES, STRICT_CBOR_MAX_DEPTH`; types `StrictCborValue, StrictCborMap`.

---

## 1. HEADLINE porting hazards (read first)

### 1.1 Chunker divergence: go-sdk `DecodeScript` vs TS `Script.#parseChunks` (OP_RETURN after unbalanced OP_ENDIF)

- TS swallows the rest of the script into an OP_RETURN chunk only when `inConditionalBlock === 0` (S:608): `if (op === OP.OP_RETURN && inConditionalBlock === 0) { chunks.push({ op, data: Script.#copyRange(bytes, pos, length) }); break }`. `OP_ENDIF` decrements unconditionally (S:616), so after an unmatched `OP_ENDIF` the counter is −1 and OP_RETURN becomes a plain opcode; parsing continues.
- go-sdk swallows when NOT `conditionalBlock > 0` (GS:258-269): `if slices.Contains(options, DecodeOptionsParseOpReturn) || conditionalBlock > 0 { b = b[1:] } else { op.Data = b[1:]; b = nil }` — i.e. it swallows at −1 too. go-sdk's own comment claims parity with `Script.#parseChunks` (GS:262-267); the parity is incomplete.
- Probe (Go, run in scratchpad against go-sdk v1.7.1): `00006d686a4c0501` → 5 chunks `00,00,6d,68,6a(data=4c0501)`, `err=nil` → a Go decoder on `s.Chunks()` would accept it as a valid deploy.
- TS (code-read, S:599-626, not executed): ENDIF → counter −1; `6a` pushed as `{op:0x6a}`; `4c 05 01` → PUSHDATA1 len 5 with 1 byte → `invalidLength: true` → `Bsv21Binary.decode` throws `'truncated push'` (B:200).
- Verdict divergence (accept vs reject) on such scripts. Planner must choose: (a) port `#parseChunks` into Go (own chunker with an `invalidLength` flag; ~30 lines, S:569-626), or (b) accept the edge (document it). Non-verdict differences in `restChunks` also exist for the same inputs, but `restPubKeyHash` stays undefined either way (P2PKH needs exactly 5 rest chunks starting `76`).
- NOTE `DecodeOptionsParseOpReturn DecodeOptions = 0` (GS:236-240): it is the zero value; never pass a `0` option or OP_RETURN parsing changes.

### 1.2 Truncated pushes: go-sdk has no `invalidLength`

- TS parser keeps the truncated push as a chunk `{ data: <available bytes>, op, invalidLength: true }` (S:619-624; `invalidLength = !hasLength || end - pos !== len`). A truncated chunk is always the LAST chunk.
- go-sdk returns the partial ops WITHOUT the truncated chunk plus `ErrDataTooSmall` (`"not enough data"`, `script/errors.go:8`) (GS:271-322). Probe: `00006d4c050102` → 3 ops `00,00,6d`, `err=not enough data`; `00004c0501` → 2 ops, `err=not enough data`.
- Equivalence rule (derived; matches both vectors `truncated-push-after-*`): TS shape needs `c.length>=3 && isPush(c0) && isPush(c1) && c2==OP_2DROP`. If Go partial ops satisfy the shape → TS also has those 3 + the truncated chunk → `'truncated push'`. If Go partial ops have <3 ops → TS has ≤3 chunks with the truncated (push-opcode) chunk last, so `c[2]` is never `OP_2DROP` → `'not a BRC-162 token output'`. So in Go: on `ErrDataTooSmall`, `if isTokenShaped(partialOps) → "truncated push" else → "not a BRC-162 token output"`; and `isTokenShaped` must be evaluated on the partial ops (BT:398-404 asserts `isTokenShaped(s) === true` for `00006d4c050102`).
- The rule also covers pushes whose LENGTH bytes are missing (e.g. `00006d4c`, `00006d4d01`): TS sets `invalidLength` via `!hasLength` (S:577-596, S:623), Go returns partial `[00,00,6d]` + `ErrDataTooSmall` (GS:271-302) → both `'truncated push'`.
- Truncation is checked BEFORE id/amount (vectors `truncated-push-wins-over-bad-id`, `truncated-push-wins-over-bad-amount`, G:331-337).

### 1.3 go-sdk push helpers are NOT canonical for this codec

- `script.PushDataPrefix` / `AppendPushData` emit `len` for ≤75, then PUSHDATA1/2/4 (GS:196-223). They never emit `OP_1..OP_16` / `OP_1NEGATE`; `AppendPushData([]byte{0x05})` writes `0105`, which this codec flags as non-canonical payload / rejects as amount. Empty data → byte `0x00` (= OP_0, coincidentally correct).
- `NewScriptFromScriptOps` re-derives push prefixes via `AppendPushData` (GS:146-152), so it re-encodes a non-minimal chunk minimally — do not round-trip vectors through it; write op byte + explicit length prefix yourself (TS serializer writes the chunk's own `op` and a prefix sized by that op, S:539-562).
- `AppendBigInt` (script.go:110-121) does map 0→OP_0, 1..16→OP_1..16, but also −1→OP_1NEGATE and uses `big.Int`; the codec's amount encoder is simpler (§3.2) and must reject negatives itself.

### 1.4 TS-only behaviours with no Go analogue (decide, don't port blindly) — see §9.

---

## 2. Constants (exact)

| Name | Value | Cite |
|---|---|---|
| `BSV21_MAX_AMOUNT` | `(1n << 64n) - 1n` = 18446744073709551615 | B:18, BT:102 |
| `TOKEN_ID_BYTES` | 32 | B:48 |
| `PKH_BYTES` | 20 | B:49 |
| `MAX_AMOUNT_BYTES` | 9 | B:50 |
| `P2PKH_OPS` | `[OP_DUP, OP_HASH160, 20, OP_EQUALVERIFY, OP_CHECKSIG]` = `[0x76,0xa9,0x14,0x88,0xac]` | B:51 |
| `TOKEN_ID_RE` | `/^[0-9a-f]{64}_0$/` | B:103 |
| `STRICT_CBOR_MAX_BYTES` | 4096 | C:12 |
| `STRICT_CBOR_MAX_DEPTH` | 4 | C:13 |
| `MAX_UINT64` (cbor, private) | `(1n << 64n) - 1n` | C:14 |

Opcodes used: `OP_0`=0x00, direct push 0x01..0x4b, `OP_PUSHDATA1`=0x4c, `OP_PUSHDATA2`=0x4d, `OP_PUSHDATA4`=0x4e, `OP_1NEGATE`=0x4f, `OP_RESERVED`=0x50 (NOT a push), `OP_1..OP_16`=0x51..0x60, `OP_NOP`=0x61, `OP_2DROP`=0x6d, `OP_DROP`=0x75, `OP_DUP`=0x76, `OP_EQUAL`=0x87, `OP_EQUALVERIFY`=0x88, `OP_SHA256`=0xa8, `OP_HASH160`=0xa9, `OP_CHECKSIG`=0xac, `OP_CHECKSIGVERIFY`=0xad.

Predicates (B:53-55):
- `isSmallIntOp(op) = op >= OP_1 && op <= OP_16` (0x51..0x60).
- `isPushOp(op) = op <= OP_PUSHDATA4 || op === OP_1NEGATE || isSmallIntOp(op)` → push set = {0x00..0x4e, 0x4f, 0x51..0x60}. 0x50 (OP_RESERVED) and 0x61 (OP_NOP) are not pushes (BT:157-158).

---

## 3. Bsv21Binary — script layout and encoding

### 3.1 Layout (B:5, B:215, P:57)

```
<id32 | OP_0> <amount | OP_0> OP_2DROP [<payload> OP_DROP] <rest of script>
```
`lock` always emits rest = canonical P2PKH: `76 a9 14 <pkh20> 88 ac` (B:229-235).

Byte layouts emitted by `lock` (verified vectors, BT:186, BT:217-218):
- authority deploy with payload `[0xa0]`: `00 00 6d 01a0 75 76a914<pkh>88ac` → `00006d01a075` + P2PKH.
- value 5000: `20 <32 id bytes natural order> 02 8813 6d` + P2PKH (5000 = 0x1388 LE `88 13`).
- value 1: `20 <id> 51 6d` + P2PKH.

Token id chunk: `{ op: 0x20, data: tokenIdFromString(tokenId) }` or `{ op: OP_0 }` when `tokenId === null` (B:224).

### 3.2 `encodeAmountChunk(amount: bigint): ScriptChunk` (B:57-70)
Steps:
1. `typeof amount !== 'bigint'` → `fail('amount must be a bigint')` (B:58) — TS-only.
2. `amount < 0n || amount > BSV21_MAX_AMOUNT` → `fail('amount outside 0..2^64-1')` (B:59).
3. `0n` → `{ op: OP_0 }` (B:60).
4. `1n..16n` → `{ op: OP_1 + amount - 1 }` (B:61).
5. else: little-endian bytes of the value (least significant first) until value is 0; if the top byte has bit 0x80 set, append `0x00` (B:62-68). Return `{ op: data.length, data }` (B:69) — direct push of 1..9 bytes.

### 3.3 `decodeAmountChunk(chunk: ScriptChunk): bigint` (B:87-101) — check order is tested
1. `chunk.op === OP_0` → `0n` (B:88).
2. `isSmallIntOp(op)` → `op - OP_1 + 1` (B:89).
3. `!isDirectAmountPush(chunk)` → `fail('amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes')` (B:90-92). `isDirectAmountPush = chunk.op >= 1 && chunk.op <= 9 && chunk.data?.length === chunk.op` (B:72-73). So PUSHDATA1/2/4, OP_1NEGATE, any non-push, op 10+, op/data length mismatch, missing data → this message.
4. top = last byte; `(top & 0x80) !== 0` → `fail('amount must not be negative')` (B:94-95). NEGATIVE is checked BEFORE minimality: `[0x80]` → negative; `[0x11,0x80]` → negative.
5. `!isMinimalScriptNum(data)` → `fail('amount is not minimally encoded')` (B:96). `isMinimalScriptNum = (top & 0x7f) !== 0 || (data.length > 1 && (below & 0x80) !== 0)` where `below` = second-to-last byte (B:76-79). So `[0x00]` → not minimal; `[0x11,0x00]` → not minimal; `[0xff,0x00,0x00]` → not minimal; `[0x80,0x00]` → minimal.
6. `v = littleEndianValue(data)` (B:81-85, B:97).
7. `v <= 16n` → `fail('amounts 0..16 must use OP_0/OP_1..OP_16')` (B:98).
8. `v > BSV21_MAX_AMOUNT` → `fail('amount exceeds 2^64-1')` (B:99). Only reachable with 9 bytes whose top byte is 0x01..0x7f (e.g. `09 0000000000000000 01`).
9. return v.

### 3.4 Token id string <-> bytes
- `tokenIdFromString(id: string): number[]` (B:106-109): `!TOKEN_ID_RE.test(id)` → `fail('token id must be <64 lowercase hex>_0')`; returns `hexToBytes(id.slice(0,64)).reverse()` (display order → natural/internal order). Uppercase hex, `_1`, `_00`, `.0`, prefix chars, 62 hex, non-hex all rejected (BT:126-139).
- `tokenIdToString(tokenId: readonly number[]): string` (B:112-115): `length !== 32` → `fail('token id must be 32 bytes')`; returns `hex(reverse(copy)) + '_0'`. Does not mutate input (BT:119-124). 31/33/36 rejected (BT:141-143).
- Vector: `TXID = 'ab'*31 + 'cd'` (display), wire = `'cd' + 'ab'*31` (BT:17-19).
- Pinned spec allows 36-byte ids (txid ‖ uint32 LE vout, vout≠0) (P:84); the codec does NOT: only a 32-byte direct push (B:174-180; D:73 "A 36-byte id is *invalid for Mandala*").

### 3.5 `isTokenShaped(script: LockingScript): boolean` (B:118-121)
`c.length >= 3 && isPushOp(c[0].op) && isPushOp(c[1].op) && c[2].op === OP_2DROP`. Chunks with `invalidLength` still count as pushes (op is a push opcode). Does not look at data.

### 3.6 Payload helpers
- `canonicalPushOp(data)` (B:124-132): len 0 → `OP_0`; len 1 and byte 1..16 → `OP_1 + b - 1`; len 1 and byte `0x81` → `OP_1NEGATE`; len ≤75 → len; ≤0xff → `OP_PUSHDATA1`; ≤0xffff → `OP_PUSHDATA2`; else `OP_PUSHDATA4`. NOTE `[0x00]` and `[0x80]` stay 1-byte data pushes (`01 00`, `01 80`).
- `payloadChunk(data)` (B:135-138): op = canonicalPushOp; if op is `OP_0` or `> OP_PUSHDATA4` (i.e. OP_1NEGATE / OP_1..16) → `{ op }` (no data) else `{ op, data: copy }`.
- `pushedBytes(chunk)` (B:140-144): `OP_1NEGATE` → `[0x81]`; small int → `[n]`; else `chunk.data ?? []` (OP_0 → `[]`).
- `splitPayload(afterPrefix)` (B:153-164): `[first, second] = afterPrefix`; if `second === undefined || !isPushOp(first.op) || second.op !== OP_DROP` → `{ payloadCanonical: true, rest: afterPrefix }` (no payload). Else `payload = pushedBytes(first)`, `payloadCanonical = (first.op === canonicalPushOp(payload))`, `rest = afterPrefix.slice(2)`. Only the FIRST `<push> OP_DROP` is consumed (BT:293-299).
- Design D:82 says payload canonical = "direct ≤ 75 bytes, PUSHDATA1 ≤ 255, PUSHDATA2 above"; code additionally uses OP_0 / OP_1..16 / OP_1NEGATE for 0/1-byte payloads and PUSHDATA4 above 65535 (B:124-132). Code + vectors are authoritative.
- `payloadCanonical === false` ⇒ "carries no attributes" (D:82). Decoder never fails on payload.

### 3.7 `p2pkhHash(rest)` → `restPubKeyHash` (B:166-172)
`rest.length !== 5 || rest.some((c,i) => c.op !== P2PKH_OPS[i])` → undefined. Then `rest[2].data?.length === 20` → copy, else undefined. Requires op literally `0x14` (PUSHDATA1-with-20 → undefined, BT:360-364), exactly 5 chunks (trailing opcode → undefined, BT:340).

### 3.8 `decodeTokenId(chunk)` (B:174-180)
`OP_0` → undefined (deploy). Else `chunk.op !== 32 || chunk.data?.length !== 32` → `fail('token id must be a direct 32-byte push')`. Else copy of data (natural order).

### 3.9 Role (B:182-185)
`tokenId === undefined` → `'deploy'` (any amount, incl. fixed-supply amount>0; "policy refuses it later", BT:200; D:94). Else `amount === 0n` → `'authority'`, else `'value'`.

### 3.10 `Bsv21Binary.decode(script: LockingScript): Bsv21BinaryDecoded` (B:197-213) — exact order
1. `!isTokenShaped(script)` → `fail('not a BRC-162 token output')`.
2. any chunk with `invalidLength === true` (anywhere in the script) → `fail('truncated push')`.
3. `tokenId = decodeTokenId(c[0])` (id errors before amount errors: vector `id-checked-before-amount` = `4f 0105 6d …` → id error).
4. `amount = decodeAmountChunk(c[1])`.
5. `{payload, payloadCanonical, rest} = splitPayload(c.slice(3))`.
6. return `{ role: roleOf(tokenId, amount), tokenId, amount, payload, payloadCanonical, restChunks: rest, restPubKeyHash: p2pkhHash(rest) }`.

### 3.11 Types (B:20-35) and suggested Go mapping (suggestion only)

```ts
export type Bsv21Role = 'deploy' | 'authority' | 'value'
export interface Bsv21BinaryDecoded {
  role: Bsv21Role
  /** 32 bytes, natural (internal) order; absent for deploy. */
  tokenId?: number[]
  amount: bigint
  /** Raw payload bytes when a payload push + OP_DROP follows OP_2DROP. */
  payload?: number[]
  /** True when the payload uses the minimal push opcode for its bytes (or there is no payload). */
  payloadCanonical: boolean
  /** The locking script after the prefix. */
  restChunks: ScriptChunk[]
  /** Set when restChunks is exactly a canonical P2PKH (direct 20-byte push). */
  restPubKeyHash?: number[]
}
export class Bsv21BinaryError extends Error { name = 'Bsv21BinaryError' }   // B:37-42
```
| TS | Go (suggested) |
|---|---|
| `tokenId?: number[]` | `TokenID *[32]byte` (nil = deploy) |
| `amount: bigint` (0..2^64-1) | `uint64` (full domain fits exactly) |
| `payload?: number[]` | `Payload []byte` + `HasPayload bool` (empty payload via OP_0 is a present, empty payload: `00006d0075…` → payload `[]`, distinct from absent) |
| `restChunks` | `[]*script.ScriptChunk` |
| `restPubKeyHash?` | `[]byte` (nil when absent) |
| `Bsv21BinaryError` | sentinel type with `.Error()` = exact message |

### 3.12 `lock(tokenId: string | null, amount: bigint, pubKeyHash: readonly number[], payload?: readonly number[]): LockingScript` (B:216-237)
Order: (1) `pubKeyHash.length !== 20` → `fail('pubKeyHash must be 20 bytes')` (B:222); (2) id chunk (`tokenIdFromString` errors) (B:224); (3) `encodeAmountChunk` errors (B:225); (4) `OP_2DROP`; (5) if `payload !== undefined`: `payloadChunk(payload), OP_DROP` (copied, not aliased; BT:258-263); (6) `OP_DUP OP_HASH160 <20-byte push> OP_EQUALVERIFY OP_CHECKSIG`. `lock(ID, 1n, PKH)` must not throw (BT:417).

### 3.13 `lockBRC29(tokenId, amount, protocolID: WalletProtocol, keyID: string, counterparty: WalletCounterparty, payload?): Promise<LockingScript>` (B:240-254)
No wallet → `fail('lockBRC29 requires a wallet')` (B:248). Calls `wallet.getPublicKey({ protocolID, keyID, counterparty }, this.originator)` and `lock(tokenId, amount, hash160(hexToBytes(publicKey)), payload)`. Test uses `[2, 'mandala token'], '1', 'self'`, originator `'example.com'` (BT:503-506). Constructor `new Bsv21Binary(wallet?, originator?)` (B:191-194). Overlay-side Go likely does not need it (UNVERIFIED whether any Go consumer needs lockBRC29).

### 3.14 `unlock(privateKey, signOutputs: 'all'|'none'|'single' = 'all', anyoneCanPay = false): ScriptTemplateUnlock` (B:260-266)
Pure delegate: `new P2PKH().unlock(privateKey, signOutputs, anyoneCanPay)`. Sighash subscript = full locking script incl. prefix (B:256-259). Tested sighash bytes: all→0x41, none→0x42, single+ACP→0xc3; `estimateLength` = 108 (BT:476-489). In Go: the go-sdk P2PKH unlocker over the full locking script should behave identically (UNVERIFIED by test).

---

## 4. Bsv21Binary error strings (exact; each is a cross-engine contract per G:283-292)

| Message | Thrown at | Vector ids in J (`rejectScripts`) |
|---|---|---|
| `not a BRC-162 token output` | B:198 | plain-p2pkh, empty-script, two-chunks, third-chunk-op-drop, first-chunk-op-dup, second-chunk-op-dup, second-chunk-op-nop, second-chunk-op-reserved |
| `truncated push` | B:200 | truncated-push-after-deploy-prefix, truncated-push-after-value-prefix, truncated-push-wins-over-bad-id, truncated-push-wins-over-bad-amount |
| `token id must be a direct 32-byte push` | B:177 | id-36-bytes, id-33-bytes, id-31-bytes, id-op-1negate, id-op-1, id-pushdata1, id-pushdata2, id-checked-before-amount |
| `amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes` | B:91 | amount-empty-pushdata1, amount-17-pushdata1, amount-op-1negate, amount-10-bytes |
| `amount must not be negative` | B:95 | amount-negative, amount-negative-zero, amount-negative-multi-byte |
| `amount is not minimally encoded` | B:96 | amount-zero-as-data, amount-padded, amount-double-padded |
| `amounts 0..16 must use OP_0/OP_1..OP_16` | B:98 | amount-small-as-data, amount-16-as-data |
| `amount exceeds 2^64-1` | B:99 | amount-above-2-64-1 |
| `amount outside 0..2^64-1` | B:59 (encode) | — (BT:90-94) |
| `amount must be a bigint` | B:58 (encode, TS-only) | — (BT:96-99) |
| `token id must be <64 lowercase hex>_0` | B:107 | — (BT:126-139, BT:415) |
| `token id must be 32 bytes` | B:113 | — (BT:141-143) |
| `pubKeyHash must be 20 bytes` | B:222 | — (BT:413-414) |
| `lockBRC29 requires a wallet` | B:248 | — (BT:513-517) |

The generator asserts the reject set covers exactly the first 8 messages (G:739-754) and `tokenShaped` false exactly for the NOT_TOKEN_SHAPED ids (G:752-753).

---

## 5. Bsv21Binary unit-test vectors (from BT, transcribed to hex)

Fixtures (BT:15-22): `PKH = [1..20]` → `PKH_HEX = 0102030405060708090a0b0c0d0e0f1011121314`; `P2PKH_HEX = 76a9140102030405060708090a0b0c0d0e0f101112131488ac`; `TXID = 'ab'*31+'cd'`; `ID = TXID+'_0'`; `ID_WIRE_HEX = 'cd'+'ab'*31`; `filled(n, fill=0x11)`.

### 5.1 Amount chunks (BT:27-49) — `encodeAmountChunk` / `decodeAmountChunk`
| amount | chunk (hex) |
|---|---|
| 0 | `00` |
| 1 | `51` |
| 5 | `55` |
| 16 | `60` |
| 17 | `0111` |
| 127 | `017f` |
| 128 | `028000` |
| 255 | `02ff00` |
| 256 | `020001` |
| 5000 | `028813` |
| 2^64-1 | `09ffffffffffffffff00` |

Width-boundary property (BT:51-62): for bits 5..64 and v ∈ {2^bits−1, 2^bits} (≤ max): `chunk.op === floor(bitLength(v)/8) + 1`, `data.length === op`, round-trips.

### 5.2 `decodeAmountChunk` rejects (BT:64-88), chunk → message
| label | chunk | hex (if byte-representable) | message substring |
|---|---|---|---|
| data push of 5 | `{op:1,data:[05]}` | `0105` | `amounts 0..16 must use OP_0/OP_1..OP_16` |
| data push of 16 | `{op:1,data:[10]}` | `0110` | `amounts 0..16 must use OP_0/OP_1..OP_16` |
| data push of 0 | `{op:1,data:[00]}` | `0100` | `amount is not minimally encoded` |
| empty PUSHDATA1 | `{op:0x4c,data:[]}` | `4c00` | `direct push of 1-9 bytes` |
| negative | `{op:1,data:[81]}` | `0181` | `amount must not be negative` |
| negative zero | `{op:1,data:[80]}` | `0180` | `amount must not be negative` |
| negative multi-byte | `{op:2,data:[11,80]}` | `021180` | `amount must not be negative` |
| OP_1NEGATE | `{op:0x4f}` | `4f` | `direct push of 1-9 bytes` |
| non-minimal padding | `{op:2,data:[11,00]}` | `021100` | `amount is not minimally encoded` |
| double padding | `{op:3,data:[ff,00,00]}` | `03ff0000` | `amount is not minimally encoded` |
| PUSHDATA1 for 17 | `{op:0x4c,data:[11]}` | `4c0111` | `direct push of 1-9 bytes` |
| above 2^64-1 | `{op:9,data:[0×8,01]}` | `09000000000000000001` | `amount exceeds 2^64-1` |
| 10 bytes | `{op:10,data:[01,0×9]}` | `0a01000000000000000000` | `direct push of 1-9 bytes` |
| length mismatch | `{op:2,data:[11]}` | not representable from bytes (would be a truncated push) | `direct push of 1-9 bytes` |
| push without data | `{op:1}` | not representable from bytes | `direct push of 1-9 bytes` |
| opcode, not a push | `{op:0x76}` | `76` | `direct push of 1-9 bytes` |
(`toThrow(message)` is substring match; full message is `amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes`.)

Encode rejects: `-1n`, `MAX+1` → `amount outside 0..2^64-1` (BT:90-94).

### 5.3 Token-id string vectors (BT:110-143)
Accept: `ababab…abcd_0` ↔ wire `cdabab…ab`. Reject (`token id must be <64 lowercase hex>_0`): `''`, `TXID` (no suffix), `TXID_1`, `TXID_00`, `TXID.toUpperCase()_0`, `TXID.0`, `xTXID_0`, `TXID.slice(2)_0` (62 hex), `'zz'+TXID.slice(2)+'_0'`. `tokenIdToString` rejects 31/33/36 bytes.

### 5.4 `isTokenShaped` (BT:146-178), ASM → hex
| label | hex | shaped |
|---|---|---|
| deploy | `00006d` | true |
| id + small amount | `20cdab…ab556d` (`20`+ID_WIRE_HEX+`556d`) | true |
| OP_1NEGATE pushes | `4f4f6d` | true |
| OP_16 pushes | `60606d51` | true |
| empty script | `` | false |
| two chunks | `0000` | false |
| third chunk not OP_2DROP | `000075` | false |
| first chunk not a push | `76006d` | false |
| second chunk not a push | `00766d` | false |
| OP_NOP not a push | `00616d` | false |
| OP_RESERVED not a push | `00506d` | false |
| plain P2PKH | `76a9140102030405060708090a0b0c0d0e0f101112131488ac` | false (decode → `not a BRC-162 token output`) |
| PUSHDATA4 counts as push | `4e0100000001006d` (`{op:0x4e,data:[1]}`,OP_0,OP_2DROP) | true |

### 5.5 lock / decode (BT:181-490)
- `lock(null, 0n, PKH, [0xa0])` → `00006d01a07576a9140102030405060708090a0b0c0d0e0f101112131488ac`; decode: role deploy, amount 0, payload `[a0]`, canonical, restPubKeyHash PKH, tokenId undefined, restChunks length 5 (BT:184-198).
- `lock(null, 5n, PKH)` → role deploy, amount 5, no payload (BT:200-205).
- `lock(ID, 5000n, PKH)` → `20cdababababababababababababababababababababababababababababababab0288136d76a9140102030405060708090a0b0c0d0e0f101112131488ac` (BT:217).
- `lock(ID, 1n, PKH)` → `20cdababababababababababababababababababababababababababababababab516d76a9140102030405060708090a0b0c0d0e0f101112131488ac` (BT:218).
- `lock(ID, 0n, PKH)` → role authority; `lock(ID, MAX, PKH)` decodes with amount MAX (BT:207-224).
- Payload chunk emitted by `lock(ID, 7n, PKH, payload)` at chunk index 3, followed by `{op:OP_DROP}` (BT:226-256): `[]`→`{op:0x00}`; `[01]`→`{op:0x51}`; `[05]`→`{op:0x55}`; `[10]`→`{op:0x60}`; `[81]`→`{op:0x4f}`; `[00]`→`{op:1,data:[00]}`; `[11]`→`{op:1,data:[11]}`; `[80]`→`{op:1,data:[80]}`; 75×0x11→`{op:75}`; 76×→`{op:0x4c}`; 255×→`{op:0x4c}`; 256×→`{op:0x4d}`; 65535×→`{op:0x4d}`; 65536×→`{op:0x4e}`. All decode `payloadCanonical: true`.
- Leading `<push> OP_DROP` is the payload: `00006d01017576a914…88ac` → payload `[01]`, `payloadCanonical: false`, restPubKeyHash PKH (BT:265-272).
- Non-minimal payload pushes → `payloadCanonical: false` (BT:274-286): `00006d4c010575`+P2PKH → `[05]`; `00006d4c0075`+P2PKH → `[]`; `00006d018175`+P2PKH → `[81]`; `00006d4c04a161610175`+P2PKH → `a1616101`; `00006d4d4c00`+`11`×76+`75`+P2PKH → 76×0x11; `00006d4e00010000`+`11`×256+`75`+P2PKH → 256×0x11.
- `00006d4f75`+P2PKH → payload `[81]`, canonical true (BT:288-291).
- `00006d51755275` → payload `[01]`, restChunks `[{op:0x52},{op:0x75}]` (BT:293-299).
- No payload, `payloadCanonical: true`, restPubKeyHash undefined (BT:301-312): `00006d` (rest 0), `00006d51` (rest 1), `00006d5151` (rest 2), `00006d7675` (rest 2).
- Near-P2PKH → restPubKeyHash undefined (BT:319-344): `00006d61a914…88ac` (DUP→NOP), `00006d76a814…88ac` (HASH160→SHA256), `00006d76a9130203…1488ac` (19-byte hash), `00006d76a914…87ac` (EQUAL), `00006d76a914…88ad` (CHECKSIGVERIFY), `00006d76a914…88ac51` (trailing OP_1). (`…` = `0102030405060708090a0b0c0d0e0f1011121314`; 19-byte = `02030405060708090a0b0c0d0e0f1011121314`.)
- Constructed chunk `{op:20, data:19 bytes}` → undefined (BT:346-358; not representable from bytes).
- `00006d76a94c140102030405060708090a0b0c0d0e0f101112131488ac` → restChunks 5, restPubKeyHash undefined (BT:360-364).
- Token-shaped but invalid (BT:366-385):
  - `2411111111111111111111111111111111111111111111111111111111111111111111111101056d` → `token id must be a direct 32-byte push` (36-byte id)
  - `1f1111111111111111111111111111111111111111111111111111111111111101056d` → same (31-byte)
  - `4f556d` → same; `51556d` → same
  - `2011111111111111111111111111111111111111111111111111111111111111110205006d` → `amount is not minimally encoded`
  - `20111111111111111111111111111111111111111111111111111111111111111101056d` → `amounts 0..16 must use OP_0/OP_1..OP_16`
  - `20111111111111111111111111111111111111111111111111111111111111111101006d` → `amount is not minimally encoded`
  - `2011111111111111111111111111111111111111111111111111111111111111114f6d` → `direct push of 1-9 bytes`
  - `201111111111111111111111111111111111111111111111111111111111111111038813ff6d` → `amount must not be negative`
- `4c20`+`11`×32+`556d` → `token id must be a direct 32-byte push` (BT:387-396).
- `00006d4c050102` → shaped, `truncated push` (BT:398-404); `20`+ID_WIRE_HEX+`516d4c050102` → `truncated push` (BT:406-410).
- lock input validation (BT:412-418): 19/21-byte pkh → `pubKeyHash must be 20 bytes`; `TXID_1` → `token id must be <64 lowercase hex>_0`; `-1n` → `amount outside 0..2^64-1`.

---

## 6. Strict CBOR subset (C) — rules

### 6.1 Value model (C:6-10)
```ts
export type StrictCborValue = bigint | Uint8Array | string | null | boolean | StrictCborMap
export interface StrictCborMap { readonly [key: string]: StrictCborValue }
export type StrictCborInput = StrictCborValue | number
```
Error class (C:18-23): `export class StrictCborError extends Error { constructor(message) { super(message); this.name = 'StrictCborError' } }` — every codec failure goes through `fail(message)` (C:25-27); CT:288-297 asserts `name === 'StrictCborError'`; `tryDecodeStrictCbor` dispatches on `instanceof StrictCborError` (C:273).

Allowed: major 0 (uint ≤ 2^64−1, decoded as bigint), major 2 (bytes), major 3 (text, strict UTF-8, NFC not required), major 5 (map, text keys), major 7 only `f4` false / `f5` true / `f6` null. Rejected: major 1, 4, 6 (incl. tag 42), floats, undefined, other simple values, indefinite lengths (C:204-227; D:139-151).

### 6.2 Encoder (C:34-116)
- `header(major, value)` minimal (C:45-52): `<24` → 1 byte `major<<5|v`; `<0x100` → `|24` + 1 byte; `<0x10000` → `|25` + 2 BE; `<0x100000000` → `|26` + 4 BE; else `|27` + 8 BE.
- `encodeText` (C:67-71): lone UTF-16 surrogate → `fail('text contains a lone surrogate')`; else `header(3, utf8len)` + utf8 bytes.
- `encodeUint` (C:76-84): `number` must be `Number.isSafeInteger && >= 0` else `fail('number must be a safe non-negative integer')`; bigint `< 0n || > MAX_UINT64` → `fail('integer outside 0..2^64-1')`; `header(0, v)`.
- `encodeValue` (C:86-95): bigint/number → uint; string → text; `null`→`f6`; `true`→`f5`; `false`→`f4`; `Uint8Array` (exactly; `instanceof Uint8Array`) → `header(2,len)+bytes`; plain object (`Object.prototype.toString === '[object Object]'`) → `encodeMap(value, depth+1)`; else `fail('unsupported value type')` (undefined, arrays, Date, Map, Uint16Array, functions — CT:88-94).
- `encodeMap(map, depth)` (C:97-107): `depth > 4` → `fail('map nesting deeper than 4')` FIRST; then encode all keys (surrogate check), sort entries by `compareBytes(encodedKeyA, encodedKeyB)` (C:54-58: bytewise, then shorter first) — equals DAG-CBOR length-first for text keys; emit `header(5, n)` + key + value per entry.
- `encodeStrictCbor(map)` (C:109-116): `!isMapObject(map)` → `fail('top level must be a map')`; `encodeMap(map, 1)`; `out.length > 4096` → `fail('encoding exceeds 4096 bytes')` (size check is after full encode, top level only).
- Depth: top-level map is depth 1; `{a:{b:{c:{d:1}}}}` (4 maps) is accepted; 5 maps rejected (CT:80-87).

### 6.3 Decoder (C:118-265) — check order is a contract (G:14-24; D:155-164)
`Reader { pos; bytes }` (C:118-157):
- `byte()`: `pos >= len` → `fail('truncated input')`.
- `take(n)`: `pos + n > len` → `fail('truncated input')`.
- `head()` (C:139-150): `b = byte()`; `major = b >> 5`; `info = b & 0x1f`; `info < 24` → `[major, info]`; `info > 27` → `fail(info === 31 ? 'indefinite length' : 'reserved additional info')` (28,29,30 → reserved); read `1 << (info-24)` bytes BE (truncated input if short); `v < [24, 0x100, 0x10000, 0x100000000][info-24]` → `fail('non-minimal header')`. Minimality is checked for EVERY major type incl. 7 and 1, BEFORE the major-type check (so `f90000`, `fa00000000`, `fb0000000000000000`, `3800`, `f814` → `non-minimal header`).
- `count(v)` (C:153-156): `v > BigInt(bytes.length)` → `fail('length exceeds input')` — compared with TOTAL input length, not remaining. So `a1 6161 4a 01` → `length exceeds input` but `a1 6161 44 010203` → `truncated input`. Must be done on the 64-bit value before narrowing to int.
- `decodeValue(r, depth)` (C:211-227): major 0 → v; 2 → `take(count(v))` copy; 3 → `decodeText(take(count(v)))`; 5 → `decodeMapBody(r, count(v), depth+1)` (count evaluated BEFORE depth check → vector `order-count-before-depth`); 7 → `decodeSimple(v)`: 20→false, 21→true, 22→null, else `fail('simple value or float not allowed')`; default → `fail(\`major type ${major} not allowed\`)` (exact strings: `major type 1 not allowed`, `major type 4 not allowed`, `major type 6 not allowed`).
- `decodeMapBody(r, count, depth)` (C:229-249): `depth > 4` → `fail('map nesting deeper than 4')`; for each entry: `start = pos`; `head()` (key header: indefinite/reserved/non-minimal errors apply); `major !== 3` → `fail('map key must be text')`; `take(count(len))`; `decodeText` (UTF-8); `encodedKey = bytes[start:pos]`; if previous and `compareBytes(previous, encodedKey) >= 0` → `fail('map keys unsorted or duplicated')`; then `decodeValue(r, depth)`. TS stores via `Object.defineProperty` on `Object.create(null)` (`__proto__` safe) — TS-only.
- `decodeStrictCbor(input: readonly number[] | Uint8Array): StrictCborMap` (C:251-265):
  1. `input.length > 4096` → `fail('input exceeds 4096 bytes')` (before any parsing).
  2. `[major, count] = head()` (so empty input → `truncated input`; `bf` → `indefinite length`; `b801` → `non-minimal header`).
  3. `major !== 5` → `fail('top level must be a map')` (before trailing check: `01 00` → not a map).
  4. `decodeMapBody(r, count(count), 1)` (`bb ffffffffffffffff` → `length exceeds input`).
  5. `r.pos !== bytes.length` → `fail('trailing bytes')`.
  6. Re-encode guard: `compareBytes(encodeStrictCbor(map), input) !== 0` → `fail('non-canonical encoding')` (compared against the original `input`, so a `number[]` entry outside 0..255 that `Uint8Array.from` wrapped fails here; CT:267-279).
- `tryDecodeStrictCbor(input)` (C:267-276): returns undefined on `StrictCborError`; rethrows anything else (e.g. `TypeError` for `null` input, CT:301-303).

### 6.4 UTF-8 validator (C:159-202) — exact table
Bytes `< 0x80` single. Lead table `utf8Lead(c)` → `[contCount, minCodePoint, payloadBits]`: `0xc2..0xdf` → `[1, 0x80, c&0x1f]`; `0xe0..0xef` → `[2, 0x800, c&0x0f]`; `0xf0..0xf4` → `[3, 0x10000, c&0x07]`; anything else (0x80..0xc1, 0xf5..0xff) invalid. Each continuation must be `(x & 0xc0) === 0x80` and present; then reject `cp < min || cp > 0x10ffff || 0xd800 <= cp <= 0xdfff`. Failure → `fail('invalid UTF-8')`. Decoding keeps a leading BOM (`TextDecoder(..., { ignoreBOM: true })`, C:32).

**Verified equivalence:** a Go port of this exact algorithm was compared with Go's `unicode/utf8.Valid` over all 1-, 2- and 3-byte inputs and all 4-byte inputs with first byte ≥ 0xc0 (1 090 584 832 inputs): 0 mismatches (probe run in scratchpad, Go 1.26). So `utf8.Valid` may replace the hand-rolled validator in Go, or the port can be literal; either matches.

### 6.5 Strict-CBOR error strings (exact)

| Message | Where | Vector ids in J (`strictCbor`) |
|---|---|---|
| `truncated input` | C:127, C:132 | empty-input, truncated-value, truncated-key, truncated-header, byte-string-longer-than-the-rest |
| `indefinite length` | C:144 | indefinite-map, indefinite-text, indefinite-bytes, break-byte-as-value |
| `reserved additional info` | C:144 | reserved-additional-info, reserved-additional-info-30 |
| `non-minimal header` | C:148 | simple-20-two-byte-form, non-minimal-uint, non-minimal-uint-16-bit, non-minimal-uint-32-bit, non-minimal-uint-64-bit, non-minimal-length, non-minimal-key-header, order-minimal-before-float64/32/16, order-minimal-before-negative-int |
| `length exceeds input` | C:154 | byte-string-longer-than-input, bytes-length-2-64-1, text-length-2-64-1, key-length-2-64-1, map-count-2-64-1, nested-map-count-longer-than-input, order-count-before-depth |
| `invalid UTF-8` | C:200 | invalid-utf8, utf8-* (13 rows), nested-invalid-utf8-key, order-key-utf8-before-key-order |
| `simple value or float not allowed` | C:208 | float-1, float16, float32, undefined, simple-32 |
| `major type 1 not allowed` / `major type 4 not allowed` / `major type 6 not allowed` | C:225 | negative-int, order-negative-int-minimal-header / array / tag-42 |
| `map nesting deeper than 4` | C:98 (enc), C:230 (dec) | depth-5, order-depth-before-key |
| `map key must be text` | C:238 | integer-key, bytes-key, nested-integer-key, nested-bytes-key, order-key-text-before-key-order |
| `map keys unsorted or duplicated` | C:242 | unsorted-keys, keys-wrong-length-first-order, duplicate-keys, nested-unsorted-keys, nested-keys-wrong-length-first-order, nested-duplicate-keys |
| `top level must be a map` | C:112 (enc), C:256 (dec) | top-level-text, top-level-array, order-top-level-before-trailing |
| `trailing bytes` | C:258 | trailing-byte |
| `input exceeds 4096 bytes` | C:252 | size-over-4096 |
| `non-canonical encoding` | C:263 | — (TS `number[]` only; CT:267-279) |
| `encoding exceeds 4096 bytes` | C:114 | — (CT:114-119: `{a: Uint8Array(4090)}` = 4096 ok; 4091 → error) |
| `integer outside 0..2^64-1` | C:82 | — (CT:66-72) |
| `number must be a safe non-negative integer` | C:79 | — TS-only (CT:73-77) |
| `text contains a lone surrogate` | C:68 | — TS-only (CT:101-113) |
| `unsupported value type` | C:94 | — TS-only (CT:88-94) |

Contract statements: "The message is a cross-engine contract: the overlay copies it into its deployPayload / detailsSchema reasons, and the Go port must produce the same bytes" (CT:172-173); "the message and the order the checks run in are both part of the contract" (G:14-24); D:155-166. The generator asserts rejects exercise exactly the 16 decoder messages listed in G:778-799.

---

## 7. Strict CBOR unit-test vectors (CT), verbatim hex

Encode (input → hex):
- `{sym:'USD', dec:2n}` → `a263646563026373796d63555344` (CT:36; spec vector, D:171).
- `{a:23}` → `a1616117`; `{a:24}` → `a161611818` (CT:38-41).
- `{a:v}` → `a16161` + : 0→`00`, 255→`18ff`, 256→`190100`, 65535→`19ffff`, 65536→`1a00010000`, 4294967295→`1affffffff`, 4294967296→`1b0000000100000000` (CT:42-55).
- `{b:Uint8Array[1,2], n:null, t:true, f:false, m:{x:1n}}` → `a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5` → compact `a561624201026166f4616da1617801616ef66174f5` (CT:56-62; keys emitted sorted b,f,m,n,t).
- `{'€':'€'}` → `a163e282ac63e282ac` (CT:63-65).
- `{a:2^64-1}` → `a161611bffffffffffffffff`; `{a:Number.MAX_SAFE_INTEGER}` → `a161611b001fffffffffffff` (CT:66-79).
- `{a:{b:{c:{d:1n}}}}` → `a16161a16162a16163a1616401` (CT:84-86); 5-deep → `map nesting deeper than 4`.
- `{a:'😀'}` → `a1616164f09f9880` (CT:112).
- `{a:Uint8Array(4090)}` → 4096 bytes exactly (CT:115).

Decode accepts (CT:122-171): `a263646563026373796d63555344` → `{dec:2n, sym:'USD'}`; `a161611bffffffffffffffff`; `a561624201026166f4616da1617801616ef66174f5`; `mapWithBytes(4090)` = `a1616159 0ffa` + `00`×4090; `a16161a16162a16163a1616401`; `__proto__` keys: `a1695f5f70726f746f5f5fa1616101`; BOM: `a1616164efbbbf78` → `{a:'﻿x'}`, `a164efbbbf7801` → `{'﻿x':1n}`; `a1616163e282ac` → '€'; `a1616164f09f9880` → '😀'; `a1616162c2a2` → '¢'.

Decode rejects (CT:174-261) — identical rows (and messages) are in J `strictCbor`; see §12 for the full list with ids. Additional CT-only: `number[]` inputs `[0xa1,0x61,0x61,0x101]`, `[…,-0xff]`, `[…,1.5]`, `[0x1a1,0x61,0x61,0x01]` → `non-canonical encoding` (TS-only); `tryDecodeStrictCbor(a1616101)` → `{a:1n}`.

---

## 8. Vector file `brc162.json` (J) — schema and how to use it from Go

- Regenerate: `REGENERATE_VECTORS=1 pnpm --filter @bsv/templates test test/vectors/generate.test.ts`; plain run = `--check` (fails if file differs) (G:5-8). "The Go overlay reads brc162.json, so a changed byte here is a cross-engine change" (G:2-3). Serialization: `JSON.stringify(vectors, null, 2) + "\n"` (G:654).
- Top level: `{ id: 'mandala.brc162', version: 1, scripts, payloadPushes, amountChunks, rejectScripts, strictCbor, commitments, deploySig }` (G:116-126, G:642-652). Row counts: scripts 34, payloadPushes 10, amountChunks 40, rejectScripts 33, strictCbor 104, commitments 19, deploySig 2.
- Row schemas (G:68-115):
  - `ScriptVector { id, tokenId: string|null, amount: string (decimal), pubKeyHash: hex, payload: hex|null, scriptHex, role }` — Go test: decode `scriptHex` → role, `tokenIdToString(tokenId)` or null, amount, payload hex or null, `payloadCanonical === true`, `restPubKeyHash` hex == pubKeyHash (G:690-700); and encoder: `lock(tokenId, amount, pkh, payload)` hex == scriptHex (G:235).
  - `PayloadPushVector { id, scriptHex, payload: hex ('' when none), payloadCanonical }` — `payloadCanonical === id.startsWith('canonical-')`; exactly 8 non-canonical (G:708-713).
  - `AmountChunkVector { id, amount: string, chunkHex }` — chunkHex is the single chunk serialized; decode round-trip; `amount-0` → `00`, `amount-17` → `0111` (G:715-727).
  - `RejectScriptVector { id, scriptHex, tokenShaped, error }` — `isTokenShaped == tokenShaped`; decode throws exactly `error` (G:729-737).
  - `StrictCborVector { id, hex, valid, error? }` — `error` present exactly on rejects; valid rows re-encode to identical bytes (G:756-805).
  - `CommitmentVector { id, detailsHex, commitment }` — `commitment = sha256(detailsHex bytes)`; details re-encode identically (G:811-839). OUT OF CODEC SCOPE (admin-details schema, D §3.3) but exercises `encodeStrictCbor` with bytes/null/text; keys are real compressed points, outpoints 36 bytes with vout 1 (G:841-865). `authority-adm-commitment` payload = `a16361646d5820` + commitment of `issue-bankref` (G:867-872).
  - `DeploySigVector { id, txid, digestHex, issuerIdentityKey, protocolID: [2,'mandala deploy'], keyID: '1', counterparty: 'anyone', signatureHex }` — digest = UTF-8 `"mandala-deploy:" + txid`; verify with ProtoWallet('anyone') → `counterparty = issuerIdentityKey` (G:600-638, G:874-941). OUT OF CODEC SCOPE (D §5.3).
- Generator fixtures: `patterned(length, seed)[i] = (seed + i*7) & 0xff` (G:51-52); `TXID_ASCENDING = 000102…1f` (G:60); `ID_PUSH = '20' + TOKEN_ID_WIRE_HEX` (G:62).
- J does not include: 65535/65536-byte payload rows (BT only), constructed-chunk cases, CT-only `number[]` cases.

---

## 9. TS-only semantics — N/A or planner decision in Go

| TS behaviour | Cite | Go status |
|---|---|---|
| `encodeAmountChunk` non-bigint → `amount must be a bigint` | B:58 | N/A (typed `uint64`/`*big.Int`) |
| `encodeAmountChunk` `amount outside 0..2^64-1` | B:59 | With `uint64` input only unreachable; keep if Go takes `*big.Int` (DECISION) |
| CBOR `number` inputs → `number must be a safe non-negative integer` | C:77-80 | N/A |
| `unsupported value type` | C:94 | Go type-switch default; keep the message |
| Lone surrogate → `text contains a lone surrogate` | C:60-71 | Go strings can hold invalid UTF-8; Go encoder needs a `utf8.ValidString` check — message choice is a DECISION (UNVERIFIED: no TS string to copy, no vector) |
| `__proto__` handling, `Object.create(null)` | C:231-246 | N/A (Go map) |
| `number[]` entries outside 0..255 → `non-canonical encoding` | C:259-263, D:166 | N/A for `[]byte`; re-encode guard expected unreachable for `[]byte` input given the strict decoder (argued, UNVERIFIED by test) — keep it as belt-and-braces |
| `tryDecodeStrictCbor` rethrows non-StrictCborError (`TypeError`) | C:270-275 | Go: return `(nil, false)` only on codec errors |
| BOM preserved | C:30-32 | Go `string(b)` preserves natively |
| Constructed chunks with op/data mismatch (`{op:2,data:[11]}`, `{op:1}`, `{op:20, data:19B}`) | BT:82-83, BT:346-358 | Not reachable from bytes via either chunker; only test if Go exposes chunk-level APIs |
| Encoder key ordering by encoded bytes | C:99-100 | Go: sort by `bytes.Compare(encodedKey)`; JS objects/Go maps cannot hold duplicate keys |
| Decoded uint as `bigint` | C:215 | Go `uint64` holds full domain |

---

## 10. Spec (pinned BRC-162, P) vs implementation divergences

1. 36-byte token ids (P:84) → rejected by the codec (`token id must be a direct 32-byte push`; vector `id-36-bytes`); D:73.
2. Spec: amount any "minimally encoded script number" (P:63, P:109-112); codec additionally rejects data pushes of 0..16 (must use OP_0/OP_1..16), PUSHDATA*, OP_1NEGATE (B:87-101; D:76-81 "Push canonicality (amendment 2026-10-02)").
3. Spec: payload "Any single push", not validated (P:65, P:116); codec records it plus a `payloadCanonical` flag; Mandala treats non-canonical payload as carrying no attributes (D:82).
4. Spec: payload attributes are full DAG-CBOR (P:117); codec reads a strict subset (no arrays, negatives, tags/42, floats; text keys; depth ≤ 4; ≤ 4096 bytes) (C; D:132-173).
5. Fixed-supply deploy (empty id, amount > 0) is valid per spec (P:102) and decodes as `role: 'deploy'` in the codec; Mandala policy refuses it later (D:94; BT:200).
6. Spec deploy must be output 0 (P:197) — not checked by the codec (no vout input); policy layer.

---

## 11. Self-checks done for this sheet
- Every error string in §4/§6.5 grep-matched against B and C.
- Hand-decoded: `0288136d` → push 2 `8813` = 0x1388 = 5000, then OP_2DROP; `a263646563026373796d63555344` → map(2) "dec"→2, "sym"→"USD"; `00006d01a075…` → OP_0 OP_0 OP_2DROP push1(a0) OP_DROP P2PKH.
- Go probes (scratchpad only): go-sdk v1.7.1 `DecodeScript` on `00006d4c050102`, `00006d686a4c0501`, `00006d6a4c0501`, `00004c0501`, `0000`, `00006d`; UTF-8 brute force (§6.4).
- NOT executed: the TS jest suites (no node_modules in the checkout); TS behaviour in §1.1 is from code reading (S:599-626).

---

## 12. `brc162.json` VERBATIM (ts-stack 87a14c9b5, `packages/helpers/ts-templates/test/vectors/brc162.json`)

This block is the only durable copy (the mandala repo has no `brc162.json`; the ts-stack checkout was ephemeral). Extract it byte-for-byte to `overlay-go/testdata/brc162.json` (D:450) with:

    sed -n '/^```json$/,/^```$/p' .superpowers/sdd/q3-facts/ts-codec.md | sed '1d;$d' > overlay-go/testdata/brc162.json
    shasum -a 256 overlay-go/testdata/brc162.json   # must be de5b898bee1a0f848f92e7082a9ca6b9026f9d2801ed7fcdda8ff6eb47e0afb1

(Verified: this extraction is `cmp`-identical to the original, SHA-256 `de5b898bee1a0f848f92e7082a9ca6b9026f9d2801ed7fcdda8ff6eb47e0afb1`, 68 364 bytes.) Fallback: re-clone ts-stack at `87a14c9b5` — UNVERIFIED that this commit is on `bsv-blockchain/ts-stack` main (its message references PR #771).

```json
{
  "id": "mandala.brc162",
  "version": 1,
  "scripts": [
    {
      "id": "deploy-authority-empty-payload",
      "tokenId": null,
      "amount": "0",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "a0",
      "scriptHex": "00006d01a07576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "deploy"
    },
    {
      "id": "deploy-authority-metadata",
      "tokenId": null,
      "amount": "0",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "a463646563026373796d63555344656c6162656c69555320446f6c6c61726c666565526174655065724b621903e8",
      "scriptHex": "00006d2ea463646563026373796d63555344656c6162656c69555320446f6c6c61726c666565526174655065724b621903e87576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "deploy"
    },
    {
      "id": "deploy-authority-fee-disabled",
      "tokenId": null,
      "amount": "0",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "a463646563026373796d63555344656c6162656c69555320446f6c6c61726c666565526174655065724b62f6",
      "scriptHex": "00006d2ca463646563026373796d63555344656c6162656c69555320446f6c6c61726c666565526174655065724b62f67576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "deploy"
    },
    {
      "id": "deploy-authority-no-payload",
      "tokenId": null,
      "amount": "0",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "00006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "deploy"
    },
    {
      "id": "deploy-fixed-supply-codec-only",
      "tokenId": null,
      "amount": "5",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "00556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "deploy"
    },
    {
      "id": "authority-no-payload",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "0",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "authority"
    },
    {
      "id": "authority-adm-commitment",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "0",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "a16361646d58209de342429e6618e9db8198ef6ebfddce4148d20259fdac6e5b416ddde4aeaa09",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab006d27a16361646d58209de342429e6618e9db8198ef6ebfddce4148d20259fdac6e5b416ddde4aeaa097576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "authority"
    },
    {
      "id": "authority-ascending-id",
      "tokenId": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f_0",
      "amount": "0",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "authority"
    },
    {
      "id": "value-amount-1",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "1",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab516d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-5",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "5",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-16",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "16",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab606d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-17",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "17",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab01116d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-127",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "127",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab017f6d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-128",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "128",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab0280006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-255",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "255",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab02ff006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-256",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "256",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab0200016d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-5000",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "5000",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab0288136d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-9007199254740991",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "9007199254740991",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab07ffffffffffff1f6d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-9007199254740992",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "9007199254740992",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab07000000000000206d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-amount-18446744073709551615",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "18446744073709551615",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "20cdababababababababababababababababababababababababababababababab09ffffffffffffffff006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-ascending-id",
      "tokenId": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f_0",
      "amount": "1",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": null,
      "scriptHex": "201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100516d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-strict-cbor-map",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "a1616101",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d04a16161017576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-empty",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d007576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-0x01",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "01",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d517576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-0x05",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "05",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d557576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-0x10",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "10",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d607576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-0x81",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "81",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d4f7576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-0x00",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "00",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d01007576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-0x11",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "11",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d01117576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-0x80",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "80",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d01807576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-75-bytes",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f90007",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d4b01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900077576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-76-bytes",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d4c4c020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f7576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-255-bytes",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d4cff030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef57576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    },
    {
      "id": "value-payload-256-bytes",
      "tokenId": "abababababababababababababababababababababababababababababababcd_0",
      "amount": "7",
      "pubKeyHash": "0102030405060708090a0b0c0d0e0f1011121314",
      "payload": "040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab576d4d0001040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd7576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "role": "value"
    }
  ],
  "payloadPushes": [
    {
      "id": "canonical-op-1negate",
      "scriptHex": "00006d4f7576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "81",
      "payloadCanonical": true
    },
    {
      "id": "canonical-op-1-value-1",
      "scriptHex": "00006d517576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "01",
      "payloadCanonical": true
    },
    {
      "id": "non-canonical-data-push-of-1",
      "scriptHex": "00006d01017576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "01",
      "payloadCanonical": false
    },
    {
      "id": "non-canonical-data-push-of-0x81",
      "scriptHex": "00006d01817576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "81",
      "payloadCanonical": false
    },
    {
      "id": "non-canonical-pushdata1-of-0x05",
      "scriptHex": "00006d4c01057576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "05",
      "payloadCanonical": false
    },
    {
      "id": "non-canonical-pushdata1-empty",
      "scriptHex": "00006d4c007576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "",
      "payloadCanonical": false
    },
    {
      "id": "non-canonical-pushdata1-4-bytes",
      "scriptHex": "00006d4c04a16161017576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "a1616101",
      "payloadCanonical": false
    },
    {
      "id": "non-canonical-pushdata2-76-bytes",
      "scriptHex": "00006d4d4c00111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111117576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
      "payloadCanonical": false
    },
    {
      "id": "non-canonical-pushdata4-256-bytes",
      "scriptHex": "00006d4e00010000111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111117576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
      "payloadCanonical": false
    },
    {
      "id": "value-non-canonical-pushdata1",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab516d4c01057576a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "payload": "05",
      "payloadCanonical": false
    }
  ],
  "amountChunks": [
    {
      "id": "amount-0",
      "amount": "0",
      "chunkHex": "00"
    },
    {
      "id": "amount-1",
      "amount": "1",
      "chunkHex": "51"
    },
    {
      "id": "amount-2",
      "amount": "2",
      "chunkHex": "52"
    },
    {
      "id": "amount-5",
      "amount": "5",
      "chunkHex": "55"
    },
    {
      "id": "amount-16",
      "amount": "16",
      "chunkHex": "60"
    },
    {
      "id": "amount-17",
      "amount": "17",
      "chunkHex": "0111"
    },
    {
      "id": "amount-127",
      "amount": "127",
      "chunkHex": "017f"
    },
    {
      "id": "amount-128",
      "amount": "128",
      "chunkHex": "028000"
    },
    {
      "id": "amount-255",
      "amount": "255",
      "chunkHex": "02ff00"
    },
    {
      "id": "amount-256",
      "amount": "256",
      "chunkHex": "020001"
    },
    {
      "id": "amount-5000",
      "amount": "5000",
      "chunkHex": "028813"
    },
    {
      "id": "amount-32767",
      "amount": "32767",
      "chunkHex": "02ff7f"
    },
    {
      "id": "amount-32768",
      "amount": "32768",
      "chunkHex": "03008000"
    },
    {
      "id": "amount-65535",
      "amount": "65535",
      "chunkHex": "03ffff00"
    },
    {
      "id": "amount-65536",
      "amount": "65536",
      "chunkHex": "03000001"
    },
    {
      "id": "amount-8388607",
      "amount": "8388607",
      "chunkHex": "03ffff7f"
    },
    {
      "id": "amount-8388608",
      "amount": "8388608",
      "chunkHex": "0400008000"
    },
    {
      "id": "amount-16777215",
      "amount": "16777215",
      "chunkHex": "04ffffff00"
    },
    {
      "id": "amount-16777216",
      "amount": "16777216",
      "chunkHex": "0400000001"
    },
    {
      "id": "amount-2147483647",
      "amount": "2147483647",
      "chunkHex": "04ffffff7f"
    },
    {
      "id": "amount-2147483648",
      "amount": "2147483648",
      "chunkHex": "050000008000"
    },
    {
      "id": "amount-4294967295",
      "amount": "4294967295",
      "chunkHex": "05ffffffff00"
    },
    {
      "id": "amount-4294967296",
      "amount": "4294967296",
      "chunkHex": "050000000001"
    },
    {
      "id": "amount-549755813887",
      "amount": "549755813887",
      "chunkHex": "05ffffffff7f"
    },
    {
      "id": "amount-549755813888",
      "amount": "549755813888",
      "chunkHex": "06000000008000"
    },
    {
      "id": "amount-1099511627775",
      "amount": "1099511627775",
      "chunkHex": "06ffffffffff00"
    },
    {
      "id": "amount-1099511627776",
      "amount": "1099511627776",
      "chunkHex": "06000000000001"
    },
    {
      "id": "amount-140737488355327",
      "amount": "140737488355327",
      "chunkHex": "06ffffffffff7f"
    },
    {
      "id": "amount-140737488355328",
      "amount": "140737488355328",
      "chunkHex": "0700000000008000"
    },
    {
      "id": "amount-281474976710655",
      "amount": "281474976710655",
      "chunkHex": "07ffffffffffff00"
    },
    {
      "id": "amount-281474976710656",
      "amount": "281474976710656",
      "chunkHex": "0700000000000001"
    },
    {
      "id": "amount-9007199254740991",
      "amount": "9007199254740991",
      "chunkHex": "07ffffffffffff1f"
    },
    {
      "id": "amount-9007199254740992",
      "amount": "9007199254740992",
      "chunkHex": "0700000000000020"
    },
    {
      "id": "amount-36028797018963967",
      "amount": "36028797018963967",
      "chunkHex": "07ffffffffffff7f"
    },
    {
      "id": "amount-36028797018963968",
      "amount": "36028797018963968",
      "chunkHex": "080000000000008000"
    },
    {
      "id": "amount-72057594037927935",
      "amount": "72057594037927935",
      "chunkHex": "08ffffffffffffff00"
    },
    {
      "id": "amount-72057594037927936",
      "amount": "72057594037927936",
      "chunkHex": "080000000000000001"
    },
    {
      "id": "amount-9223372036854775807",
      "amount": "9223372036854775807",
      "chunkHex": "08ffffffffffffff7f"
    },
    {
      "id": "amount-9223372036854775808",
      "amount": "9223372036854775808",
      "chunkHex": "09000000000000008000"
    },
    {
      "id": "amount-18446744073709551615",
      "amount": "18446744073709551615",
      "chunkHex": "09ffffffffffffffff00"
    }
  ],
  "rejectScripts": [
    {
      "id": "amount-small-as-data",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab01056d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amounts 0..16 must use OP_0/OP_1..OP_16"
    },
    {
      "id": "amount-16-as-data",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab01106d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amounts 0..16 must use OP_0/OP_1..OP_16"
    },
    {
      "id": "amount-zero-as-data",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab01006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount is not minimally encoded"
    },
    {
      "id": "amount-empty-pushdata1",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab4c006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes"
    },
    {
      "id": "amount-17-pushdata1",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab4c01116d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes"
    },
    {
      "id": "amount-op-1negate",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab4f6d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes"
    },
    {
      "id": "amount-negative",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab01816d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount must not be negative"
    },
    {
      "id": "amount-negative-zero",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab01806d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount must not be negative"
    },
    {
      "id": "amount-negative-multi-byte",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab0211806d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount must not be negative"
    },
    {
      "id": "amount-padded",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab0211006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount is not minimally encoded"
    },
    {
      "id": "amount-double-padded",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab03ff00006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount is not minimally encoded"
    },
    {
      "id": "amount-above-2-64-1",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab090000000000000000016d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount exceeds 2^64-1"
    },
    {
      "id": "amount-10-bytes",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab0a010000000000000000006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes"
    },
    {
      "id": "id-36-bytes",
      "scriptHex": "24111111111111111111111111111111111111111111111111111111111111111111111111556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "id-33-bytes",
      "scriptHex": "21111111111111111111111111111111111111111111111111111111111111111111556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "id-31-bytes",
      "scriptHex": "1f11111111111111111111111111111111111111111111111111111111111111556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "id-op-1negate",
      "scriptHex": "4f556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "id-op-1",
      "scriptHex": "51556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "id-pushdata1",
      "scriptHex": "4c201111111111111111111111111111111111111111111111111111111111111111556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "id-pushdata2",
      "scriptHex": "4d20001111111111111111111111111111111111111111111111111111111111111111556d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "truncated-push-after-deploy-prefix",
      "scriptHex": "00006d4c050102",
      "tokenShaped": true,
      "error": "truncated push"
    },
    {
      "id": "truncated-push-after-value-prefix",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab516d4c050102",
      "tokenShaped": true,
      "error": "truncated push"
    },
    {
      "id": "truncated-push-wins-over-bad-id",
      "scriptHex": "24111111111111111111111111111111111111111111111111111111111111111111111111556d76a9140102030405060708090a0b0c0d0e0f101112131488ac4c050102",
      "tokenShaped": true,
      "error": "truncated push"
    },
    {
      "id": "truncated-push-wins-over-bad-amount",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab01056d76a9140102030405060708090a0b0c0d0e0f101112131488ac4c050102",
      "tokenShaped": true,
      "error": "truncated push"
    },
    {
      "id": "id-checked-before-amount",
      "scriptHex": "4f01056d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": true,
      "error": "token id must be a direct 32-byte push"
    },
    {
      "id": "plain-p2pkh",
      "scriptHex": "76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    },
    {
      "id": "empty-script",
      "scriptHex": "",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    },
    {
      "id": "two-chunks",
      "scriptHex": "0000",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    },
    {
      "id": "third-chunk-op-drop",
      "scriptHex": "000075",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    },
    {
      "id": "first-chunk-op-dup",
      "scriptHex": "76006d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    },
    {
      "id": "second-chunk-op-dup",
      "scriptHex": "20cdababababababababababababababababababababababababababababababab766d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    },
    {
      "id": "second-chunk-op-nop",
      "scriptHex": "00616d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    },
    {
      "id": "second-chunk-op-reserved",
      "scriptHex": "00506d76a9140102030405060708090a0b0c0d0e0f101112131488ac",
      "tokenShaped": false,
      "error": "not a BRC-162 token output"
    }
  ],
  "strictCbor": [
    {
      "id": "spec-sym-dec",
      "hex": "a263646563026373796d63555344",
      "valid": true
    },
    {
      "id": "empty-map",
      "hex": "a0",
      "valid": true
    },
    {
      "id": "uint-max-2-64-1",
      "hex": "a161611bffffffffffffffff",
      "valid": true
    },
    {
      "id": "uint-0",
      "hex": "a1616100",
      "valid": true
    },
    {
      "id": "uint-23",
      "hex": "a1616117",
      "valid": true
    },
    {
      "id": "uint-24",
      "hex": "a161611818",
      "valid": true
    },
    {
      "id": "uint-255",
      "hex": "a1616118ff",
      "valid": true
    },
    {
      "id": "uint-256",
      "hex": "a16161190100",
      "valid": true
    },
    {
      "id": "uint-65535",
      "hex": "a1616119ffff",
      "valid": true
    },
    {
      "id": "uint-65536",
      "hex": "a161611a00010000",
      "valid": true
    },
    {
      "id": "uint-4294967295",
      "hex": "a161611affffffff",
      "valid": true
    },
    {
      "id": "uint-4294967296",
      "hex": "a161611b0000000100000000",
      "valid": true
    },
    {
      "id": "all-value-kinds",
      "hex": "a561624201026166f4616da1617801616ef66174f5",
      "valid": true
    },
    {
      "id": "depth-4",
      "hex": "a16161a16162a16163a1616401",
      "valid": true
    },
    {
      "id": "keys-length-first",
      "hex": "a261620162616102",
      "valid": true
    },
    {
      "id": "keys-same-length-sorted",
      "hex": "a2616101616202",
      "valid": true
    },
    {
      "id": "key-with-24-bytes",
      "hex": "a1781861616161616161616161616161616161616161616161616101",
      "valid": true
    },
    {
      "id": "bytes-with-24-bytes",
      "hex": "a161615818000000000000000000000000000000000000000000000000",
      "valid": true
    },
    {
      "id": "text-utf8-3-byte",
      "hex": "a1616163e282ac",
      "valid": true
    },
    {
      "id": "text-utf8-4-byte",
      "hex": "a1616164f09f9880",
      "valid": true
    },
    {
      "id": "text-utf8-2-byte",
      "hex": "a1616162c2a2",
      "valid": true
    },
    {
      "id": "text-leading-bom",
      "hex": "a1616164efbbbf78",
      "valid": true
    },
    {
      "id": "text-utf8-smallest-2-byte",
      "hex": "a1616162c280",
      "valid": true
    },
    {
      "id": "text-utf8-smallest-3-byte",
      "hex": "a1616163e0a080",
      "valid": true
    },
    {
      "id": "text-utf8-smallest-4-byte",
      "hex": "a1616164f0908080",
      "valid": true
    },
    {
      "id": "text-utf8-below-surrogates",
      "hex": "a1616163ed9fbf",
      "valid": true
    },
    {
      "id": "text-utf8-above-surrogates",
      "hex": "a1616163ee8080",
      "valid": true
    },
    {
      "id": "text-utf8-max-code-point",
      "hex": "a1616164f48fbfbf",
      "valid": true
    },
    {
      "id": "key-utf8",
      "hex": "a163e282ac63e282ac",
      "valid": true
    },
    {
      "id": "key-proto",
      "hex": "a1695f5f70726f746f5f5fa1616101",
      "valid": true
    },
    {
      "id": "nested-keys-length-first",
      "hex": "a16161a261620162616102",
      "valid": true
    },
    {
      "id": "size-limit-4096",
      "hex": "a16161590ffa00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      "valid": true
    },
    {
      "id": "float-1",
      "hex": "a16161fb3ff0000000000000",
      "valid": false,
      "error": "simple value or float not allowed"
    },
    {
      "id": "float16",
      "hex": "a16161f93c00",
      "valid": false,
      "error": "simple value or float not allowed"
    },
    {
      "id": "float32",
      "hex": "a16161fa3f800000",
      "valid": false,
      "error": "simple value or float not allowed"
    },
    {
      "id": "tag-42",
      "hex": "a16161d82a4100",
      "valid": false,
      "error": "major type 6 not allowed"
    },
    {
      "id": "negative-int",
      "hex": "a1616120",
      "valid": false,
      "error": "major type 1 not allowed"
    },
    {
      "id": "array",
      "hex": "a161618101",
      "valid": false,
      "error": "major type 4 not allowed"
    },
    {
      "id": "undefined",
      "hex": "a16161f7",
      "valid": false,
      "error": "simple value or float not allowed"
    },
    {
      "id": "simple-32",
      "hex": "a16161f820",
      "valid": false,
      "error": "simple value or float not allowed"
    },
    {
      "id": "simple-20-two-byte-form",
      "hex": "a16161f814",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "non-minimal-uint",
      "hex": "a161611805",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "non-minimal-uint-16-bit",
      "hex": "a16161190005",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "non-minimal-uint-32-bit",
      "hex": "a161611a0000ffff",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "non-minimal-uint-64-bit",
      "hex": "a161611b00000000ffffffff",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "non-minimal-length",
      "hex": "b801616101",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "non-minimal-key-header",
      "hex": "a178016101",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "indefinite-map",
      "hex": "bf616101ff",
      "valid": false,
      "error": "indefinite length"
    },
    {
      "id": "indefinite-text",
      "hex": "a161617f6161ff",
      "valid": false,
      "error": "indefinite length"
    },
    {
      "id": "indefinite-bytes",
      "hex": "a161615f4100ff",
      "valid": false,
      "error": "indefinite length"
    },
    {
      "id": "break-byte-as-value",
      "hex": "a16161ff",
      "valid": false,
      "error": "indefinite length"
    },
    {
      "id": "reserved-additional-info",
      "hex": "a161611c",
      "valid": false,
      "error": "reserved additional info"
    },
    {
      "id": "reserved-additional-info-30",
      "hex": "a161611e",
      "valid": false,
      "error": "reserved additional info"
    },
    {
      "id": "top-level-text",
      "hex": "6161",
      "valid": false,
      "error": "top level must be a map"
    },
    {
      "id": "top-level-array",
      "hex": "8101",
      "valid": false,
      "error": "top level must be a map"
    },
    {
      "id": "empty-input",
      "hex": "",
      "valid": false,
      "error": "truncated input"
    },
    {
      "id": "trailing-byte",
      "hex": "a161610100",
      "valid": false,
      "error": "trailing bytes"
    },
    {
      "id": "depth-5",
      "hex": "a16161a16161a16161a16161a1616101",
      "valid": false,
      "error": "map nesting deeper than 4"
    },
    {
      "id": "truncated-value",
      "hex": "a16161",
      "valid": false,
      "error": "truncated input"
    },
    {
      "id": "truncated-key",
      "hex": "a161",
      "valid": false,
      "error": "truncated input"
    },
    {
      "id": "truncated-header",
      "hex": "a161611901",
      "valid": false,
      "error": "truncated input"
    },
    {
      "id": "size-over-4096",
      "hex": "a16161590ffb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      "valid": false,
      "error": "input exceeds 4096 bytes"
    },
    {
      "id": "unsorted-keys",
      "hex": "a2616201616101",
      "valid": false,
      "error": "map keys unsorted or duplicated"
    },
    {
      "id": "keys-wrong-length-first-order",
      "hex": "a262616101616201",
      "valid": false,
      "error": "map keys unsorted or duplicated"
    },
    {
      "id": "duplicate-keys",
      "hex": "a2616101616102",
      "valid": false,
      "error": "map keys unsorted or duplicated"
    },
    {
      "id": "integer-key",
      "hex": "a10101",
      "valid": false,
      "error": "map key must be text"
    },
    {
      "id": "bytes-key",
      "hex": "a1416101",
      "valid": false,
      "error": "map key must be text"
    },
    {
      "id": "nested-unsorted-keys",
      "hex": "a16161a2616201616101",
      "valid": false,
      "error": "map keys unsorted or duplicated"
    },
    {
      "id": "nested-keys-wrong-length-first-order",
      "hex": "a16161a262616101616201",
      "valid": false,
      "error": "map keys unsorted or duplicated"
    },
    {
      "id": "nested-duplicate-keys",
      "hex": "a16161a2616101616102",
      "valid": false,
      "error": "map keys unsorted or duplicated"
    },
    {
      "id": "nested-integer-key",
      "hex": "a16161a10101",
      "valid": false,
      "error": "map key must be text"
    },
    {
      "id": "nested-bytes-key",
      "hex": "a16161a1416101",
      "valid": false,
      "error": "map key must be text"
    },
    {
      "id": "nested-invalid-utf8-key",
      "hex": "a16161a161ff01",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "byte-string-longer-than-input",
      "hex": "a161614a01",
      "valid": false,
      "error": "length exceeds input"
    },
    {
      "id": "byte-string-longer-than-the-rest",
      "hex": "a1616144010203",
      "valid": false,
      "error": "truncated input"
    },
    {
      "id": "bytes-length-2-64-1",
      "hex": "a161615bffffffffffffffff",
      "valid": false,
      "error": "length exceeds input"
    },
    {
      "id": "text-length-2-64-1",
      "hex": "a161617bffffffffffffffff",
      "valid": false,
      "error": "length exceeds input"
    },
    {
      "id": "key-length-2-64-1",
      "hex": "a17bffffffffffffffff",
      "valid": false,
      "error": "length exceeds input"
    },
    {
      "id": "map-count-2-64-1",
      "hex": "bbffffffffffffffff",
      "valid": false,
      "error": "length exceeds input"
    },
    {
      "id": "nested-map-count-longer-than-input",
      "hex": "a16161b8ff",
      "valid": false,
      "error": "length exceeds input"
    },
    {
      "id": "invalid-utf8",
      "hex": "a1616161ff",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-overlong-c080",
      "hex": "a1616162c080",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-overlong-c1bf",
      "hex": "a1616162c1bf",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-overlong-3-byte",
      "hex": "a1616163e09fbf",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-overlong-4-byte",
      "hex": "a1616164f08fbfbf",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-last-surrogate-edbfbf",
      "hex": "a1616163edbfbf",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-lead-f5",
      "hex": "a1616164f5808080",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-surrogate-eda080",
      "hex": "a1616163eda080",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-above-10ffff",
      "hex": "a1616164f4908080",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-truncated-sequence",
      "hex": "a1616162e282",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-lone-continuation",
      "hex": "a161616180",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-bad-continuation",
      "hex": "a1616162c241",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-five-byte-lead",
      "hex": "a1616165f888808080",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "utf8-invalid-in-key",
      "hex": "a161ff01",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "order-minimal-before-float64",
      "hex": "a16161fb0000000000000000",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "order-minimal-before-float32",
      "hex": "a16161fa00000000",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "order-minimal-before-float16",
      "hex": "a16161f90000",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "order-minimal-before-negative-int",
      "hex": "a161613800",
      "valid": false,
      "error": "non-minimal header"
    },
    {
      "id": "order-negative-int-minimal-header",
      "hex": "a1616138ff",
      "valid": false,
      "error": "major type 1 not allowed"
    },
    {
      "id": "order-count-before-depth",
      "hex": "a16161a16162a16163a16164b8ff",
      "valid": false,
      "error": "length exceeds input"
    },
    {
      "id": "order-depth-before-key",
      "hex": "a16161a16162a16163a16164a14161",
      "valid": false,
      "error": "map nesting deeper than 4"
    },
    {
      "id": "order-key-text-before-key-order",
      "hex": "a2616201416101",
      "valid": false,
      "error": "map key must be text"
    },
    {
      "id": "order-key-utf8-before-key-order",
      "hex": "a261620161ff01",
      "valid": false,
      "error": "invalid UTF-8"
    },
    {
      "id": "order-top-level-before-trailing",
      "hex": "0100",
      "valid": false,
      "error": "top level must be a map"
    }
  ],
  "commitments": [
    {
      "id": "issue-bankref",
      "detailsHex": "a2646b696e646569737375656762616e6b526566582040474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b1219",
      "commitment": "9de342429e6618e9db8198ef6ebfddce4148d20259fdac6e5b416ddde4aeaa09"
    },
    {
      "id": "issue-no-bankref",
      "detailsHex": "a1646b696e64656973737565",
      "commitment": "5048b6182d8c7c2819141b5b414c97757c43aee9460dab32902ff96d49cb3ac5"
    },
    {
      "id": "issue-bankref-reason",
      "detailsHex": "a3646b696e6465697373756566726561736f6e697769726520343731316762616e6b526566582040474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b1219",
      "commitment": "d82217842f517a82e1960a0626af5a2e32edef065e866ea64cea21bb69516d69"
    },
    {
      "id": "redeem",
      "detailsHex": "a1646b696e646672656465656d",
      "commitment": "6ff1614f25229c427cb4853a50fd6dea1d0fd28b5a95a5a648a32d86026b480d"
    },
    {
      "id": "reissue",
      "detailsHex": "a3646b696e646772656973737565686f7574706f696e74582410171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e90100000069726563697069656e745821038c44b639733c7893760b8b6a954f79f0e76d71bbc10da8a761be1dae262421ff",
      "commitment": "35957ceeb0074c9998516dd39f16e20e558dc917f92a1cc4bd92667d64fa5164"
    },
    {
      "id": "pause",
      "detailsHex": "a1646b696e64657061757365",
      "commitment": "e885e8f25a98c91a20c922fa97ce07eb415c6a896e6c7749ca6994340c438a5b"
    },
    {
      "id": "unpause",
      "detailsHex": "a2646b696e6467756e706175736566726561736f6e6f696e636964656e7420636c6f736564",
      "commitment": "0c33dd1118235fb9dcc0a8a1974675771eab40098b8d5c7997ae484cdbab6aca"
    },
    {
      "id": "blockIdentity",
      "detailsHex": "a2646b696e646d626c6f636b4964656e746974796b6964656e746974794b65795821027fd738cb67baa2c6818850e56b2c7fe7de87130964dc1c2210b143a8e97bd0a6",
      "commitment": "37b4aeb048402f8674d733986c46bdb582e22f704bde36be54a5817b0d28e393"
    },
    {
      "id": "unblockIdentity",
      "detailsHex": "a2646b696e646f756e626c6f636b4964656e746974796b6964656e746974794b65795821027fd738cb67baa2c6818850e56b2c7fe7de87130964dc1c2210b143a8e97bd0a6",
      "commitment": "2d80e348f85c855d1e25edad784f56572e22c8f4c4c8ca8aadc4b9e33ac529bf"
    },
    {
      "id": "allowIdentity",
      "detailsHex": "a2646b696e646d616c6c6f774964656e746974796b6964656e746974794b65795821027fd738cb67baa2c6818850e56b2c7fe7de87130964dc1c2210b143a8e97bd0a6",
      "commitment": "0a3935aeb8a2b2eb62ea7bb9ae53d033989803367d9bbaa0ea8debf8cf55b4fc"
    },
    {
      "id": "unallowIdentity",
      "detailsHex": "a2646b696e646f756e616c6c6f774964656e746974796b6964656e746974794b65795821027fd738cb67baa2c6818850e56b2c7fe7de87130964dc1c2210b143a8e97bd0a6",
      "commitment": "85d4fcdb7a5f828092f6fdda820526a00f707d685d08eb61562ffc5a67c3c08b"
    },
    {
      "id": "setAccessMode-denylist",
      "detailsHex": "a2646b696e646d7365744163636573734d6f6465646d6f64656864656e796c697374",
      "commitment": "4b3da0a4dd7833d8bd78ca0e488cf0c1355a786a6a9d126017706adbf61309c8"
    },
    {
      "id": "setAccessMode-allowlist",
      "detailsHex": "a2646b696e646d7365744163636573734d6f6465646d6f646569616c6c6f776c697374",
      "commitment": "1c3cfa62fc654864c5cfbc48fd62b8d94d488273c0ae6a99d7e5083e97e5c750"
    },
    {
      "id": "freezeOutput",
      "detailsHex": "a2646b696e646c667265657a654f7574707574686f7574706f696e74582410171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e901000000",
      "commitment": "4e530a63026892b3123479c122a583510f3279ca903f9484eafab5803540a390"
    },
    {
      "id": "unfreezeOutput",
      "detailsHex": "a2646b696e646e756e667265657a654f7574707574686f7574706f696e74582410171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e901000000",
      "commitment": "c9f6ed98e1be170b07a3ce09749376c1f218f6e3bb685eb578d0d44b2435b3d2"
    },
    {
      "id": "setFeeRate",
      "detailsHex": "a2646b696e646a736574466565526174656c666565526174655065724b621903e8",
      "commitment": "3b2798d09437548828294224efc33b38a3574c72b4f3a8651bd3a30a00bb3783"
    },
    {
      "id": "setFeeRate-disabled",
      "detailsHex": "a2646b696e646a736574466565526174656c666565526174655065724b62f6",
      "commitment": "758e4ef1f86db8228525302c0a31798935c86bf4332ba290baf87720a9ae2ce9"
    },
    {
      "id": "admitIdentity",
      "detailsHex": "a2646b696e646d61646d69744964656e746974796b6964656e746974794b65795821027fd738cb67baa2c6818850e56b2c7fe7de87130964dc1c2210b143a8e97bd0a6",
      "commitment": "aaefb0ea584c2313d2b379b558387440617e7da83f41d08c504917b57fdf7a08"
    },
    {
      "id": "revokeIdentity",
      "detailsHex": "a2646b696e646e7265766f6b654964656e746974796b6964656e746974794b65795821027fd738cb67baa2c6818850e56b2c7fe7de87130964dc1c2210b143a8e97bd0a6",
      "commitment": "7eee679cae57aaa531ce4b36a6192cbcc1b75a7bbc14bb15259e99b27187abd5"
    }
  ],
  "deploySig": [
    {
      "id": "digest-1",
      "txid": "abababababababababababababababababababababababababababababababcd",
      "digestHex": "6d616e64616c612d6465706c6f793a61626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626364",
      "issuerIdentityKey": "0364f4edfaef6066ac3b98005c5670d8c771f986640abbd2f804364d271d410f2e",
      "protocolID": [
        2,
        "mandala deploy"
      ],
      "keyID": "1",
      "counterparty": "anyone",
      "signatureHex": "3044022073e985499c764e64d136e92cac1c6fafe42335065c7c396167c2fdbb9835ede202200287c7f0ebc9cbecf1b56ef194ce67ff5b6f862c4a587743b33e08f34cc49682"
    },
    {
      "id": "digest-2",
      "txid": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "digestHex": "6d616e64616c612d6465706c6f793a30303031303230333034303530363037303830393061306230633064306530663130313131323133313431353136313731383139316131623163316431653166",
      "issuerIdentityKey": "0364f4edfaef6066ac3b98005c5670d8c771f986640abbd2f804364d271d410f2e",
      "protocolID": [
        2,
        "mandala deploy"
      ],
      "keyID": "1",
      "counterparty": "anyone",
      "signatureHex": "304402207e8c09fb4c0431feff38603192439068b80e878fef29dfdadb1bc5ce490327b102205ce60329bdf5c50a877b70cbad0c72da69dab8dc41fa8c85f770d3dffa6edc3f"
    }
  ]
}
```
