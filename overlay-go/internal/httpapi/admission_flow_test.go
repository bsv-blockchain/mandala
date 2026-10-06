package httpapi

// σI per topic (A1.2), the per-topic admission record and the known-verdict rule (D-8) on a stub Submitter. These
// stubs and helpers are shared by the other httpapi tests. Stub tests never name tm_mandala without tm_<own txid>, so
// Task 23's pairing rule leaves them untouched.

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// Arbitrary valid secp256k1 private key (test-only) for the stub signer.
const admissionPrivHex = "1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"

const vectorTxid = "3f0c9a1b2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"

// Two token topics the stub submitter hosts (a nil hasTopic hosts every name).
var (
	testTopicA = "tm_" + strings.Repeat("a", 64)
	testTopicB = "tm_" + strings.Repeat("b", 64)
)

func testSigner(t *testing.T) *mandala.ECAdmissionSigner {
	t.Helper()
	s, err := mandala.NewECAdmissionSigner(admissionPrivHex)
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

// submitBeef builds a minimal, parseable BEEF so the handler derives a txid (every txid-keyed path depends on it).
func submitBeef(t *testing.T, fill byte) ([]byte, string) {
	t.Helper()
	srcID, err := chainhash.NewHash(bytes.Repeat([]byte{fill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	tx := transaction.NewTransaction()
	tx.AddInput(&transaction.TransactionInput{SourceTXID: srcID, SourceTxOutIndex: 0, UnlockingScript: &script.Script{}})
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: &script.Script{}})
	beef, err := tx.AtomicBEEF(true)
	if err != nil {
		t.Fatal(err)
	}
	return beef, tx.TxID().String()
}

// stubAdmissionStore records every call so tests can assert both the wire answer and the side effects.
type stubAdmissionStore struct {
	record *mandala.AdmissionRecord
	getErr error
	// recordErr fails the FINALIZE write; provisionalErr fails the provisional one.
	recordErr      error
	provisionalErr error

	getCalls     int
	recorded     []mandala.AdmissionRecord // finalizing writes
	provisional  []mandala.AdmissionRecord // pending writes
	refusals     []mandala.Refusal
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
	s.refusals = append(s.refusals, r)
	return nil
}

var _ AdmissionRecorder = (*stubAdmissionStore)(nil)

// emptyPayloadHash is the payload identity of a submit carrying no off-chain values.
func emptyPayloadHash() string { return mandala.PayloadHashHex(nil) }

func submitTopicsReq(beef []byte, topics ...string) *http.Request {
	raw, _ := json.Marshal(topics)
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(beef))
	req.Header.Set("X-Topics", string(raw))
	return req
}

func submitBeefReq(beef []byte) *http.Request { return submitTopicsReq(beef, testTopicA) }

// proofOf is an applied proof over a fixed topic -> vouts map (a nil map: nothing applied).
func proofOf(m map[string][]uint32) AppliedAdmissionProof {
	return func(context.Context, string) (map[string][]uint32, error) {
		out := make(map[string][]uint32, len(m))
		for k, v := range m {
			out[k] = v
		}
		return out, nil
	}
}

func entryOf(t *testing.T, body map[string]any, topic string) map[string]any {
	t.Helper()
	e, ok := body[topic].(map[string]any)
	if !ok {
		t.Fatalf("body has no %s entry: %v", topic, body)
	}
	return e
}

func outputsOf(t *testing.T, e map[string]any) []uint32 {
	t.Helper()
	raw, ok := e["outputsToAdmit"].([]any)
	if !ok {
		t.Fatalf("entry without outputsToAdmit: %v", e)
	}
	out := make([]uint32, len(raw))
	for i, v := range raw {
		out[i] = uint32(v.(float64))
	}
	return out
}

// requireSigma asserts e carries a σI by identity over (topic, txid, outs) that verifies under topic and under none
// of the other named topics.
func requireSigma(t *testing.T, e map[string]any, identity, topic, txid string, outs []uint32, others ...string) {
	t.Helper()
	sig, _ := e["admissionSignature"].(string)
	ident, _ := e["admissionIdentityKey"].(string)
	if sig == "" || ident != identity {
		t.Fatalf("entry %v: want a σI by %s", e, identity)
	}
	if ok, err := mandala.VerifyAdmission(topic, txid, outs, sig, ident); err != nil || !ok {
		t.Fatalf("σI does not verify under %s over %v: %v", topic, outs, err)
	}
	for _, other := range others {
		if ok, _ := mandala.VerifyAdmission(other, txid, outs, sig, ident); ok {
			t.Fatalf("the σI of %s also verifies under %s (digest v3 must bind the topic)", topic, other)
		}
	}
}

func requireNoSigma(t *testing.T, e map[string]any) {
	t.Helper()
	if _, has := e["admissionSignature"]; has {
		t.Fatalf("entry %v must carry no σI", e)
	}
	if _, has := e["admissionIdentityKey"]; has {
		t.Fatalf("entry %v must carry no admissionIdentityKey", e)
	}
}

func admissionKeys(rec mandala.AdmissionRecord) []string {
	keys := make([]string, 0, len(rec.Admissions))
	for k := range rec.Admissions {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func TestSubmit_SignsEachSigmaTopicEntryWithItsOwnDigest(t *testing.T) {
	beef, txid := submitBeef(t, 0x11)
	own := "tm_" + txid
	stub := &stubSubmitter{steak: overlay.Steak{
		mandala.MandalaTopic: {OutputsToAdmit: []uint32{0}},
		own:                  {OutputsToAdmit: []uint32{0}},
		mandala.KYCTopic:     {OutputsToAdmit: []uint32{0}},
	}}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitTopicsReq(beef, mandala.MandalaTopic, own, mandala.KYCTopic))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	reg, tok := entryOf(t, body, mandala.MandalaTopic), entryOf(t, body, own)
	requireSigma(t, reg, testIdentityKey(t), mandala.MandalaTopic, txid, []uint32{0}, own)
	requireSigma(t, tok, testIdentityKey(t), own, txid, []uint32{0}, mandala.MandalaTopic)
	if reg["admissionSignature"] == tok["admissionSignature"] {
		t.Fatal("a deploy's two σI must differ (digest v3 binds the topic)")
	}
	requireNoSigma(t, entryOf(t, body, mandala.KYCTopic))

	if len(rec.provisional) != 1 || !reflect.DeepEqual(rec.provisional[0].Topics, []string{mandala.MandalaTopic, own, mandala.KYCTopic}) {
		t.Fatalf("provisional = %+v", rec.provisional)
	}
	if len(rec.recorded) != 1 {
		t.Fatalf("finalize writes = %d, want 1", len(rec.recorded))
	}
	final := rec.recorded[0]
	// admissionKeys sorts, and every "tm_<hex>" sorts before "tm_mandala".
	if got, want := admissionKeys(final), []string{own, mandala.MandalaTopic}; !reflect.DeepEqual(got, want) {
		t.Fatalf("finalized admissions = %v, want %v (never KYC)", got, want)
	}
	if final.AdmissionIdentityKey != testIdentityKey(t) || final.Admissions[own].AdmissionSignature != tok["admissionSignature"] {
		t.Fatalf("finalized record %+v does not hold the σI sent on the wire", final)
	}
}

func TestSubmit_KYCOnlySubmitIsNeitherSignedNorRecorded(t *testing.T) {
	beef, _ := submitBeef(t, 0x12)
	stub := &stubSubmitter{steak: overlay.Steak{mandala.KYCTopic: {OutputsToAdmit: []uint32{0}}}}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proofOf(nil)))

	resp := doRequest(t, app, submitTopicsReq(beef, mandala.KYCTopic))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	requireNoSigma(t, entryOf(t, decodeJSON(t, resp), mandala.KYCTopic))
	if rec.getCalls != 0 || len(rec.provisional) != 0 || len(rec.recorded) != 0 {
		t.Fatalf("a KYC-only submit touched the admission record: get=%d provisional=%d recorded=%d", rec.getCalls, len(rec.provisional), len(rec.recorded))
	}
}

