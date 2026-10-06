// Package mandalatest builds real-signature Mandala fixtures for Go tests: fixed parties, BRC-42
// derived token locks, BRC-72 linkage revealed to the overlay, SPV-valid spends, atomic BEEF and
// the off-chain envelope. It imports only internal/brc162 and go-sdk, never internal/mandala, so
// package mandala's own tests, wiring and httpapi can all use it (plan D-3).
package mandalatest

import (
	"bytes"
	"encoding/hex"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// Party is one fixed test identity.
type Party struct {
	Name     string
	Priv     *ec.PrivateKey
	Identity string // compressed lowercase hex
}

// NewParty returns the party whose private key is 32 copies of scalar.
func NewParty(name string, scalar byte) Party {
	priv, _ := ec.PrivateKeyFromBytes(bytes.Repeat([]byte{scalar}, 32))
	return Party{Name: name, Priv: priv, Identity: priv.PubKey().ToDERHex()}
}

// PrivHex is the 64-hex private key (what a test passes as SERVER_PRIVATE_KEY for Overlay).
func (p Party) PrivHex() string { return hex.EncodeToString(p.Priv.Serialize()) }

// The TS vectors' cast (F/ts-layers §13, Q2 fixtures.ts): verifier 0a, issuer 66, holder 44,
// receiver 22, rogue 33.
var (
	Overlay  = NewParty("overlay", 0x0a)
	Issuer   = NewParty("issuer", 0x66)
	Holder   = NewParty("holder", 0x44)
	Receiver = NewParty("receiver", 0x22)
	Rogue    = NewParty("rogue", 0x33)
)

// FTProtocol is the one protocol every Mandala token output derives under (D §5.1a).
var FTProtocol = wallet.Protocol{SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, Protocol: "mandala token"}

// deployProtocol is D §5.3's deploy-signature protocol.
var deployProtocol = wallet.Protocol{SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, Protocol: "mandala deploy"}

// fundingParty owns every funding coin; it is never a token party.
var fundingParty = NewParty("funding", 0x55)

func (p Party) protoWallet() *wallet.ProtoWallet {
	pw, err := wallet.NewProtoWallet(wallet.ProtoWalletArgs{Type: wallet.ProtoWalletArgsTypePrivateKey, PrivateKey: p.Priv})
	if err != nil {
		panic("mandalatest: proto wallet for " + p.Name + ": " + err.Error())
	}
	return pw
}

func (p Party) other() wallet.Counterparty {
	return wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: p.Priv.PubKey()}
}
