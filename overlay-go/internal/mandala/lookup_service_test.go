package mandala

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/wallet"
)

// ---------------------------------------------------------------------------
// Self-contained fixtures (deliberately not sharing identifiers with
// topic_manager_test.go, even though both files live in package mandala).
// ---------------------------------------------------------------------------

const (
	lsVerifierKeyHex = "0000000000000000000000000000000000000000000000000000000000000021"
	lsHolderKeyHex   = "0000000000000000000000000000000000000000000000000000000000000022"
)

var lsFtProtocol = wallet.Protocol{SecurityLevel: 2, Protocol: "mandala token"}

// lsDummyInput builds a syntactically-valid, source-less input so a
// standalone transaction can still be serialized to AtomicBEEF (allowPartial
// tolerates the missing source transaction).
func lsDummyInput(fill byte, vout uint32) *transaction.TransactionInput {
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

// lsMustLockToken builds a MandalaToken locking script or fails the test.
func lsMustLockToken(t *testing.T, assetID string, amount int64, pkh []byte) *script.Script {
	t.Helper()
	s, err := LockToken(assetID, amount, pkh)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// lsRevealLinkage produces a real BRC-72 specific key linkage: prover =
// holder wallet, verifier = the lookup service's Verifier identity.
func lsRevealLinkage(t *testing.T, holderPW *wallet.ProtoWallet, proverID string, verifierPub *ec.PublicKey, keyID string, cp *ec.PublicKey) *SpecificLinkage {
	t.Helper()
	res, err := holderPW.RevealSpecificKeyLinkage(context.Background(), wallet.RevealSpecificKeyLinkageArgs{
		Counterparty: wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: cp},
		Verifier:     verifierPub,
		ProtocolID:   lsFtProtocol,
		KeyID:        keyID,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	return &SpecificLinkage{
		Prover:                proverID,
		Verifier:              verifierPub.ToDERHex(),
		Counterparty:          cp.ToDERHex(),
		ProtocolID:            ProtocolID{SecurityLevel: 2, Name: "mandala token"},
		KeyID:                 keyID,
		EncryptedLinkage:      res.EncryptedLinkage,
		EncryptedLinkageProof: res.EncryptedLinkageProof,
		ProofType:             int(res.ProofType),
	}
}

// lsFTFixture bundles the keys needed to build FT admission fixtures.
type lsFTFixture struct {
	verifier    *Verifier
	verifierPub *ec.PublicKey
	holderPW    *wallet.ProtoWallet
	holderKD    *wallet.KeyDeriver
	holderPub   *ec.PublicKey
	holderID    string
}

func newLSFTFixture(t *testing.T) *lsFTFixture {
	t.Helper()
	verifier, err := NewVerifier(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	verifierPriv, err := ec.PrivateKeyFromHex(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	holderPriv, err := ec.PrivateKeyFromHex(lsHolderKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	holderPW, err := wallet.NewProtoWallet(wallet.ProtoWalletArgs{
		Type: wallet.ProtoWalletArgsTypePrivateKey, PrivateKey: holderPriv,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &lsFTFixture{
		verifier:    verifier,
		verifierPub: verifierPriv.PubKey(),
		holderPW:    holderPW,
		holderKD:    wallet.NewKeyDeriver(holderPriv),
		holderPub:   holderPriv.PubKey(),
		holderID:    holderPriv.PubKey().ToDERHex(),
	}
}

// lsTokenPKH derives the BRC-42 child pubkey hash the holder wallet locks a
// token output to for the given counterparty.
func (f *lsFTFixture) tokenPKH(t *testing.T, keyID string, cp *ec.PublicKey) []byte {
	t.Helper()
	pub, err := f.holderKD.DerivePublicKey(lsFtProtocol, keyID,
		wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: cp}, false)
	if err != nil {
		t.Fatal(err)
	}
	return hash.Hash160(pub.Compressed())
}

func lsAtomicBEEF(t *testing.T, tx *transaction.Transaction) []byte {
	t.Helper()
	b, err := tx.AtomicBEEF(true)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// ---------------------------------------------------------------------------
// (a) FT output with linkage -> token row + balance + linkage row
// ---------------------------------------------------------------------------

func TestOutputAdmittedByTopicFTWithLinkage(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	f := newLSFTFixture(t)
	ls := NewLookupService(f.verifier, store)

	assetID := strings.Repeat("aa", 32) + ".0"
	keyID := "out-0"
	pkh := f.tokenPKH(t, keyID, f.holderPub)

	tx := transaction.NewTransaction()
	tx.AddInput(lsDummyInput(0x01, 0))
	tx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: lsMustLockToken(t, assetID, 42, pkh),
	})

	linkage := lsRevealLinkage(t, f.holderPW, f.holderID, f.verifierPub, keyID, f.holderPub)
	payload := &LinkagePayload{Outputs: []IndexedLinkage{{Index: 0, Linkage: linkage}}}
	offChain, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	err = ls.OutputAdmittedByTopic(ctx, &engine.OutputAdmittedByTopic{
		Topic: "tm_mandala", OutputIndex: 0,
		AtomicBEEF: lsAtomicBEEF(t, tx), OffChainValues: offChain,
	})
	if err != nil {
		t.Fatal(err)
	}

	txid := tx.TxID().String()
	row, err := store.GetTokenRow(ctx, txid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if row == nil {
		t.Fatal("expected token row")
	}
	if row.AssetID != assetID || row.Amount != 42 || row.IdentityKey != f.holderID {
		t.Fatalf("token row: %+v", row)
	}

	bal, err := store.GetBalance(ctx, f.holderID)
	if err != nil {
		t.Fatal(err)
	}
	if bal != 42 {
		t.Fatalf("balance = %d, want 42", bal)
	}

	lrow, err := store.GetLinkageRow(ctx, txid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if lrow == nil {
		t.Fatal("expected linkage row")
	}
	if lrow.IdentityKey != f.holderID {
		t.Fatalf("linkage row identity: %+v", lrow)
	}
}

// ---------------------------------------------------------------------------
// (b) FT output without offChainValues -> token row, empty identity, no
// balance change.
// ---------------------------------------------------------------------------

func TestOutputAdmittedByTopicFTWithoutOffChainValues(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	f := newLSFTFixture(t)
	ls := NewLookupService(f.verifier, store)

	assetID := strings.Repeat("bb", 32) + ".0"
	pkh := f.tokenPKH(t, "out-0", f.holderPub)

	tx := transaction.NewTransaction()
	tx.AddInput(lsDummyInput(0x02, 0))
	tx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: lsMustLockToken(t, assetID, 7, pkh),
	})

	err := ls.OutputAdmittedByTopic(ctx, &engine.OutputAdmittedByTopic{
		Topic: "tm_mandala", OutputIndex: 0,
		AtomicBEEF: lsAtomicBEEF(t, tx), OffChainValues: nil,
	})
	if err != nil {
		t.Fatal(err)
	}

	txid := tx.TxID().String()
	row, err := store.GetTokenRow(ctx, txid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if row == nil {
		t.Fatal("expected token row")
	}
	if row.IdentityKey != "" {
		t.Fatalf("expected empty identityKey, got %q", row.IdentityKey)
	}
	if row.AssetID != assetID || row.Amount != 7 {
		t.Fatalf("token row: %+v", row)
	}

	bal, err := store.GetBalance(ctx, f.holderID)
	if err != nil {
		t.Fatal(err)
	}
	if bal != 0 {
		t.Fatalf("balance = %d, want 0 (no credit without identity)", bal)
	}

	lrow, err := store.GetLinkageRow(ctx, txid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if lrow != nil {
		t.Fatalf("expected no linkage row, got %+v", lrow)
	}
}

// ---------------------------------------------------------------------------
// (b1) FT output whose offChainValues has an index-matching outputs[] entry
// with no Linkage set -> verification must still run (and fail cleanly) even
// though Linkage is nil; the error must propagate and no token row should be
// stored (linkage verification runs before StoreToken in indexTokenOutput).
// ---------------------------------------------------------------------------

func TestOutputAdmittedByTopicFTIndexMatchNilLinkagePropagatesError(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	f := newLSFTFixture(t)
	ls := NewLookupService(f.verifier, store)

	assetID := strings.Repeat("cc", 32) + ".0"
	pkh := f.tokenPKH(t, "out-0", f.holderPub)

	tx := transaction.NewTransaction()
	tx.AddInput(lsDummyInput(0x05, 0))
	tx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: lsMustLockToken(t, assetID, 9, pkh),
	})

	// outputs[] has an entry for index 0, but it carries no "linkage" field.
	payload := &LinkagePayload{Outputs: []IndexedLinkage{{Index: 0}}}
	offChain, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	err = ls.OutputAdmittedByTopic(ctx, &engine.OutputAdmittedByTopic{
		Topic: "tm_mandala", OutputIndex: 0,
		AtomicBEEF: lsAtomicBEEF(t, tx), OffChainValues: offChain,
	})
	if err == nil {
		t.Fatal("expected error propagated from nil-linkage verification, got nil")
	}

	txid := tx.TxID().String()
	row, getErr := store.GetTokenRow(ctx, txid, 0)
	if getErr != nil {
		t.Fatal(getErr)
	}
	if row != nil {
		t.Fatalf("expected no token row stored when linkage verification fails, got %+v", row)
	}
}

// ---------------------------------------------------------------------------
// (b2) AtomicBEEF header txid not present in the bundle -> ParseBeef returns
// (tx=nil, err=nil); OutputAdmittedByTopic must not panic and must return a
// clean error instead of dereferencing the nil tx.
// ---------------------------------------------------------------------------

func TestOutputAdmittedByTopicAtomicTxidNotInBundleReturnsError(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("OutputAdmittedByTopic panicked: %v", r)
		}
	}()

	ctx := context.Background()
	store := mustStore(t, testDB(t))
	f := newLSFTFixture(t)
	ls := NewLookupService(f.verifier, store)

	assetID := strings.Repeat("dd", 32) + ".0"
	pkh := f.tokenPKH(t, "out-0", f.holderPub)

	tx := transaction.NewTransaction()
	tx.AddInput(lsDummyInput(0x09, 0))
	tx.AddOutput(&transaction.TransactionOutput{
		Satoshis:      1,
		LockingScript: lsMustLockToken(t, assetID, 1, pkh),
	})

	beef := lsAtomicBEEF(t, tx)
	// Corrupt the atomic-header subject txid (bytes [4:36]) so it no longer
	// matches the txid of the transaction actually carried in the BEEF
	// bundle body (bytes [36:]). transaction.ParseBeef's ATOMIC_BEEF branch
	// then calls Beef.FindTransaction with the corrupted txid, which finds
	// nothing and returns (tx=nil, err=nil) -- the specific nil/nil case
	// this test targets.
	corrupted := append([]byte(nil), beef...)
	for i := 4; i < 36; i++ {
		corrupted[i] ^= 0xff
	}

	err := ls.OutputAdmittedByTopic(ctx, &engine.OutputAdmittedByTopic{
		Topic: "tm_mandala", OutputIndex: 0,
		AtomicBEEF: corrupted, OffChainValues: nil,
	})
	if err == nil {
		t.Fatal("expected error for atomic tx not found in beef, got nil")
	}
}

// ---------------------------------------------------------------------------
// (c) register admin output with publicData -> metadata row + history entry
// + state.issuerIdentityKey set.
// ---------------------------------------------------------------------------

func TestOutputAdmittedByTopicRegisterAdmin(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	verifier, err := NewVerifier(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	ls := NewLookupService(verifier, store)

	pkh := [20]byte{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	lockScript, err := LockAdmin(pkh[:], map[string]any{"note": "register"})
	if err != nil {
		t.Fatal(err)
	}

	tx := transaction.NewTransaction()
	tx.AddInput(lsDummyInput(0x03, 0))
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: lockScript})

	foreignAssetID := strings.Repeat("cc", 32) + ".0"
	issuerKey := strings.Repeat("03", 33)
	details := ActionDetails{"kind": "register", "assetId": foreignAssetID, "issuer": issuerKey}
	payload := &LinkagePayload{Admin: []IndexedAdmin{{Index: 0, ActionDetails: details}}}
	offChain, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	err = ls.OutputAdmittedByTopic(ctx, &engine.OutputAdmittedByTopic{
		Topic: "tm_mandala", OutputIndex: 0,
		AtomicBEEF: lsAtomicBEEF(t, tx), OffChainValues: offChain,
	})
	if err != nil {
		t.Fatal(err)
	}

	txid := tx.TxID().String()
	genesis := fmtOutpoint(txid, 0)
	meta, err := store.FindMetadataByAssetID(ctx, fmtOutpoint(txid, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(meta) != 1 || meta[0].Txid != txid || meta[0].OutputIndex != 0 {
		t.Fatalf("metadata: %+v", meta)
	}

	hist, err := store.FindAdminHistoryByAssetID(ctx, genesis)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 1 {
		t.Fatalf("admin history: %+v", hist)
	}
	if hist[0].ActionDetails.Kind() != "register" || hist[0].Txid != txid {
		t.Fatalf("admin history entry: %+v", hist[0])
	}
	if hist[0].AdmitSeq < 1 {
		t.Fatalf("admitSeq not assigned: %+v", hist[0])
	}
	if rows, err := store.FindAdminHistoryByAssetID(ctx, foreignAssetID); err != nil || len(rows) != 0 {
		t.Fatalf("register was folded under the payload's assetId: rows=%+v err=%v", rows, err)
	}

	state, err := store.GetAssetState(ctx, genesis)
	if err != nil {
		t.Fatal(err)
	}
	if state.IssuerIdentityKey != issuerKey {
		t.Fatalf("issuerIdentityKey = %q, want %q", state.IssuerIdentityKey, issuerKey)
	}
	if state.LastAdmitSeq != hist[0].AdmitSeq {
		t.Fatalf("lastAdmitSeq = %d, want %d", state.LastAdmitSeq, hist[0].AdmitSeq)
	}
}

// ---------------------------------------------------------------------------
// (d) OutputSpent decrements balance and deletes the token row.
// ---------------------------------------------------------------------------

func TestOutputSpentDecrementsAndDeletes(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	verifier, err := NewVerifier(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	ls := NewLookupService(verifier, store)

	identity := "02" + strings.Repeat("dd", 32)
	txid := strings.Repeat("ee", 32)
	if err := store.StoreToken(ctx, TokenRow{
		Txid: txid, OutputIndex: 2, AssetID: txid + ".2", Amount: 30,
		IdentityKey: identity, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.AdjustBalance(ctx, identity, 30); err != nil {
		t.Fatal(err)
	}

	outpoint, err := transaction.OutpointFromString(fmtOutpoint(txid, 2))
	if err != nil {
		t.Fatal(err)
	}
	if err := ls.OutputSpent(ctx, &engine.OutputSpent{Outpoint: outpoint, Topic: "tm_mandala"}); err != nil {
		t.Fatal(err)
	}

	bal, err := store.GetBalance(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	if bal != 0 {
		t.Fatalf("balance = %d, want 0 after spend", bal)
	}
	row, err := store.GetTokenRow(ctx, txid, 2)
	if err != nil {
		t.Fatal(err)
	}
	if row != nil {
		t.Fatalf("expected token row deleted, got %+v", row)
	}
}

// ---------------------------------------------------------------------------
// (e) Lookup{assetId} excludes evicted outpoints.
// ---------------------------------------------------------------------------

func TestLookupAssetIDExcludesEvicted(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	verifier, err := NewVerifier(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	ls := NewLookupService(verifier, store)

	keepTxid := strings.Repeat("11", 32)
	evictedTxid := strings.Repeat("22", 32)
	assetID := strings.Repeat("ff", 32) + ".0"
	if err := store.StoreToken(ctx, TokenRow{Txid: keepTxid, OutputIndex: 0, AssetID: assetID, Amount: 1, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := store.StoreToken(ctx, TokenRow{Txid: evictedTxid, OutputIndex: 0, AssetID: assetID, Amount: 1, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	st := DefaultAssetState(assetID)
	st.EvictedOutpoints = []string{fmtOutpoint(evictedTxid, 0)}
	if err := store.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}

	query, err := json.Marshal(map[string]any{"assetId": assetID})
	if err != nil {
		t.Fatal(err)
	}
	ans, err := ls.Lookup(ctx, &lookup.LookupQuestion{Service: "ls_mandala", Query: query})
	if err != nil {
		t.Fatal(err)
	}
	if ans.Type != lookup.AnswerTypeFormula {
		t.Fatalf("answer type = %q, want formula", ans.Type)
	}
	if len(ans.Formulas) != 1 {
		t.Fatalf("formulas = %+v, want exactly the non-evicted outpoint", ans.Formulas)
	}
	wantOutpoint, err := transaction.OutpointFromString(fmtOutpoint(keepTxid, 0))
	if err != nil {
		t.Fatal(err)
	}
	if !ans.Formulas[0].Outpoint.Equal(wantOutpoint) {
		t.Fatalf("outpoint = %s, want %s", ans.Formulas[0].Outpoint, wantOutpoint)
	}
}

// ---------------------------------------------------------------------------
// (f) Lookup with an unrecognized query shape errors "Unsupported query".
// ---------------------------------------------------------------------------

func TestLookupUnsupportedQuery(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	verifier, err := NewVerifier(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	ls := NewLookupService(verifier, store)

	query, err := json.Marshal(map[string]any{"somethingElse": "x"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = ls.Lookup(ctx, &lookup.LookupQuestion{Service: "ls_mandala", Query: query})
	if err == nil {
		t.Fatal("expected error for unsupported query")
	}
	if err.Error() != "Unsupported query" {
		t.Fatalf("error = %q, want %q", err.Error(), "Unsupported query")
	}
}

func TestAdminAssetIDKeysRegisterByOwnOutpoint(t *testing.T) {
	txid := strings.Repeat("ab", 32)
	foreign := strings.Repeat("cc", 32) + ".0"
	cases := []struct {
		name    string
		details ActionDetails
		want    string
	}{
		{"register ignores payload assetId", ActionDetails{"kind": "register", "assetId": foreign}, fmtOutpoint(txid, 2)},
		{"register without assetId", ActionDetails{"kind": "register"}, fmtOutpoint(txid, 2)},
		{"pause uses payload assetId", ActionDetails{"kind": "pause", "assetId": foreign}, foreign},
		{"pause without assetId falls back to own outpoint", ActionDetails{"kind": "pause"}, fmtOutpoint(txid, 2)},
		{"setFeeRate uses payload assetId", ActionDetails{"kind": "setFeeRate", "assetId": foreign}, foreign},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := adminAssetID(c.details, txid, 2); got != c.want {
				t.Fatalf("adminAssetID = %q, want %q", got, c.want)
			}
		})
	}
}
