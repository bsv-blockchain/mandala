package brc162

import (
	"encoding/hex"
	"regexp"
)

// Role is a BRC-162 output role (TS Bsv21Role).
type Role string

const (
	RoleDeploy    Role = "deploy"
	RoleAuthority Role = "authority"
	RoleValue     Role = "value"
)

const (
	TokenIDBytes    = 32
	PubKeyHashBytes = 20
	MaxAmountBytes  = 9
)

// CodecError is TS Bsv21BinaryError. Message is the exact cross-engine string
// (fact base ts-codec §4).
type CodecError struct{ Message string }

func (e *CodecError) Error() string { return e.Message }

func fail(message string) error { return &CodecError{Message: message} }

func isSmallIntOp(op byte) bool { return op >= op1 && op <= op16 }

func isPushOp(op byte) bool { return op <= opPushData4 || op == op1Negate || isSmallIntOp(op) }

// Decoded is TS Bsv21BinaryDecoded.
type Decoded struct {
	Role             Role
	TokenID          *[32]byte // natural (internal) byte order; nil for a deploy
	Amount           uint64
	Payload          []byte // meaningful only when HasPayload
	HasPayload       bool   // an OP_0 payload is present and empty
	PayloadCanonical bool   // true when there is no payload
	RestChunks       []Chunk
	RestPubKeyHash   []byte // 20 bytes iff RestChunks is exactly OP_DUP OP_HASH160 <0x14 push of 20> OP_EQUALVERIFY OP_CHECKSIG
}

func tokenShaped(c []Chunk) bool {
	return len(c) >= 3 && isPushOp(c[0].Op) && isPushOp(c[1].Op) && c[2].Op == op2Drop
}

// IsTokenShaped reports whether the script begins `<push> <push> OP_2DROP`
// (Bsv21Binary.ts:118-121). A truncated push still counts as a push.
func IsTokenShaped(script []byte) bool { return tokenShaped(ParseChunks(script)) }

// Decode ports Bsv21Binary.decode (Bsv21Binary.ts:197-213), checks in this order:
// shape, "truncated push" over EVERY chunk, token id, amount, payload split.
func Decode(script []byte) (*Decoded, error) {
	c := ParseChunks(script)
	if !tokenShaped(c) {
		return nil, fail("not a BRC-162 token output")
	}
	for _, ch := range c {
		if ch.InvalidLength {
			return nil, fail("truncated push")
		}
	}
	id, err := decodeTokenID(c[0])
	if err != nil {
		return nil, err
	}
	amount, err := DecodeAmountChunk(c[1])
	if err != nil {
		return nil, err
	}
	payload, hasPayload, canonical, rest := splitPayload(c[3:])
	return &Decoded{
		Role:             roleOf(id, amount),
		TokenID:          id,
		Amount:           amount,
		Payload:          payload,
		HasPayload:       hasPayload,
		PayloadCanonical: canonical,
		RestChunks:       rest,
		RestPubKeyHash:   p2pkhHash(rest),
	}, nil
}

func decodeTokenID(c Chunk) (*[32]byte, error) {
	if c.Op == op0 {
		return nil, nil
	}
	if c.Op != TokenIDBytes || len(c.Data) != TokenIDBytes {
		return nil, fail("token id must be a direct 32-byte push")
	}
	var id [32]byte
	copy(id[:], c.Data)
	return &id, nil
}

func roleOf(id *[32]byte, amount uint64) Role {
	if id == nil {
		return RoleDeploy
	}
	if amount == 0 {
		return RoleAuthority
	}
	return RoleValue
}

// EncodeAmountChunk ports encodeAmountChunk (Bsv21Binary.ts:57-70). The TS
// "amount outside 0..2^64-1" refusal cannot arise for a uint64.
func EncodeAmountChunk(amount uint64) Chunk {
	if amount == 0 {
		return Chunk{Op: op0}
	}
	if amount <= 16 {
		return Chunk{Op: op1 + byte(amount) - 1}
	}
	var data []byte
	var top byte
	for v := amount; v > 0; v >>= 8 {
		top = byte(v)
		data = append(data, top)
	}
	if top&0x80 != 0 {
		data = append(data, 0x00)
	}
	return Chunk{Op: byte(len(data)), Data: data}
}

// DecodeAmountChunk ports decodeAmountChunk (Bsv21Binary.ts:87-101), check
// order: OP_0, OP_1..OP_16, direct push of 1-9 bytes, negative, minimal,
// 0..16 as data, above 2^64-1.
func DecodeAmountChunk(c Chunk) (uint64, error) {
	if c.Op == op0 {
		return 0, nil
	}
	if isSmallIntOp(c.Op) {
		return uint64(c.Op-op1) + 1, nil
	}
	if c.Op < 1 || c.Op > MaxAmountBytes || len(c.Data) != int(c.Op) {
		return 0, fail("amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes")
	}
	d := c.Data
	top := d[len(d)-1]
	if top&0x80 != 0 {
		return 0, fail("amount must not be negative")
	}
	if !isMinimalScriptNum(d) {
		return 0, fail("amount is not minimally encoded")
	}
	// A 9-byte push whose top byte is not the sign pad holds a value >= 2^64,
	// which is also > 16, so this check keeps the TS order.
	if len(d) == MaxAmountBytes && top != 0 {
		return 0, fail("amount exceeds 2^64-1")
	}
	var v uint64
	for i := min(len(d), 8) - 1; i >= 0; i-- {
		v = v<<8 | uint64(d[i])
	}
	if v <= 16 {
		return 0, fail("amounts 0..16 must use OP_0/OP_1..OP_16")
	}
	return v, nil
}

