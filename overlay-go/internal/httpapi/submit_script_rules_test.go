package httpapi

// POST /submit's script-rules parity with the TS overlay: a version-1 tx
// carrying a SIGHASH_CHRONICLE signature (directly, or in an unproven
// ancestor) is refused 503 ERR_UNAVAILABLE before any state is touched. The
// vectors are the ones overlay/src/chronicleSighashParity.test.ts reads: each
// records what @bsv/sdk does with the same bytes.

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

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalav2"
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

			// The handler-level check refuses exactly where TS refuses, minus
			// the named open corner (the engine admits it; see
			// wiring.CheckChronicleSighashRule).
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
				// No side effect of any kind: not submitted, no snapshot, no
				// provisional or final record, and nothing persisted as a verdict.
				if stub.gotCtx != nil {
					t.Fatal("a refused tx must not reach Engine.Submit")
				}
				if comp.prepareCalls != 0 {
					t.Fatal("a refused tx must not take a pre-spend snapshot")
				}
				if len(rec.provisional) != 0 || len(rec.recorded) != 0 || rec.refusalCalls != 0 {
					t.Fatalf("a refused tx must leave no record: provisional=%d recorded=%d refusals=%d",
						len(rec.provisional), len(rec.recorded), rec.refusalCalls)
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

// A tx this node admitted before the rule existed still resolves from its
// record: the check runs after the known-verdict path, so it can never turn an
// admitted tx's idempotent resubmit into a refusal.
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
	rec := &stubAdmissionStore{record: &mandalav2.AdmissionRecord{
		Txid: txid, Topics: []string{tokenTopic}, OutputsToAdmit: []uint32{0},
		AdmissionSignature: "stale", AdmissionIdentityKey: "02stale", At: "2026-01-01T00:00:00.000Z",
	}}
	app := newServer(stub, nil, nil, nil, WithAdmissionSigner(testSigner(t)), WithAdmissionStore(rec, nil))

	resp := doRequest(t, app, submitBeefReq(raw))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 from the admitted record", resp.StatusCode)
	}
	if stub.gotCtx != nil {
		t.Fatal("a dupe must not reach Engine.Submit")
	}
}

// The production stack end to end: wiring.Build (real engine, real Mongo
// stores, scripts-only chain tracker) behind New(app). A script the TS engine
// refuses answers 503 ERR_UNAVAILABLE here; one it admits gets past the script
// stage and is answered by tm_mandala (a plain P2PKH spend has no token
// output, so 200 with nothing to admit). The named open corner is the one
// vector where Go answers 200 although TS refuses.
func TestSubmit_ChronicleSighashRuleOnTheProductionStack(t *testing.T) {
	testAdminDB(t) // skips when Mongo is unreachable; any Build error after it is a real failure
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, err := wiring.Build(ctx, wiring.Config{
		NodeName:         "mandala_go_chronicle_e2e",
		ServerPrivKeyHex: admissionPrivHex,
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
	})
	if err != nil {
		t.Fatalf("wiring.Build: %v", err)
	}
	t.Cleanup(func() {
		_ = app.Mongo.Drop(context.Background())
		_ = app.Mongo.Client().Disconnect(context.Background())
	})
	srv := New(app)

	for _, v := range loadChronicleVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(v.BeefHex)
			if err != nil {
				t.Fatal(err)
			}
			resp := doRequest(t, srv, submitBeefReq(raw))
			wantRefused := !v.TSVerifies && v.KnownGap == ""
			if wantRefused {
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
