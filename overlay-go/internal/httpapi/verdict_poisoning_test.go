package httpapi

// A1.3: what is persisted, keyed by (txid, payloadHash) and the refusing topic, and why a holder of the bytes cannot
// poison a transaction by submitting it stripped of its envelope.

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

// payloadAwareSubmitter stands in for a token manager: the bytes without an envelope are refused (typed, final, on
// its topic); with one they admit output 0.
type payloadAwareSubmitter struct {
	topic string
	calls int
}

func (p *payloadAwareSubmitter) HasTopicManager(string) bool { return true }

func (p *payloadAwareSubmitter) Submit(_ context.Context, tb overlay.TaggedBEEF, _ engine.SumbitMode, _ engine.OnSteakReady) (overlay.Steak, error) {
	p.calls++
	if len(tb.OffChainValues) == 0 {
		return nil, &mandala.RejectError{Code: mandala.CodeLinkage, Reason: "output 0: token output with no verified linkage", Topic: p.topic}
	}
	return overlay.Steak{p.topic: {OutputsToAdmit: []uint32{0}, CoinsToRetain: []uint32{}}}, nil
}

func framedSubmitBody(beef, offChain []byte) []byte {
	var b bytes.Buffer
	b.Write(varintBytes(uint64(len(beef))))
	b.Write(beef)
	b.Write(offChain)
	return b.Bytes()
}

func framedTopicsReq(beef, offChain []byte, topic string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(framedSubmitBody(beef, offChain)))
	req.Header.Set("X-Topics", `["`+topic+`"]`)
	req.Header.Set("x-includes-off-chain-values", "true")
	return req
}