func TestSubmit_ProvisionalAndFinalRecordsCarryTheRestoreSnapshot(t *testing.T) {
	beef, txid := submitBeef(t, 0x13)
	restore := &mandala.RestoreSnapshot{SpentOutpoints: []string{strings.Repeat("cd", 32) + ".1"}}
	comp := &stubCompensation{restore: restore}
	stub := &stubSubmitter{steak: overlay.Steak{testTopicA: {OutputsToAdmit: []uint32{0}}}}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil), WithBroadcastCompensation(comp.prepare))

	if resp := doRequest(t, app, submitBeefReq(beef)); resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if !reflect.DeepEqual(comp.gotTopics, []string{testTopicA}) {
		t.Fatalf("prepare got topics %v, want the named topics", comp.gotTopics)
	}
	if len(rec.provisional) != 1 || !rec.provisional[0].Pending || rec.provisional[0].Txid != txid || rec.provisional[0].Restore != restore {
		t.Fatalf("provisional = %+v, want one pending write carrying the snapshot", rec.provisional)
	}
	if len(rec.recorded) != 1 || rec.recorded[0].Restore != restore || rec.recorded[0].Pending {
		t.Fatalf("finalize = %+v, want the snapshot kept on the final record", rec.recorded)
	}
}

func TestSubmit_ProvisionalWriteFailureIs503AndSkipsSubmit(t *testing.T) {
	beef, _ := submitBeef(t, 0x14)
	stub := &stubSubmitter{steak: overlay.Steak{testTopicA: {OutputsToAdmit: []uint32{0}}}}
	rec := &stubAdmissionStore{provisionalErr: errors.New("mongo down")}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["code"] != CodeUnavailable || body["description"] != "provisional admission record write failed: mongo down" {
		t.Fatalf("body = %v", body)
	}
	if stub.gotCtx != nil {
		t.Fatal("Submit must not run without a durable provisional record")
	}
}

