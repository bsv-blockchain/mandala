package httpapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// Arbitrary valid secp256k1 private key (test-only), shared by the signer
// fixtures below.
const admissionPrivHex = "1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"

func testSigner(t *testing.T) *ECAdmissionSigner {
	t.Helper()
	s, err := NewECAdmissionSigner(admissionPrivHex)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func testIdentityKey(t *testing.T) string {
	t.Helper()
	priv, err := ec.PrivateKeyFromHex(admissionPrivHex)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(priv.PubKey().Compressed())
}

// submitBeef builds a minimal but genuinely parseable BEEF so the handler can
// derive a txid (every txid-keyed path — dupe, verdict, σ_I — depends on it).
func submitBeef(t *testing.T, fill byte) ([]byte, string) {
	t.Helper()
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = fill
	}
	srcID, err := chainhash.NewHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	tx := transaction.NewTransaction()
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID:       srcID,
		SourceTxOutIndex: 0,
		UnlockingScript:  &script.Script{},
	})
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: &script.Script{}})
	beef, err := tx.AtomicBEEF(true)
	if err != nil {
		t.Fatal(err)
	}
	return beef, tx.TxID().String()
}

// stubAdmissionStore is an AdmissionRecorder double that records every call,
// so tests can assert both the wire answer and the side effects (or their
// absence).
type stubAdmissionStore struct {
	record *mandala.AdmissionRecord
	getErr error
	// recordErr fails the FINALIZE write; provisionalErr fails the §9.4
	// provisional one. They are separate so a test can break exactly one.
	recordErr      error
	provisionalErr error

	getCalls int
	// recorded holds finalizing writes; provisional holds the pending ones,
	// so "did this submit record an admission?" stays a question about the
	// finalize.
	recorded     []mandala.AdmissionRecord
	provisional  []mandala.AdmissionRecord
	refusals     []mandala.AdmissionRecord
	refusalCalls int
}

func (s *stubAdmissionStore) GetAdmission(_ context.Context, txid string) (*mandala.AdmissionRecord, error) {
	s.getCalls++
	if s.getErr != nil {
		return nil, s.getErr
	}
	if s.record != nil && s.record.Txid == txid {
		return s.record, nil
	}
	return nil, nil
}

func (s *stubAdmissionStore) RecordAdmission(_ context.Context, rec mandala.AdmissionRecord) error {
	if rec.Pending {
		if s.provisionalErr != nil {
			return s.provisionalErr
		}
		s.provisional = append(s.provisional, rec)
		return nil
	}
	if s.recordErr != nil {
		return s.recordErr
	}
	s.recorded = append(s.recorded, rec)
	return nil
}

func (s *stubAdmissionStore) MarkRefused(_ context.Context, r mandala.Refusal) error {
	s.refusalCalls++
	s.refusals = append(s.refusals, mandala.AdmissionRecord{
		Txid: r.Txid, RefusedCode: r.Code, RefusedDescription: r.Description,
		RefusedSpendTxid: r.SpendTxid, RefusedPayloadHash: r.PayloadHash,
	})
	return nil
}

var _ AdmissionRecorder = (*stubAdmissionStore)(nil)

// emptyPayloadHash is the §9.1 identity of a submit carrying no off-chain
// values — what every submitBeefReq below sends.
func emptyPayloadHash() string { return mandala.PayloadHashHex(nil) }

func submitBeefReq(beef []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(beef))
	req.Header.Set("X-Topics", `["tm_mandala"]`)
	return req
}

// --- FIX A/B: σ_I binds to the tm_mandala admitted output set ---

