// Package econ implements the fuel-pair sizing rules of spec §1.3. All
// arithmetic is integer; products that could exceed 64 bits are checked.
package econ

import (
	"errors"
	"fmt"
	"math/bits"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

var ErrTooLarge = errors.New("too_large")

type Params struct {
	D            uint64
	BSVRatePerKb uint64
	KMax         int
}

func ceilDiv(a, b uint64) uint64 { return (a + b - 1) / b }

func mul(a, b uint64) (uint64, error) {
	hi, lo := bits.Mul64(a, b)
	if hi != 0 {
		return 0, fmt.Errorf("econ: %d*%d overflows", a, b)
	}
	return lo, nil
}

// CoveredBytes = floor(D*1000/BSV_RATE).
func CoveredBytes(p Params) uint64 {
	v, err := mul(p.D, 1000)
	if err != nil {
		return 0
	}
	return v / p.BSVRatePerKb
}

// FeePerPair = ceil(feeRatePerKb * coveredBytes / 1000), token base units.
func FeePerPair(p Params, feeRatePerKb int64) (int64, error) {
	if feeRatePerKb < 1 || feeRatePerKb > token.MaxSafeAmount {
		return 0, fmt.Errorf("econ: feeRatePerKb %d out of range", feeRatePerKb)
	}
	prod, err := mul(uint64(feeRatePerKb), CoveredBytes(p))
	if err != nil {
		return 0, err
	}
	f := ceilDiv(prod, 1000)
	if f < 1 || f > uint64(token.MaxSafeAmount) {
		return 0, fmt.Errorf("econ: fee per pair %d out of range", f)
	}
	return int64(f), nil
}

// EstSize upper-bounds wallet-toolbox's own size estimate for the inputs the
// lib passes: tx overhead 10, token input 150, fuel input 148, token output 85,
// one BSV change output 34.
func EstSize(n, m, k int) uint64 {
	return 10 + 150*uint64(n) + 148*uint64(k) + 85*uint64(m+k) + 34
}

func changeDust(rate uint64) uint64 { return 2 * ceilDiv(192*rate, 1000) }

// Need = ceil(estSize*rate/1000) + satDeficit + changeDust.
func Need(p Params, n, m, k int) (uint64, error) {
	feeBytes, err := mul(EstSize(n, m, k), p.BSVRatePerKb)
	if err != nil {
		return 0, err
	}
	fee := ceilDiv(feeBytes, 1000)
	deficit := uint64(m + k - n) // may be "negative": token outputs are 1 sat each, token inputs 1 sat each
	if m+k-n < 0 {
		deficit = 0
	}
	return fee + deficit + changeDust(p.BSVRatePerKb), nil
}

// SizeDraft returns the smallest k ≥ 1 with k*D ≥ Need(k); ErrTooLarge past KMax.
func SizeDraft(p Params, n, m int) (int, error) {
	for k := 1; k <= p.KMax; k++ {
		need, err := Need(p, n, m, k)
		if err != nil {
			return 0, err
		}
		have, err := mul(uint64(k), p.D)
		if err != nil {
			return 0, err
		}
		if have >= need {
			return k, nil
		}
	}
	return 0, ErrTooLarge
}
