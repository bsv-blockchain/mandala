package mandala

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/sirdeggen/mandala/overlay-go/internal/amount"
)

type amountDoc struct {
	A Amount  `bson:"a"`
	P *Amount `bson:"p,omitempty"`
}

// Every record amount is a Decimal128 with exponent 0 (contract §6, D13); a nil *Amount with
// omitempty (AdminHistoryEntry.FrozenAmount on a non-freeze row) stays absent.
func TestAmountWritesADecimal128(t *testing.T) {
	raw, err := bson.Marshal(amountDoc{A: amount.FromUint64(math.MaxUint64)})
	if err != nil {
		t.Fatal(err)
	}
	v := bson.Raw(raw).Lookup("a")
	if v.Type != bson.TypeDecimal128 {
		t.Fatalf("amount written as %v, want decimal128", v.Type)
	}
	if d := v.Decimal128(); d.String() != "18446744073709551615" {
		t.Fatalf("amount = %v", d)
	}
	if bson.Raw(raw).Lookup("p").Type != 0 {
		t.Fatal("a nil *Amount with omitempty must be absent")
	}
	var back amountDoc
	if err := bson.Unmarshal(raw, &back); err != nil || back.A.String() != "18446744073709551615" || back.P != nil {
		t.Fatalf("%+v %v", back, err)
	}
}

// Review Focus 5: an old-format record (int32/int64/double amount) does not decode; it is never
// read as 0 or a truncated value.
func TestRecordRefusesOldAmountShapes(t *testing.T) {
	for name, v := range map[string]any{
		"int32":    int32(42),
		"int64":    int64(42),
		"double":   float64(42),
		"fraction": 1.5,
		"NaN":      math.NaN(),
		"string":   "42",
	} {
		raw, err := bson.Marshal(bson.D{{Key: "txid", Value: "aa"}, {Key: "amount", Value: v}})
		if err != nil {
			t.Fatal(err)
		}
		var got OwnerRecord
		if err := bson.Unmarshal(raw, &got); err == nil {
			t.Fatalf("%s decoded as %s", name, got.Amount)
		}
	}
}

// Every record-sourced amount is a canonical decimal string in JSON (contract §0, §6).
func TestAmountJSONIsADecimalString(t *testing.T) {
	b, err := json.Marshal(FrozenRef{Outpoint: "x.0", Amount: amount.FromUint64(math.MaxUint64), Owner: "k"})
	if err != nil || !strings.Contains(string(b), `"amount":"18446744073709551615"`) {
		t.Fatalf("%s %v", b, err)
	}
	b, err = json.Marshal(AdminHistoryEntry{Delta: amt(-40)})
	if err != nil || !strings.Contains(string(b), `"delta":"-40"`) || strings.Contains(string(b), "frozenAmount") {
		t.Fatalf("%s %v", b, err)
	}
	var back FrozenRef
	if err := json.Unmarshal([]byte(`{"amount":"100"}`), &back); err != nil || back.Amount.String() != "100" {
		t.Fatalf("%+v %v", back, err)
	}
}

func TestDefaultAssetStateListsAreEmptyNotNull(t *testing.T) {
	fee := int64(500)
	st := DefaultAssetState("aa_0", &fee)
	fee = 7
	if st.FeeRatePerKb == nil || *st.FeeRatePerKb != 500 {
		t.Fatal("the fee rate must be copied, not aliased")
	}
	b, err := json.Marshal(DefaultAssetState("aa_0", nil))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"accessMode":"denylist"`, `"blockedIdentities":[]`, `"allowedIdentities":[]`, `"frozenOutpoints":[]`, `"evictedOutpoints":[]`, `"feeRatePerKb":null`, `"isPaused":false`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("%s lacks %s", b, want)
		}
	}
	raw, err := bson.Marshal(DefaultAssetState("aa_0", nil))
	if err != nil {
		t.Fatal(err)
	}
	if v := bson.Raw(raw).Lookup("feeRatePerKb"); v.Type != bson.TypeNull {
		t.Fatalf("feeRatePerKb written as %v, want null", v.Type)
	}
	if v := bson.Raw(raw).Lookup("frozenOutpoints"); v.Type != bson.TypeArray {
		t.Fatalf("frozenOutpoints written as %v, want array", v.Type)
	}
	var back AssetAdminState
	if err := bson.Unmarshal(raw, &back); err != nil || back.FeeRatePerKb != nil || back.AccessMode != "denylist" {
		t.Fatalf("%+v %v", back, err)
	}
}