func TestSubmit_SignsDigestV2OverTheTmMandalaSet(t *testing.T) {
	beef, txid := submitBeef(t, 0x11)
	stub := &stubSubmitter{steak: overlay.Steak{
		tokenTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{2, 0}},
	}}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	tm, ok := body[tokenTopic].(map[string]any)
	if !ok {
		t.Fatalf("body = %v, missing tm_mandala", body)
	}
	sigHex, _ := tm["admissionSignature"].(string)
	if sigHex == "" {
		t.Fatalf("no admissionSignature on an admitting submit: %v", tm)
	}
	if got, _ := tm["admissionIdentityKey"].(string); got != testIdentityKey(t) {
		t.Fatalf("admissionIdentityKey = %q", got)
	}
	// The signature must verify against the SORTED admitted set, not the
	// bare txid and not the engine's ordering.
	digest, err := AdmissionDigestV2(txid, []uint32{0, 2})
	if err != nil {
		t.Fatal(err)
	}
	der, err := hex.DecodeString(sigHex)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := ec.FromDER(der)
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := ec.PrivateKeyFromHex(admissionPrivHex)
	if !sig.Verify(digest[:], priv.PubKey()) {
		t.Fatal("σ_I does not verify against admissionDigestV2(txid, sorted outputsToAdmit)")
	}
}

// A registry-only admission never yields a token σ_I, and σ_I never rides on
// a topic it does not speak for.
func TestSubmit_RegistryOnlyAdmissionGetsNoSignature(t *testing.T) {
	beef, _ := submitBeef(t, 0x12)
	stub := &stubSubmitter{steak: overlay.Steak{
		mandala.RegistryTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}},
		tokenTopic:            &overlay.AdmittanceInstructions{OutputsToAdmit: nil},
	}}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	req := submitBeefReq(beef)
	req.Header.Set("X-Topics", `["tm_mandala","`+mandala.RegistryTopic+`"]`)
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	reg, _ := body[mandala.RegistryTopic].(map[string]any)
	if reg == nil {
		t.Fatalf("body = %v", body)
	}
	if _, has := reg["admissionSignature"]; has {
		t.Fatalf("a registry admission carried a token σ_I: %v", reg)
	}
	if len(rec.recorded) != 0 {
		t.Fatalf("a registry-only admission wrote a token admission record: %+v", rec.recorded)
	}
}

// --- wire contract §4: the record is written before the 200 is sent ---

func TestSubmit_RecordsAdmissionSynchronouslyWithRestoreSnapshot(t *testing.T) {
	beef, txid := submitBeef(t, 0x13)
	stub := &stubSubmitter{steak: overlay.Steak{
		tokenTopic:            &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}},
		mandala.RegistryTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{1}},
	}}
	rec := &stubAdmissionStore{}
	snapshot := &mandala.RestoreSnapshot{
		SpentOutpoints: []string{"aa.0"},
		TokenRows:      []mandala.TokenRow{{Txid: "aa", OutputIndex: 0, AssetID: "a.0", Amount: 100}},
	}
	comp := &stubCompensation{restore: snapshot}
	app := newServer(stub, nil, nil, nil,
		WithAdmissionSigner(testSigner(t)),
		WithAdmissionStore(rec, nil),
		WithBroadcastCompensation(comp.prepare))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, readRawBody(t, resp))
	}
	if len(rec.recorded) != 1 {
		t.Fatalf("recorded %d admissions, want exactly 1 written before the response", len(rec.recorded))
	}
	got := rec.recorded[0]
	if got.Txid != txid {
		t.Fatalf("recorded txid = %s, want %s", got.Txid, txid)
	}
	if len(got.OutputsToAdmit) != 1 || got.OutputsToAdmit[0] != 0 {
		t.Fatalf("recorded outputsToAdmit = %v, want the tm_mandala set", got.OutputsToAdmit)
	}
	if len(got.Topics) != 2 {
		t.Fatalf("recorded topics = %v, want every admitting topic", got.Topics)
	}
	if got.AdmissionSignature == "" || got.AdmissionIdentityKey == "" {
		t.Fatalf("recorded admission without σ_I: %+v", got)
	}
	if got.Restore == nil || len(got.Restore.TokenRows) != 1 {
		t.Fatalf("recorded admission without the pre-spend restore snapshot: %+v", got.Restore)
	}
	// §9.4: the provisional row came FIRST and already carried the snapshot,
	// so a crash inside Submit still leaves the coins recoverable.
	if len(rec.provisional) != 1 {
		t.Fatalf("wrote %d provisional records, want exactly 1 before Submit", len(rec.provisional))
	}
	prov := rec.provisional[0]
	if prov.Txid != txid || !prov.Pending {
		t.Fatalf("provisional record = %+v", prov)
	}
	if prov.Restore == nil || len(prov.Restore.TokenRows) != 1 {
		t.Fatalf("provisional record has no restore snapshot: %+v", prov)
	}
	if len(prov.OutputsToAdmit) != 0 || prov.AdmissionSignature != "" {
		t.Fatalf("a provisional record must not claim an admission: %+v", prov)
	}
}

