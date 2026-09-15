package mandala

import (
	"strings"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

// A04 — one membership gate, issuer-exempt, TS ≡ Go.
//
// Once the registration chain has a row, every identity a transfer names must
// be admitted — except asset issuers and the overlay itself. The exemption is
// what keeps the issuer able to act (issue, unpause, …) after its own row is
// revoked or the registry index is lost; TS enforces the same rule through
// overlay/src/registry.ts registryScreening.

const issuerKeyHex = "0000000000000000000000000000000000000000000000000000000000000006"
const otherIssuerKeyHex = "0000000000000000000000000000000000000000000000000000000000000007"

func pubHex(t *testing.T, privHex string) (*ec.PublicKey, string) {
	t.Helper()
	priv, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		t.Fatal(err)
	}
	return priv.PubKey(), priv.PubKey().ToDERHex()
}

// issueTo rebuilds the harness transaction as an issuer admin action: one
// recorded admin prior as the only input, an "issue 100" admin output, and a
// single 100-unit FT output whose verified linkage names `recipient`.
func issueTo(t *testing.T, h *harness, recipient *ec.PublicKey) {
	t.Helper()
	h.tx = transaction.NewTransaction()
	h.payload = &LinkagePayload{}
	prior := h.addRecordedAdminPrior(0x77, 0)
	h.tx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: mustLockToken(t, h.assetID, 100, h.tokenPKH(t, "iss-0", recipient)),
	})
	h.payload.Outputs = []IndexedLinkage{{Index: 0, Linkage: h.reveal(t, "iss-0", recipient)}}
	h.addAdminOutput(t, ActionDetails{
		"kind": "issue", "assetId": h.assetID, "amount": float64(100), "priorOutpoint": prior,
	})
	h.refresh(t)
}

func liveRegistryHarness(t *testing.T) (*harness, *ec.PublicKey) {
	t.Helper()
	h := newHarness(t)
	issuerPub, issuerID := pubHex(t, issuerKeyHex)
	st := DefaultAssetState(h.assetID)
	st.IssuerIdentityKey = issuerID
	h.state.states[h.assetID] = st
	// Live registry that lists neither the issuer nor the harness recipient.
	h.tm.WithRegistry(admittedRegistry{"02" + "ee": true})
	return h, issuerPub
}

func TestMembershipIssuerActsWithoutARegistryRow(t *testing.T) {
	h, issuerPub := liveRegistryHarness(t)
	issueTo(t, h, issuerPub)
	res, err := h.run(t, []uint32{0})
	if err != nil {
		t.Fatalf("issuer's own issue was refused while the issuer holds no registry row: %v", err)
	}
	wantAdmitted(t, res, 0, 1)
}

func TestMembershipRefusesANonAdmittedPeer(t *testing.T) {
	h, _ := liveRegistryHarness(t)
	issueTo(t, h, h.recipientPub)
	_, err := h.run(t, []uint32{0})
	wantReject(t, err, "identity not admitted: "+h.recipientID)
}

func TestMembershipExemptsEveryIssuerTheStateStoreKnows(t *testing.T) {
	// Parity with TS, whose screening seam only sees identity keys: every
	// issuerIdentityKey in the asset-state store is exempt, not only the
	// issuers of assets moving in this transaction.
	h, _ := liveRegistryHarness(t)
	otherPub, otherID := pubHex(t, otherIssuerKeyHex)
	h.state.issuers = []string{otherID}
	issueTo(t, h, otherPub)
	if _, err := h.run(t, []uint32{0}); err != nil {
		t.Fatalf("issuer of another asset was refused: %v", err)
	}
}

func TestMembershipExemptsTheOverlayIdentity(t *testing.T) {
	h, _ := liveRegistryHarness(t)
	h.tm.WithMembershipExemptions(h.recipientID)
	issueTo(t, h, h.recipientPub)
	if _, err := h.run(t, []uint32{0}); err != nil {
		t.Fatalf("exempt identity was refused: %v", err)
	}
}

func TestMembershipInactiveRegistryIsOpen(t *testing.T) {
	h := newHarness(t)
	h.tm.WithRegistry(admittedRegistry{})
	if _, err := h.run(t, []uint32{0}); err != nil {
		t.Fatalf("empty registry must not gate: %v", err)
	}
}

// A16 — a freeze whose target has no token row folds to {amount: 0, owner: ''}
// and can never be reissued. Refuse it at admission, with the same string the
// TS wrapper (overlay/src/adminChainGuard.ts) uses.

func freezeHarness(t *testing.T, target string) *harness {
	t.Helper()
	h := newHarness(t)
	prior := h.addRecordedAdminPrior(0x66, 0)
	h.addAdminOutput(t, ActionDetails{
		"kind": "freezeOutput", "assetId": h.assetID, "outpoint": target, "priorOutpoint": prior,
	})
	return h
}

func TestFreezeOfAnOutpointWithNoTokenRowIsRefused(t *testing.T) {
	target := fmtOutpoint(strings.Repeat("ef", 32), 1)
	h := freezeHarness(t, target)
	// Coin 0 is the token input, coin 1 the recorded admin prior.
	_, err := h.run(t, []uint32{0, 1})
	wantReject(t, err, "tm_mandala: freezeOutput targets an outpoint with no token row: "+target)
}

func TestFreezeOfALiveCoinIsAdmitted(t *testing.T) {
	// Freeze a coin other than the one this tx spends (a frozen input is gate
	// 1's business): a second live row the freeze points at.
	live := fmtOutpoint(strings.Repeat("cd", 32), 0)
	h := freezeHarness(t, live)
	h.state.tokens[live] = &TokenRow{AssetID: h.assetID, Amount: 5, IdentityKey: h.holderID}
	res, err := h.run(t, []uint32{0, 1})
	if err != nil {
		t.Fatalf("freeze of a live coin was refused: %v", err)
	}
	wantAdmitted(t, res, 0, 1, 2)
}

func TestFreezeWithAMalformedOutpointFailsClosed(t *testing.T) {
	h := freezeHarness(t, "not-an-outpoint")
	_, err := h.run(t, []uint32{0, 1})
	wantReject(t, err, "no token row: not-an-outpoint")
}
