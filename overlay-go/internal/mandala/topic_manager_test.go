package mandala

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type fakeState struct {
	states map[string]AssetAdminState
	tokens map[string]*TokenRow
	// adminOutpoints keys are "<assetId>|<txid>.<vout>" for admin outputs this
	// topic previously admitted for that asset.
	adminOutpoints map[string]bool
	// issuers is what IssuerIdentityKeys reports (the store-wide issuer set
	// the membership gate exempts); the per-asset states above are separate.
	issuers []string
}

func (f *fakeState) IsAdminOutpoint(_ context.Context, assetID, txid string, vout uint32) (bool, error) {
	return f.adminOutpoints[assetID+"|"+fmtOutpoint(txid, vout)], nil
}

func (f *fakeState) IssuerIdentityKeys(context.Context) ([]string, error) {
	return f.issuers, nil
}

func (f *fakeState) GetAssetState(_ context.Context, id string) (AssetAdminState, error) {
	if s, ok := f.states[id]; ok {
		return s, nil
	}
	return DefaultAssetState(id), nil
}

func (f *fakeState) GetTokenRow(_ context.Context, txid string, vout uint32) (*TokenRow, error) {
	return f.tokens[fmtOutpoint(txid, vout)], nil
}

type sanctioned map[string]bool

func (s sanctioned) IsSanctioned(_ context.Context, k string) (bool, error) { return s[k], nil }

// ---------------------------------------------------------------------------
// Harness: one FT input (100 units of asset A, previously admitted) spent to
// recipient 60 + change 40, with real BRC-72 linkages produced by a go-sdk
// ProtoWallet prover (the holder's wallet).
// ---------------------------------------------------------------------------

const (
	verifierKeyHex  = "0000000000000000000000000000000000000000000000000000000000000001"
	holderKeyHex    = "0000000000000000000000000000000000000000000000000000000000000002"
	recipientKeyHex = "0000000000000000000000000000000000000000000000000000000000000003"
	adminKeyHex     = "0000000000000000000000000000000000000000000000000000000000000004"
)

var ftProtocol = wallet.Protocol{SecurityLevel: 2, Protocol: "mandala token"}

type harness struct {
	ctx      context.Context
	verifier *Verifier
	adminW   *AdminWallet
	state    *fakeState
	screen   sanctioned
	tm       *TopicManager

	holderPW     *wallet.ProtoWallet
	holderKD     *wallet.KeyDeriver
	holderPub    *ec.PublicKey
	recipientPub *ec.PublicKey
	verifierPub  *ec.PublicKey
	holderID     string
	recipientID  string

	assetID     string
	srcTx       *transaction.Transaction
	srcOutpoint string

	tx      *transaction.Transaction
	payload *LinkagePayload

	beef *transaction.Beef
	txid *chainhash.Hash
}

func dummyInput(fill byte, vout uint32) *transaction.TransactionInput {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = fill
	}
	h, err := chainhash.NewHash(raw)
	if err != nil {
		panic(err)
	}
	return &transaction.TransactionInput{
		SourceTXID:       h,
		SourceTxOutIndex: vout,
		UnlockingScript:  &script.Script{},
	}
}

// tokenPKH derives the BRC-42 child pubkey hash the holder wallet locks a
// token output to, for the given counterparty (forSelf=false: it is the
// counterparty's child key, per Appendix A §1.3 lockBRC29).
func (h *harness) tokenPKH(t *testing.T, keyID string, cp *ec.PublicKey) []byte {
	t.Helper()
	pub, err := h.holderKD.DerivePublicKey(ftProtocol, keyID,
		wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: cp}, false)
	if err != nil {
		t.Fatal(err)
	}
	return hash.Hash160(pub.Compressed())
}