// §9.4 — a crash between the provisional write and the finalize leaves a
// pending row; the next submit of those bytes finds the engine's applied proof
// and finalizes it, rather than re-submitting or answering 404 forever.
func TestSubmit_DupeFinalizesAPendingRecordFromTheAppliedProof(t *testing.T) {
	beef, txid := submitBeef(t, 0x21)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:    txid,
		Topics:  []string{tokenTopic},
		Pending: true,
		Restore: &mandala.RestoreSnapshot{SpentOutpoints: []string{"aa.0"}},
	}}
	proof := func(context.Context, string) (bool, []uint32, error) { return true, []uint32{0, 2}, nil }
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, readRawBody(t, resp))
	}
	if stub.gotCtx != nil {
		t.Fatal("an engine-proven dupe must not reach Engine.Submit again")
	}
	if len(rec.recorded) != 1 {
		t.Fatalf("the pending record was not finalized: %+v", rec.recorded)
	}
	got := rec.recorded[0]
	if got.Txid != txid || got.Pending || len(got.OutputsToAdmit) != 2 || got.AdmissionSignature == "" {
		t.Fatalf("finalized record = %+v", got)
	}
}

// §9.4 — if the finalize cannot be written the client must not be handed a
// signature it cannot look up: 503, and the retry lands on the dupe path.
func TestSubmit_DupeFinalizeFailureIs503(t *testing.T) {
	beef, txid := submitBeef(t, 0x22)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{
		record:    &mandala.AdmissionRecord{Txid: txid, Pending: true},
		recordErr: errors.New("mongo down"),
	}
	proof := func(context.Context, string) (bool, []uint32, error) { return true, []uint32{0}, nil }
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["code"] != CodeUnavailable || body["retryable"] != true {
		t.Fatalf("body = %v", body)
	}
}

// §9.4 — the provisional write is what makes the restore snapshot durable, so
// a failure there must stop the submit BEFORE the engine mutates anything.
func TestSubmit_ProvisionalRecordWriteFailureIs503AndSkipsSubmit(t *testing.T) {
	beef, _ := submitBeef(t, 0x23)
	stub := &stubSubmitter{steak: overlay.Steak{
		tokenTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}},
	}}
	rec := &stubAdmissionStore{provisionalErr: errors.New("mongo down")}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["code"] != CodeUnavailable || body["retryable"] != true {
		t.Fatalf("body = %v", body)
	}
	if stub.gotCtx != nil {
		t.Fatal("Submit ran without a durable restore snapshot")
	}
}

// A client holding a 200 must be able to GET the record immediately. If the
// record cannot be written, the 200 would be a promise the overlay cannot
// keep — answer 503 instead and let the retry land on the dupe path.
func TestSubmit_RecordWriteFailureIs503(t *testing.T) {
	beef, _ := submitBeef(t, 0x14)
	stub := &stubSubmitter{steak: overlay.Steak{
		tokenTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}},
	}}
	rec := &stubAdmissionStore{recordErr: errors.New("mongo down")}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["code"] != CodeUnavailable || body["retryable"] != true {
		t.Fatalf("body = %v", body)
	}
}

// --- FIX C/D: the idempotent dupe path and "verdict wins" ---

