package httpapi

import (
	"math/big"

	"github.com/sirdeggen/mandala/overlay-go/internal/amount"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// amt is a test amount literal (negative for a delta).
func amt(v int64) mandala.Amount {
	a, err := amount.FromBig(big.NewInt(v))
	if err != nil {
		panic(err)
	}
	return a
}
