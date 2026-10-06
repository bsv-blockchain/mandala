package mandala

import (
	"context"
	"encoding/hex"
	"errors"
	"math/big"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// The deploy signature (design §5.3; TS src/mandala/deploySig.ts): the issuer's
// signature over this txid, so an issuer's earlier linkage cannot be replayed
// onto a spoofed deploy.
const DeployPrefix = "mandala-deploy:"

var DeployProtocol = wallet.Protocol{SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, Protocol: "mandala deploy"}

// DeployDigest is the UTF-8 bytes of "mandala-deploy:" + txid (txid: 64 lowercase hex, display order).
func DeployDigest(txid string) []byte { return []byte(DeployPrefix + txid) }

var errNonCanonicalDER = errors.New("signature is not canonical DER")

// ParseDERLikeTS accepts exactly the signatures TS ProtoWallet.verifySignature
// lets through to verification (D-14, Open Risk R2). TS runs
// validateVerifySignatureArgs first (at most 72 bytes, then
// isCanonicalDERSignature: @bsv/sdk 2.8.11 dist/esm/src/wallet/validationHelpers.js:1223-1230
// and Secp256k1Validation.js:32-53; ts-stack 37468f290
// packages/sdk/src/wallet/validationHelpers.ts:1795-1804 and Secp256k1Validation.ts:33-51),
// then Signature.fromDER (Signature.js:41-93), which accepts every canonical
// DER signature. So this is a line-for-line port of isCanonicalDERSignature:
// total length 8..72, 0x30, length byte = total-2, two INTEGERs (0x02) of 1..33
// bytes, no high bit on the first byte, no excess zero pad, 0 < scalar < N, no
// trailing bytes. High-S is accepted (neither side enforces low-S).
func ParseDERLikeTS(b []byte) (*ec.Signature, error) {
	if len(b) < 8 || len(b) > 72 || b[0] != 0x30 || int(b[1]) != len(b)-2 {
		return nil, errNonCanonicalDER
	}
	n := ec.S256().Params().N
	var scalars [2]*big.Int
	offset := 2
	for i := range scalars {
		if offset >= len(b) || b[offset] != 0x02 {
			return nil, errNonCanonicalDER
		}
		offset++
		if offset >= len(b) {
			return nil, errNonCanonicalDER
		}
		length := int(b[offset])
		offset++
		if length < 1 || length > 33 || offset+length > len(b) {
			return nil, errNonCanonicalDER
		}
		first := b[offset]
		if first&0x80 != 0 || (length > 1 && first == 0 && b[offset+1]&0x80 == 0) {
			return nil, errNonCanonicalDER
		}
		scalar := new(big.Int).SetBytes(b[offset : offset+length])
		if scalar.Sign() == 0 || scalar.Cmp(n) >= 0 {
			return nil, errNonCanonicalDER
		}
		scalars[i] = scalar
		offset += length
	}
	if offset != len(b) {
		return nil, errNonCanonicalDER
	}
	return &ec.Signature{R: scalars[0], S: scalars[1]}, nil
}

// VerifyDeploySig ports TS verifyDeploySig (deploySig.ts:22-40): true only when
// sigHex is the owner's createSignature over DeployDigest(txid) under
// [2, "mandala deploy"], keyID "1", counterparty "anyone". Anything else,
// including any error, is false. The owner key must be a 66-hex compressed key,
// as TS validateCounterparty requires.
func VerifyDeploySig(ctx context.Context, txid, sigHex string, hasSig bool, ownerIdentityKey string) bool {
	if !hasSig || !lowercaseHexPairs.MatchString(sigHex) {
		return false
	}
	raw, err := hex.DecodeString(sigHex)
	if err != nil {
		return false
	}
	sig, err := ParseDERLikeTS(raw)
	if err != nil {
		return false
	}
	if len(ownerIdentityKey) != 66 {
		return false
	}
	owner, err := ec.PublicKeyFromString(ownerIdentityKey)
	if err != nil {
		return false
	}
	pw, err := wallet.NewProtoWallet(wallet.ProtoWalletArgs{Type: wallet.ProtoWalletArgsTypeAnyone})
	if err != nil {
		return false
	}
	res, err := pw.VerifySignature(ctx, wallet.VerifySignatureArgs{
		EncryptionArgs: wallet.EncryptionArgs{
			ProtocolID:   DeployProtocol,
			KeyID:        "1",
			Counterparty: wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: owner},
		},
		Data:      DeployDigest(txid),
		Signature: sig,
	}, "")
	return err == nil && res != nil && res.Valid
}