func TestSubmit_DupeOfAdmittedTxidReSignsWithoutSideEffects(t *testing.T) {
	beef, txid := submitBeef(t, 0x15)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	comp := &stubCompensation{}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:                 txid,
		Topics:               []string{tokenTopic},
		OutputsToAdmit:       []uint32{0, 2},
		AdmissionSignature:   "stale-signature",
		AdmissionIdentityKey: "02stale",
		At:                   "2026-01-01T00:00:00.000Z",
	}}
	app := newServer(stub, nil, nil, nil,
		WithAdmissionSigner(testSigner(t)),
		WithAdmissionStore(rec, nil),
		WithBroadcastCompensation(comp.prepare))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if stub.gotCtx != nil {
		t.Fatal("a dupe must not reach Engine.Submit")
	}
	if comp.prepareCalls != 0 {
		t.Fatal("a dupe must not take a new pre-spend snapshot")
	}
	if len(rec.recorded) != 0 {
		t.Fatal("a dupe must not rewrite the admission record")
	}
	body := decodeJSON(t, resp)
	tm, _ := body[tokenTopic].(map[string]any)
	if tm == nil {
		t.Fatalf("body = %v", body)
	}
	admits, _ := tm["outputsToAdmit"].([]any)
	if len(admits) != 2 || admits[0].(float64) != 0 || admits[1].(float64) != 2 {
		t.Fatalf("outputsToAdmit = %v, want the recorded set", tm["outputsToAdmit"])
	}
	// Freshly signed, not the stale stored string.
	want, _, err := testSigner(t).SignAdmission(txid, []uint32{0, 2})
	if err != nil {
		t.Fatal(err)
	}
	if tm["admissionSignature"] != want {
		t.Fatalf("admissionSignature = %v, want a fresh σ_I %s", tm["admissionSignature"], want)
	}
}

// The set on the wire is the canonical set that was signed: a stored record
// carrying duplicate indexes serves them collapsed, so a verifier never
// checks σ_I against a set the signer did not use.
func TestSubmit_DupePathServesTheCanonicalOutputSet(t *testing.T) {
	beef, txid := submitBeef(t, 0x1c)
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:                 txid,
		OutputsToAdmit:       []uint32{2, 0, 2},
		AdmissionSignature:   "stale",
		AdmissionIdentityKey: "02stale",
		At:                   "2026-01-01T00:00:00.000Z",
	}}
	app := newServer(&stubSubmitter{}, nil, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	tm, _ := decodeJSON(t, resp)[tokenTopic].(map[string]any)
	admits, _ := tm["outputsToAdmit"].([]any)
	if len(admits) != 2 || admits[0].(float64) != 0 || admits[1].(float64) != 2 {
		t.Fatalf("outputsToAdmit = %v, want the canonical [0 2]", tm["outputsToAdmit"])
	}
	want, _, _ := testSigner(t).SignAdmission(txid, []uint32{0, 2})
	if tm["admissionSignature"] != want {
		t.Fatalf("admissionSignature = %v, want the canonical-set σ_I", tm["admissionSignature"])
	}
}

// FIX C proper: no admission record at all, but the ENGINE's applied-
// transaction store proves the txid went through tm_mandala. Sign anyway,
// deriving outputsToAdmit from the engine's own stored outputs.
func TestSubmit_DupeFromAppliedProofWithNoRecord(t *testing.T) {
	beef, txid := submitBeef(t, 0x16)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{}
	var askedFor string
	proof := func(_ context.Context, id string) (bool, []uint32, error) {
		askedFor = id
		return true, []uint32{3, 1}, nil
	}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if askedFor != txid {
		t.Fatalf("applied proof asked for %q, want %q", askedFor, txid)
	}
	if stub.gotCtx != nil {
		t.Fatal("an engine-proven dupe must not reach Engine.Submit")
	}
	body := decodeJSON(t, resp)
	tm, _ := body[tokenTopic].(map[string]any)
	admits, _ := tm["outputsToAdmit"].([]any)
	if len(admits) != 2 || admits[0].(float64) != 1 || admits[1].(float64) != 3 {
		t.Fatalf("outputsToAdmit = %v, want [1 3] ascending", tm["outputsToAdmit"])
	}
	want, _, _ := testSigner(t).SignAdmission(txid, []uint32{1, 3})
	if tm["admissionSignature"] != want {
		t.Fatalf("admissionSignature = %v, want %s", tm["admissionSignature"], want)
	}
}

