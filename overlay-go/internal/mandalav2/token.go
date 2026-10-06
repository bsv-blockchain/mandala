package mandalav2

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"github.com/bsv-blockchain/go-sdk/script"
)

const maxSafeAmount = int64(9007199254740991)

type TokenDecoded struct {
	AssetID    string
	Amount     int64
	PubKeyHash [20]byte
}

func EncodeAssetID(assetID string) ([]byte, error) {
	dot := strings.LastIndexByte(assetID, '.')
	if dot < 0 {
		return nil, fmt.Errorf("assetId missing vout: %q", assetID)
	}
	txidHex, voutStr := assetID[:dot], assetID[dot+1:]
	if len(txidHex) != 64 {
		return nil, fmt.Errorf("assetId txid must be 64 hex chars")
	}
	txid, err := hex.DecodeString(txidHex)
	if err != nil {
		return nil, err
	}
	vout, err := strconv.ParseUint(voutStr, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("assetId vout: %w", err)
	}
	out := make([]byte, 36)
	for i := 0; i < 32; i++ { // display order -> internal order
		out[i] = txid[31-i]
	}
	binary.LittleEndian.PutUint32(out[32:], uint32(vout))
	return out, nil
}

func DecodeAssetID(b []byte) (string, error) {
	if len(b) != 36 {
		return "", fmt.Errorf("assetId must be 36 bytes, got %d", len(b))
	}
	rev := make([]byte, 32)
	for i := 0; i < 32; i++ {
		rev[i] = b[31-i]
	}
	vout := binary.LittleEndian.Uint32(b[32:])
	return fmt.Sprintf("%s.%d", hex.EncodeToString(rev), vout), nil
}

// decodeScriptNumChunk accepts OP_0/OP_1NEGATE/OP_1..OP_16 opcode forms and
// little-endian sign-magnitude data forms (Appendix A §1.1).
func decodeScriptNumChunk(op byte, data []byte) (int64, error) {
	switch {
	case op == script.Op0:
		return 0, nil
	case op == script.Op1NEGATE:
		return -1, nil
	case op >= script.Op1 && op <= script.Op16:
		return int64(op-script.Op1) + 1, nil
	}
	if len(data) == 0 {
		return 0, nil
	}
	if len(data) > 8 {
		return 0, fmt.Errorf("script number too large")
	}
	var n int64
	for i := len(data) - 1; i >= 0; i-- {
		b := data[i]
		if i == len(data)-1 {
			n = int64(b & 0x7f)
		} else {
			n = n<<8 | int64(b)
		}
	}
	if data[len(data)-1]&0x80 != 0 {
		n = -n
	}
	return n, nil
}

func encodeScriptNum(n int64) []byte {
	if n == 0 {
		return nil
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var out []byte
	for n > 0 {
		out = append(out, byte(n&0xff))
		n >>= 8
	}
	if out[len(out)-1]&0x80 != 0 {
		if neg {
			out = append(out, 0x80)
		} else {
			out = append(out, 0x00)
		}
	} else if neg {
		out[len(out)-1] |= 0x80
	}
	return out
}

func DecodeToken(s *script.Script) (*TokenDecoded, error) {
	chunks, err := s.Chunks()
	if err != nil {
		return nil, err
	}
	if len(chunks) != 8 {
		return nil, fmt.Errorf("not a mandala token: %d chunks", len(chunks))
	}
	if chunks[2].Op != script.Op2DROP || chunks[3].Op != script.OpDUP ||
		chunks[4].Op != script.OpHASH160 || chunks[6].Op != script.OpEQUALVERIFY ||
		chunks[7].Op != script.OpCHECKSIG {
		return nil, fmt.Errorf("not a mandala token: opcode shape")
	}
	if len(chunks[0].Data) != 36 {
		return nil, fmt.Errorf("not a mandala token: assetId push")
	}
	assetID, err := DecodeAssetID(chunks[0].Data)
	if err != nil {
		return nil, err
	}
	amount, err := decodeScriptNumChunk(chunks[1].Op, chunks[1].Data)
	if err != nil {
		return nil, err
	}
	if amount < 1 || amount > maxSafeAmount {
		return nil, fmt.Errorf("invalid token amount %d", amount)
	}
	if len(chunks[5].Data) != 20 {
		return nil, fmt.Errorf("not a mandala token: pkh push")
	}
	d := &TokenDecoded{AssetID: assetID, Amount: amount}
	copy(d.PubKeyHash[:], chunks[5].Data)
	return d, nil
}

func LockToken(assetID string, amount int64, pubKeyHash []byte) (*script.Script, error) {
	if len(pubKeyHash) != 20 {
		return nil, fmt.Errorf("pubKeyHash must be 20 bytes")
	}
	if amount < 1 || amount > maxSafeAmount {
		return nil, fmt.Errorf("amount out of range")
	}
	aid, err := EncodeAssetID(assetID)
	if err != nil {
		return nil, err
	}
	s := &script.Script{}
	if err := s.AppendPushData(aid); err != nil {
		return nil, fmt.Errorf("lock token: append asset id: %w", err)
	}
	if amount <= 16 { // minimal-push opcode form
		if err := s.AppendOpcodes(script.Op1 + byte(amount-1)); err != nil {
			return nil, fmt.Errorf("lock token: append amount opcode: %w", err)
		}
	} else {
		if err := s.AppendPushData(encodeScriptNum(amount)); err != nil {
			return nil, fmt.Errorf("lock token: append amount data: %w", err)
		}
	}
	if err := s.AppendOpcodes(script.Op2DROP, script.OpDUP, script.OpHASH160); err != nil {
		return nil, fmt.Errorf("lock token: append opcodes (2DROP/DUP/HASH160): %w", err)
	}
	if err := s.AppendPushData(pubKeyHash); err != nil {
		return nil, fmt.Errorf("lock token: append pubkey hash: %w", err)
	}
	if err := s.AppendOpcodes(script.OpEQUALVERIFY, script.OpCHECKSIG); err != nil {
		return nil, fmt.Errorf("lock token: append opcodes (EQUALVERIFY/CHECKSIG): %w", err)
	}
	return s, nil
}
