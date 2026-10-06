package mandala

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/wallet"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// NumBytes is a []byte that marshals as a JSON number array (TS number[])
// and, in BSON, as an array of int32 — matching how the TS overlay's Node
// MongoDB driver encodes a plain `number[]` field. This keeps
// mandalaLinkageRecords byte-compatible with the TS-written documents
// (bson.A of numbers), not Go's default of BSON binary for a []byte field.
type NumBytes []byte

func (n *NumBytes) UnmarshalJSON(b []byte) error {
	var ints []int
	if err := json.Unmarshal(b, &ints); err != nil {
		return err
	}
	out := make([]byte, len(ints))
	for i, v := range ints {
		if v < 0 || v > 255 {
			return fmt.Errorf("byte out of range: %d", v)
		}
		out[i] = byte(v)
	}
	*n = out
	return nil
}

func (n NumBytes) MarshalJSON() ([]byte, error) {
	ints := make([]int, len(n))
	for i, b := range n {
		ints[i] = int(b)
	}
	return json.Marshal(ints)
}

// MarshalBSONValue encodes n as a BSON array of int32, matching the shape
// the TS overlay's Mongo driver produces for a plain `number[]` field.
func (n NumBytes) MarshalBSONValue() (byte, []byte, error) {
	arr := make(bson.A, len(n))
	for i, b := range n {
		arr[i] = int32(b)
	}
	t, data, err := bson.MarshalValue(arr)
	if err != nil {
		return 0, nil, err
	}
	return byte(t), data, nil
}

// UnmarshalBSONValue decodes a BSON array of any numeric type into bytes.
// It also defensively accepts BSON binary and BSON null/undefined as an
// empty/nil value.
func (n *NumBytes) UnmarshalBSONValue(t byte, data []byte) error {
	switch bson.Type(t) {
	case bson.TypeArray:
		var arr bson.A
		if err := bson.UnmarshalValue(bson.Type(t), data, &arr); err != nil {
			return err
		}
		out := make([]byte, len(arr))
		for i, v := range arr {
			iv, err := bsonNumberToInt(v)
			if err != nil {
				return fmt.Errorf("numBytes[%d]: %w", i, err)
			}
			if iv < 0 || iv > 255 {
				return fmt.Errorf("numBytes[%d]: byte out of range: %d", i, iv)
			}
			out[i] = byte(iv)
		}
		*n = out
		return nil
	case bson.TypeBinary:
		var bin bson.Binary
		if err := bson.UnmarshalValue(bson.Type(t), data, &bin); err != nil {
			return err
		}
		*n = bin.Data
		return nil
	case bson.TypeNull, bson.TypeUndefined:
		*n = nil
		return nil
	default:
		return fmt.Errorf("numBytes: unsupported bson type %v", bson.Type(t))
	}
}

// bsonNumberToInt converts a decoded BSON numeric value (int32, int64, or
// double — however the writer chose to encode it) to an int.
func bsonNumberToInt(v any) (int, error) {
	switch x := v.(type) {
	case int32:
		return int(x), nil
	case int64:
		return int(x), nil
	case float64:
		return int(x), nil
	case float32:
		return int(x), nil
	default:
		return 0, fmt.Errorf("expected numeric value, got %T", v)
	}
}

// ProtocolID mirrors the TS SDK's WalletProtocol tuple [SecurityLevel,
// ProtocolString]: a 2-element JSON array on the wire and a 2-element BSON
// array in Mongo. A string or fractional security level is a decode error
// (D-13: strict typing where TS would coerce it into the invoice string).
type ProtocolID struct {
	SecurityLevel int
	Name          string
}

func (p *ProtocolID) UnmarshalJSON(b []byte) error {
	var arr []json.RawMessage
	if err := json.Unmarshal(b, &arr); err != nil {
		return err
	}
	if len(arr) != 2 {
		return fmt.Errorf("protocolID must be a 2-element array, got %d", len(arr))
	}
	if err := json.Unmarshal(arr[0], &p.SecurityLevel); err != nil {
		return err
	}
	return json.Unmarshal(arr[1], &p.Name)
}

func (p ProtocolID) MarshalJSON() ([]byte, error) {
	return json.Marshal([2]any{p.SecurityLevel, p.Name})
}

// MarshalBSONValue encodes p as a 2-element BSON array [securityLevel, name].
func (p ProtocolID) MarshalBSONValue() (byte, []byte, error) {
	t, data, err := bson.MarshalValue(bson.A{int32(p.SecurityLevel), p.Name})
	if err != nil {
		return 0, nil, err
	}
	return byte(t), data, nil
}