// reveal produces a real BRC-72 specific key linkage: prover = holder wallet,
// verifier = the topic manager's Verifier identity, counterparty per output.
func (h *harness) reveal(t *testing.T, keyID string, cp *ec.PublicKey) *SpecificLinkage {
	t.Helper()
	res, err := h.holderPW.RevealSpecificKeyLinkage(h.ctx, wallet.RevealSpecificKeyLinkageArgs{
		Counterparty: wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: cp},
		Verifier:     h.verifierPub,
		ProtocolID:   ftProtocol,
		KeyID:        keyID,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	return &SpecificLinkage{
		Prover:                h.holderID,
		Verifier:              h.verifierPub.ToDERHex(),
		Counterparty:          cp.ToDERHex(),
		ProtocolID:            ProtocolID{SecurityLevel: 2, Name: "mandala token"},
		KeyID:                 keyID,
		EncryptedLinkage:      res.EncryptedLinkage,
		EncryptedLinkageProof: res.EncryptedLinkageProof,
		ProofType:             int(res.ProofType),
	}
}

func mustLockToken(t *testing.T, assetID string, amount int64, pkh []byte) *script.Script {
	t.Helper()
	s, err := LockToken(assetID, amount, pkh)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func p2pkhScript(t *testing.T, pkh [20]byte) *script.Script {
	t.Helper()
	s := &script.Script{}
	if err := s.AppendOpcodes(script.OpDUP, script.OpHASH160); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendPushData(pkh[:]); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOpcodes(script.OpEQUALVERIFY, script.OpCHECKSIG); err != nil {
		t.Fatal(err)
	}
	return s
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{ctx: context.Background()}

	var err error
	if h.verifier, err = NewVerifier(verifierKeyHex); err != nil {
		t.Fatal(err)
	}
	if h.adminW, err = NewAdminWallet(adminKeyHex); err != nil {
		t.Fatal(err)
	}
	verifierPriv, err := ec.PrivateKeyFromHex(verifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	holderPriv, err := ec.PrivateKeyFromHex(holderKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	recipientPriv, err := ec.PrivateKeyFromHex(recipientKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	h.verifierPub = verifierPriv.PubKey()
	h.holderPub = holderPriv.PubKey()
	h.recipientPub = recipientPriv.PubKey()
	h.holderID = h.holderPub.ToDERHex()
	h.recipientID = h.recipientPub.ToDERHex()
	if h.holderPW, err = wallet.NewProtoWallet(wallet.ProtoWalletArgs{
		Type: wallet.ProtoWalletArgsTypePrivateKey, PrivateKey: holderPriv,
	}); err != nil {
		t.Fatal(err)
	}
	h.holderKD = wallet.NewKeyDeriver(holderPriv)

	h.assetID = strings.Repeat("ab", 32) + ".0"

	// Source tx: one token output, 100 units of asset A, locked to the
	// holder's own BRC-42 child key (counterparty = holder identity).
	h.srcTx = transaction.NewTransaction()
	h.srcTx.AddInput(dummyInput(0x01, 0))
	h.srcTx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: mustLockToken(t, h.assetID, 100, h.tokenPKH(t, "src-0", h.holderPub)),
	})
	h.srcOutpoint = fmtOutpoint(h.srcTx.TxID().String(), 0)

	// Spending tx: 60 to the recipient, 40 change back to the holder.
	h.tx = transaction.NewTransaction()
	h.tx.AddInput(&transaction.TransactionInput{
		SourceTXID:        h.srcTx.TxID(),
		SourceTxOutIndex:  0,
		SourceTransaction: h.srcTx,
		UnlockingScript:   &script.Script{},
	})
	h.tx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: mustLockToken(t, h.assetID, 60, h.tokenPKH(t, "out-0", h.recipientPub)),
	})
	h.tx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: mustLockToken(t, h.assetID, 40, h.tokenPKH(t, "out-1", h.holderPub)),
	})

	h.payload = &LinkagePayload{
		Inputs: []IndexedLinkage{
			{Index: 0, Linkage: h.reveal(t, "src-0", h.holderPub)},
		},
		Outputs: []IndexedLinkage{
			{Index: 0, Linkage: h.reveal(t, "out-0", h.recipientPub)},
			{Index: 1, Linkage: h.reveal(t, "out-1", h.holderPub)},
		},
	}

	h.state = &fakeState{states: map[string]AssetAdminState{}, tokens: map[string]*TokenRow{}, adminOutpoints: map[string]bool{}}
	h.screen = sanctioned{}
	h.tm = NewTopicManager(h.verifier, h.adminW, h.screen, h.state)
	h.refresh(t)
	return h
}

// refresh rebuilds the beef/txid after tests mutate h.tx.
func (h *harness) refresh(t *testing.T) {
	t.Helper()
	beef := transaction.NewBeefV2()
	if _, err := beef.MergeTransaction(h.srcTx); err != nil {
		t.Fatal(err)
	}
	if _, err := beef.MergeTransaction(h.tx); err != nil {
		t.Fatal(err)
	}
	h.beef = beef
	h.txid = h.tx.TxID()
}

