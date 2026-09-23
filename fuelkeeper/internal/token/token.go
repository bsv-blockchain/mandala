package token

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/bsv-blockchain/go-sdk/script"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
)

// MaxSafeAmount is the maximum amount that can be represented in a token without
// loss of precision (2^53 - 1, the largest safe integer in JavaScript).
const MaxSafeAmount = int64(9007199254740991)

// FTProtocol is the BRC-42 protocol every Mandala token key is derived under
// (lib/src/constants.ts FT_PROTOCOL = [2, 'mandala token']).
var FTProtocol = sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryAppAndCounterparty, Protocol: "mandala token"}

var assetIDRe = regexp.MustCompile(`^[0-9a-f]{64}\.[0-9]+$`)

// EncodeAssetID encodes an assetID string in the form "txid.vout" into its binary representation.
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

// encodeScriptNum encodes an int64 as a bitcoin script number (little-endian, sign-magnitude).
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

// LockToken creates a mandala token locking script with the given assetID, amount, and recipient pubKeyHash.
func LockToken(assetID string, amount int64, pubKeyHash []byte) (*script.Script, error) {
	if len(pubKeyHash) != 20 {
		return nil, fmt.Errorf("pubKeyHash must be 20 bytes")
	}
	if amount < 1 || amount > MaxSafeAmount {
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

// ValidAssetID accepts the canonical lowercase "<txid>.<vout>" form only.
func ValidAssetID(s string) bool { return assetIDRe.MatchString(s) }

// ScriptHash returns the WhatsOnChain script hash of a locking script:
// SHA-256 of the script bytes, byte-reversed, hex (go-wallet-toolbox
// pkg/internal/txutils.HashOutputScript, which is not importable).
func ScriptHash(lockingScript []byte) string {
	sum := sha256.Sum256(lockingScript)
	slices.Reverse(sum[:])
	return hex.EncodeToString(sum[:])
}
