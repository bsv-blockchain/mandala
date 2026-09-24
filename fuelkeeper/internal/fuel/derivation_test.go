package fuel

import (
	"context"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

func TestFeeKeyMatchesRequesterSideDerivation(t *testing.T) {
	issuerPriv, _ := ec.NewPrivateKey()
	requesterPriv, _ := ec.NewPrivateKey()
	f := NewFake(issuerPriv)
	pkh, err := f.FeePubKeyHash(context.Background(), "fee-aa.0", requesterPriv.PubKey())
	require.NoError(t, err)
	require.Len(t, pkh, 20)

	rw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypePrivateKey, PrivateKey: requesterPriv})
	require.NoError(t, err)
	res, err := rw.GetPublicKey(context.Background(), sdk.GetPublicKeyArgs{EncryptionArgs: sdk.EncryptionArgs{
		ProtocolID:   token.FTProtocol,
		KeyID:        "fee-aa.0",
		Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeOther, Counterparty: issuerPriv.PubKey()},
	}}, "test")
	require.NoError(t, err)
	require.Equal(t, res.PublicKey.Hash(), pkh)
}

func TestFakeUnlockerSignsItsOwnFuel(t *testing.T) {
	issuerPriv, _ := ec.NewPrivateKey()
	f := NewFake(issuerPriv)
	row := f.AddFuel(t, 200)
	rows, err := f.ListProven(context.Background(), "fuel", 10, 0)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, row.Outpoint, rows[0].Outpoint)
	require.NoError(t, f.Detach(context.Background(), row.Outpoint))
	ok, err := f.StillSpendable(context.Background(), row.Outpoint)
	require.NoError(t, err)
	require.True(t, ok)
	f.SpendExternally(row.Outpoint)
	ok, _ = f.StillSpendable(context.Background(), row.Outpoint)
	require.False(t, ok)
}