func (h *harness) run(t *testing.T, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	t.Helper()
	h.refresh(t)
	return h.tm.IdentifyAdmissibleOutputs(WithPayload(h.ctx, h.payload), h.beef, h.txid, previousCoins)
}

// addPriorAuthInput appends an extra (dummy) input the admin action's
// priorOutpoint can point at. The outpoint is NOT recorded as an admin output,
// so on its own it does not anchor the admin chain — use
// addRecordedAdminPrior for a legitimate action.
func (h *harness) addPriorAuthInput(fill byte, vout uint32) string {
	in := dummyInput(fill, vout)
	h.tx.AddInput(in)
	return fmtOutpoint(in.SourceTXID.String(), vout)
}

// addRecordedAdminPrior appends the input a legitimate admin action spends and
// records it as an admin-auth output this topic already admitted for the
// harness asset — the anchor real admin actions chain to.
func (h *harness) addRecordedAdminPrior(fill byte, vout uint32) string {
	prior := h.addPriorAuthInput(fill, vout)
	h.state.adminOutpoints[h.assetID+"|"+prior] = true
	return prior
}

// addAdminOutput appends a verified-shape admin output (P2PKH whose pkh is
// re-derived by the AdminWallet from a real Commitment(details) keyID) plus
// the matching payload.Admin entry.
func (h *harness) addAdminOutput(t *testing.T, details ActionDetails) {
	t.Helper()
	pkh, err := h.adminW.ExpectedPKH(details)
	if err != nil {
		t.Fatal(err)
	}
	h.tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: p2pkhScript(t, pkh)})
	h.payload.Admin = append(h.payload.Admin, IndexedAdmin{
		Index:         uint32(len(h.tx.Outputs) - 1),
		ActionDetails: details,
	})
}

func wantReject(t *testing.T, err error, substr string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected rejection containing %q, got nil error", substr)
	}
	if !strings.Contains(err.Error(), substr) {
		t.Fatalf("expected error containing %q, got: %v", substr, err)
	}
}