// On the real v3 store: the refusal of the stripped bytes binds to the empty payload only; the genuine payload
// admits, clears it, and from then on the stripped bytes replay the admission (D-8) instead of being refused.
func TestSubmit_StrippedPayloadCannotPoisonTheTxid(t *testing.T) {
	store, err := mandala.NewStore(testmongo.DB(t, "mandala3_test_httpapi_poisoning"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	beef, txid := submitBeef(t, 0x31)
	sub := &payloadAwareSubmitter{topic: testTopicA}
	applied := map[string][]uint32{}
	proof := func(context.Context, string) (map[string][]uint32, error) {
		out := map[string][]uint32{}
		for k, v := range applied {
			out[k] = v
		}
		return out, nil
	}
	app := newServer(sub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(store, proof))
	envelope := []byte(`{"inputs":[],"outputs":[],"admin":[]}`)

	if resp := doRequest(t, app, submitBeefReq(beef)); resp.StatusCode != 400 {
		t.Fatalf("stripped: status %d, want 400", resp.StatusCode)
	}
	rec, err := store.GetAdmission(ctx, txid)
	if err != nil || rec == nil || rec.RefusedCode != CodeLinkage || rec.RefusedPayloadHash != emptyPayloadHash() || rec.RefusedTopic != testTopicA {
		t.Fatalf("stripped refusal record = %+v (%v), want ERR_LINKAGE for the empty payload on tm_<A>", rec, err)
	}

	if resp := doRequest(t, app, submitBeefReq(beef)); resp.StatusCode != 400 || sub.calls != 1 {
		t.Fatalf("stripped again: status %d, engine calls %d; want 400 from the record", resp.StatusCode, sub.calls)
	}

	resp := doRequest(t, app, framedTopicsReq(beef, envelope, testTopicA))
	if resp.StatusCode != http.StatusOK || sub.calls != 2 {
		t.Fatalf("genuine payload: status %d, engine calls %d (%s)", resp.StatusCode, sub.calls, readRawBody(t, resp))
	}
	rec, err = store.GetAdmission(ctx, txid)
	if err != nil || rec == nil || !rec.Admitted() || rec.RefusedCode != "" || len(rec.Admissions[testTopicA].OutputsToAdmit) != 1 {
		t.Fatalf("after the genuine payload: %+v (%v), want an admitted record with the refusal cleared", rec, err)
	}

	applied[testTopicA] = []uint32{0} // the engine now holds tm_<A>'s applied record
	if resp := doRequest(t, app, submitBeefReq(beef)); resp.StatusCode != http.StatusOK || sub.calls != 2 {
		t.Fatalf("stripped after admission: status %d, engine calls %d; want a 200 replay", resp.StatusCode, sub.calls)
	}
}

// The A1.3 matrix: only typed, final refusals by tm_mandala or a tm_<id> are persisted, with the refusing topic.
func TestSubmit_PersistenceFollowsA13(t *testing.T) {
	beef, txid := submitBeef(t, 0x32)
	own := "tm_" + txid
	reject := func(code mandala.Code, reason, topic string) *mandala.RejectError {
		return &mandala.RejectError{Code: code, Reason: reason, Topic: topic}
	}
	cases := []struct {
		name      string
		topics    []string
		err       error
		status    int
		code      string
		persisted *mandala.RejectError
	}{
		{"conservation on a token topic", []string{testTopicA}, reject(mandala.CodeConservation, "token x_0: value in 1 != value out 2 without an authority", testTopicA), 400, CodeConservation,
			reject(mandala.CodeConservation, "token x_0: value in 1 != value out 2 without an authority", testTopicA)},
		{"malformed envelope on a token topic", []string{testTopicA}, reject(mandala.CodeShape, "Mandala payload must be an object", testTopicA), 400, CodeShape,
			reject(mandala.CodeShape, "Mandala payload must be an object", testTopicA)},
		{"authority on the registry", []string{mandala.MandalaTopic, own}, reject(mandala.CodeAuthority, "output 0: deploy requires a valid deploySig over this txid", mandala.MandalaTopic), 400, CodeAuthority,
			reject(mandala.CodeAuthority, "output 0: deploy requires a valid deploySig over this txid", mandala.MandalaTopic)},
		{"shape on KYC", []string{mandala.KYCTopic}, reject(mandala.CodeShape, "tm_mandala_registry: registration chain already exists; register is genesis-only", mandala.KYCTopic), 400, CodeShape, nil},
		{"untrusted", []string{testTopicA}, reject(mandala.CodeUntrusted, "output 0: owner 02aa is not a trusted issuer", testTopicA), 409, CodeUntrusted, nil},
		{"paused", []string{testTopicA}, reject(mandala.CodePaused, "token x_0 is paused", testTopicA), 409, CodePaused, nil},
		{"input spent", []string{testTopicA}, &mandala.RejectError{Code: mandala.CodeInputSpent, Reason: "input y.0: already spent by z", Topic: testTopicA, SpendTxid: "z"}, 400, CodeInputSpent, nil},
		{"typed unavailable", []string{testTopicA}, reject(mandala.CodeUnavailable, "owner index unavailable for y.0", testTopicA), 503, CodeUnavailable, nil},
		{"untyped manager fault", []string{testTopicA}, &mandala.RejectError{Reason: "txid not in BEEF", Topic: testTopicA}, 400, CodeShape, nil},
		{"engine unknown topic", []string{testTopicA}, engine.ErrUnknownTopic, 400, CodeShape, nil},
		{"dependency fault", []string{testTopicA}, errors.New("mongo down"), 503, CodeUnavailable, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := &stubAdmissionStore{}
			app := newServer(&stubSubmitter{err: tc.err}, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))
			resp := doRequest(t, app, submitTopicsReq(beef, tc.topics...))
			body := decodeJSON(t, resp)
			if resp.StatusCode != tc.status || body["code"] != tc.code {
				t.Fatalf("answer %d %v, want %d %s", resp.StatusCode, body, tc.status, tc.code)
			}
			if tc.persisted == nil {
				if rec.refusalCalls != 0 {
					t.Fatalf("persisted %+v, want nothing", rec.refusals)
				}
				return
			}
			want := mandala.Refusal{Txid: txid, Code: string(tc.persisted.Code), Description: tc.persisted.Reason, PayloadHash: emptyPayloadHash(), Topic: tc.persisted.Topic}
			if len(rec.refusals) != 1 || rec.refusals[0] != want {
				t.Fatalf("persisted %+v, want exactly %+v", rec.refusals, want)
			}
		})
	}
}