func TestSubmit_EvictedTxidIs410Forever(t *testing.T) {
	beef, txid := submitBeef(t, 0x17)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:      txid,
		EvictedAt: "2026-02-03T04:05:06.000Z",
	}}
	// Even with the engine still claiming the tx was applied, the eviction
	// stamp wins.
	proof := func(context.Context, string) (bool, []uint32, error) { return true, []uint32{0}, nil }
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("status = %d, want 410", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["code"] != CodeEvicted || body["retryable"] != false || body["status"] != "error" {
		t.Fatalf("body = %v", body)
	}
	// The description is part of the wire contract: byte-identical on both
	// engines and on both routes, with no timestamp in it.
	want := "transaction " + txid + " was admitted and later evicted; its inputs are spendable again"
	if body["description"] != want {
		t.Fatalf("description = %q, want %q", body["description"], want)
	}
	if stub.gotCtx != nil {
		t.Fatal("an evicted txid must not be resubmitted to the engine")
	}
}

func TestSubmit_PersistedRefusalIsReservedIdentically(t *testing.T) {
	beef, txid := submitBeef(t, 0x18)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:               txid,
		RefusedCode:        CodeConservation,
		RefusedDescription: "conservation violated: outputs exceed authorized inputs/issuance",
		RefusedPayloadHash: emptyPayloadHash(),
	}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["code"] != CodeConservation || body["retryable"] != false {
		t.Fatalf("body = %v", body)
	}
	if body["description"] != "conservation violated: outputs exceed authorized inputs/issuance" {
		t.Fatalf("description = %v", body["description"])
	}
	if stub.gotCtx != nil {
		t.Fatal("a txid with a final verdict for THIS payload must not be resubmitted to the engine")
	}
}

// §9.1 — a refusal earned with one payload says nothing about another. The
// same BEEF submitted with a different payload is evaluated fresh.
func TestSubmit_PersistedRefusalDoesNotApplyToADifferentPayload(t *testing.T) {
	beef, txid := submitBeef(t, 0x24)
	stub := &stubSubmitter{steak: overlay.Steak{
		tokenTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}},
	}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:               txid,
		RefusedCode:        CodeLinkage,
		RefusedDescription: "output 0: MandalaToken-decodable output with no verified linkage",
		RefusedPayloadHash: mandala.PayloadHashHex([]byte("some other payload")),
	}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, readRawBody(t, resp))
	}
	if stub.gotCtx == nil {
		t.Fatal("a refusal scoped to another payload must not short-circuit the engine")
	}
}

// A final verdict earned fresh is persisted; a liftable 409 one is not.
func TestSubmit_PersistsFinalVerdictsOnly(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		wantCode  string
		wantHTTP  int
		persisted bool
	}{
		{
			"final: linkage",
			&mandala.RejectError{Topic: tokenTopic, Err: errors.New("output 1: MandalaToken-decodable output with no verified linkage")},
			CodeLinkage, http.StatusBadRequest, true,
		},
		{
			"final: conservation",
			&mandala.RejectError{Topic: tokenTopic, Err: errors.New("conservation violated: outputs exceed authorized inputs/issuance")},
			CodeConservation, http.StatusBadRequest, true,
		},
		{
			"liftable: paused",
			&mandala.RejectError{Topic: tokenTopic, Err: errors.New("control gate rejected the transaction (paused asset or access mode)")},
			CodePaused, http.StatusConflict, false,
		},
		{
			"fault: not persisted",
			errors.New("mongo down"),
			CodeUnavailable, http.StatusServiceUnavailable, false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			beef, txid := submitBeef(t, 0x19)
			stub := &stubSubmitter{err: tc.err}
			rec := &stubAdmissionStore{}
			app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

			resp := doRequest(t, app, submitBeefReq(beef))
			if resp.StatusCode != tc.wantHTTP {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantHTTP)
			}
			if body := decodeJSON(t, resp); body["code"] != tc.wantCode {
				t.Fatalf("code = %v, want %s", body["code"], tc.wantCode)
			}
			if tc.persisted {
				if rec.refusalCalls != 1 {
					t.Fatalf("persisted %d verdicts, want 1", rec.refusalCalls)
				}
				if rec.refusals[0].Txid != txid || rec.refusals[0].RefusedCode != tc.wantCode {
					t.Fatalf("persisted %+v", rec.refusals[0])
				}
				// §9.1: every persisted refusal is scoped to the payload that
				// earned it, never to the txid alone.
				if rec.refusals[0].RefusedPayloadHash != emptyPayloadHash() {
					t.Fatalf("persisted refusal has payloadHash %q, want the submitted payload's hash",
						rec.refusals[0].RefusedPayloadHash)
				}
			} else if rec.refusalCalls != 0 {
				t.Fatalf("a non-final verdict was persisted: %+v", rec.refusals)
			}
		})
	}
}