// isMinimalScriptNum: the top byte may be zero only as the sign pad of a value
// byte with its high bit set (Bsv21Binary.ts:76-79).
func isMinimalScriptNum(d []byte) bool {
	top := d[len(d)-1]
	return top&0x7f != 0 || (len(d) > 1 && d[len(d)-2]&0x80 != 0)
}

var tokenIDPattern = regexp.MustCompile(`^[0-9a-f]{64}_0$`)

// TokenIDToString formats 32 wire bytes (natural order) as `<64 hex, display order>_0`.
func TokenIDToString(id [32]byte) string {
	var rev [32]byte
	for i := range id {
		rev[31-i] = id[i]
	}
	return hex.EncodeToString(rev[:]) + "_0"
}

// TokenIDFromString parses `<64 lowercase hex, display order>_0` into the 32 wire bytes.
func TokenIDFromString(s string) ([32]byte, error) {
	var id [32]byte
	if !tokenIDPattern.MatchString(s) {
		return id, fail("token id must be <64 lowercase hex>_0")
	}
	raw, _ := hex.DecodeString(s[:64])
	for i := range raw {
		id[31-i] = raw[i]
	}
	return id, nil
}

// canonicalPushOp is the minimal push opcode for raw bytes (Bsv21Binary.ts:124-132).
func canonicalPushOp(d []byte) byte {
	switch {
	case len(d) == 0:
		return op0
	case len(d) == 1 && d[0] >= 1 && d[0] <= 16:
		return op1 + d[0] - 1
	case len(d) == 1 && d[0] == 0x81:
		return op1Negate
	case len(d) <= 75:
		return byte(len(d))
	case len(d) <= 0xff:
		return opPushData1
	case len(d) <= 0xffff:
		return opPushData2
	default:
		return opPushData4
	}
}

// payloadChunk: OP_0, OP_1..OP_16 and OP_1NEGATE carry no data (Bsv21Binary.ts:135-138).
func payloadChunk(d []byte) Chunk {
	op := canonicalPushOp(d)
	if op == op0 || op > opPushData4 {
		return Chunk{Op: op}
	}
	return Chunk{Op: op, Data: append([]byte{}, d...)}
}

// pushedBytes (Bsv21Binary.ts:140-144).
func pushedBytes(c Chunk) []byte {
	if c.Op == op1Negate {
		return []byte{0x81}
	}
	if isSmallIntOp(c.Op) {
		return []byte{c.Op - op1 + 1}
	}
	return append([]byte{}, c.Data...)
}

// splitPayload: only the first `<push> OP_DROP` after OP_2DROP is the payload
// (Bsv21Binary.ts:153-164).
func splitPayload(after []Chunk) (payload []byte, hasPayload, canonical bool, rest []Chunk) {
	if len(after) < 2 || !isPushOp(after[0].Op) || after[1].Op != opDrop {
		return nil, false, true, after
	}
	p := pushedBytes(after[0])
	return p, true, after[0].Op == canonicalPushOp(p), after[2:]
}

var p2pkhOps = [5]byte{opDup, opHash160, PubKeyHashBytes, opEqualVerify, opCheckSig}

// p2pkhHash (Bsv21Binary.ts:166-172).
func p2pkhHash(rest []Chunk) []byte {
	if len(rest) != len(p2pkhOps) {
		return nil
	}
	for i, c := range rest {
		if c.Op != p2pkhOps[i] {
			return nil
		}
	}
	if len(rest[2].Data) != PubKeyHashBytes {
		return nil
	}
	return append([]byte{}, rest[2].Data...)
}

// LockParams are Bsv21Binary.lock's arguments.
type LockParams struct {
	TokenID    string // "" = deploy (OP_0 id)
	Amount     uint64
	PubKeyHash []byte // must be 20 bytes
	Payload    []byte
	HasPayload bool
}

// Lock ports Bsv21Binary.lock (Bsv21Binary.ts:216-237), order: pkh length, id,
// amount chunk, OP_2DROP, [canonical payload push, OP_DROP], canonical P2PKH.
func Lock(p LockParams) ([]byte, error) {
	if len(p.PubKeyHash) != PubKeyHashBytes {
		return nil, fail("pubKeyHash must be 20 bytes")
	}
	idChunk := Chunk{Op: op0}
	if p.TokenID != "" {
		id, err := TokenIDFromString(p.TokenID)
		if err != nil {
			return nil, err
		}
		idChunk = Chunk{Op: TokenIDBytes, Data: id[:]}
	}
	chunks := []Chunk{idChunk, EncodeAmountChunk(p.Amount), {Op: op2Drop}}
	if p.HasPayload {
		chunks = append(chunks, payloadChunk(p.Payload), Chunk{Op: opDrop})
	}
	chunks = append(chunks,
		Chunk{Op: opDup},
		Chunk{Op: opHash160},
		Chunk{Op: PubKeyHashBytes, Data: append([]byte{}, p.PubKeyHash...)},
		Chunk{Op: opEqualVerify},
		Chunk{Op: opCheckSig},
	)
	return serializeChunks(chunks), nil
}
