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
