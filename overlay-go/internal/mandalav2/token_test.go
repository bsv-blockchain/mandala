package mandalav2

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/bsv-blockchain/go-sdk/script"
)

type vectors struct {
	TokenScripts []struct {
		AssetID    string `json:"assetId"`
		Amount     int64  `json:"amount"`
		PubKeyHash []byte `json:"pubKeyHash"`
		ScriptHex  string `json:"scriptHex"`
	} `json:"tokenScripts"`
	AssetIDs []string `json:"assetIds"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("../../testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestDecodeTokenGoldenVectors(t *testing.T) {
	for _, tv := range loadVectors(t).TokenScripts {
		s, err := script.NewFromHex(tv.ScriptHex)
		if err != nil {
			t.Fatal(err)
		}
		d, err := DecodeToken(s)
		if err != nil {
			t.Fatalf("amount %d: %v", tv.Amount, err)
		}
		if d.AssetID != tv.AssetID || d.Amount != tv.Amount {
			t.Fatalf("amount %d: got %+v", tv.Amount, d)
		}
	}
}

func TestLockRoundTripsThroughDecode(t *testing.T) {
	for _, tv := range loadVectors(t).TokenScripts {
		s, err := LockToken(tv.AssetID, tv.Amount, tv.PubKeyHash)
		if err != nil {
			t.Fatal(err)
		}
		if s.String() != tv.ScriptHex { // byte-identical to the TS encoder
			t.Fatalf("amount %d: encode mismatch", tv.Amount)
		}
	}
}

func TestAssetIDRoundTrip(t *testing.T) {
	for _, id := range loadVectors(t).AssetIDs {
		b, err := EncodeAssetID(id)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) != 36 {
			t.Fatalf("want 36 bytes, got %d", len(b))
		}
		back, err := DecodeAssetID(b)
		if err != nil || back != id {
			t.Fatalf("round trip %q -> %q (%v)", id, back, err)
		}
	}
}

func TestDecodeTokenRejectsNonToken(t *testing.T) {
	s, _ := script.NewFromHex("006a") // OP_FALSE OP_RETURN
	if _, err := DecodeToken(s); err == nil {
		t.Fatal("expected error")
	}
}