// FIX L end to end through the HTTP layer: the manager's conflicting-spend
// verdict becomes a 400 that names the competitor — and, per §9.2, is NEVER
// persisted. It is a statement about live state that an eviction of the
// competitor undoes; persisted, it would outlive its own truth and keep
// telling the wallet a coin is gone after it came back.
func TestSubmit_ConflictingSpendIs400WithSpendTxidAndIsNeverPersisted(t *testing.T) {
	beef, _ := submitBeef(t, 0x1a)
	competitor := "cc" + vectorTxid[2:]
	stub := &stubSubmitter{err: &mandala.RejectError{
		Topic:     tokenTopic,
		Err:       errors.New("input aa.0 already spent by " + competitor),
		SpendTxid: competitor,
	}}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["code"] != CodeInputSpent || body["spendTxid"] != competitor {
		t.Fatalf("body = %v", body)
	}
	if body["retryable"] != false {
		t.Fatalf("retryable = %v, want false on the wire", body["retryable"])
	}
	if rec.refusalCalls != 0 {
		t.Fatalf("ERR_INPUT_SPENT was persisted (§9.2 forbids it): %+v", rec.refusals)
	}
}

// Wire contract §9.5, at the HTTP boundary: a fault raised inside one of the
// manager's guards reaches Submit as a plain (non-*RejectError) error — see
// mandala's TestInfraFaultInEveryGuardIsNeverAVerdict, which proves store,
// provider and chaintracker faults are typed that way — and must answer 503
// with nothing admitted and nothing persisted. A 4xx here would tell a wallet
// its perfectly good transaction is invalid forever because Mongo blinked.
func TestSubmit_GuardDependencyFaultIs503AndAdmitsNothing(t *testing.T) {
	beef, _ := submitBeef(t, 0x25)
	stub := &stubSubmitter{err: errors.New("tm_mandala: token row for aa.0: mongo down")}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["code"] != CodeUnavailable || body["retryable"] != true {
		t.Fatalf("body = %v, want a retryable ERR_UNAVAILABLE", body)
	}
	if body[tokenTopic] != nil {
		t.Fatalf("a faulted submit returned an admittance: %v", body)
	}
	if len(rec.recorded) != 0 {
		t.Fatalf("a faulted submit recorded an admission: %+v", rec.recorded)
	}
	if rec.refusalCalls != 0 {
		t.Fatalf("a dependency fault was persisted as a verdict: %+v", rec.refusals)
	}
}

// A record lookup that fails is a dependency fault: 503, never a guess.
func TestSubmit_RecordLookupFailureIs503(t *testing.T) {
	beef, _ := submitBeef(t, 0x1b)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{getErr: errors.New("mongo down")}
	app := newServer(stub, nil, nil, nil, WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if stub.gotCtx != nil {
		t.Fatal("Submit must not run when the verdict lookup failed")
	}
}

// --- wire contract §3: GET /admin/admission/:txid ---

func admissionReq(txid, token string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/admin/admission/"+txid, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func TestAdmissionEndpoint_200ForAnAdmittedTxid(t *testing.T) {
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:                 vectorTxid,
		Topics:               []string{tokenTopic},
		OutputsToAdmit:       []uint32{2, 0},
		AdmissionSignature:   "3044stored",
		AdmissionIdentityKey: "02stored",
		At:                   "2026-01-01T00:00:00.000Z",
	}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["txid"] != vectorTxid {
		t.Fatalf("txid = %v", body["txid"])
	}
	outs, _ := body["outputsToAdmit"].([]any)
	if len(outs) != 2 || outs[0].(float64) != 0 || outs[1].(float64) != 2 {
		t.Fatalf("outputsToAdmit = %v, want [0 2] ascending", body["outputsToAdmit"])
	}
	if body["admissionSignature"] != "3044stored" || body["admissionIdentityKey"] != "02stored" {
		t.Fatalf("stored σ_I not served verbatim: %v", body)
	}
	if body["at"] != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("at = %v", body["at"])
	}
}