// UnmarshalBSONValue decodes a 2-element BSON array into p, accepting int32,
// int64, or double for the security level.
func (p *ProtocolID) UnmarshalBSONValue(t byte, data []byte) error {
	if bson.Type(t) != bson.TypeArray {
		return fmt.Errorf("protocolID: expected bson array, got %v", bson.Type(t))
	}
	var arr bson.A
	if err := bson.UnmarshalValue(bson.Type(t), data, &arr); err != nil {
		return err
	}
	if len(arr) != 2 {
		return fmt.Errorf("protocolID must be a 2-element array, got %d", len(arr))
	}
	level, err := bsonNumberToInt(arr[0])
	if err != nil {
		return fmt.Errorf("protocolID[0]: %w", err)
	}
	name, ok := arr[1].(string)
	if !ok {
		return fmt.Errorf("protocolID[1]: expected string, got %T", arr[1])
	}
	p.SecurityLevel = level
	p.Name = name
	return nil
}

// SpecificLinkage is a BRC-72 specific key linkage revelation (TS SpecificLinkage).
type SpecificLinkage struct {
	Prover                string     `json:"prover" bson:"prover"`
	Verifier              string     `json:"verifier" bson:"verifier"`
	Counterparty          string     `json:"counterparty" bson:"counterparty"`
	ProtocolID            ProtocolID `json:"protocolID" bson:"protocolID"`
	KeyID                 string     `json:"keyID" bson:"keyID"`
	EncryptedLinkage      NumBytes   `json:"encryptedLinkage" bson:"encryptedLinkage"`
	EncryptedLinkageProof NumBytes   `json:"encryptedLinkageProof" bson:"encryptedLinkageProof"`
	ProofType             int        `json:"proofType" bson:"proofType"`
}

// ParseLinkage types one envelope linkage body (IndexedLinkage.Raw). Keys are
// matched exactly (TS reads linkage.prover, never linkage.Prover; encoding/json
// struct decoding would bind case-insensitively), an absent key leaves the zero
// value, and a present key of the wrong JSON type is an error (D-13: a string
// or fractional security level, a fractional byte, a non-string keyID). Callers
// map any error to rNoLinkage (outputs) or rInputLinkageControl (inputs).
func ParseLinkage(raw json.RawMessage) (*SpecificLinkage, error) {
	if jsonFirstByte(raw) != '{' {
		return nil, errors.New("linkage: not an object")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("linkage: %w", err)
	}
	var l SpecificLinkage
	for _, f := range []struct {
		key string
		dst any
	}{
		{"prover", &l.Prover},
		{"verifier", &l.Verifier},
		{"counterparty", &l.Counterparty},
		{"protocolID", &l.ProtocolID},
		{"keyID", &l.KeyID},
		{"encryptedLinkage", &l.EncryptedLinkage},
		{"encryptedLinkageProof", &l.EncryptedLinkageProof},
		{"proofType", &l.ProofType},
	} {
		v, ok := fields[f.key]
		if !ok {
			continue
		}
		if err := json.Unmarshal(v, f.dst); err != nil {
			return nil, fmt.Errorf("linkage %s: %w", f.key, err)
		}
	}
	return &l, nil
}

// LinkageVerifier verifies BRC-72 linkages for layer B.
type LinkageVerifier interface {
	VerifyKeyLinkage(ctx context.Context, l *SpecificLinkage) (identityKey string, pubKeyHash []byte, err error) // base = counterparty; identityKey = CanonicalKey(counterparty)
	VerifyInputLinkage(ctx context.Context, l *SpecificLinkage) (prover string, pubKeyHash []byte, err error)    // base = prover; prover = CanonicalKey(prover)
}

// Verifier holds the verifier's identity key and wraps a go-sdk ProtoWallet,
// which performs the BRC-2/42/43 decryption needed to unwrap a specific key
// linkage revelation (BRC-72 §2.5).
type Verifier struct {
	pw       *wallet.ProtoWallet
	identity string
}

var _ LinkageVerifier = (*Verifier)(nil)

// NewVerifier builds a Verifier from a hex-encoded secp256k1 private key.
func NewVerifier(privHex string) (*Verifier, error) {
	priv, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		return nil, fmt.Errorf("verifier key: %w", err)
	}
	pw, err := wallet.NewProtoWallet(wallet.ProtoWalletArgs{
		Type:       wallet.ProtoWalletArgsTypePrivateKey,
		PrivateKey: priv,
	})
	if err != nil {
		return nil, err
	}
	return &Verifier{pw: pw, identity: priv.PubKey().ToDERHex()}, nil
}

// IdentityKey returns the verifier's own identity public key, compressed lowercase hex.
func (v *Verifier) IdentityKey() string { return v.identity }

