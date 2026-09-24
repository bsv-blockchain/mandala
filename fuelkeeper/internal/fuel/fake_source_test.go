package fuel

import (
	"context"
	"errors"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"
)

func newFake(t *testing.T) *Fake {
	t.Helper()
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	return NewFake(priv)
}

func verifyInput(t *testing.T, tx *transaction.Transaction, idx int) error {
	t.Helper()
	return interpreter.NewEngine().Execute(
		interpreter.WithTx(tx, idx, tx.Inputs[idx].SourceTxOutput()),
		interpreter.WithForkID(),
		interpreter.WithAfterGenesis(),
	)
}

// The fuel unlocker must spend the toolbox-shaped self→self BRC-29 lock, sign
// with 0xC3, and stay valid when the requester later adds inputs and outputs.
func TestUnlockerSignsFuelWithSingleAnyoneCanPay(t *testing.T) {
	f := newFake(t)
	row := f.AddFuel(t, 1000)

	src, err := transaction.NewTransactionFromBEEF(row.Beef)
	require.NoError(t, err)
	require.Equal(t, row.Txid, src.TxID().String())
	require.NotNil(t, src.MerklePath, "fake BEEF must carry a BUMP")
	require.Equal(t, row.Satoshis, src.Outputs[row.Vout].Satoshis)
	require.Equal(t, row.LockingScript, []byte(*src.Outputs[row.Vout].LockingScript))

	tpl, err := f.Unlocker(row.DerivationPrefix, row.DerivationSuffix)
	require.NoError(t, err)

	spend := transaction.NewTransaction()
	spend.AddInputFromTx(src, row.Vout, tpl)
	spend.AddOutput(&transaction.TransactionOutput{Satoshis: 900, LockingScript: script.NewFromBytes(row.LockingScript)})
	us, err := tpl.Sign(spend, 0)
	require.NoError(t, err)
	spend.Inputs[0].UnlockingScript = us
	require.NoError(t, verifyInput(t, spend, 0))

	chunks, err := us.Chunks()
	require.NoError(t, err)
	require.Len(t, chunks, 2)
	sig := chunks[0].Data
	require.Equal(t, byte(0xC3), sig[len(sig)-1])

	// Requester appends its own input and outputs after the keeper signed.
	other := f.AddFuel(t, 500)
	otherSrc, err := transaction.NewTransactionFromBEEF(other.Beef)
	require.NoError(t, err)
	spend.AddInputFromTx(otherSrc, other.Vout, nil)
	spend.AddOutput(&transaction.TransactionOutput{Satoshis: 400, LockingScript: script.NewFromBytes(other.LockingScript)})
	require.NoError(t, verifyInput(t, spend, 0), "fuel signature must survive added inputs/outputs")

	// Changing the paired output breaks it.
	spend.Outputs[0].Satoshis = 899
	require.Error(t, verifyInput(t, spend, 0))
}

func TestUnlockerWrongDerivationFails(t *testing.T) {
	f := newFake(t)
	row := f.AddFuel(t, 1000)
	src, err := transaction.NewTransactionFromBEEF(row.Beef)
	require.NoError(t, err)
	tpl, err := f.Unlocker(row.DerivationPrefix, row.DerivationPrefix)
	require.NoError(t, err)
	spend := transaction.NewTransaction()
	spend.AddInputFromTx(src, row.Vout, tpl)
	spend.AddOutput(&transaction.TransactionOutput{Satoshis: 900, LockingScript: script.NewFromBytes(row.LockingScript)})
	us, err := tpl.Sign(spend, 0)
	require.NoError(t, err)
	spend.Inputs[0].UnlockingScript = us
	require.Error(t, verifyInput(t, spend, 0))

	_, err = f.Unlocker("", row.DerivationSuffix)
	require.Error(t, err)
}

func TestFeeKeyRejectsNilRequester(t *testing.T) {
	_, err := newFake(t).FeePubKeyHash(context.Background(), "fee-aa.0", nil)
	require.Error(t, err)
}