func TestSubmit_FinalizeWriteFailureIs503(t *testing.T) {
	beef, _ := submitBeef(t, 0x15)
	stub := &stubSubmitter{steak: overlay.Steak{testTopicA: {OutputsToAdmit: []uint32{0}}}}
	rec := &stubAdmissionStore{recordErr: errors.New("mongo down")}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 rather than a σI the overlay has no record of", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["description"] != "admission record write failed: mongo down" {
		t.Fatalf("body = %v", body)
	}
}

// D-8 on stubs: the record alone never answers; a 200 replay needs an engine applied record for EVERY named topic,
// and a retry naming one more topic reaches Submit, signs both and finalizes both.
func TestSubmit_KnownVerdictNeedsEveryNamedTopicApplied(t *testing.T) {
	beef, txid := submitBeef(t, 0x16)
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: txid, Topics: []string{testTopicA},
		Admissions:           map[string]mandala.TopicAdmission{testTopicA: {OutputsToAdmit: []uint32{0}, AdmissionSignature: "3044stale"}},
		AdmissionIdentityKey: "02stale", At: "2026-10-05T00:00:00.000Z",
	}}
	stub := &stubSubmitter{steak: overlay.Steak{
		testTopicA: {},
		testTopicB: {OutputsToAdmit: []uint32{1}, CoinsToRetain: []uint32{1}},
	}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proofOf(map[string][]uint32{testTopicA: {0}})))

	resp := doRequest(t, app, submitTopicsReq(beef, testTopicA))
	if resp.StatusCode != http.StatusOK || stub.gotCtx != nil {
		t.Fatalf("covered submit: status %d, reached Submit %v; want a 200 replay without Submit", resp.StatusCode, stub.gotCtx != nil)
	}
	replay := decodeJSON(t, resp)
	a := entryOf(t, replay, testTopicA)
	requireSigma(t, a, testIdentityKey(t), testTopicA, txid, []uint32{0}, testTopicB)
	if retain, _ := a["coinsToRetain"].([]any); retain == nil || len(retain) != 0 {
		t.Fatalf("replay coinsToRetain = %v, want []", a["coinsToRetain"])
	}
	if len(rec.recorded) != 0 {
		t.Fatalf("a replay of a topic the record already holds must not write: %+v", rec.recorded)
	}

	resp = doRequest(t, app, submitTopicsReq(beef, testTopicA, testTopicB))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("uncovered submit: status %d (%s)", resp.StatusCode, readRawBody(t, resp))
	}
	if stub.gotCtx == nil || !reflect.DeepEqual(stub.gotTB.Topics, []string{testTopicA, testTopicB}) {
		t.Fatal("a submit naming a topic the engine has not applied must reach Submit")
	}
	body := decodeJSON(t, resp)
	if got := outputsOf(t, entryOf(t, body, testTopicA)); !reflect.DeepEqual(got, []uint32{0}) {
		t.Fatalf("skipped-as-applied tm_<A> entry outputs = %v, want [0] from the record", got)
	}
	requireSigma(t, entryOf(t, body, testTopicA), testIdentityKey(t), testTopicA, txid, []uint32{0}, testTopicB)
	requireSigma(t, entryOf(t, body, testTopicB), testIdentityKey(t), testTopicB, txid, []uint32{1}, testTopicA)
	if len(rec.recorded) != 1 || !reflect.DeepEqual(admissionKeys(rec.recorded[0]), []string{testTopicA, testTopicB}) {
		t.Fatalf("finalize = %+v, want both topics", rec.recorded)
	}
	if len(rec.provisional) != 1 || !reflect.DeepEqual(rec.provisional[0].Topics, []string{testTopicA, testTopicB}) {
		t.Fatalf("provisional = %+v, want one write naming both topics", rec.provisional)
	}
}

