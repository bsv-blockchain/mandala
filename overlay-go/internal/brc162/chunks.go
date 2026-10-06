package brc162

// Opcodes the chunker and codec read. Hard-coded: this file and codec.go never
// import go-sdk/script (TestCodecNeverImportsTheGoSDKScriptPackage).
const (
	op0           byte = 0x00
	opPushData1   byte = 0x4c
	opPushData2   byte = 0x4d
	opPushData4   byte = 0x4e
	op1Negate     byte = 0x4f
	op1           byte = 0x51
	op16          byte = 0x60
	opIf          byte = 0x63
	opNotIf       byte = 0x64
	opVerIf       byte = 0x65
	opVerNotIf    byte = 0x66
	opEndIf       byte = 0x68
	opReturn      byte = 0x6a
	op2Drop       byte = 0x6d
	opDrop        byte = 0x75
	opDup         byte = 0x76
	opEqualVerify byte = 0x88
	opHash160     byte = 0xa9
	opCheckSig    byte = 0xac
)

// Chunk is one parsed script element (TS ScriptChunk).
type Chunk struct {
	Op            byte
	Data          []byte // pushed bytes; nil for non-push opcodes and OP_0; for an OP_RETURN at depth 0, every remaining byte
	InvalidLength bool   // TS invalidLength: truncated data or length bytes; always the last chunk
}

// ParseChunks ports TS Script.#parseChunks (ts-stack 37468f290
// packages/sdk/src/script/Script.ts:599-626; fact base ts-codec §1.1-§1.2):
// OP_RETURN swallows the rest only at conditional depth 0; IF/NOTIF/VERIF/VERNOTIF
// increment the depth and ENDIF decrements it unconditionally, so after an
// unmatched ENDIF the depth is -1 and OP_RETURN is a plain opcode. A push whose
// length bytes or data run past the end is kept with the bytes present and
// InvalidLength set.
func ParseChunks(script []byte) []Chunk {
	chunks := make([]Chunk, 0, 8)
	length := len(script)
	pos := 0
	depth := 0
	for pos < length {
		op := script[pos]
		pos++
		if op == opReturn && depth == 0 {
			chunks = append(chunks, Chunk{Op: op, Data: copyRange(script, pos, length)})
			break
		}
		switch op {
		case opIf, opNotIf, opVerIf, opVerNotIf:
			depth++
		case opEndIf:
			depth--
		}
		if op > 0 && op <= opPushData4 {
			n, newPos, hasLength := readPushLength(op, script, pos)
			pos = newPos
			end := min(pos+n, length)
			chunks = append(chunks, Chunk{
				Op:            op,
				Data:          copyRange(script, pos, end),
				InvalidLength: !hasLength || end-pos != n,
			})
			pos = end
		} else {
			chunks = append(chunks, Chunk{Op: op})
		}
	}
	return chunks
}

// readPushLength ports TS Script.#readPushdataLength (Script.ts:569-597): a
// missing length byte reads as 0 and clears hasLength.
func readPushLength(op byte, b []byte, pos int) (n, newPos int, hasLength bool) {
	length := len(b)
	at := func(i int) int {
		if i < length {
			return int(b[i])
		}
		return 0
	}
	switch op {
	case opPushData1:
		if pos < length {
			return int(b[pos]), pos + 1, true
		}
		return 0, pos, false
	case opPushData2:
		return at(pos) | at(pos+1)<<8, min(pos+2, length), pos+1 < length
	case opPushData4:
		// TS reads the four bytes as a uint32 (>>> 0). Assemble them as uint32 and
		// compare with the bytes left before converting to int, so a top byte >= 0x80
		// cannot wrap negative on 32-bit builds.
		v := uint32(at(pos)) | uint32(at(pos+1))<<8 | uint32(at(pos+2))<<16 | uint32(at(pos+3))<<24
		newPos = min(pos+4, length)
		return pushData4Length(v, length-newPos), newPos, pos+3 < length
	default: // 0x01..0x4b: direct push
		return int(op), pos, true
	}
}

// pushData4Length converts a PUSHDATA4 length to an int without wrapping on
// 32-bit builds. A length above the bytes left (left >= 0) can never be
// satisfied, so it becomes left+1: ParseChunks then takes the truncated-push
// path (end = length, end-pos != n), exactly as the TS uint32 length does.
func pushData4Length(v uint32, left int) int {
	if uint64(v) > uint64(left) {
		return left + 1
	}
	return int(v)
}

func copyRange(b []byte, start, end int) []byte {
	out := make([]byte, max(end-start, 0))
	copy(out, b[start:max(end, start)])
	return out
}

// SerializeChunk ports the per-chunk part of TS Script.#serializeChunksToBytes
// (Script.ts:473-490, #writeChunkData :539-563): the chunk's own op, then (when
// Data != nil) an OP_RETURN's data raw, or a length prefix sized by the op and
// the data. Never re-minimised.
func SerializeChunk(c Chunk) []byte {
	out := []byte{c.Op}
	if c.Data == nil {
		return out
	}
	n := len(c.Data)
	switch {
	case c.Op == opReturn:
	case c.Op < opPushData1:
	case c.Op == opPushData1:
		out = append(out, byte(n))
	case c.Op == opPushData2:
		out = append(out, byte(n), byte(n>>8))
	case c.Op == opPushData4:
		out = append(out, byte(n), byte(n>>8), byte(n>>16), byte(n>>24))
	default:
		return out
	}
	return append(out, c.Data...)
}

func serializeChunks(chunks []Chunk) []byte {
	var out []byte
	for _, c := range chunks {
		out = append(out, SerializeChunk(c)...)
	}
	return out
}
