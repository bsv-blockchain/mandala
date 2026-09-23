package mandala

import (
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// Admin authority is the chain of spends, not key re-derivation: an admin
// action is authorised because it SPENDS the asset's previously admitted
// admin output. details.counterparty is therefore free to name whoever holds
// authority next (delegation), while forgery is closed by requiring the prior
// to be an admin output this topic recorded for this asset AND to be actually
// spent by this transaction.

const attackerKeyHex = "0000000000000000000000000000000000000000000000000000000000000005"

// attackerLockedAdminOutput appends an admin output whose pkh the ATTACKER
// derived from its own key plus the overlay's PUBLIC admin key — no access to
// the overlay's private key required.
func attackerLockedAdminOutput(t *testing.T, h *harness, details ActionDetails) {
	t.Helper()
	attackerPriv, err := ec.PrivateKeyFromHex(attackerKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	adminPriv, err := ec.PrivateKeyFromHex(adminKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	keyID, err := Commitment(map[string]any(details))
	if err != nil {
		t.Fatal(err)
	}
	pub, err := wallet.NewKeyDeriver(attackerPriv).DerivePublicKey(adminProtocol, keyID,
		wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: adminPriv.PubKey()}, true)
	if err != nil {
		t.Fatal(err)
	}
	var pkh [20]byte
	copy(pkh[:], hash.Hash160(pub.Compressed()))
	h.tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: p2pkhScript(t, pkh)})
	h.payload.Admin = append(h.payload.Admin, IndexedAdmin{
		Index: uint32(len(h.tx.Outputs) - 1), ActionDetails: details,
	})
}

func pausedHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	st := DefaultAssetState(h.assetID)
	st.IsPaused = true
	h.state.states[h.assetID] = st
	return h
}

func TestForgedAdminOutputRejectedWhenPriorIsNotAnAdminOutput(t *testing.T) {
	h := pausedHarness(t)
	// The attacker points priorOutpoint at a coin it owns, which this topic
	// never admitted as an admin output.
	prior := h.addPriorAuthInput(0xAB, 3)
	attackerLockedAdminOutput(t, h, ActionDetails{
		"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
		"counterparty": mustPubHex(t, attackerKeyHex),
	})
	if _, err := h.run(t, []uint32{0}); err == nil {
		t.Fatal("forged unpause was admitted: a third party can lift a pause")
	}
}

func TestForgedAdminOutputRejectedEvenWhenPriorIsSpent(t *testing.T) {
	h := pausedHarness(t)
	// Stronger: the prior IS an input the engine previously admitted (index 0,
	// the FT coin) but it is not an admin output of this asset.
	prior := fmtOutpoint(h.srcTx.TxID().String(), 0)
	attackerLockedAdminOutput(t, h, ActionDetails{
		"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
		"counterparty": mustPubHex(t, attackerKeyHex),
	})
	if _, err := h.run(t, []uint32{0}); err == nil {
		t.Fatal("forged unpause admitted while spending a non-admin previousCoin")
	}
}

func TestAdminActionAdmittedWhenItSpendsTheRecordedAdminOutput(t *testing.T) {
	h := pausedHarness(t)
	prior := h.addPriorAuthInput(0x77, 1)
	h.state.adminOutpoints[h.assetID+"|"+prior] = true
	h.addAdminOutput(t, ActionDetails{
		"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
	})
	res, err := h.run(t, []uint32{0, 1})
	if err != nil {
		t.Fatal(err)
	}
	wantAdmitted(t, res, 0, 1, 2)
}

func TestAdminAuthorityTransfersToWhoeverTheNextOutputIsLockedTo(t *testing.T) {
	h := pausedHarness(t)
	prior := h.addPriorAuthInput(0x77, 1)
	h.state.adminOutpoints[h.assetID+"|"+prior] = true
	// The issuer delegates: the next admin output is locked to the delegate,
	// named by details.counterparty. That is legitimate, because producing it
	// required spending the recorded admin output.
	attackerLockedAdminOutput(t, h, ActionDetails{
		"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
		"counterparty": mustPubHex(t, attackerKeyHex),
	})
	res, err := h.run(t, []uint32{0, 1})
	if err != nil {
		t.Fatalf("delegation via a legitimately chained spend was rejected: %v", err)
	}
	wantAdmitted(t, res, 0, 1, 2)
}

func TestAdminActionRejectedWhenPriorIsRecordedButNotSpentByThisTx(t *testing.T) {
	h := pausedHarness(t)
	prior := h.addPriorAuthInput(0x77, 1)
	h.state.adminOutpoints[h.assetID+"|"+prior] = true
	h.addAdminOutput(t, ActionDetails{
		"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
	})
	// previousCoins omits input 1, so the engine did not admit that spend.
	if _, err := h.run(t, []uint32{0}); err == nil {
		t.Fatal("admin action admitted without the prior being a previously admitted coin")
	}
}

func TestRegisterNeedsNoPriorAndCannotClaimAnExistingAsset(t *testing.T) {
	h := newHarness(t)
	// A genesis register creates its OWN asset (assetId = its outpoint), so it
	// needs no prior and grants no authority over any existing asset.
	h.addAdminOutput(t, ActionDetails{"kind": "register"})
	if _, err := h.run(t, []uint32{0}); err != nil {
		t.Fatalf("genesis register rejected: %v", err)
	}
}

func mustPubHex(t *testing.T, privHex string) string {
	t.Helper()
	p, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		t.Fatal(err)
	}
	return p.PubKey().ToDERHex()
}

// P0 (token-fee spec §2.1): register is unauthenticated (its lock key is
// re-derived against the payload's counterparty), so the only thing that keeps
// a third party from grafting itself onto an EXISTING asset's admin chain is
// refusing any register that names an assetId. A genesis has none.
func TestRegisterNamingAnExistingAssetIsRejected(t *testing.T) {
	h := newHarness(t)
	h.addAdminOutput(t, ActionDetails{
		"kind": "register", "assetId": h.assetID, "issuer": mustPubHex(t, adminKeyHex),
	})
	_, err := h.run(t, []uint32{0})
	if err == nil {
		t.Fatal("register carrying an assetId was admitted: a third party can claim an existing asset's chain")
	}
	if err.Error() != AdminNotAnchoredReason {
		t.Fatalf("reason = %q, want AdminNotAnchoredReason", err.Error())
	}
}

func TestRegisterWithEmptyAssetIdIsStillGenesis(t *testing.T) {
	h := newHarness(t)
	h.addAdminOutput(t, ActionDetails{"kind": "register", "assetId": ""})
	if _, err := h.run(t, []uint32{0}); err != nil {
		t.Fatalf("genesis register with empty assetId rejected: %v", err)
	}
}

func TestRegisterWithNonStringAssetIdIsRejected(t *testing.T) {
	h := newHarness(t)
	h.addAdminOutput(t, ActionDetails{"kind": "register", "assetId": 7.0})
	if _, err := h.run(t, []uint32{0}); err == nil {
		t.Fatal("register with a non-string assetId was admitted")
	}
}