// A lost record: the engine's proof covers every named topic, so the replay re-signs each σ-topic and finalizes them.
func TestSubmit_ReplayFinalizesMissingEntriesFromTheAppliedProof(t *testing.T) {
	beef, txid := submitBeef(t, 0x17)
	own := "tm_" + txid
	stub := &stubSubmitter{}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)),
		WithAdmissionStore(rec, proofOf(map[string][]uint32{mandala.MandalaTopic: {0}, own: {0}})))

	resp := doRequest(t, app, submitTopicsReq(beef, mandala.MandalaTopic, own))
	if resp.StatusCode != http.StatusOK || stub.gotCtx != nil {
		t.Fatalf("status %d, reached Submit %v; want a replay", resp.StatusCode, stub.gotCtx != nil)
	}
	body := decodeJSON(t, resp)
	requireSigma(t, entryOf(t, body, mandala.MandalaTopic), testIdentityKey(t), mandala.MandalaTopic, txid, []uint32{0}, own)
	requireSigma(t, entryOf(t, body, own), testIdentityKey(t), own, txid, []uint32{0}, mandala.MandalaTopic)
	// admissionKeys sorts ("tm_<hex>" < "tm_mandala"); Topics keeps the X-Topics order.
	if len(rec.recorded) != 1 || !reflect.DeepEqual(admissionKeys(rec.recorded[0]), []string{own, mandala.MandalaTopic}) ||
		!reflect.DeepEqual(rec.recorded[0].Topics, []string{mandala.MandalaTopic, own}) {
		t.Fatalf("finalize = %+v", rec.recorded)
	}
	if len(rec.provisional) != 0 {
		t.Fatal("a replay writes no provisional record")
	}
}

