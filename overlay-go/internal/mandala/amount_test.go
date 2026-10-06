package mandala

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type amountDoc struct {
	A Amount  `bson:"a"`
	P *Amount `bson:"p,omitempty"`
}

func TestAmountWritesABSONDouble(t *testing.T) {
	raw, err := bson.Marshal(amountDoc{A: Amount(MaxSafeAmount)})
	if err != nil {
		t.Fatal(err)
	}
	v := bson.Raw(raw).Lookup("a")
	if v.Type != bson.TypeDouble {
		t.Fatalf("amount written as %v, want double", v.Type)
	}
	if f := v.Double(); f != 9007199254740991 {
		t.Fatalf("amount = %v", f)
	}
	if bson.Raw(raw).Lookup("p").Type != 0 {
		t.Fatal("a nil *Amount with omitempty must be absent")
	}
}

func TestAmountReadsInt32Int64AndIntegralDouble(t *testing.T) {
	for name, doc := range map[string]bson.D{
		"int32":  {{Key: "a", Value: int32(42)}},
		"int64":  {{Key: "a", Value: int64(42)}},
		"double": {{Key: "a", Value: float64(42)}},
	} {
		raw, err := bson.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		var got amountDoc
		if err := bson.Unmarshal(raw, &got); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got.A != 42 {
			t.Fatalf("%s: %d", name, got.A)
		}
	}
	raw, _ := bson.Marshal(bson.D{{Key: "a", Value: float64(-40)}})
	var neg amountDoc
	if err := bson.Unmarshal(raw, &neg); err != nil || neg.A != -40 {
		t.Fatalf("negative delta: %d %v", neg.A, err)
	}
}

func TestAmountRefusesFractionalHugeOrNonNumeric(t *testing.T) {
	for name, v := range map[string]any{
		"fraction":   1.5,
		"above 2^53": float64(1 << 54),
		"NaN":        math.NaN(),
		"string":     "42",
	} {
		raw, err := bson.Marshal(bson.D{{Key: "a", Value: v}})
		if err != nil {
			t.Fatal(err)
		}
		var got amountDoc
		if err := bson.Unmarshal(raw, &got); err == nil {
			t.Fatalf("%s decoded as %d", name, got.A)
		}
	}
}

func TestAmountJSONIsAPlainInteger(t *testing.T) {
	b, err := json.Marshal(struct {
		A Amount `json:"amount"`
	}{A: 9007199254740991})
	if err != nil || string(b) != `{"amount":9007199254740991}` {
		t.Fatalf("%s %v", b, err)
	}
	var back struct {
		A Amount `json:"amount"`
	}
	if err := json.Unmarshal([]byte(`{"amount":100}`), &back); err != nil || back.A != 100 {
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
