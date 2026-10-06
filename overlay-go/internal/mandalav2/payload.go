package mandalav2

import (
	"encoding/json"
	"fmt"
	"math"

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
// It also defensively accepts BSON binary (Go's own default encoding, in
// case any documents were ever written by an older Go build) and BSON
// null/undefined as an empty/nil value.
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

// ProtocolID mirrors the TS SDK's WalletProtocol tuple type
// [SecurityLevel, ProtocolString]. It marshals to/from a 2-element JSON
// array in the wire payload and, in BSON, to/from a 2-element array —
// matching how the TS overlay's Mongo driver encodes a plain JS tuple
// array, not Go's default of an embedded document with lowercased keys.
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

// MarshalBSONValue encodes p as a 2-element BSON array [securityLevel,
// name], matching the shape the TS overlay's Mongo driver produces for a
// plain JS tuple like [2, "mandala token"].
func (p ProtocolID) MarshalBSONValue() (byte, []byte, error) {
	t, data, err := bson.MarshalValue(bson.A{int32(p.SecurityLevel), p.Name})
	if err != nil {
		return 0, nil, err
	}
	return byte(t), data, nil
}

// UnmarshalBSONValue decodes a 2-element BSON array into p, accepting
// int32, int64, or double for the security-level element (however the
// writer chose to encode the small integer).
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

type SpecificLinkage struct {
	Prover                string     `bson:"prover" json:"prover"`
	Verifier              string     `bson:"verifier" json:"verifier"`
	Counterparty          string     `bson:"counterparty" json:"counterparty"`
	ProtocolID            ProtocolID `bson:"protocolID" json:"protocolID"`
	KeyID                 string     `bson:"keyID" json:"keyID"`
	EncryptedLinkage      NumBytes   `bson:"encryptedLinkage" json:"encryptedLinkage"`
	EncryptedLinkageProof NumBytes   `bson:"encryptedLinkageProof" json:"encryptedLinkageProof"`
	ProofType             int        `bson:"proofType" json:"proofType"`
}

type ActionDetails map[string]any

func (d ActionDetails) Kind() string {
	s, _ := d["kind"].(string)
	return s
}

func (d ActionDetails) Str(key string) (string, bool) {
	s, ok := d[key].(string)
	return s, ok
}

func (d ActionDetails) Num(key string) (int64, bool) {
	f, ok := d[key].(float64)
	if !ok || f != math.Trunc(f) {
		return 0, false
	}
	if math.Abs(f) > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}

type IndexedLinkage struct {
	Index   uint32           `json:"index"`
	Linkage *SpecificLinkage `json:"linkage"`
}

type IndexedAdmin struct {
	Index         uint32        `json:"index"`
	ActionDetails ActionDetails `json:"actionDetails"`
}

type LinkagePayload struct {
	Inputs  []IndexedLinkage `json:"inputs"`
	Outputs []IndexedLinkage `json:"outputs"`
	Admin   []IndexedAdmin   `json:"admin,omitempty"`
}

func DecodeLinkagePayload(b []byte) (*LinkagePayload, error) {
	if len(b) == 0 {
		return &LinkagePayload{}, nil
	}
	var p LinkagePayload
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("linkage payload: %w", err)
	}
	return &p, nil
}
