package mandala

import "github.com/sirdeggen/mandala/overlay-go/internal/amount"

// MaxSafeAmount is 2^53-1, the Mandala cap on every per-output amount, sum and supply (D §3.4).
// It is a token rule only; storage is exact (Amount). Task 6 removes the cap (uint64 end to end).
const MaxSafeAmount uint64 = 9007199254740991

// Amount is the overlay's one exact amount type (contract §0, §6; design D13): a *big.Int inside,
// a Decimal128 with exponent 0 in Mongo and a canonical decimal string in JSON. A stored amount of
// any other BSON type (an old-format double/int32/int64 store) is a read error, never 0.
type Amount = amount.Amount

// zeroAmount is an explicit 0. Use it rather than Amount{} where the value may be compared
// structurally against a decoded zero.
func zeroAmount() Amount { return amount.FromUint64(0) }