func wantAdmitted(t *testing.T, res overlay.AdmittanceInstructions, want ...uint32) {
	t.Helper()
	if len(res.OutputsToAdmit) != len(want) {
		t.Fatalf("admitted %v, want %v", res.OutputsToAdmit, want)
	}
	for i, w := range want {
		if res.OutputsToAdmit[i] != w {
			t.Fatalf("admitted %v, want %v", res.OutputsToAdmit, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestAdmitsBalancedTransferWithLinkage(t *testing.T) {
	h := newHarness(t)
	res, err := h.tm.IdentifyAdmissibleOutputs(WithPayload(context.Background(), h.payload), h.beef, h.txid, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	wantAdmitted(t, res, 0, 1)
	if len(res.CoinsToRetain) != 1 || res.CoinsToRetain[0] != 0 {
		t.Fatalf("coinsToRetain: %v", res.CoinsToRetain)
	}
}

// FIX A (§3.1, wire contract §6): a MandalaToken-decodable output with no
// linkage entry at its index REJECTS the whole submission. It used to be a
// silent skip, which let conservation hold over the admitted subset while an
// un-admitted token output of arbitrary size rode along in the same signed
// txid (the EB-1/SM-1 phantom coin).
func TestMissingOutputLinkageRejectsWholeTx(t *testing.T) {
	h := newHarness(t)
	h.payload.Outputs = h.payload.Outputs[:1] // drop the change linkage
	res, err := h.tm.IdentifyAdmissibleOutputs(WithPayload(context.Background(), h.payload), h.beef, h.txid, []uint32{0})
	wantReject(t, err, "output 1: MandalaToken-decodable output with no verified linkage")
	if len(res.OutputsToAdmit) != 0 {
		t.Fatalf("expected no admits on whole-tx rejection, got %v", res.OutputsToAdmit)
	}
	if strings.Contains(err.Error(), "conservation violated") {
		t.Fatalf("must fail on linkage, not conservation: %v", err)
	}
}

func TestWrongPKHLinkageRejectsWholeTx(t *testing.T) {
	h := newHarness(t)
	// Swap the two output linkages: both fail the pkh match. A clean pkh
	// MISMATCH is now a rejection, not a skip (FIX A).
	h.payload.Outputs[0].Index, h.payload.Outputs[1].Index = 1, 0
	res, err := h.run(t, []uint32{0})
	wantReject(t, err, "output 0: MandalaToken-decodable output with no verified linkage")
	if len(res.OutputsToAdmit) != 0 {
		t.Fatalf("expected no admits on whole-tx rejection, got %v", res.OutputsToAdmit)
	}
}

// TestUnlinkedPhantomTokenOutputRejectsWholeTx is the EB-1/SM-1 regression:
// the admitted subset balances perfectly on its own (100 in, 100 out at index
// 0), so pre-FIX-A conservation was satisfied and the overlay signed the txid
// while an un-admitted 1,000,000-unit MandalaToken output sat at index 1.
// An offline verifier crediting on σ_I coverage of the txid would have
// credited the phantom. The whole transaction must now be refused.
func TestUnlinkedPhantomTokenOutputRejectsWholeTx(t *testing.T) {
	h := newHarness(t)
	h.tx.Outputs[0].LockingScript = mustLockToken(t, h.assetID, 100, h.tokenPKH(t, "out-0", h.recipientPub))
	h.tx.Outputs[1].LockingScript = mustLockToken(t, h.assetID, 1_000_000, h.tokenPKH(t, "phantom", h.holderPub))
	h.payload.Outputs = h.payload.Outputs[:1] // only output 0 is linked

	res, err := h.run(t, []uint32{0})
	wantReject(t, err, "output 1: MandalaToken-decodable output with no verified linkage")
	if len(res.OutputsToAdmit) != 0 {
		t.Fatalf("expected no admits on whole-tx rejection, got %v", res.OutputsToAdmit)
	}
	if strings.Contains(err.Error(), "conservation violated") {
		t.Fatalf("conservation held over the admitted subset — the rejection must come from the linkage gate: %v", err)
	}
}

// TestRejectionsAreTypedVerdicts pins FIX D's structural precondition: every
// rejection the manager mints is a *RejectError, so the HTTP layer can tell a
// manager verdict (400/409) from an infrastructure fault (503) without
// inspecting strings it did not produce.
func TestRejectionsAreTypedVerdicts(t *testing.T) {
	h := newHarness(t)
	h.payload.Outputs = h.payload.Outputs[:1]
	_, err := h.run(t, []uint32{0})
	var rej *RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("rejection is not a *RejectError: %#v", err)
	}
	if rej.Topic != "tm_mandala" {
		t.Fatalf("RejectError.Topic = %q, want tm_mandala", rej.Topic)
	}
}

// fakeSpendChecker maps "<txid>.<vout>" to the txid that already spent it
// ("" = live), the FIX L seam wiring backs with the engine store's spent
// flag plus the admission record's evictedAt.
type fakeSpendChecker map[string]string

func (f fakeSpendChecker) SpentBy(_ context.Context, txid string, vout uint32) (string, error) {
	return f[fmtOutpoint(txid, vout)], nil
}

// FIX L (wire contract §7): the overlay refuses a conflicting second spend
// itself rather than leaving it to Arcade's broadcast race.
func TestConflictingSpendIsRefusedWithTheCompetingTxid(t *testing.T) {
	h := newHarness(t)
	competitor := strings.Repeat("cd", 32)
	h.tm.WithSpendChecker(fakeSpendChecker{h.srcOutpoint: competitor})

	res, err := h.run(t, []uint32{0})
	wantReject(t, err, "already spent by "+competitor)
	if len(res.OutputsToAdmit) != 0 {
		t.Fatalf("expected no admits, got %v", res.OutputsToAdmit)
	}
	var rej *RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("not a *RejectError: %#v", err)
	}
	if rej.SpendTxid != competitor {
		t.Fatalf("RejectError.SpendTxid = %q, want %q", rej.SpendTxid, competitor)
	}
}

func TestSpendGuardAdmitsALiveCoin(t *testing.T) {
	h := newHarness(t)
	h.tm.WithSpendChecker(fakeSpendChecker{})
	res, err := h.run(t, []uint32{0})
	if err != nil {
		t.Fatalf("a live coin was refused: %v", err)
	}
	wantAdmitted(t, res, 0, 1)
}

// A resubmit of the very transaction that marked the input spent is not a
// conflicting spend — the dupe path, not a refusal.
func TestSpendGuardIgnoresASpendByThisSameTx(t *testing.T) {
	h := newHarness(t)
	h.refresh(t)
	h.tm.WithSpendChecker(fakeSpendChecker{h.srcOutpoint: h.txid.String()})
	res, err := h.run(t, []uint32{0})
	if err != nil {
		t.Fatalf("a resubmit of the spending tx itself was refused: %v", err)
	}
	wantAdmitted(t, res, 0, 1)
}

// failingState turns every asset-state read into a dependency fault.
type failingState struct {
	*fakeState
	err error
}

func (f failingState) GetAssetState(context.Context, string) (AssetAdminState, error) {
	return AssetAdminState{}, f.err
}

// failingScreen is a ScreeningProvider that is simply unreachable.
type failingScreen struct{ err error }

func (f failingScreen) IsSanctioned(context.Context, string) (bool, error) { return false, f.err }

// FIX D's allowlist discipline, at the source: a dependency fault must NOT
// leave the manager typed as a verdict, or the HTTP layer would mint a
// permanent 4xx ("this transaction is invalid forever") out of a Mongo blip.
func TestStoreFaultIsNotAVerdict(t *testing.T) {
	h := newHarness(t)
	h.tm = NewTopicManager(h.verifier, h.adminW, h.screen, failingState{fakeState: h.state, err: errors.New("mongo down")})
	_, err := h.run(t, []uint32{0})
	if err == nil {
		t.Fatal("expected the store fault to surface")
	}
	var rej *RejectError
	if errors.As(err, &rej) {
		t.Fatalf("a store fault was minted as a manager verdict: %v", err)
	}
}

func TestScreeningProviderFaultIsNotAVerdict(t *testing.T) {
	h := newHarness(t)
	h.tm = NewTopicManager(h.verifier, h.adminW, failingScreen{err: errors.New("provider unreachable")}, h.state)
	_, err := h.run(t, []uint32{0})
	if err == nil {
		t.Fatal("expected the provider fault to surface")
	}
	var rej *RejectError
	if errors.As(err, &rej) {
		t.Fatalf("a sanctions-provider fault was minted as a manager verdict: %v", err)
	}
}

func TestSpendCheckerFaultIsNotAVerdict(t *testing.T) {
	h := newHarness(t)
	h.tm.WithSpendChecker(failingSpendChecker{err: errors.New("mongo down")})
	_, err := h.run(t, []uint32{0})
	if err == nil {
		t.Fatal("expected the spend-checker fault to surface")
	}
	var rej *RejectError
	if errors.As(err, &rej) {
		t.Fatalf("a spend-state store fault was minted as a manager verdict: %v", err)
	}
}

type failingSpendChecker struct{ err error }

func (f failingSpendChecker) SpentBy(context.Context, string, uint32) (string, error) {
	return "", f.err
}

func TestTamperedOutputLinkagePropagatesError(t *testing.T) {
	h := newHarness(t)
	// Tamper the CHANGE output's linkage ciphertext past the 32-byte IV: a
	// decrypt/GCM-auth ERROR here must reject the WHOLE tx (§3.3 + §2.5 "errors
	// propagate as failure"; TS parity: verifyFtOutputs calls verifyKeyLinkage
	// directly, uncaught — only linkageControlsPubKeyHash swallows errors, and
	// the admission loop does not use that helper). The other output (index 0,
	// valid linkage) must NOT be admitted on its own.
	bad := make(NumBytes, len(h.payload.Outputs[1].Linkage.EncryptedLinkage))
	copy(bad, h.payload.Outputs[1].Linkage.EncryptedLinkage)
	bad[40] ^= 0xff
	h.payload.Outputs[1].Linkage.EncryptedLinkage = bad
	res, err := h.run(t, []uint32{0})
	if err == nil {
		t.Fatalf("expected tampered output-linkage verification error, got admits %v", res.OutputsToAdmit)
	}
	if len(res.OutputsToAdmit) != 0 {
		t.Fatalf("expected no admits on whole-tx rejection, got %v", res.OutputsToAdmit)
	}
	// Must fail because the decrypt/verification error propagated, NOT because
	// the tampered output was silently skipped and conservation happened to
	// notice the resulting imbalance (that would mask the real bug: a second,
	// still-valid output could slip through in a less symmetric transfer).
	if strings.Contains(err.Error(), "conservation violated") {
		t.Fatalf("should fail in output linkage verification, not conservation: %v", err)
	}
	if !strings.Contains(err.Error(), "linkage verification") {
		t.Fatalf("expected a linkage verification error, got: %v", err)
	}
}

func TestBadInputLinkageThrowsDuringScreening(t *testing.T) {
	h := newHarness(t)
	// Tamper the INPUT linkage ciphertext: §3.5 sanctions screening must
	// propagate the verification error (asymmetric with §3.6, which skips).
	bad := make(NumBytes, len(h.payload.Inputs[0].Linkage.EncryptedLinkage))
	copy(bad, h.payload.Inputs[0].Linkage.EncryptedLinkage)
	bad[40] ^= 0xff
	h.payload.Inputs[0].Linkage.EncryptedLinkage = bad
	_, err := h.run(t, []uint32{0})
	if err == nil {
		t.Fatal("expected input-linkage verification error to propagate")
	}
	if strings.Contains(err.Error(), "conservation violated") {
		t.Fatalf("should fail in screening, not conservation: %v", err)
	}
}

func TestPauseBlocksPeerTransferButNotAdmin(t *testing.T) {
	pausedState := func(h *harness) AssetAdminState {
		st := DefaultAssetState(h.assetID)
		st.IsPaused = true
		return st
	}

	t.Run("peer transfer rejected", func(t *testing.T) {
		h := newHarness(t)
		h.state.states[h.assetID] = pausedState(h)
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, "control gate rejected")
	})

	t.Run("verified admin action exempt", func(t *testing.T) {
		h := newHarness(t)
		h.state.states[h.assetID] = pausedState(h)
		prior := h.addRecordedAdminPrior(0x77, 1)
		h.addAdminOutput(t, ActionDetails{
			"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
		})
		res, err := h.run(t, []uint32{0, 1})
		if err != nil {
			t.Fatal(err)
		}
		wantAdmitted(t, res, 0, 1, 2) // both FT outputs + the admin output
	})

	t.Run("unverified admin payload entry does NOT exempt", func(t *testing.T) {
		h := newHarness(t)
		h.state.states[h.assetID] = pausedState(h)
		prior := h.addRecordedAdminPrior(0x77, 1)
		details := ActionDetails{"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior}
		h.addAdminOutput(t, details)
		// Corrupt the on-chain pkh so pkh re-derivation fails: the raw payload
		// admin entry alone must not grant the exemption. The entry itself IS
		// anchored (previousCoins includes the recorded prior at input 1), so
		// guard 3 passes and the pkh mismatch is the only thing under test.
		h.tx.Outputs[2].LockingScript = p2pkhScript(t, [20]byte{0xde, 0xad})
		_, err := h.run(t, []uint32{0, 1})
		wantReject(t, err, "control gate rejected")
	})
}

func TestMalformedAdminCounterpartyHexPropagatesError(t *testing.T) {
	h := newHarness(t)
	// details.counterparty = "zz" is not valid hex: AdminWallet.ExpectedPKH's
	// ec.PublicKeyFromString fails deriving the expected lock key (§3.2c key
	// derivation, not script-shape classification). That error must reject
	// the WHOLE tx (TS parity: adminWallet.getPublicKey is awaited uncaught in
	// verifyAdminOutput), not just silently skip the admin output while still
	// admitting the two otherwise-valid FT outputs.
	prior := h.addRecordedAdminPrior(0x77, 1)
	details := ActionDetails{
		"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
		"counterparty": "zz",
	}
	// Can't use h.addAdminOutput here: it calls ExpectedPKH to build a
	// correctly-locked output, which would itself fail for this malformed
	// counterparty. Build a plain P2PKH shape with an arbitrary pkh instead —
	// the malformed hex must be rejected before any pkh comparison happens.
	h.tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: p2pkhScript(t, [20]byte{0xde, 0xad, 0xbe, 0xef})})
	h.payload.Admin = append(h.payload.Admin, IndexedAdmin{
		Index:         uint32(len(h.tx.Outputs) - 1),
		ActionDetails: details,
	})
	res, err := h.run(t, []uint32{0, 1})
	if err == nil {
		t.Fatalf("expected malformed admin counterparty hex to reject the whole tx, got admits %v", res.OutputsToAdmit)
	}
	if len(res.OutputsToAdmit) != 0 {
		t.Fatalf("expected no admits (not even the two valid FT outputs) on whole-tx rejection, got %v", res.OutputsToAdmit)
	}
}

func TestDenylistRejectsBlockedParty(t *testing.T) {
	h := newHarness(t)
	st := DefaultAssetState(h.assetID) // accessMode "denylist" by default
	st.BlockedIdentities = []string{h.recipientID}
	h.state.states[h.assetID] = st
	_, err := h.run(t, []uint32{0})
	wantReject(t, err, "control gate rejected")
}

func TestAllowlistRejectsUnlisted(t *testing.T) {
	h := newHarness(t)
	st := DefaultAssetState(h.assetID)
	st.AccessMode = "allowlist" // empty allowedIdentities: everyone unlisted
	h.state.states[h.assetID] = st
	_, err := h.run(t, []uint32{0})
	wantReject(t, err, "control gate rejected")

	// Positive control: listing every party (recipient + holder, who appears
	// both as change recipient and as resolved sender) admits the transfer.
	st.AllowedIdentities = []string{h.recipientID, h.holderID}
	h.state.states[h.assetID] = st
	res, err := h.run(t, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	wantAdmitted(t, res, 0, 1)
}

func TestAllowlistExemptsIssuerKey(t *testing.T) {
	h := newHarness(t)
	st := DefaultAssetState(h.assetID)
	st.AccessMode = "allowlist"
	st.IssuerIdentityKey = h.holderID // holder is the issuer: excluded from parties
	st.AllowedIdentities = []string{h.recipientID}
	h.state.states[h.assetID] = st
	res, err := h.run(t, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	wantAdmitted(t, res, 0, 1)
}

func TestFrozenInputRejectsAllTxs(t *testing.T) {
	frozenState := func(h *harness) AssetAdminState {
		st := DefaultAssetState(h.assetID)
		st.FrozenOutpoints = []FrozenRef{{Outpoint: h.srcOutpoint, Amount: 100, Owner: h.holderID}}
		return st
	}

	t.Run("peer transfer rejected", func(t *testing.T) {
		h := newHarness(t)
		h.state.states[h.assetID] = frozenState(h)
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, "control gate rejected")
	})

	t.Run("verified admin tx rejected too (gate 1 has no admin exemption)", func(t *testing.T) {
		h := newHarness(t)
		h.state.states[h.assetID] = frozenState(h)
		prior := h.addRecordedAdminPrior(0x77, 1)
		h.addAdminOutput(t, ActionDetails{
			"kind": "unfreezeOutput", "assetId": h.assetID,
			"outpoint": h.srcOutpoint, "priorOutpoint": prior,
		})
		_, err := h.run(t, []uint32{0, 1})
		wantReject(t, err, "control gate rejected")
	})

	t.Run("evicted input rejected", func(t *testing.T) {
		h := newHarness(t)
		st := DefaultAssetState(h.assetID)
		st.EvictedOutpoints = []string{h.srcOutpoint}
		h.state.states[h.assetID] = st
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, "control gate rejected")
	})
}

func TestSanctionedSenderRejects(t *testing.T) {
	h := newHarness(t)
	h.screen[h.holderID] = true // the sender identity, resolved from payload.Inputs
	_, err := h.run(t, []uint32{0})
	wantReject(t, err, "sanctioned party involved in transfer")

	// A sanctioned recipient (admitted output identity) is caught too.
	h2 := newHarness(t)
	h2.screen[h2.recipientID] = true
	_, err = h2.run(t, []uint32{0})
	wantReject(t, err, "sanctioned party involved in transfer")
}

func TestReissueGuards(t *testing.T) {
	h := newHarness(t)

	// A second, unfrozen source of asset A for the FT-input-present guard (c).
	srcTx2 := transaction.NewTransaction()
	srcTx2.AddInput(dummyInput(0x55, 0))
	srcTx2.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: mustLockToken(t, h.assetID, 25, h.tokenPKH(t, "other-src", h.holderPub)),
	})

	frozenState := func(amount int64) AssetAdminState {
		st := DefaultAssetState(h.assetID)
		st.FrozenOutpoints = []FrozenRef{{Outpoint: h.srcOutpoint, Amount: amount, Owner: h.holderID}}
		return st
	}

	// buildReissue constructs a standalone reissue tx: one prior-auth input
	// (NOT a token — reissue must carry zero FT inputs of the asset), one
	// reissued 100-unit token output, one verified admin output.
	runReissue := func(t *testing.T, withFtInput bool) (overlay.AdmittanceInstructions, error) {
		t.Helper()
		rtx := transaction.NewTransaction()
		prior := dummyInput(0x99, 0)
		rtx.AddInput(prior)
		priorOp := fmtOutpoint(prior.SourceTXID.String(), 0)
		h.state.adminOutpoints[h.assetID+"|"+priorOp] = true
		if withFtInput {
			rtx.AddInput(&transaction.TransactionInput{
				SourceTXID:        srcTx2.TxID(),
				SourceTxOutIndex:  0,
				SourceTransaction: srcTx2,
				UnlockingScript:   &script.Script{},
			})
		}
		rtx.AddOutput(&transaction.TransactionOutput{
			Satoshis:      1,
			LockingScript: mustLockToken(t, h.assetID, 100, h.tokenPKH(t, "reissue-0", h.recipientPub)),
		})
		details := ActionDetails{
			"kind": "reissue", "assetId": h.assetID, "outpoint": h.srcOutpoint,
			"amount": float64(100), "priorOutpoint": priorOp,
		}
		pkh, err := h.adminW.ExpectedPKH(details)
		if err != nil {
			t.Fatal(err)
		}
		rtx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: p2pkhScript(t, pkh)})
		payload := &LinkagePayload{
			Outputs: []IndexedLinkage{{Index: 0, Linkage: h.reveal(t, "reissue-0", h.recipientPub)}},
			Admin:   []IndexedAdmin{{Index: 1, ActionDetails: details}},
		}
		beef := transaction.NewBeefV2()
		if withFtInput {
			if _, err := beef.MergeTransaction(srcTx2); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := beef.MergeTransaction(rtx); err != nil {
			t.Fatal(err)
		}
		// Input 0 is the admin-auth coin the engine previously admitted.
		return h.tm.IdentifyAdmissibleOutputs(WithPayload(h.ctx, payload), beef, rtx.TxID(), []uint32{0})
	}

	t.Run("valid reissue passes", func(t *testing.T) {
		h.state.states[h.assetID] = frozenState(100)
		res, err := runReissue(t, false)
		if err != nil {
			t.Fatal(err)
		}
		wantAdmitted(t, res, 0, 1) // reissued token + admin output
	})

	t.Run("a: target outpoint not frozen", func(t *testing.T) {
		h.state.states[h.assetID] = DefaultAssetState(h.assetID)
		_, err := runReissue(t, false)
		wantReject(t, err, "control gate rejected")
	})

	t.Run("b: frozen amount mismatch", func(t *testing.T) {
		h.state.states[h.assetID] = frozenState(40) // admin action mints 100
		_, err := runReissue(t, false)
		wantReject(t, err, "control gate rejected")
	})

	t.Run("c: FT input of the asset present", func(t *testing.T) {
		h.state.states[h.assetID] = frozenState(100)
		_, err := runReissue(t, true)
		wantReject(t, err, "control gate rejected")
	})
}

