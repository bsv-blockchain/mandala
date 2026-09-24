package fuel

import (
	"context"
	"errors"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wdk"
	"github.com/stretchr/testify/require"
)

type fakeReader struct {
	rows      wdk.TableOutputs
	err       error
	gotAuth   wdk.AuthID
	gotFilter wdk.FindOutputsArgs
}

func (r *fakeReader) FindOutputsAuth(_ context.Context, auth wdk.AuthID, f wdk.FindOutputsArgs) (wdk.TableOutputs, error) {
	r.gotAuth, r.gotFilter = auth, f
	return r.rows, r.err
}

func tableRow(r Row) wdk.TableOutput {
	txid, prefix, suffix := r.Txid, r.DerivationPrefix, r.DerivationSuffix
	return wdk.TableOutput{
		OutputID:         r.OutputID,
		TxID:             &txid,
		Vout:             r.Vout,
		Satoshis:         int64(r.Satoshis),
		Spendable:        true,
		Change:           true,
		DerivationPrefix: &prefix,
		DerivationSuffix: &suffix,
		LockingScript:    r.LockingScript,
	}
}

func TestWalletSourceStillSpendable(t *testing.T) {
	ctx := context.Background()
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	kd := sdk.NewKeyDeriver(priv)
	reader := &fakeReader{}
	s := NewWalletSource(nil, reader, kd, 7, nil)
	op := "8c4f6b4a0ef0e0d6a4d9d47d0c3b7c0f0b2f5d1d1a1a3c3e7f6e5d4c3b2a1908.3"
	spent := uint(99)

	reader.rows = wdk.TableOutputs{{Spendable: true}}
	ok, err := s.StillSpendable(ctx, op)
	require.NoError(t, err)
	require.True(t, ok)
	require.NotNil(t, reader.gotAuth.UserID)
	require.Equal(t, 7, *reader.gotAuth.UserID)
	require.Equal(t, kd.IdentityKeyHex(), reader.gotAuth.IdentityKey)
	require.Equal(t, op[:64], *reader.gotFilter.TxID)
	require.Equal(t, uint32(3), *reader.gotFilter.Vout)

	reader.rows = wdk.TableOutputs{{Spendable: true, SpentBy: &spent}}
	ok, err = s.StillSpendable(ctx, op)
	require.NoError(t, err)
	require.False(t, ok)

	reader.rows = wdk.TableOutputs{{Spendable: false}}
	ok, err = s.StillSpendable(ctx, op)
	require.NoError(t, err)
	require.False(t, ok)

	// Unknown or ambiguous rows fail closed: an error, never "spent".
	reader.rows = nil
	_, err = s.StillSpendable(ctx, op)
	require.Error(t, err)
	reader.rows = wdk.TableOutputs{{Spendable: true}, {Spendable: true}}
	_, err = s.StillSpendable(ctx, op)
	require.Error(t, err)

	reader.rows, reader.err = nil, errors.New("db down")
	_, err = s.StillSpendable(ctx, op)
	require.Error(t, err)

	_, err = s.StillSpendable(ctx, "not-an-outpoint")
	require.Error(t, err)
}

func TestSelectProven(t *testing.T) {
	f := newFake(t)
	self := f.IdentityKeyHex()
	other, err := ec.NewPrivateKey()
	require.NoError(t, err)
	otherHex := other.PubKey().ToDERHex()

	accepted := f.AddFuel(t, 100)
	selfSender := f.AddFuel(t, 110)
	spentRow := f.AddFuel(t, 120)
	notInBasket := f.AddFuel(t, 130)
	foreign := f.AddFuel(t, 140)
	txidOnly := f.AddFuel(t, 150)
	unproven := f.AddFuel(t, 160)
	absent := f.AddFuel(t, 170)
	notChange := f.AddFuel(t, 180)
	noDerivation := f.AddFuel(t, 190)

	beef := transaction.NewBeefV2()
	for _, r := range []Row{accepted, selfSender, spentRow, notInBasket, foreign, notChange, noDerivation} {
		require.NoError(t, beef.MergeBeefBytes(r.Beef))
	}
	h, err := chainhash.NewHashFromHex(txidOnly.Txid)
	require.NoError(t, err)
	beef.MergeTxidOnly(h)
	utx, err := transaction.NewTransactionFromBEEF(unproven.Beef)
	require.NoError(t, err)
	utx.MerklePath = nil
	_, err = beef.MergeTransaction(utx)
	require.NoError(t, err)

	inBasket := map[string]sdk.Output{}
	for _, r := range []Row{accepted, selfSender, spentRow, foreign, txidOnly, unproven, absent, notChange, noDerivation} {
		inBasket[r.Outpoint] = sdk.Output{}
	}

	spentBy := uint(1)
	rows := wdk.TableOutputs{}
	for _, r := range []Row{accepted, selfSender, spentRow, notInBasket, foreign, txidOnly, unproven, absent, notChange, noDerivation} {
		tr := tableRow(r)
		switch r.Outpoint {
		case selfSender.Outpoint:
			tr.SenderIdentityKey = &self
		case spentRow.Outpoint:
			tr.SpentBy = &spentBy
		case foreign.Outpoint:
			tr.SenderIdentityKey = &otherHex
		case notChange.Outpoint:
			tr.Change = false
		case noDerivation.Outpoint:
			tr.DerivationSuffix = nil
		}
		rows = append(rows, tr)
	}

	out, skipped := selectProven(rows, inBasket, beef, self)
	require.Equal(t, []string{selfSender.Outpoint, accepted.Outpoint}, outpoints(out))
	require.Equal(t, 3, skipped, "txid-only, unproven and absent rows lack proof material")

	got := out[1]
	require.Equal(t, accepted.Satoshis, got.Satoshis)
	require.Equal(t, accepted.DerivationPrefix, got.DerivationPrefix)
	require.Equal(t, accepted.DerivationSuffix, got.DerivationSuffix)
	require.Equal(t, accepted.LockingScript, got.LockingScript)
	src, err := transaction.NewTransactionFromBEEF(got.Beef)
	require.NoError(t, err)
	require.Equal(t, accepted.Txid, src.TxID().String())
	require.NotNil(t, src.MerklePath)

	// No BEEF at all: every otherwise-eligible row is skipped for proof.
	out, skipped = selectProven(rows, inBasket, nil, self)
	require.Empty(t, out)
	require.Equal(t, 5, skipped)
}
