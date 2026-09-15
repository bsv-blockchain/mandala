package mandala

import (
	"context"
	"strings"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// The owner of an output is bound when the overlay admits it, from the
// recipient the output linkage declares. A spend is therefore named from the
// stored owner of the coin being spent -- never from the payload's linkage
// counterparty, which is whoever PAID that coin and, under sender blinding, is
// a one-time key that is deliberately not an identity at all.

const blindedSenderKeyHex = "000000000000000000000000000000000000000000000000000000000000000a"

// payHolderFromSender rebuilds the harness source coin as one the SENDER paid
// to the HOLDER, and reveals the input linkage the way lib/src/transfer.ts
// does: counterparty = the sender recorded in the received output's
// customInstructions. Returns the sender's identity key.
func payHolderFromSender(t *testing.T, h *harness, senderHex string) string {
	t.Helper()
	senderPriv, err := ec.PrivateKeyFromHex(senderHex)
	if err != nil {
		t.Fatal(err)
	}
	senderPub := senderPriv.PubKey()
	locked, err := wallet.NewKeyDeriver(senderPriv).DerivePublicKey(ftProtocol, "paid-0",
		wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: h.holderPub}, false)
	if err != nil {
		t.Fatal(err)
	}
	h.srcTx = transaction.NewTransaction()
	h.srcTx.AddInput(dummyInput(0x01, 0))
	h.srcTx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: mustLockToken(t, h.assetID, 100, hash.Hash160(locked.Compressed())),
	})
	h.srcOutpoint = fmtOutpoint(h.srcTx.TxID().String(), 0)
	h.tx.Inputs[0].SourceTXID = h.srcTx.TxID()
	h.tx.Inputs[0].SourceTransaction = h.srcTx
	h.payload.Inputs = []IndexedLinkage{{Index: 0, Linkage: h.reveal(t, "paid-0", senderPub)}}
	h.refresh(t)
	return senderPub.ToDERHex()
}

// admittedRegistry admits exactly the given identities.
type admittedRegistry map[string]bool

func (a admittedRegistry) RegistryActive(context.Context) (bool, error) { return len(a) > 0, nil }
func (a admittedRegistry) IsAdmitted(_ context.Context, k string) (bool, error) {
	return a[k], nil
}

func TestSpendIsNamedFromTheStoredOwnerNotThePayingKey(t *testing.T) {
	h := newHarness(t)
	sender := payHolderFromSender(t, h, blindedSenderKeyHex)

	// The overlay bound the holder as the owner when it admitted the coin.
	h.state.tokens[h.srcOutpoint] = &TokenRow{
		Txid: h.srcTx.TxID().String(), OutputIndex: 0,
		AssetID: h.assetID, Amount: 100, IdentityKey: h.holderID,
	}
	// The registry admits the holder and the recipient. It does NOT admit the
	// one-time key that paid the holder -- under blinding it never could.
	h.tm.registry = admittedRegistry{h.holderID: true, h.recipientID: true}

	if _, err := h.run(t, []uint32{0}); err != nil {
		t.Fatalf("spend of a coin paid by a blinded sender was refused: %v", err)
	}
	if strings.EqualFold(sender, h.holderID) {
		t.Fatal("fixture error: sender and holder must differ")
	}
}

func TestSpendByANonAdmittedOwnerIsRefused(t *testing.T) {
	h := newHarness(t)
	payHolderFromSender(t, h, blindedSenderKeyHex)
	h.state.tokens[h.srcOutpoint] = &TokenRow{
		Txid: h.srcTx.TxID().String(), OutputIndex: 0,
		AssetID: h.assetID, Amount: 100, IdentityKey: h.holderID,
	}
	// The holder has been revoked; the recipient is fine.
	h.tm.registry = admittedRegistry{h.recipientID: true}

	if _, err := h.run(t, []uint32{0}); err == nil {
		t.Fatal("a revoked owner was allowed to spend")
	}
}

func TestInputLinkageThatDoesNotControlTheSpentCoinIsRejected(t *testing.T) {
	h := newHarness(t)
	payHolderFromSender(t, h, blindedSenderKeyHex)
	h.state.tokens[h.srcOutpoint] = &TokenRow{
		Txid: h.srcTx.TxID().String(), OutputIndex: 0,
		AssetID: h.assetID, Amount: 100, IdentityKey: h.holderID,
	}
	// Swap in a linkage for a different key: it verifies cryptographically but
	// reconstructs a key that does not lock the coin being spent.
	h.payload.Inputs = []IndexedLinkage{{Index: 0, Linkage: h.reveal(t, "unrelated", h.recipientPub)}}
	h.refresh(t)

	if _, err := h.run(t, []uint32{0}); err == nil {
		t.Fatal("an input linkage that does not control the spent coin was accepted")
	}
}