// D-20 / R8: a same-txid submit that read step 4 before a concurrent one committed, then met the engine's dupe gate
// after it (check-then-act, F/gos-engine §5 row 5a), gets empty STEAK entries for an admitted transaction. The handler
// re-reads the applied proof once and answers those topics like the known path: outputs from the proof, σI re-signed,
// finalized. A fault on that read is 503, retryable: a retry replays from step 4.
func TestSubmit_DupeGateRaceAnswersFromTheReReadProof(t *testing.T) {
	beef, txid := submitBeef(t, 0x21)
	own := "tm_" + txid
	stub := &stubSubmitter{steak: overlay.Steak{mandala.MandalaTopic: {}, own: {}}}
	rec := &stubAdmissionStore{}
	calls := 0
	var reReadErr error
	proof := func(context.Context, string) (map[string][]uint32, error) {
		calls++
		if calls == 1 {
			return map[string][]uint32{}, nil // step 4: the other submit has not committed yet
		}
		if reReadErr != nil {
			return nil, reReadErr
		}
		return map[string][]uint32{mandala.MandalaTopic: {0}, own: {0}}, nil // after Submit: it has
	}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof))

	resp := doRequest(t, app, submitTopicsReq(beef, mandala.MandalaTopic, own))
	if resp.StatusCode != http.StatusOK || stub.gotCtx == nil {
		t.Fatalf("status %d, reached Submit %v; want 200 after Submit (%s)", resp.StatusCode, stub.gotCtx != nil, readRawBody(t, resp))
	}
	if calls != 2 {
		t.Fatalf("applied proof read %d times, want 2 (step 4, then once after Submit)", calls)
	}
	body := decodeJSON(t, resp)
	for _, topic := range []string{mandala.MandalaTopic, own} {
		if got := outputsOf(t, entryOf(t, body, topic)); !reflect.DeepEqual(got, []uint32{0}) {
			t.Fatalf("%s outputs = %v, want [0] from the re-read proof", topic, got)
		}
	}
	requireSigma(t, entryOf(t, body, mandala.MandalaTopic), testIdentityKey(t), mandala.MandalaTopic, txid, []uint32{0}, own)
	requireSigma(t, entryOf(t, body, own), testIdentityKey(t), own, txid, []uint32{0}, mandala.MandalaTopic)
	want := []string{mandala.MandalaTopic, own}
	sort.Strings(want)
	if len(rec.recorded) != 1 || !reflect.DeepEqual(admissionKeys(rec.recorded[0]), want) {
		t.Fatalf("finalize = %+v, want one write holding both topics", rec.recorded)
	}

	// The same race with a failing re-read: 503, nothing finalized.
	calls, reReadErr = 0, errors.New("mongo down")
	rec.recorded = nil
	resp = doRequest(t, app, submitTopicsReq(beef, mandala.MandalaTopic, own))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["code"] != CodeUnavailable || body["description"] != "applied-transaction lookup failed: mongo down" {
		t.Fatalf("body = %v", body)
	}
	if len(rec.recorded) != 0 {
		t.Fatalf("a failed re-read finalized %+v", rec.recorded)
	}
}

func TestSubmit_ReplayFinalizeFailureIs503(t *testing.T) {
	beef, _ := submitBeef(t, 0x18)
	rec := &stubAdmissionStore{recordErr: errors.New("mongo down")}
	app := newServer(&stubSubmitter{}, nil, nil, nil, WithAdmissionSigner(testSigner(t)),
		WithAdmissionStore(rec, proofOf(map[string][]uint32{testTopicA: {0}})))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["description"] != "admission record write failed: mongo down" {
		t.Fatalf("body = %v", body)
	}
}

func TestSubmit_EvictedTxidIs410Forever(t *testing.T) {
	beef, txid := submitBeef(t, 0x19)
	stub := &stubSubmitter{steak: overlay.Steak{testTopicA: {OutputsToAdmit: []uint32{0}}}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{Txid: txid, EvictedAt: "2026-10-05T00:00:00.000Z"}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proofOf(map[string][]uint32{testTopicA: {0}})))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("status = %d, want 410", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["code"] != CodeEvicted || body["retryable"] != false ||
		body["description"] != "transaction "+txid+" was admitted and later evicted; its inputs are spendable again" {
		t.Fatalf("body = %v", body)
	}
	if stub.gotCtx != nil {
		t.Fatal("an evicted txid must not reach Submit")
	}
}

func TestSubmit_PersistedRefusalReplaysForTheSamePayloadOnly(t *testing.T) {
	beef, txid := submitBeef(t, 0x1a)
	const reason = "output 0: token output with no verified linkage"
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: txid, RefusedCode: CodeLinkage, RefusedDescription: reason, RefusedPayloadHash: emptyPayloadHash(), RefusedTopic: testTopicA,
	}}
	stub := &stubSubmitter{steak: overlay.Steak{testTopicA: {OutputsToAdmit: []uint32{0}}}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proofOf(nil)))

	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("same payload: status = %d, want 400", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["code"] != CodeLinkage || body["description"] != reason || body["retryable"] != false {
		t.Fatalf("same payload: body = %v", body)
	}
	if stub.gotCtx != nil {
		t.Fatal("the persisted refusal must answer without Submit")
	}

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(framedSubmitBody(beef, []byte(`{"outputs":[]}`))))
	req.Header.Set("X-Topics", `["`+testTopicA+`"]`)
	req.Header.Set("x-includes-off-chain-values", "true")
	if resp := doRequest(t, app, req); resp.StatusCode != http.StatusOK || stub.gotCtx == nil {
		t.Fatalf("different payload: status %d, reached Submit %v; want a fresh evaluation", resp.StatusCode, stub.gotCtx != nil)
	}
}

