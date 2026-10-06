package httpapi

// POST /submit's script-rules parity with the TS overlay: a version-1 tx carrying a SIGHASH_CHRONICLE signature
// (directly, or in an unproven ancestor) is refused 503 ERR_UNAVAILABLE before any state is touched. The vectors are
// the ones overlay/src/chronicleSighashParity.test.ts reads.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/overlay"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

type chronicleVector struct {
	Name       string `json:"name"`
	TSVerifies bool   `json:"tsVerifies"`
	KnownGap   string `json:"knownGap"`
	BeefHex    string `json:"beefHex"`
}

func loadChronicleVectors(t *testing.T) []chronicleVector {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/chronicle_sighash_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Vectors []chronicleVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	return f.Vectors
}

func TestSubmit_ChronicleSighashRuleMatchesTSVerdicts(t *testing.T) {
	for _, v := range loadChronicleVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(v.BeefHex)
			if err != nil {
				t.Fatal(err)
			}
			stub := &stubSubmitter{steak: overlay.Steak{}}
			comp := &stubCompensation{}
			rec := &stubAdmissionStore{}
			app := newServer(stub, nil, nil, nil,
				WithAdmissionSigner(testSigner(t)),
				WithAdmissionStore(rec, nil),
				WithBroadcastCompensation(comp.prepare))

			resp := doRequest(t, app, submitBeefReq(raw))
			if refused := !v.TSVerifies && v.KnownGap == ""; refused {
				if resp.StatusCode != http.StatusServiceUnavailable {
					t.Fatalf("status = %d, want 503", resp.StatusCode)
				}
				body := decodeJSON(t, resp)
				if body["code"] != CodeUnavailable || body["retryable"] != true {
					t.Fatalf("body = %v, want ERR_UNAVAILABLE retryable", body)
				}
				if d, _ := body["description"].(string); !strings.Contains(d, "SIGHASH_CHRONICLE") {
					t.Fatalf("description = %q", d)
				}
				if stub.gotCtx != nil || comp.prepareCalls != 0 || len(rec.provisional) != 0 || len(rec.recorded) != 0 || rec.refusalCalls != 0 {
					t.Fatalf("a refused tx must leave no trace: submit=%v prepare=%d provisional=%d recorded=%d refusals=%d",
						stub.gotCtx != nil, comp.prepareCalls, len(rec.provisional), len(rec.recorded), rec.refusalCalls)
				}
				return
			}
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			if stub.gotCtx == nil || string(stub.gotTB.Beef) != string(raw) {
				t.Fatal("an accepted tx must reach Engine.Submit with its BEEF")
			}
		})
	}
}

// A tx the engine already applied on every named topic still resolves from state: the script check runs after the
// known-verdict path, so it never turns an admitted tx's idempotent resubmit into a refusal.
func TestSubmit_ChronicleSighashRuleDoesNotOverrideAnAdmittedRecord(t *testing.T) {
	var raw []byte
	for _, v := range loadChronicleVectors(t) {
		if v.Name == "v1_chronicle" {
			b, err := hex.DecodeString(v.BeefHex)
			if err != nil {
				t.Fatal(err)
			}
			raw = b
		}
	}
	if raw == nil {
		t.Fatal("v1_chronicle vector missing")
	}
	txid, err := txidFromBeef(raw)
	if err != nil {
		t.Fatal(err)
	}
	stub := &stubSubmitter{steak: overlay.Steak{}}
	rec := &stubAdmissionStore{record: &mandala.AdmissionRecord{
		Txid: txid, Topics: []string{testTopicA},
		Admissions:           map[string]mandala.TopicAdmission{testTopicA: {OutputsToAdmit: []uint32{0}, AdmissionSignature: "3044stale"}},
		AdmissionIdentityKey: "02stale", At: "2026-01-01T00:00:00.000Z",
	}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, proofOf(map[string][]uint32{testTopicA: {0}})))

	resp := doRequest(t, app, submitBeefReq(raw))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 from the applied record", resp.StatusCode)
	}
	if stub.gotCtx != nil {
		t.Fatal("a dupe must not reach Engine.Submit")
	}
}

// The production stack end to end: wiring.Build (real engine, real Mongo, scripts-only SPV) behind New(app). A script
// TS refuses answers 503 here; one it admits gets past the script stage. The submits name tm_mandala_kyc on purpose:
// these plain P2PKH spends carry no token output, so the KYC manager admits {[], []}, whereas naming tm_mandala alone
// would be refused by Task 23's pairing rule before the script stage. Do not change the topic back.
func TestSubmit_ChronicleSighashRuleOnTheProductionStack(t *testing.T) {
	testmongo.DB(t, "mandala3_test_httpapi_chronicle_lookup_services")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, err := wiring.Build(ctx, wiring.Config{
		NodeName:         "mandala3_test_httpapi_chronicle",
		ServerPrivKeyHex: mandalatest.Overlay.PrivHex(),
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
		IssuerKeys:       []string{mandalatest.Issuer.Identity},
	})
	if err != nil {
		t.Fatalf("wiring.Build: %v", err)
	}
	t.Cleanup(func() {
		app.Close()
		_ = app.Mongo.Client().Disconnect(context.Background())
	})
	srv := New(app)

	for _, v := range loadChronicleVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(v.BeefHex)
			if err != nil {
				t.Fatal(err)
			}
			resp := doRequest(t, srv, submitTopicsReq(raw, mandala.KYCTopic))
			if wantRefused := !v.TSVerifies && v.KnownGap == ""; wantRefused {
				if resp.StatusCode != http.StatusServiceUnavailable {
					t.Fatalf("status = %d, want 503 (TS refuses these bytes)", resp.StatusCode)
				}
				if body := decodeJSON(t, resp); body["code"] != CodeUnavailable || body["retryable"] != true {
					t.Fatalf("body = %v, want ERR_UNAVAILABLE retryable", body)
				}
				return
			}
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200 (TS verifies = %v, knownGap = %q): %s",
					resp.StatusCode, v.TSVerifies, v.KnownGap, readRawBody(t, resp))
			}
		})
	}
}
