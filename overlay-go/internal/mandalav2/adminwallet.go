package mandalav2

import (
	"fmt"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// adminProtocol is ADMIN_PROTOCOL = [2, "mandala admin"] (Appendix A §1.4).
var adminProtocol = wallet.Protocol{
	SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, // 2
	Protocol:      "mandala admin",
}

// AdminWallet holds the admin root key and re-derives the P2PKH lock key an
// admin-auth output must be locked to for a given action-details commitment
// (Appendix A §1.4 key binding, §3.2c verification).
type AdminWallet struct {
	deriver *wallet.KeyDeriver
}

// NewAdminWallet builds an AdminWallet from a hex-encoded secp256k1 private
// key (the admin root key).
func NewAdminWallet(privHex string) (*AdminWallet, error) {
	priv, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		return nil, fmt.Errorf("admin key: %w", err)
	}
	return &AdminWallet{deriver: wallet.NewKeyDeriver(priv)}, nil
}

// ExpectedPKH derives hash160(derivePublicKey(ADMIN_PROTOCOL,
// Commitment(details), counterparty, forSelf=false)). The counterparty is
// details["counterparty"] when it is a string, else "self" (self-locked
// auth) — Appendix A §1.4 / §3.2c.
func (w *AdminWallet) ExpectedPKH(details ActionDetails) ([20]byte, error) {
	var out [20]byte
	keyID, err := Commitment(map[string]any(details))
	if err != nil {
		return out, err
	}
	cp := wallet.Counterparty{Type: wallet.CounterpartyTypeSelf}
	if s, ok := details.Str("counterparty"); ok {
		pub, err := ec.PublicKeyFromString(s)
		if err != nil {
			return out, fmt.Errorf("admin counterparty: %w", err)
		}
		cp = wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: pub}
	}
	pub, err := w.deriver.DerivePublicKey(adminProtocol, keyID, cp, false)
	if err != nil {
		return out, err
	}
	copy(out[:], hash.Hash160(pub.Compressed()))
	return out, nil
}
