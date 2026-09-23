// Package auth verifies signed draft/release requests exactly as the overlay
// does (spec §3.1): the requester signs with counterparty 'anyone', so a
// ProtoWallet over the well-known 'anyone' key verifies with counterparty =
// requester. Verification succeeds only on Valid==true with a nil error.
package auth

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
)

var (
	ErrShape = errors.New("shape")
	ErrAuth  = errors.New("auth")

	FuelProtocol = sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryApp, Protocol: "mandala fuel"}
)

func DraftMessage(assetID string, n, m int, requester, nonce string, ts int64) []byte {
	return []byte("mandala-fuel-draft:" + assetID + ":" + strconv.Itoa(n) + ":" + strconv.Itoa(m) + ":" + requester + ":" + nonce + ":" + strconv.FormatInt(ts, 10))
}

func ReleaseMessage(requestID, requester string, ts int64) []byte {
	return []byte("mandala-fuel-release:" + requestID + ":" + requester + ":" + strconv.FormatInt(ts, 10))
}

type Verifier struct {
	pw     *sdk.ProtoWallet
	now    func() time.Time
	window time.Duration
}

func NewVerifier(now func() time.Time) (*Verifier, error) {
	pw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypeAnyone})
	if err != nil {
		return nil, fmt.Errorf("auth: anyone wallet: %w", err)
	}
	return &Verifier{pw: pw, now: now, window: 300 * time.Second}, nil
}

// ParseRequester enforces the parse boundary: 66 hex chars decoding to a valid compressed point.
func ParseRequester(requesterHex string) (*ec.PublicKey, error) {
	if len(requesterHex) != 66 {
		return nil, fmt.Errorf("%w: requester must be 66 hex chars", ErrShape)
	}
	if _, err := hex.DecodeString(requesterHex); err != nil {
		return nil, fmt.Errorf("%w: requester not hex", ErrShape)
	}
	pub, err := ec.PublicKeyFromString(requesterHex)
	if err != nil {
		return nil, fmt.Errorf("%w: requester not a valid point", ErrShape)
	}
	return pub, nil
}

func ValidNonce(nonce string) bool {
	if len(nonce) != 64 {
		return false
	}
	_, err := hex.DecodeString(nonce)
	return err == nil
}

func (v *Verifier) Verify(ctx context.Context, requesterHex, keyID, sigHex string, ts int64, msg []byte) error {
	pub, err := ParseRequester(requesterHex)
	if err != nil {
		return err
	}
	if !ValidNonce(keyID) {
		return fmt.Errorf("%w: nonce must be 64 hex chars", ErrShape)
	}
	sigBytes, err := hex.DecodeString(sigHex)
	if err != nil {
		return fmt.Errorf("%w: sig not hex", ErrShape)
	}
	sig, err := ec.ParseDERSignature(sigBytes)
	if err != nil {
		return fmt.Errorf("%w: sig not DER", ErrShape)
	}
	d := v.now().Unix() - ts
	if d > int64(v.window/time.Second) || -d > int64(v.window/time.Second) {
		return fmt.Errorf("%w: ts outside window", ErrShape)
	}
	res, err := v.pw.VerifySignature(ctx, sdk.VerifySignatureArgs{
		EncryptionArgs: sdk.EncryptionArgs{
			ProtocolID:   FuelProtocol,
			KeyID:        keyID,
			Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeOther, Counterparty: pub},
		},
		Data:      msg,
		Signature: sig,
	}, "fuelkeeper")
	if err != nil || res == nil || !res.Valid {
		return ErrAuth
	}
	return nil
}

// Sign produces the requester-side signature (counterparty 'anyone'); used by
// tests and by the overlay's own test fixtures.
func Sign(ctx context.Context, pw *sdk.ProtoWallet, keyID string, msg []byte) (string, error) {
	res, err := pw.CreateSignature(ctx, sdk.CreateSignatureArgs{
		EncryptionArgs: sdk.EncryptionArgs{
			ProtocolID:   FuelProtocol,
			KeyID:        keyID,
			Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeAnyone},
		},
		Data: msg,
	}, "test")
	if err != nil {
		return "", err
	}
	der, err := res.Signature.ToDER()
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(der), nil
}
