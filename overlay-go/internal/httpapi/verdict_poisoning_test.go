package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// Wire contract §9.1 — payload-scoped final verdicts.
//
// The txid does NOT commit to the off-chain linkage payload. Before this rule,
// a persisted refusal was keyed by txid alone, so anyone holding the BEEF
// could submit it stripped of its payload, earn a permanent ERR_LINKAGE, and
// leave the legitimate holder's correct submission answered from the record
// without ever reaching the engine. The transaction was dead for everyone,
// forever, at the cost of one unauthenticated request.

// payloadAwareSubmitter mirrors the one thing about the real tm_mandala
// manager that matters here: the verdict is a function of the OFF-CHAIN
// payload threaded onto ctx (topic_manager.go's guard 1 rejects a token output
// with no linkage entry), not of the BEEF bytes.
type payloadAwareSubmitter struct {
	calls int
}

func (p *payloadAwareSubmitter) Submit(ctx context.Context, _ overlay.TaggedBEEF, _ engine.SumbitMode, _ engine.OnSteakReady) (overlay.Steak, error) {
	p.calls++
	pl := mandala.PayloadFromContext(ctx)
	if pl == nil || len(pl.Outputs) == 0 {
		return overlay.Steak{}, &mandala.RejectError{
			Topic: tokenTopic,
			Err:   errors.New("output 0: MandalaToken-decodable output with no verified linkage"),
		}
	}
	return overlay.Steak{tokenTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}}}, nil
}

// memRecorder is a faithful in-memory AdmissionRecorder with the store's real
// semantics: refusals are scoped to a payload hash and overwritten by a later
// one, an admission clears them, and a provisional row never clobbers an
// admission.
type memRecorder struct {
	rows map[string]*mandala.AdmissionRecord
}

func newMemRecorder() *memRecorder {
	return &memRecorder{rows: map[string]*mandala.AdmissionRecord{}}
}

func (m *memRecorder) GetAdmission(_ context.Context, txid string) (*mandala.AdmissionRecord, error) {
	return m.rows[txid], nil
}

func (m *memRecorder) RecordAdmission(_ context.Context, rec mandala.AdmissionRecord) error {
	cur := m.rows[rec.Txid]
	if rec.Pending {
		if cur != nil && cur.AdmissionSignature != "" {
			return nil
		}
		row := rec
		m.rows[rec.Txid] = &row
		return nil
	}
	row := rec
	row.Pending = false
	if cur != nil && cur.Restore != nil && row.Restore == nil {
		row.Restore = cur.Restore
	}
	m.rows[rec.Txid] = &row
	return nil
}

func (m *memRecorder) MarkRefused(_ context.Context, r mandala.Refusal) error {
	cur := m.rows[r.Txid]
	if cur != nil && (cur.AdmissionSignature != "" || cur.EvictedAt != "") {
		return nil
	}
	row := mandala.AdmissionRecord{Txid: r.Txid}
	if cur != nil {
		row = *cur
	}
	row.RefusedCode = r.Code
	row.RefusedDescription = r.Description
	row.RefusedSpendTxid = r.SpendTxid
	row.RefusedPayloadHash = r.PayloadHash
	m.rows[r.Txid] = &row
	return nil
}

var _ AdmissionRecorder = (*memRecorder)(nil)

// framedSubmitBody builds the wire framing /submit expects when
// x-includes-off-chain-values is set: varint(len(beef)) || beef || offChain.
func framedSubmitBody(beef, offChain []byte) []byte {
	var b bytes.Buffer
	b.Write(varintBytes(uint64(len(beef))))
	b.Write(beef)
	b.Write(offChain)
	return b.Bytes()
}

