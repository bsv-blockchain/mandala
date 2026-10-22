// Package amount is the overlay's one exact token-amount type (contract §0, §6; design D13).
//
// An Amount is an exact integer within the storage range ±(10^34-1): every per-output token
// amount (0..2^64-1), every sum, supply, delta and balance. Inside the process it is a *big.Int,
// in Mongo a Decimal128 with exponent 0 (exact to 34 digits, so $inc, $sum and sorts stay exact),
// and in JSON a canonical decimal string `0|-?[1-9][0-9]*` (never "-0").
//
// Reads fail closed: a stored amount that is not a finite, integral, in-range Decimal128 (for
// example the BSON double/int32/int64 of an old-format Mandala store) is an error, never a silent
// 0 or a truncated value.
package amount

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ErrOutOfRange is returned (wrapped) by every constructor and operation whose result would leave
// the storage range ±(10^34-1). It is a storage bound, not a token rule.
var ErrOutOfRange = errors.New("amount aggregate exceeds storage range")

// maxDigits is the number of decimal digits of MaxStorable.
const maxDigits = 34

var maxStorable = func() *big.Int {
	m := new(big.Int).Exp(big.NewInt(10), big.NewInt(maxDigits), nil)
	return m.Sub(m, big.NewInt(1))
}()

// MaxStorable returns 10^34-1, the largest magnitude an Amount (and a Mongo Decimal128 with
// exponent 0) holds exactly. Each call returns a fresh copy.
func MaxStorable() *big.Int { return new(big.Int).Set(maxStorable) }

// Amount is an immutable exact integer. The zero value is 0. v is never mutated after
// construction and never handed out; nil means 0.
type Amount struct{ v *big.Int }

// FromUint64 returns u as an Amount. Every uint64 is within the storage range.
func FromUint64(u uint64) Amount { return Amount{v: new(big.Int).SetUint64(u)} }

// FromBig returns a copy of b as an Amount, or ErrOutOfRange when |b| > MaxStorable.
func FromBig(b *big.Int) (Amount, error) {
	if b == nil {
		return Amount{}, errors.New("amount: nil big.Int")
	}
	if b.CmpAbs(maxStorable) > 0 {
		return Amount{}, fmt.Errorf("amount: %s: %w", b.String(), ErrOutOfRange)
	}
	return Amount{v: new(big.Int).Set(b)}, nil
}

// Parse reads a canonical decimal string `0|-?[1-9][0-9]*` ("-0", "+1", leading zeros, spaces,
// fractions and exponents are refused) within the storage range.
func Parse(s string) (Amount, error) {
	digits := s
	if len(digits) > 0 && digits[0] == '-' {
		digits = digits[1:]
	}
	if len(digits) == 0 {
		return Amount{}, fmt.Errorf("amount: %q is not a canonical decimal integer", s)
	}
	for i := 0; i < len(digits); i++ {
		if digits[i] < '0' || digits[i] > '9' {
			return Amount{}, fmt.Errorf("amount: %q is not a canonical decimal integer", truncate(s))
		}
	}
	if digits[0] == '0' && (len(digits) > 1 || len(s) != len(digits)) {
		return Amount{}, fmt.Errorf("amount: %q is not a canonical decimal integer", truncate(s))
	}
	// Canonical form has no leading zeros, so more than 34 digits is beyond 10^34-1; refusing on
	// length first keeps a huge input from being parsed into a big.Int at all.
	if len(digits) > maxDigits {
		return Amount{}, fmt.Errorf("amount: %q: %w", truncate(s), ErrOutOfRange)
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return Amount{}, fmt.Errorf("amount: %q is not a canonical decimal integer", s)
	}
	return Amount{v: v}, nil
}

func truncate(s string) string {
	if len(s) > 48 {
		return s[:48] + "…"
	}
	return s
}

func (a Amount) big() *big.Int {
	if a.v == nil {
		return new(big.Int)
	}
	return a.v
}

// Big returns a fresh copy of the value.
func (a Amount) Big() *big.Int { return new(big.Int).Set(a.big()) }

// Uint64 returns the value and true iff 0 <= a <= 2^64-1.
func (a Amount) Uint64() (uint64, bool) {
	v := a.big()
	if v.Sign() < 0 || !v.IsUint64() {
		return 0, false
	}
	return v.Uint64(), true
}

