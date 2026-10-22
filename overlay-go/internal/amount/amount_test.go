package amount

import (
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestAmountJSON(t *testing.T) {
	b, _ := json.Marshal(FromUint64(math.MaxUint64))
	if string(b) != `"18446744073709551615"` {
		t.Fatal(string(b))
	}
	for _, bad := range []string{`"-0"`, `"01"`, `"1e3"`, `"1.0"`, `5.5`, `null`, `"+1"`, `-0`, `01`, `1e3`, `""`, `" 1"`, `true`, `"\` + "u0031" + `"`} {
		var a Amount
		if json.Unmarshal([]byte(bad), &a) == nil {
			t.Fatalf("%s accepted", bad)
		}
	}
	var a Amount
	if err := json.Unmarshal([]byte(`-36893488147419103230`), &a); err != nil || a.String() != "-36893488147419103230" {
		t.Fatal(a, err)
	}
	var s Amount
	if err := json.Unmarshal([]byte(`"36893488147419103230"`), &s); err != nil || s.String() != "36893488147419103230" {
		t.Fatal(s, err)
	}
	var zero Amount
	if b, err := json.Marshal(zero); err != nil || string(b) != `"0"` {
		t.Fatal(string(b), err)
	}
	// Inside a struct, a field round-trips as a string.
	type row struct {
		Amount Amount `json:"amount"`
	}
	b, _ = json.Marshal(row{Amount: FromUint64(7)})
	if string(b) != `{"amount":"7"}` {
		t.Fatal(string(b))
	}
}

func TestAmountParseAndRange(t *testing.T) {
	max := MaxStorable()
	if max.String() != strings.Repeat("9", 34) {
		t.Fatal(max)
	}
	max.SetInt64(1) // a fresh copy each call
	if MaxStorable().String() != strings.Repeat("9", 34) {
		t.Fatal("MaxStorable shares state")
	}
	for _, bad := range []string{"", "-0", "-", "01", "+1", "1.0", "1e3", " 1", "0x1", "١"} {
		if _, err := Parse(bad); err == nil {
			t.Fatalf("Parse(%q) accepted", bad)
		}
	}
	if _, err := Parse(strings.Repeat("9", 35)); !errors.Is(err, ErrOutOfRange) {
		t.Fatal(err)
	}
	if _, err := Parse("-1" + strings.Repeat("0", 34)); !errors.Is(err, ErrOutOfRange) {
		t.Fatal(err)
	}
	if _, err := Parse(strings.Repeat("1", 100000)); !errors.Is(err, ErrOutOfRange) {
		t.Fatal(err)
	}
	if a, err := Parse("-" + strings.Repeat("9", 34)); err != nil || a.Sign() != -1 {
		t.Fatal(a, err)
	}
	// FromBig copies its argument.
	b := big.NewInt(5)
	a, err := FromBig(b)
	if err != nil {
		t.Fatal(err)
	}
	b.SetInt64(6)
	if a.String() != "5" {
		t.Fatal("FromBig aliases its argument")
	}
	// Big returns a fresh copy.
	a.Big().SetInt64(9)
	if a.String() != "5" {
		t.Fatal("Big aliases the amount")
	}
	if _, err := FromBig(nil); err == nil {
		t.Fatal("FromBig(nil) accepted")
	}
}

func TestAmountArithmetic(t *testing.T) {
	max := FromUint64(math.MaxUint64)
	sum, err := max.Add(max)
	if err != nil || sum.String() != "36893488147419103230" {
		t.Fatal(sum, err)
	}
	if _, ok := sum.Uint64(); ok {
		t.Fatal("2^65-2 fit a uint64")
	}
	if u, ok := max.Uint64(); !ok || u != math.MaxUint64 {
		t.Fatal(u, ok)
	}
	if _, ok := FromUint64(1).Neg().Uint64(); ok {
		t.Fatal("-1 fit a uint64")
	}
	if !mustAdd(max.Neg(), max).IsZero() {
		t.Fatal("max-max != 0")
	}
	var zero Amount
	if !zero.IsZero() || zero.Sign() != 0 || zero.String() != "0" || zero.Cmp(FromUint64(0)) != 0 || zero.Neg().String() != "0" {
		t.Fatal("zero value is not 0")
	}
	if u, ok := zero.Uint64(); !ok || u != 0 {
		t.Fatal(u, ok)
	}
	top, _ := FromBig(MaxStorable())
	if _, err := top.Add(FromUint64(1)); !errors.Is(err, ErrOutOfRange) {
		t.Fatal(err)
	}
	if _, err := top.Neg().Add(FromUint64(1).Neg()); !errors.Is(err, ErrOutOfRange) {
		t.Fatal(err)
	}
	if FromUint64(1).Cmp(FromUint64(2)) != -1 || FromUint64(2).Cmp(FromUint64(1)) != 1 {
		t.Fatal("Cmp")
	}
}

// mustAdd is Add that must not fail.
func mustAdd(a, b Amount) Amount {
	s, err := a.Add(b)
	if err != nil {
		panic(err)
	}
	return s
}

func TestAmountBSONRoundTrip(t *testing.T) {
	max := MaxStorable()
	for _, s := range []string{"0", "1", "18446744073709551615", "-18446744073709551615", max.String(), "-" + max.String()} {
		a, err := Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		typ, data, err := a.MarshalBSONValue()
		if err != nil || bson.Type(typ) != bson.TypeDecimal128 {
			t.Fatal(typ, err)
		}
		var d bson.Decimal128
		if err := bson.UnmarshalValue(bson.TypeDecimal128, data, &d); err != nil {
			t.Fatal(err)
		}
		if _, exp, err := d.BigInt(); err != nil || exp != 0 {
			t.Fatalf("%s stored with exponent %d (%v)", s, exp, err)
		}
		var back Amount
		if err := back.UnmarshalBSONValue(typ, data); err != nil || back.Cmp(a) != 0 {
			t.Fatal(s, back, err)
		}
	}
	if _, err := FromBig(new(big.Int).Add(max, big.NewInt(1))); !errors.Is(err, ErrOutOfRange) {
		t.Fatal(err)
	}
}

func TestAmountBSONRefusesOldShapes(t *testing.T) { // Review Focus 5
	for _, v := range []any{5.0, int32(5), int64(5), "5"} {
		typ, data, _ := bson.MarshalValue(v)
		var a Amount
		if err := a.UnmarshalBSONValue(byte(typ), data); err == nil || !strings.Contains(err.Error(), "want decimal128") {
			t.Fatalf("%T: %v", v, err)
		}
	}
	frac, _ := bson.ParseDecimal128("1.5")
	typ, data, _ := bson.MarshalValue(frac)
	var a Amount
	if err := a.UnmarshalBSONValue(byte(typ), data); err == nil || !strings.Contains(err.Error(), "is not an integer") {
		t.Fatal("1.5 accepted", err)
	}
}

func TestAmountBSONDecimalShapes(t *testing.T) {
	dec := func(s string) (byte, []byte) {
		d, err := bson.ParseDecimal128(s)
		if err != nil {
			t.Fatal(s, err)
		}
		typ, data, err := bson.MarshalValue(d)
		if err != nil {
			t.Fatal(err)
		}
		return byte(typ), data
	}
	// Integral values in other exponents are read exactly.
	for in, want := range map[string]string{"1.00": "1", "15E+2": "1500", "-2.0": "-2", "0E+6000": "0", "0E-6000": "0", "-0": "0", "1E+33": "1" + strings.Repeat("0", 33)} {
		typ, data := dec(in)
		var a Amount
		if err := a.UnmarshalBSONValue(typ, data); err != nil || a.String() != want {
			t.Fatalf("%s: %v %v", in, a, err)
		}
	}
	for _, in := range []string{"NaN", "Infinity", "-Infinity"} {
		typ, data := dec(in)
		var a Amount
		if err := a.UnmarshalBSONValue(typ, data); err == nil || !strings.Contains(err.Error(), "non-finite") {
			t.Fatal(in, err)
		}
	}
	for _, in := range []string{"1E+34", "1E+6000", "-1E+34", "99999999999999999999999999999999990"} {
		typ, data := dec(in)
		var a Amount
		if err := a.UnmarshalBSONValue(typ, data); !errors.Is(err, ErrOutOfRange) {
			t.Fatal(in, err)
		}
	}
	for _, in := range []string{"1E-6000", "0.0001"} {
		typ, data := dec(in)
		var a Amount
		if err := a.UnmarshalBSONValue(typ, data); err == nil || !strings.Contains(err.Error(), "is not an integer") {
			t.Fatal(in, err)
		}
	}
	// A truncated Decimal128 payload is an error, never a zero.
	typ, data := dec("5")
	var a Amount
	if err := a.UnmarshalBSONValue(typ, data[:15]); err == nil {
		t.Fatal("truncated decimal128 accepted")
	}
	// A failed decode leaves the target untouched.
	b := FromUint64(42)
	if err := b.UnmarshalBSONValue(byte(bson.TypeDouble), data[:8]); err == nil || b.String() != "42" {
		t.Fatal(b, err)
	}
}
