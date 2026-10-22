package wiring

import (
	"math/big"

	"github.com/sirdeggen/mandala/overlay-go/internal/amount"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// Mongo-backed wiring tests get their database from testmongo.DB (directly, or through buildV3App), the one skip path:
// it skips only when Mongo is unreachable and refuses any name outside mandala3_test_.

// Arbitrary valid secp256k1 private key (test-only).
const testPrivHex = "1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"

// amt is a test amount literal (negative for a delta).
func amt(v int64) mandala.Amount {
	a, err := amount.FromBig(big.NewInt(v))
	if err != nil {
		panic(err)
	}
	return a
}