func TestFakeListProvenOrderMaxAndHooks(t *testing.T) {
	ctx := context.Background()
	f := newFake(t)
	a, b, c := f.AddFuel(t, 100), f.AddFuel(t, 200), f.AddFuel(t, 300)
	require.Less(t, a.OutputID, b.OutputID)
	require.Less(t, b.OutputID, c.OutputID)

	rows, err := f.ListProven(ctx, "fuel", 10, 0)
	require.NoError(t, err)
	require.Equal(t, []string{c.Outpoint, b.Outpoint, a.Outpoint}, outpoints(rows))

	rows, err = f.ListProven(ctx, "fuel", 2, 0)
	require.NoError(t, err)
	require.Equal(t, []string{c.Outpoint, b.Outpoint}, outpoints(rows))

	rows, err = f.ListProven(ctx, "fuel", 0, 0)
	require.NoError(t, err)
	require.Empty(t, rows)

	// minSats drops smaller rows before the truncation: a max of 1 still
	// reaches the one row worth enough, however many newer small rows exist.
	rows, err = f.ListProven(ctx, "fuel", 10, 200)
	require.NoError(t, err)
	require.Equal(t, []string{c.Outpoint, b.Outpoint}, outpoints(rows))
	rows, err = f.ListProven(ctx, "fuel", 1, 250)
	require.NoError(t, err)
	require.Equal(t, []string{c.Outpoint}, outpoints(rows))
	rows, err = f.ListProven(ctx, "fuel", 10, 301)
	require.NoError(t, err)
	require.Empty(t, rows)

	// Returned rows are copies.
	rows, _ = f.ListProven(ctx, "fuel", 1, 0)
	rows[0].Beef[0] ^= 0xff
	require.Equal(t, c.Beef, f.Row(c.Outpoint).Beef)
	require.Equal(t, Row{}, f.Row("nope"))

	calls := f.ListProvenCalls()
	boom := errors.New("boom")
	f.FailNextList(boom)
	_, err = f.ListProven(ctx, "fuel", 10, 0)
	require.ErrorIs(t, err, boom)
	rows, err = f.ListProven(ctx, "fuel", 10, 0)
	require.NoError(t, err)
	require.Len(t, rows, 3)
	require.Equal(t, calls+2, f.ListProvenCalls(), "every call is counted, failed ones included")

	f.HideBasket()
	rows, err = f.ListProven(ctx, "fuel", 10, 0)
	require.NoError(t, err)
	require.Empty(t, rows)
	f.ShowBasket()
	rows, _ = f.ListProven(ctx, "fuel", 10, 0)
	require.Len(t, rows, 3)

	// Detach: one injected failure leaves the row in the basket.
	f.FailNextDetach(boom)
	require.ErrorIs(t, f.Detach(ctx, c.Outpoint), boom)
	rows, _ = f.ListProven(ctx, "fuel", 10, 0)
	require.Len(t, rows, 3)
	require.NoError(t, f.Detach(ctx, c.Outpoint))
	require.NoError(t, f.Detach(ctx, c.Outpoint), "detach is idempotent")
	rows, _ = f.ListProven(ctx, "fuel", 10, 0)
	require.Equal(t, []string{b.Outpoint, a.Outpoint}, outpoints(rows))
	ok, err := f.StillSpendable(ctx, c.Outpoint)
	require.NoError(t, err)
	require.True(t, ok)

	// SpendAfterDetach: the detach lands but the output was taken as change.
	f.SpendAfterDetach(b.Outpoint)
	require.NoError(t, f.Detach(ctx, b.Outpoint))
	ok, _ = f.StillSpendable(ctx, b.Outpoint)
	require.False(t, ok)

	// External spend drops the row from the listing.
	f.SpendExternally(a.Outpoint)
	rows, _ = f.ListProven(ctx, "fuel", 10, 0)
	require.Empty(t, rows)

	require.Error(t, f.Detach(ctx, "00"))
	// An unknown outpoint is an error (fail closed, as WalletSource), never
	// a definitive "not spendable" a caller could drop fuel on.
	ok, err = f.StillSpendable(ctx, "unknown")
	require.ErrorIs(t, err, errUnknownOutpoint)
	require.False(t, ok)
}

func TestFakeInternalizeAndBalance(t *testing.T) {
	ctx := context.Background()
	f := newFake(t)
	f.Balance = 12345
	bal, err := f.BalanceSats(ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(12345), bal)

	args := sdk.InternalizeActionArgs{Tx: []byte{1, 2, 3}, Description: "sweep change"}
	require.NoError(t, f.Internalize(ctx, args))
	f.InternalizeErr = errors.New("storage down")
	require.Error(t, f.Internalize(ctx, args))
	require.Len(t, f.Internalized, 2)
	require.Equal(t, "sweep change", f.Internalized[0].Description)

	// FailNthInternalize: only the n-th call from now fails, once.
	f.InternalizeErr = nil
	boom := errors.New("boom")
	f.FailNthInternalize(2, boom)
	require.NoError(t, f.Internalize(ctx, args))
	require.ErrorIs(t, f.Internalize(ctx, args), boom)
	require.NoError(t, f.Internalize(ctx, args))
	require.Len(t, f.Internalized, 5, "the failing call is still recorded")
}

func outpoints(rows []Row) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Outpoint
	}
	return out
}