// Sign returns -1, 0 or +1.
func (a Amount) Sign() int { return a.big().Sign() }

// Cmp compares a and b: -1, 0 or +1.
func (a Amount) Cmp(b Amount) int { return a.big().Cmp(b.big()) }

// Add returns a+b, or ErrOutOfRange when the sum leaves the storage range.
func (a Amount) Add(b Amount) (Amount, error) {
	return FromBig(new(big.Int).Add(a.big(), b.big()))
}

// Neg returns -a. The storage range is symmetric, so Neg never fails.
func (a Amount) Neg() Amount { return Amount{v: new(big.Int).Neg(a.big())} }

// IsZero reports a == 0.
func (a Amount) IsZero() bool { return a.big().Sign() == 0 }

// String returns the canonical decimal form.
func (a Amount) String() string { return a.big().String() }

// MarshalBSONValue writes the amount as a Decimal128 with exponent 0.
func (a Amount) MarshalBSONValue() (byte, []byte, error) {
	d, ok := bson.ParseDecimal128FromBigInt(a.big(), 0)
	if !ok {
		return 0, nil, fmt.Errorf("amount: %s: %w", a.String(), ErrOutOfRange)
	}
	if _, exp, err := d.BigInt(); err != nil || exp != 0 {
		// Unreachable for |a| <= 10^34-1; refuse rather than write a rescaled value.
		return 0, nil, fmt.Errorf("amount: %s does not encode with exponent 0", a.String())
	}
	t, data, err := bson.MarshalValue(d)
	if err != nil {
		return 0, nil, err
	}
	return byte(t), data, nil
}

// UnmarshalBSONValue reads only a finite, integral Decimal128 within the storage range. Any
// other BSON type is old-format data and an error. On error *a is left unchanged.
func (a *Amount) UnmarshalBSONValue(t byte, data []byte) error {
	if bson.Type(t) != bson.TypeDecimal128 {
		return fmt.Errorf("amount: stored as %s, want decimal128 (old-format data: use a fresh NODE_NAME)", bson.Type(t))
	}
	if len(data) != 16 {
		return fmt.Errorf("amount: decimal128 payload is %d bytes, want 16", len(data))
	}
	d := bson.NewDecimal128(binary.LittleEndian.Uint64(data[8:]), binary.LittleEndian.Uint64(data[:8]))
	if d.IsNaN() || d.IsInf() != 0 {
		return errors.New("amount: non-finite decimal128")
	}
	sig, exp, err := d.BigInt()
	if err != nil {
		return fmt.Errorf("amount: decimal128: %w", err)
	}
	v := sig
	switch {
	case sig.Sign() == 0:
		v = new(big.Int)
	case exp > 0:
		// A non-zero significand times 10^35 or more is beyond the range; skip the power.
		if exp > maxDigits {
			return fmt.Errorf("amount: %s: %w", d.String(), ErrOutOfRange)
		}
		v = new(big.Int).Mul(sig, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(exp)), nil))
	case exp < 0:
		// The significand is below 2^113 (< 10^35), so 10^35 or more never divides it.
		if -exp > maxDigits+1 {
			return fmt.Errorf("amount: %s is not an integer", d.String())
		}
		q, r := new(big.Int).QuoRem(sig, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(-exp)), nil), new(big.Int))
		if r.Sign() != 0 {
			return fmt.Errorf("amount: %s is not an integer", d.String())
		}
		v = q
	}
	out, err := FromBig(v)
	if err != nil {
		return err
	}
	*a = out
	return nil
}

// MarshalJSON writes the canonical decimal string, e.g. "18446744073709551615".
func (a Amount) MarshalJSON() ([]byte, error) {
	return []byte(`"` + a.String() + `"`), nil
}

// UnmarshalJSON reads a canonical decimal string. A bare JSON integer literal in the same
// canonical form is also read (the pinned TS vector files carry those); null, escapes,
// fractions and exponents are refused. On error *a is left unchanged.
func (a *Amount) UnmarshalJSON(b []byte) error {
	raw := bytes.TrimSpace(b)
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		raw = raw[1 : len(raw)-1]
	}
	v, err := Parse(string(raw))
	if err != nil {
		return err
	}
	*a = v
	return nil
}