func TestIdentifyNeededInputsAndMetadata(t *testing.T) {
	h := newHarness(t)
	outs, err := h.tm.IdentifyNeededInputs(h.ctx, h.beef, h.txid)
	if err != nil || outs != nil {
		t.Fatalf("IdentifyNeededInputs = %v, %v; want nil, nil", outs, err)
	}
	md := h.tm.GetMetaData()
	if md == nil || md.Name != "tm_mandala" {
		t.Fatalf("metadata: %+v", md)
	}
	if h.tm.GetDocumentation() == "" {
		t.Fatal("documentation must be non-empty")
	}
}

// TestOneSatRule mirrors the TS MandalaTopicManager 1-satoshi rule: every
// token output and every VERIFIED admin output must carry exactly 1 satoshi
// (token value is payload-denominated). Ordinary P2PKH change — which is
// admin-shaped but never admitted — is exempt.
func TestOneSatRule(t *testing.T) {
	t.Run("token output over 1 sat rejects", func(t *testing.T) {
		h := newHarness(t)
		h.tx.Outputs[0].Satoshis = 2
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, "token output 0 must carry exactly 1 satoshi")
	})

	t.Run("verified admin output over 1 sat rejects", func(t *testing.T) {
		h := newHarness(t)
		prior := h.addRecordedAdminPrior(0x02, 0)
		h.addAdminOutput(t, ActionDetails{"kind": "pause", "assetId": h.assetID, "priorOutpoint": prior})
		h.tx.Outputs[len(h.tx.Outputs)-1].Satoshis = 2
		_, err := h.run(t, []uint32{0, 1})
		wantReject(t, err, "admin output 2 must carry exactly 1 satoshi")
	})

	t.Run("non-admitted change output over 1 sat unaffected", func(t *testing.T) {
		h := newHarness(t)
		h.tx.AddOutput(&transaction.TransactionOutput{
			Satoshis:      999,
			LockingScript: p2pkhScript(t, [20]byte{0xde, 0xad, 0xbe, 0xef}),
		})
		res, err := h.run(t, []uint32{0})
		if err != nil {
			t.Fatal(err)
		}
		wantAdmitted(t, res, 0, 1)
	})
}
