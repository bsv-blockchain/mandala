package econ

import (
	"testing"

	"github.com/stretchr/testify/require"
)

var defaults = Params{D: 200, BSVRatePerKb: 100, KMax: 4}

func TestWorkedExample(t *testing.T) {
	// Spec §1.3: n=1, m=3 → estSize(1)=682, fee 69, deficit 3, dust 40, need 112 → k=1, F=20 at rate 10.
	require.Equal(t, uint64(2000), CoveredBytes(defaults))
	require.Equal(t, uint64(682), EstSize(1, 3, 1))
	need, err := Need(defaults, 1, 3, 1)
	require.NoError(t, err)
	require.Equal(t, uint64(112), need)
	k, err := SizeDraft(defaults, 1, 3)
	require.NoError(t, err)
	require.Equal(t, 1, k)
	f, err := FeePerPair(defaults, 10)
	require.NoError(t, err)
	require.Equal(t, int64(20), f)
}

func TestSizeDraft_GrowsAndCaps(t *testing.T) {
	k, err := SizeDraft(defaults, 4, 6)
	require.NoError(t, err)
	require.Equal(t, 1, k) // estSize=10+600+148+85*7+34=1387 → fee 139 + deficit 3 + 40 = 182 ≤ 200
	k, err = SizeDraft(defaults, 8, 10)
	require.NoError(t, err)
	require.Equal(t, 2, k)
	_, err = SizeDraft(Params{D: 200, BSVRatePerKb: 100, KMax: 1}, 8, 10)
	require.ErrorIs(t, err, ErrTooLarge)
}

func TestFeePerPair_Rounding(t *testing.T) {
	f, err := FeePerPair(defaults, 1)
	require.NoError(t, err)
	require.Equal(t, int64(2), f) // ceil(1*2000/1000)
	f, err = FeePerPair(Params{D: 30, BSVRatePerKb: 100, KMax: 4}, 7)
	require.NoError(t, err)
	require.Equal(t, int64(3), f) // covered=300, ceil(2100/1000)=3
}

func TestFeePerPair_Bounds(t *testing.T) {
	_, err := FeePerPair(defaults, 0)
	require.Error(t, err)
	_, err = FeePerPair(defaults, 9007199254740992)
	require.Error(t, err)
	_, err = FeePerPair(Params{D: 1 << 60, BSVRatePerKb: 1, KMax: 4}, 9007199254740991)
	require.Error(t, err, "product overflow must be detected, not wrapped")
}

func TestChangeDustTracksRate(t *testing.T) {
	need100, _ := Need(defaults, 1, 1, 1)
	need50, _ := Need(Params{D: 200, BSVRatePerKb: 50, KMax: 4}, 1, 1, 1)
	require.Greater(t, need100, need50)
	// changeDust = 2*ceil(192*rate/1000): 40 at 100, 20 at 50.
	require.Equal(t, uint64(40), changeDust(100))
	require.Equal(t, uint64(20), changeDust(50))
}