func TestSubmit_StrippedPayloadCannotPoisonTheTxid(t *testing.T) {
	beef, txid := submitBeef(t, 0x42)
	sub := &payloadAwareSubmitter{}
	rec := newMemRecorder()
	app := newServer(sub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	// (1) The attacker submits the same BEEF with no off-chain values at all.
	attack := doRequest(t, app, submitBeefReq(beef))
	if attack.StatusCode != http.StatusBadRequest {
		t.Fatalf("attacker submit status = %d, want 400", attack.StatusCode)
	}
	if body := decodeJSON(t, attack); body["code"] != CodeLinkage {
		t.Fatalf("attacker submit body = %v, want ERR_LINKAGE", body)
	}
	row := rec.rows[txid]
	if row == nil || row.RefusedCode != CodeLinkage {
		t.Fatalf("expected the refusal to be persisted, got %+v", row)
	}
	if row.RefusedPayloadHash != mandala.PayloadHashHex(nil) {
		t.Fatalf("refusal payloadHash = %q, want the empty-payload hash", row.RefusedPayloadHash)
	}

	// (2) The legitimate holder submits the identical BEEF with the correct
	// linkage payload. It must reach the engine and be admitted with σ_I.
	payload, err := json.Marshal(mandala.LinkagePayload{
		Outputs: []mandala.IndexedLinkage{{Index: 0, Linkage: &mandala.SpecificLinkage{}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	callsBefore := sub.calls
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(framedSubmitBody(beef, payload)))
	req.Header.Set("X-Topics", `["tm_mandala"]`)
	req.Header.Set("x-includes-off-chain-values", "true")
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("honest submit status = %d, want 200 (body %s)", resp.StatusCode, readRawBody(t, resp))
	}
	if sub.calls == callsBefore {
		t.Fatal("the honest submit was answered from the poisoned record without reaching the engine")
	}
	body := decodeJSON(t, resp)
	tm, _ := body[tokenTopic].(map[string]any)
	if tm == nil || tm["admissionSignature"] == "" {
		t.Fatalf("honest submit did not earn σ_I: %v", body)
	}
	want, _, err := testSigner(t).SignAdmission(txid, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	if tm["admissionSignature"] != want {
		t.Fatalf("admissionSignature = %v, want %s", tm["admissionSignature"], want)
	}

	// (3) The admission cleared the refusal, so even the attacker's stripped
	// payload now reads as admitted rather than replaying the old 400.
	after := rec.rows[txid]
	if after.RefusedCode != "" || after.RefusedPayloadHash != "" {
		t.Fatalf("the admission did not clear the refusal: %+v", after)
	}
	replay := doRequest(t, app, submitBeefReq(beef))
	if replay.StatusCode != http.StatusOK {
		t.Fatalf("post-admission replay status = %d, want 200", replay.StatusCode)
	}
}

// Finding 8 / §9.6 — every state serveKnownVerdict answers from belongs to
// tm_mandala. A registry-only submit of an already-admitted txid must reach
// the registry manager instead of being short-circuited by the token topic's
// record.
func TestSubmit_RegistryOnlySubmitOfAnAdmittedTxidStillReachesTheEngine(t *testing.T) {
	beef, txid := submitBeef(t, 0x43)
	stub := &stubSubmitter{steak: overlay.Steak{
		mandala.RegistryTopic: &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}},
	}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid:                 txid,
		Topics:               []string{tokenTopic},
		OutputsToAdmit:       []uint32{0},
		AdmissionSignature:   "3044stored",
		AdmissionIdentityKey: "02stored",
		At:                   "2026-01-01T00:00:00.000Z",
	}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(beef))
	req.Header.Set("X-Topics", `["`+mandala.RegistryTopic+`"]`)
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", resp.StatusCode, readRawBody(t, resp))
	}
	if stub.gotCtx == nil {
		t.Fatal("a registry-only submit was answered from the tm_mandala admission record")
	}
	body := decodeJSON(t, resp)
	if _, has := body[mandala.RegistryTopic]; !has {
		t.Fatalf("body = %v, want the registry topic's own STEAK entry", body)
	}
	if _, has := body[tokenTopic]; has {
		t.Fatalf("body = %v, want no tm_mandala entry for a registry-only submit", body)
	}
	// And it must not have written a token admission record either.
	if len(rec.recorded) != 0 || len(rec.provisional) != 0 {
		t.Fatalf("a registry-only submit touched the token admission record: %+v %+v", rec.recorded, rec.provisional)
	}
}

// An evicted txid resubmitted to tm_mandala is still 410 — the short-circuit
// is narrowed to the token topic, not removed.
func TestSubmit_TokenSubmitOfAnEvictedTxidIsStill410(t *testing.T) {
	beef, txid := submitBeef(t, 0x44)
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: txid, EvictedAt: "2026-02-03T04:05:06.000Z",
	}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(beef))
	req.Header.Set("X-Topics", `["`+mandala.RegistryTopic+`","tm_mandala"]`)
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("status = %d, want 410", resp.StatusCode)
	}
	if stub.gotCtx != nil {
		t.Fatal("an evicted txid must not be resubmitted to the engine")
	}
}
