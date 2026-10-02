package chain

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

type fakeLookup struct {
	gotHash string
	gotOp   *transaction.Outpoint
	unspent bool
	err     error
	calls   int
}

func (f *fakeLookup) IsUtxo(_ context.Context, scriptHash string, op *transaction.Outpoint) (bool, error) {
	f.calls++
	f.gotHash, f.gotOp = scriptHash, op
	return f.unspent, f.err
}

func TestServicesCheckerPassesScriptHashAndOutpoint(t *testing.T) {
	ctx := context.Background()
	op := strings.Repeat("ab", 32) + ".3"
	f := &fakeLookup{unspent: true}
	c := servicesChecker{u: f}
	ok, err := c.IsUnspent(ctx, "76a914", op)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, token.ScriptHash([]byte{0x76, 0xa9, 0x14}), f.gotHash)
	require.Equal(t, op, f.gotOp.String())

	f.unspent = false
	ok, err = c.IsUnspent(ctx, "76a914", op)
	require.NoError(t, err)
	require.False(t, ok)

	f.err = errors.New("rate limited")
	_, err = c.IsUnspent(ctx, "76a914", op)
	require.ErrorContains(t, err, "rate limited")
}

func TestServicesCheckerRejectsBadInput(t *testing.T) {
	ctx := context.Background()
	f := &fakeLookup{unspent: true}
	c := servicesChecker{u: f}
	good := strings.Repeat("ab", 32) + ".0"
	for _, tc := range []struct{ script, op string }{
		{"", good},
		{"zz", good},
		{"76a914", "short.0"},
		{"76a914", strings.Repeat("ab", 32) + "x0"},
		{"76a914", strings.Repeat("ab", 32) + ".00"},
	} {
		_, err := c.IsUnspent(ctx, tc.script, tc.op)
		require.Error(t, err, "%q %q", tc.script, tc.op)
	}
	require.Zero(t, f.calls, "invalid input never reaches the service")
}

func TestDisabledAlwaysErrors(t *testing.T) {
	ok, err := Disabled{}.IsUnspent(context.Background(), "76a914", strings.Repeat("ab", 32)+".0")
	require.ErrorIs(t, err, ErrDisabled)
	require.False(t, ok)
	require.IsType(t, Disabled{}, NewServicesChecker(nil))
}

// The checker passes the lookup's answer through unchanged. In particular a
// lookup that returns (false, nil) — which go-wallet-toolbox v0.186.3's
// WhatsOnChain IsUtxo also does for a script the indexer has never seen
// ("script not found" → no UTXOs), not only for a spent output — comes back
// as a plain "spent" with no error. The ambiguity is documented here and
// compensated for by the sweeper (rule-2 canary and two spaced readings),
// never by this package.
func TestServicesCheckerSurfacesLookupAnswersUnchanged(t *testing.T) {
	op := strings.Repeat("ab", 32) + ".1"
	lookupErr := errors.New("woc: 500")
	for _, tc := range []struct {
		name        string
		unspent     bool
		err         error
		wantUnspent bool
		wantErr     bool
	}{
		{name: "unspent", unspent: true, wantUnspent: true},
		{name: "spent or never indexed: (false, nil) stays (false, nil)", unspent: false, wantUnspent: false},
		{name: "lookup error", unspent: false, err: lookupErr, wantErr: true},
		{name: "an error wins over a true answer", unspent: true, err: lookupErr, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeLookup{unspent: tc.unspent, err: tc.err}
			got, err := NewServicesChecker(f).IsUnspent(context.Background(), "76a914", op)
			require.Equal(t, 1, f.calls)
			if tc.wantErr {
				require.ErrorIs(t, err, lookupErr)
				require.False(t, got, "an error is never an answer")
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.wantUnspent, got)
		})
	}
}