// VerifyKeyLinkage verifies a linkage revealed for an OUTPUT: the derived key
// is counterparty + L·G and the party named is the counterparty, returned in
// canonical (compressed lowercase) form (TS verifyKeyLinkage + canonicalKey).
func (v *Verifier) VerifyKeyLinkage(ctx context.Context, l *SpecificLinkage) (string, []byte, error) {
	if l == nil {
		return "", nil, errors.New("nil linkage")
	}
	pkh, err := v.deriveLinkedKey(ctx, l, l.Counterparty)
	if err != nil {
		return "", nil, err
	}
	identity, err := CanonicalKey(l.Counterparty)
	if err != nil {
		return "", nil, fmt.Errorf("counterparty key: %w", err)
	}
	return identity, pkh, nil
}

// VerifyInputLinkage verifies a linkage revealed for a coin BEING SPENT: the
// coin was locked to the spender's own child key, so the key is prover + L·G
// and the party is the prover, returned canonical (TS verifyInputKeyLinkage).
func (v *Verifier) VerifyInputLinkage(ctx context.Context, l *SpecificLinkage) (string, []byte, error) {
	if l == nil {
		return "", nil, errors.New("nil linkage")
	}
	pkh, err := v.deriveLinkedKey(ctx, l, l.Prover)
	if err != nil {
		return "", nil, err
	}
	prover, err := CanonicalKey(l.Prover)
	if err != nil {
		return "", nil, fmt.Errorf("prover key: %w", err)
	}
	return prover, pkh, nil
}

// deriveLinkedKey ports TS deriveLinkedKey (verifyKeyLinkage.ts:21-39): decrypt
// L under [2, "specific linkage revelation <level> <name>"], the linkage keyID
// and the prover as counterparty, then hash160(base + L·G). The prover must be
// a 66-hex compressed key, as TS validateCounterparty requires for decrypt; it is
// not trimmed (D-13: a padded prover is refused).
func (v *Verifier) deriveLinkedKey(ctx context.Context, l *SpecificLinkage, base string) ([]byte, error) {
	if len(l.Prover) != 66 {
		return nil, errors.New("prover key: must be 66 hex characters")
	}
	proverPub, err := ec.PublicKeyFromString(l.Prover)
	if err != nil {
		return nil, fmt.Errorf("prover key: %w", err)
	}
	dec, err := v.pw.Decrypt(ctx, wallet.DecryptArgs{
		EncryptionArgs: wallet.EncryptionArgs{
			ProtocolID: wallet.Protocol{
				SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty,
				Protocol:      fmt.Sprintf("specific linkage revelation %d %s", l.ProtocolID.SecurityLevel, l.ProtocolID.Name),
			},
			KeyID:        l.KeyID,
			Counterparty: wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: proverPub},
		},
		Ciphertext: []byte(l.EncryptedLinkage),
	}, "")
	if err != nil {
		return nil, fmt.Errorf("linkage decrypt: %w", err)
	}
	basePub, err := ec.PublicKeyFromString(base)
	if err != nil {
		return nil, fmt.Errorf("base key: %w", err)
	}
	curve := ec.S256()
	scalar := new(big.Int).SetBytes(dec.Plaintext)
	scalar.Mod(scalar, curve.Params().N)
	lx, ly := curve.ScalarBaseMult(scalar.Bytes())
	dx, dy := curve.Add(basePub.X, basePub.Y, lx, ly)
	derived := &ec.PublicKey{Curve: curve, X: dx, Y: dy}
	return hash.Hash160(derived.Compressed()), nil
}

var compressedKeyPattern = regexp.MustCompile(`^0[23][0-9a-f]{64}$`)

// CanonicalKey is TS canonicalKey (PublicKey.fromString(k).toString()): any parseable
// key (upper case, uncompressed) in compressed lowercase hex. go-sdk v1.7.1 parses a
// compressed key whose x is not below the field prime p and echoes that x; @bsv/sdk
// re-encodes the reduced point, so x is reduced mod p here too (D-22):
// "02"+"ff"x32 -> "0200…01000003d0", which IsCanonicalKey then refuses.
func CanonicalKey(k string) (string, error) {
	pk, err := ec.PublicKeyFromString(k)
	if err != nil {
		return "", err
	}
	if p := ec.S256().Params().P; pk.X.Cmp(p) >= 0 {
		pk.X = new(big.Int).Mod(pk.X, p)
	}
	return pk.ToDERHex(), nil
}

// IsIdentity is TS isIdentity: the compressed-key regex only, no curve check.
func IsIdentity(k string) bool { return compressedKeyPattern.MatchString(k) }

// IsCanonicalKey is TS isCanonicalKey: IsIdentity, on the curve and x below p
// (CanonicalKey(k) == k).
func IsCanonicalKey(k string) bool {
	if !IsIdentity(k) {
		return false
	}
	c, err := CanonicalKey(k)
	return err == nil && c == k
}