func TestAdmissionEndpoint_ReSignsFromAppliedProofWhenRecordMissing(t *testing.T) {
	rec := &stubAdmissionStore{}
	proof := func(context.Context, string) (bool, []uint32, error) { return true, []uint32{1}, nil }
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	want, _, _ := testSigner(t).SignAdmission(vectorTxid, []uint32{1})
	if body["admissionSignature"] != want {
		t.Fatalf("admissionSignature = %v, want a re-derived σ_I", body["admissionSignature"])
	}
	if body["admissionIdentityKey"] != testIdentityKey(t) {
		t.Fatalf("admissionIdentityKey = %v", body["admissionIdentityKey"])
	}
	if body["at"] == "" {
		t.Fatalf("at must still be present: %v", body)
	}
}

func TestAdmissionEndpoint_410ForAnEvictedTxid(t *testing.T) {
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: vectorTxid, EvictedAt: "2026-02-03T04:05:06.000Z",
	}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("status = %d, want 410", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" || body["code"] != CodeEvicted || body["retryable"] != false {
		t.Fatalf("body = %v", body)
	}
	want := "transaction " + vectorTxid + " was admitted and later evicted; its inputs are spendable again"
	if body["description"] != want {
		t.Fatalf("description = %q, want %q (identical to the /submit 410)", body["description"], want)
	}
}

// §9.3 — the persisted refusal is served only to a caller that names the
// payload it was earned with; every other caller falls through to the
// applied-proof check and then to 404.
func TestAdmissionEndpoint_RefusalIsGatedOnThePayloadHash(t *testing.T) {
	const desc = "conservation violated: outputs exceed authorized inputs/issuance"
	hash := mandala.PayloadHashHex([]byte(`{"outputs":[{"index":0}]}`))
	newApp := func(t *testing.T) *fiber.App {
		rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
			Txid:               vectorTxid,
			RefusedCode:        CodeConservation,
			RefusedDescription: desc,
			RefusedPayloadHash: hash,
		}}
		proof := func(context.Context, string) (bool, []uint32, error) { return false, nil, nil }
		return newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
			WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))
	}

	t.Run("matching payloadHash is the 400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/admin/admission/"+vectorTxid+"?payloadHash="+hash, nil)
		resp := doRequest(t, newApp(t), req)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.StatusCode)
		}
		body := decodeJSON(t, resp)
		if body["code"] != CodeConservation || body["retryable"] != false || body["description"] != desc {
			t.Fatalf("body = %v", body)
		}
	})

	t.Run("uppercase payloadHash still matches", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/admin/admission/"+vectorTxid+"?payloadHash="+strings.ToUpper(hash), nil)
		resp := doRequest(t, newApp(t), req)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("mismatched payloadHash falls through to 404", func(t *testing.T) {
		other := mandala.PayloadHashHex(nil)
		req := httptest.NewRequest(http.MethodGet, "/admin/admission/"+vectorTxid+"?payloadHash="+other, nil)
		resp := doRequest(t, newApp(t), req)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", resp.StatusCode)
		}
	})

	t.Run("absent payloadHash falls through to 404", func(t *testing.T) {
		resp := doRequest(t, newApp(t), admissionReq(vectorTxid, ""))
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", resp.StatusCode)
		}
	})
}