func TestSubmit_RecordAndProofFaultsAre503(t *testing.T) {
	beef, _ := submitBeef(t, 0x1b)
	stub := &stubSubmitter{}
	app := newServer(stub, nil, nil, nil, WithAdmissionStore(&stubAdmissionStore{getErr: errors.New("mongo down")}, nil))
	resp := doRequest(t, app, submitBeefReq(beef))
	if body := decodeJSON(t, resp); resp.StatusCode != 503 || body["description"] != "admission record lookup failed: mongo down" {
		t.Fatalf("record fault: %d %v", resp.StatusCode, body)
	}
	failing := func(context.Context, string) (map[string][]uint32, error) {
		return nil, errors.New("engine store down")
	}
	app = newServer(stub, nil, nil, nil, WithAdmissionStore(&stubAdmissionStore{}, failing))
	resp = doRequest(t, app, submitBeefReq(beef))
	if body := decodeJSON(t, resp); resp.StatusCode != 503 || body["description"] != "applied-transaction lookup failed: engine store down" {
		t.Fatalf("proof fault: %d %v", resp.StatusCode, body)
	}
	if stub.gotCtx != nil {
		t.Fatal("a read fault must stop before Submit")
	}
}

// G6/A1.3: an unhosted topic is answered before any admission-record read or write, and nothing reaches the engine.
func TestSubmit_UnknownTopicPreCheckTouchesNothing(t *testing.T) {
	beef, _ := submitBeef(t, 0x1c)
	stub := &stubSubmitter{hasTopic: func(name string) bool { return name != testTopicB }}
	comp := &stubCompensation{}
	rec := &stubAdmissionStore{}
	proofCalls := 0
	proof := func(context.Context, string) (map[string][]uint32, error) {
		proofCalls++
		return map[string][]uint32{}, nil
	}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proof), WithBroadcastCompensation(comp.prepare))

	resp := doRequest(t, app, submitTopicsReq(beef, testTopicA, testTopicB))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["code"] != CodeShape || body["retryable"] != false || body["description"] != "unknown-topic: "+testTopicB {
		t.Fatalf("body = %v", body)
	}
	if stub.gotCtx != nil || comp.prepareCalls != 0 || rec.getCalls != 0 || proofCalls != 0 || len(rec.provisional) != 0 || rec.refusalCalls != 0 {
		t.Fatalf("the pre-check must touch nothing: submit=%v prepare=%d get=%d proof=%d provisional=%d refusals=%d",
			stub.gotCtx != nil, comp.prepareCalls, rec.getCalls, proofCalls, len(rec.provisional), rec.refusalCalls)
	}
}

// G17: duplicate X-Topics are submitted once, first positions kept.
func TestSubmit_DuplicateTopicsAreSubmittedOnce(t *testing.T) {
	beef, _ := submitBeef(t, 0x1d)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(beef))
	req.Header.Set("X-Topics", `["`+testTopicA+`","`+testTopicA+`","`+mandala.KYCTopic+`","`+testTopicA+`"]`)

	if resp := doRequest(t, app, req); resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	want := []string{testTopicA, mandala.KYCTopic}
	if !reflect.DeepEqual(stub.gotTB.Topics, want) {
		t.Fatalf("submitted topics = %v, want %v", stub.gotTB.Topics, want)
	}
	if len(rec.provisional) != 1 || !reflect.DeepEqual(rec.provisional[0].Topics, want) {
		t.Fatalf("provisional topics = %+v, want %v", rec.provisional, want)
	}
}

// TT §9 / A1.3: the engine's unknown-topic (a race with the pre-check) is 400 ERR_SHAPE and never persisted.
func TestSubmit_EngineUnknownTopicIs400AndNeverPersisted(t *testing.T) {
	beef, _ := submitBeef(t, 0x1e)
	rec := &stubAdmissionStore{}
	app := newServer(&stubSubmitter{err: engine.ErrUnknownTopic}, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))
	resp := doRequest(t, app, submitBeefReq(beef))
	body := decodeJSON(t, resp)
	if resp.StatusCode != 400 || body["code"] != CodeShape || body["description"] != "unknown-topic" || body["retryable"] != false {
		t.Fatalf("%d %v", resp.StatusCode, body)
	}
	if rec.refusalCalls != 0 {
		t.Fatal("unknown-topic must never be persisted")
	}
}

