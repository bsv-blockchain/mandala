package auth

import (
	"context"
	"encoding/hex"
	"math"
	"testing"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"
)

const asset = "abababababababababababababababababababababababababababababababab.0"

func requester(t *testing.T) (*sdk.ProtoWallet, string) {
	t.Helper()
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	pw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypePrivateKey, PrivateKey: priv})
	require.NoError(t, err)
	return pw, priv.PubKey().ToDERHex()
}

func TestDraftMessage_Canonical(t *testing.T) {
	msg := DraftMessage(asset, 1, 3, "02aa", "ff", 1758500000)
	require.Equal(t, "mandala-fuel-draft:"+asset+":1:3:02aa:ff:1758500000", string(msg))
	require.Equal(t, "mandala-fuel-release:req:02aa:5", string(ReleaseMessage("req", "02aa", 5)))
}

func TestVerify_RoundTrip(t *testing.T) {
	now := time.Unix(1758500000, 0)
	v, err := NewVerifier(func() time.Time { return now })
	require.NoError(t, err)
	pw, pub := requester(t)
	nonce := hex.EncodeToString(make([]byte, 32))
	msg := DraftMessage(asset, 1, 3, pub, nonce, now.Unix())
	sig, err := Sign(context.Background(), pw, nonce, msg)
	require.NoError(t, err)
	require.NoError(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix(), msg))
}

func TestVerify_Rejections(t *testing.T) {
	now := time.Unix(1758500000, 0)
	v, _ := NewVerifier(func() time.Time { return now })
	pw, pub := requester(t)
	_, other := requester(t)
	nonce := hex.EncodeToString(make([]byte, 32))
	msg := DraftMessage(asset, 1, 3, pub, nonce, now.Unix())
	sig, _ := Sign(context.Background(), pw, nonce, msg)

	require.ErrorIs(t, v.Verify(context.Background(), other, nonce, sig, now.Unix(), msg), ErrAuth, "wrong requester")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix(), append(msg, 'x')), ErrAuth, "tampered message")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix()+301, msg), ErrShape, "ts outside window")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix()-301, msg), ErrShape)
	require.ErrorIs(t, v.Verify(context.Background(), "02zz", nonce, sig, now.Unix(), msg), ErrShape, "requester not hex")
	require.ErrorIs(t, v.Verify(context.Background(), pub[:64], nonce, sig, now.Unix(), msg), ErrShape, "requester wrong length")
	require.ErrorIs(t, v.Verify(context.Background(), pub, "abcd", sig, now.Unix(), msg), ErrShape, "nonce not 64 hex")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, "3000", now.Unix(), msg), ErrShape, "sig not DER")
	// A structurally valid DER signature over other data is an auth failure, not a shape failure.
	otherSig, _ := Sign(context.Background(), pw, nonce, []byte("other"))
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, otherSig, now.Unix(), msg), ErrAuth)
	// The window edges are inclusive.
	for _, ts := range []int64{now.Unix() - 300, now.Unix() + 300} {
		edge := DraftMessage(asset, 1, 3, pub, nonce, ts)
		edgeSig, err := Sign(context.Background(), pw, nonce, edge)
		require.NoError(t, err)
		require.NoError(t, v.Verify(context.Background(), pub, nonce, edgeSig, ts, edge), "ts %d", ts)
	}
}

// An adversarial ts must never wrap the window arithmetic. Each ts is signed
// over the message it is verified with, so only the window check can refuse
// it: now+math.MinInt64 makes now-ts wrap to math.MinInt64, whose negation is
// itself, which a subtract-then-negate check accepted.
func TestVerify_ExtremeTimestampsAreOutsideWindow(t *testing.T) {
	now := time.Unix(1758500000, 0)
	v, err := NewVerifier(func() time.Time { return now })
	require.NoError(t, err)
	pw, pub := requester(t)
	nonce := hex.EncodeToString(make([]byte, 32))
	for _, ts := range []int64{math.MinInt64, math.MaxInt64, now.Unix() + math.MinInt64, math.MinInt64 + 1, math.MaxInt64 - 1} {
		msg := DraftMessage(asset, 1, 3, pub, nonce, ts)
		sig, err := Sign(context.Background(), pw, nonce, msg)
		require.NoError(t, err)
		require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, sig, ts, msg), ErrShape, "ts %d", ts)
	}
}