// §9.3 — a malformed txid is the caller's deterministic mistake, answered with
// the contract's error body rather than a 404 or a 500.
func TestAdmissionEndpoint_MalformedTxidIs400ErrShape(t *testing.T) {
	rec := &stubAdmissionStore{}
	proof := func(context.Context, string) (bool, []uint32, error) {
		t.Fatal("a malformed txid must never reach the applied-proof lookup")
		return false, nil, nil
	}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	for _, bad := range []string{"not-a-txid", vectorTxid[:63], vectorTxid + "ab", strings.Repeat("g", 64)} {
		t.Run(bad[:min(len(bad), 12)], func(t *testing.T) {
			resp := doRequest(t, app, admissionReq(bad, ""))
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", resp.StatusCode)
			}
			body := decodeJSON(t, resp)
			if body["status"] != "error" || body["code"] != CodeShape || body["retryable"] != false {
				t.Fatalf("body = %v", body)
			}
			if body["description"] == "" || body["message"] == "" {
				t.Fatalf("body = %v, want both description and message", body)
			}
		})
	}
	if rec.getCalls != 0 {
		t.Fatalf("a malformed txid hit the record store %d times", rec.getCalls)
	}
}

// §9.3 — txids are lowercase everywhere in this system; an uppercase one is
// the same transaction, not an unknown one.
func TestAdmissionEndpoint_TxidIsLowercased(t *testing.T) {
	var askedFor string
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: vectorTxid, Topics: []string{tokenTopic}, OutputsToAdmit: []uint32{0},
		AdmissionSignature: "3044stored", AdmissionIdentityKey: "02stored",
		At: "2026-01-01T00:00:00.000Z",
	}}
	proof := func(_ context.Context, id string) (bool, []uint32, error) {
		askedFor = id
		return false, nil, nil
	}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, admissionReq(strings.ToUpper(vectorTxid), ""))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, readRawBody(t, resp))
	}
	if body := decodeJSON(t, resp); body["txid"] != vectorTxid {
		t.Fatalf("txid = %v, want the lowercase form", body["txid"])
	}
	if askedFor != "" {
		t.Fatalf("applied proof was consulted with %q despite a record hit", askedFor)
	}
}

// §9.3 — an applied proof with an EMPTY admitted set is not an admission: σ_I
// speaks for a set of outputs, and there is no set here to speak for.
func TestAdmissionEndpoint_EmptyAdmittedSetIs404NotAn200(t *testing.T) {
	rec := &stubAdmissionStore{}
	proof := func(context.Context, string) (bool, []uint32, error) { return true, nil, nil }
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" || body["message"] != "no admission on record for "+vectorTxid {
		t.Fatalf("body = %v", body)
	}
}

// The 404 body keeps the TS overlay's existing wording verbatim.
func TestAdmissionEndpoint_404ForAnUnknownTxid(t *testing.T) {
	rec := &stubAdmissionStore{}
	proof := func(context.Context, string) (bool, []uint32, error) { return false, nil, nil }
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" || body["message"] != "no admission on record for "+vectorTxid {
		t.Fatalf("body = %v", body)
	}
}

// A13: the route is gated exactly like /admin/registry.
func TestAdmissionEndpoint_IsBearerGated(t *testing.T) {
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: vectorTxid, OutputsToAdmit: []uint32{0},
		AdmissionSignature: "3044", AdmissionIdentityKey: "02aa", At: "2026-01-01T00:00:00.000Z",
	}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil), WithAdminAPIToken("secret"))

	for _, tc := range []struct {
		name   string
		token  string
		status int
	}{
		{"no token", "", http.StatusUnauthorized},
		{"wrong token", "nope", http.StatusUnauthorized},
		{"right token", "secret", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := doRequest(t, app, admissionReq(vectorTxid, tc.token))
			if resp.StatusCode != tc.status {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.status)
			}
			if tc.status == http.StatusUnauthorized {
				if body := decodeJSON(t, resp); body["error"] != "unauthorized" {
					t.Fatalf("body = %v, want the /admin/registry 401 shape", body)
				}
			}
		})
	}
}

// Narrowed CORS applies to the admission route too (adminGatedPath).
func TestAdmissionEndpoint_UsesNarrowedCORS(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionStore(&stubAdmissionStore{}, nil),
		WithAdminCORSOrigins([]string{"https://console.example"}))

	req := admissionReq(vectorTxid, "")
	req.Header.Set(fiber.HeaderOrigin, "https://evil.example")
	resp := doRequest(t, app, req)
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want it withheld from a non-console origin", got)
	}
}