func TestSubmit_ConflictingSpendIs400WithSpendTxidAndIsNeverPersisted(t *testing.T) {
	beef, _ := submitBeef(t, 0x1f)
	competitor := strings.Repeat("c", 64)
	reason := "input " + vectorTxid + ".0: already spent by " + competitor
	rec := &stubAdmissionStore{}
	stub := &stubSubmitter{err: &mandala.RejectError{Code: mandala.CodeInputSpent, Reason: reason, Topic: testTopicA, SpendTxid: competitor}}
	app := newServer(stub, nil, nil, nil, WithAdmissionStore(rec, nil))
	resp := doRequest(t, app, submitBeefReq(beef))
	body := decodeJSON(t, resp)
	if resp.StatusCode != 400 || body["code"] != CodeInputSpent || body["retryable"] != false || body["spendTxid"] != competitor || body["description"] != reason {
		t.Fatalf("%d %v", resp.StatusCode, body)
	}
	if rec.refusalCalls != 0 {
		t.Fatal("ERR_INPUT_SPENT is live state and must never be persisted")
	}
}

func TestSubmit_NoStoreNoSignerStillAdmits(t *testing.T) {
	beef, _ := submitBeef(t, 0x20)
	app := newServer(&stubSubmitter{steak: overlay.Steak{testTopicA: {OutputsToAdmit: []uint32{0}}}}, nil, nil, nil)
	resp := doRequest(t, app, submitBeefReq(beef))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	requireNoSigma(t, entryOf(t, decodeJSON(t, resp), testTopicA))
}

// --- GET /admin/admission/:txid -------------------------------------------------------------------------------

func admissionReq(txid, token string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/admin/admission/"+txid, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func TestAdmissionEndpoint_ReturnsThePerTopicMap(t *testing.T) {
	signer := testSigner(t)
	sigM, ident, err := signer.SignAdmission(mandala.MandalaTopic, vectorTxid, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	sigA, _, err := signer.SignAdmission(testTopicA, vectorTxid, []uint32{0, 2})
	if err != nil {
		t.Fatal(err)
	}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: vectorTxid, Topics: []string{mandala.MandalaTopic, testTopicA},
		Admissions: map[string]mandala.TopicAdmission{
			mandala.MandalaTopic: {OutputsToAdmit: []uint32{0}, AdmissionSignature: sigM},
			testTopicA:           {OutputsToAdmit: []uint32{0, 2}, AdmissionSignature: sigA},
		},
		AdmissionIdentityKey: ident, At: "2026-10-05T01:02:03.000Z",
	}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithAdmissionSigner(signer), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var got map[string]any
	if err := json.Unmarshal(readRawBody(t, resp), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"txid": vectorTxid, "admissionIdentityKey": ident, "at": "2026-10-05T01:02:03.000Z",
		"admissions": map[string]any{
			mandala.MandalaTopic: map[string]any{"outputsToAdmit": []any{0.0}, "admissionSignature": sigM},
			testTopicA:           map[string]any{"outputsToAdmit": []any{0.0, 2.0}, "admissionSignature": sigA},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("body = %v\nwant   %v", got, want)
	}
}

func TestAdmissionEndpoint_ReSignsFromTheAppliedProof(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithAdmissionSigner(testSigner(t)),
		WithAdmissionStore(&stubAdmissionStore{}, proofOf(map[string][]uint32{testTopicA: {2, 0}, mandala.KYCTopic: {0}, mandala.MandalaTopic: {}})))

	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	adm, _ := body["admissions"].(map[string]any)
	if len(adm) != 1 {
		t.Fatalf("admissions = %v, want only tm_<A> (KYC is never signed; an empty set is not a σI)", adm)
	}
	a := adm[testTopicA].(map[string]any)
	a["admissionIdentityKey"] = body["admissionIdentityKey"]
	if got := outputsOf(t, a); !reflect.DeepEqual(got, []uint32{0, 2}) {
		t.Fatalf("outputs = %v, want [0 2] (canonical)", got)
	}
	requireSigma(t, a, testIdentityKey(t), testTopicA, vectorTxid, []uint32{0, 2}, mandala.MandalaTopic)
	if at, _ := body["at"].(string); at == "" {
		t.Fatal("a re-derived admission still carries an at stamp")
	}
}

