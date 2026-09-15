package mandala

import (
	"context"
	"fmt"
	"math/big"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// Verifier holds the verifier's identity key and wraps a go-sdk ProtoWallet,
// which performs the BRC-2/42/43 decryption needed to unwrap a specific key
// linkage revelation (BRC-72 §2.5).
type Verifier struct {
	pw       *wallet.ProtoWallet
	identity string
}

// NewVerifier builds a Verifier from a hex-encoded secp256k1 private key.
func NewVerifier(privHex string) (*Verifier, error) {
	priv, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		return nil, fmt.Errorf("verifier key: %w", err)
	}
	pw, err := wallet.NewProtoWallet(wallet.ProtoWalletArgs{
		Type:       wallet.ProtoWalletArgsTypePrivateKey,
		PrivateKey: priv,
	})
	if err != nil {
		return nil, err
	}
	return &Verifier{pw: pw, identity: priv.PubKey().ToDERHex()}, nil
}

// IdentityKey returns the verifier's own identity public key, hex-encoded.
func (v *Verifier) IdentityKey() string { return v.identity }

// VerifyKeyLinkage decrypts a BRC-72 specific-key-linkage revelation and
// reconstructs the derived public key hash it attests to.
//
// Algorithm (BRC-72 Appendix A §2.5): decrypt l.EncryptedLinkage as the
// verifier, using the wrapper protocol [2, "specific linkage revelation
// <origLevel> <origName>"], the original keyID, and the prover as
// counterparty. The decrypted plaintext L is the BRC-42 invoice-number HMAC
// scalar; the specific derived key is then
// derived = Point(l.Counterparty) + (L mod n)·G, and the returned hash is
// hash160 of its compressed encoding.
func (v *Verifier) VerifyKeyLinkage(ctx context.Context, l *SpecificLinkage) (string, []byte, error) {
	if l == nil {
		return "", nil, fmt.Errorf("nil linkage")
	}
	proverPub, err := ec.PublicKeyFromString(l.Prover)
	if err != nil {
		return "", nil, fmt.Errorf("prover key: %w", err)
	}
	wrapper := wallet.Protocol{
		SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, // 2
		Protocol: fmt.Sprintf("specific linkage revelation %d %s",
			l.ProtocolID.SecurityLevel, l.ProtocolID.Name),
	}
	dec, err := v.pw.Decrypt(ctx, wallet.DecryptArgs{
		EncryptionArgs: wallet.EncryptionArgs{
			ProtocolID: wrapper,
			KeyID:      l.KeyID,
			Counterparty: wallet.Counterparty{
				Type:         wallet.CounterpartyTypeOther,
				Counterparty: proverPub,
			},
		},
		Ciphertext: []byte(l.EncryptedLinkage),
	}, "")
	if err != nil {
		return "", nil, fmt.Errorf("linkage decrypt: %w", err)
	}
	counterPub, err := ec.PublicKeyFromString(l.Counterparty)
	if err != nil {
		return "", nil, fmt.Errorf("counterparty key: %w", err)
	}
	// derived = counterparty + (L mod n)·G
	curve := ec.S256()
	scalar := new(big.Int).SetBytes(dec.Plaintext)
	scalar.Mod(scalar, curve.Params().N)
	lx, ly := curve.ScalarBaseMult(scalar.Bytes())
	dx, dy := curve.Add(counterPub.X, counterPub.Y, lx, ly)
	derived := &ec.PublicKey{Curve: curve, X: dx, Y: dy}
	pkh := hash.Hash160(derived.Compressed())
	return l.Counterparty, pkh, nil
}

// VerifyInputLinkage reconstructs the key a linkage attests to for a coin
// BEING SPENT, and names the party that holds it.
//
// For an OUTPUT the linkage declares the recipient, so the derived key is
// counterparty + L·G (VerifyKeyLinkage). For an INPUT the revealer is the
// spender: the coin was locked to the spender's own child key, so the key is
// prover + L·G and the party is the prover. Checking an input against
// counterparty reconstructs the key of whoever PAID that coin, which never
// matches the coin being spent and, under sender blinding, is a one-time key
// that is not an identity at all.
func (v *Verifier) VerifyInputLinkage(ctx context.Context, l *SpecificLinkage) (string, []byte, error) {
	if l == nil {
		return "", nil, fmt.Errorf("nil linkage")
	}
	proverPub, err := ec.PublicKeyFromString(l.Prover)
	if err != nil {
		return "", nil, fmt.Errorf("prover key: %w", err)
	}
	offset, err := v.linkageOffset(ctx, l, proverPub)
	if err != nil {
		return "", nil, err
	}
	curve := ec.S256()
	lx, ly := curve.ScalarBaseMult(offset.Bytes())
	dx, dy := curve.Add(proverPub.X, proverPub.Y, lx, ly)
	derived := &ec.PublicKey{Curve: curve, X: dx, Y: dy}
	return l.Prover, hash.Hash160(derived.Compressed()), nil
}

// linkageOffset decrypts the BRC-72 revelation and returns L mod n.
func (v *Verifier) linkageOffset(ctx context.Context, l *SpecificLinkage, proverPub *ec.PublicKey) (*big.Int, error) {
	wrapper := wallet.Protocol{
		SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, // 2
		Protocol: fmt.Sprintf("specific linkage revelation %d %s",
			l.ProtocolID.SecurityLevel, l.ProtocolID.Name),
	}
	dec, err := v.pw.Decrypt(ctx, wallet.DecryptArgs{
		EncryptionArgs: wallet.EncryptionArgs{
			ProtocolID: wrapper,
			KeyID:      l.KeyID,
			Counterparty: wallet.Counterparty{
				Type:         wallet.CounterpartyTypeOther,
				Counterparty: proverPub,
			},
		},
		Ciphertext: []byte(l.EncryptedLinkage),
	}, "")
	if err != nil {
		return nil, fmt.Errorf("linkage decrypt: %w", err)
	}
	scalar := new(big.Int).SetBytes(dec.Plaintext)
	return scalar.Mod(scalar, ec.S256().Params().N), nil
}

// LinkageControlsPKH reports whether l's specific key linkage controls pkh.
// It returns false on any error (bad keys, failed decrypt/GCM auth, length
// mismatch) rather than propagating the error, and compares in constant
// shape (fixed-length loop, no early return mid-comparison).
func (v *Verifier) LinkageControlsPKH(ctx context.Context, l *SpecificLinkage, pkh []byte) bool {
	if l == nil || len(pkh) != 20 {
		return false
	}
	_, got, err := v.VerifyKeyLinkage(ctx, l)
	if err != nil || len(got) != len(pkh) {
		return false
	}
	diff := byte(0)
	for i := range got {
		diff |= got[i] ^ pkh[i]
	}
	return diff == 0
}