func TestAdmissionEndpoint_410ForAnEvictedTxid(t *testing.T) {
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{Txid: vectorTxid, EvictedAt: "2026-10-05T00:00:00.000Z"}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithAdmissionStore(rec, proofOf(map[string][]uint32{testTopicA: {0}})))
	resp := doRequest(t, app, admissionReq(vectorTxid, ""))
	if body := decodeJSON(t, resp); resp.StatusCode != http.StatusGone || body["code"] != CodeEvicted {
		t.Fatalf("%d %v", resp.StatusCode, body)
	}
}

func TestAdmissionEndpoint_RefusalIsGatedOnThePayloadHash(t *testing.T) {
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: vectorTxid, RefusedCode: CodeConservation, RefusedDescription: "token x_0: value in 1 != value out 2 without an authority",
		RefusedPayloadHash: emptyPayloadHash(), RefusedTopic: testTopicA,
	}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithAdmissionStore(rec, proofOf(nil)))

	resp := doRequest(t, app, admissionReq(vectorTxid+"?payloadHash="+strings.ToUpper(emptyPayloadHash()), ""))
	if body := decodeJSON(t, resp); resp.StatusCode != 400 || body["code"] != CodeConservation {
		t.Fatalf("matching hash: %d %v", resp.StatusCode, body)
	}
	resp = doRequest(t, app, admissionReq(vectorTxid, ""))
	if body := decodeJSON(t, resp); resp.StatusCode != 404 || body["message"] != "no admission on record for "+vectorTxid {
		t.Fatalf("no hash: %d %v", resp.StatusCode, body)
	}
}

func TestAdmissionEndpoint_MalformedTxidIs400ErrShape(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithAdmissionStore(&stubAdmissionStore{}, nil))
	resp := doRequest(t, app, admissionReq("abc", ""))
	body := decodeJSON(t, resp)
	if resp.StatusCode != 400 || body["code"] != CodeShape || body["description"] != "invalid txid: expected 64 hex characters, got 3" {
		t.Fatalf("%d %v", resp.StatusCode, body)
	}
}

func TestAdmissionEndpoint_TxidIsLowercased(t *testing.T) {
	rec := &stubAdmissionStore{}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithAdmissionStore(rec, nil))
	resp := doRequest(t, app, admissionReq(strings.ToUpper(vectorTxid), ""))
	if body := decodeJSON(t, resp); resp.StatusCode != 404 || body["message"] != "no admission on record for "+vectorTxid {
		t.Fatalf("%d %v", resp.StatusCode, body)
	}
	if rec.getCalls != 1 {
		t.Fatalf("record reads = %d, want 1", rec.getCalls)
	}
}

func TestAdmissionEndpoint_EmptyAdmittedSetIs404NotA200(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithAdmissionSigner(testSigner(t)),
		WithAdmissionStore(&stubAdmissionStore{}, proofOf(map[string][]uint32{testTopicA: {}})))
	if resp := doRequest(t, app, admissionReq(vectorTxid, "")); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestAdmissionEndpoint_IsBearerGated(t *testing.T) {
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: vectorTxid, Admissions: map[string]mandala.TopicAdmission{testTopicA: {OutputsToAdmit: []uint32{0}, AdmissionSignature: "3044"}},
		AdmissionIdentityKey: "02aa", At: "2026-01-01T00:00:00.000Z",
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
					t.Fatalf("body = %v", body)
				}
			}
		})
	}
}

func TestAdmissionEndpoint_UsesNarrowedCORS(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithAdmissionStore(&stubAdmissionStore{}, nil), WithAdminCORSOrigins([]string{"https://console.example"}))
	req := admissionReq(vectorTxid, "")
	req.Header.Set(fiber.HeaderOrigin, "https://evil.example")
	resp := doRequest(t, app, req)
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want it withheld from a non-console origin", got)
	}
}
