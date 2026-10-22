package httpapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// stubLookuper is a Lookuper test double: it records what it was called
// with and returns canned results, so tests never need a real engine,
// lookup service, or Mongo.
type stubLookuper struct {
	answer *lookup.LookupAnswer
	err    error

	gotCtx     context.Context
	gotService string
	gotQuery   json.RawMessage
}

func (s *stubLookuper) Lookup(ctx context.Context, q *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	s.gotCtx = ctx
	s.gotService = q.Service
	s.gotQuery = q.Query
	return s.answer, s.err
}

func lookupRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/lookup", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestLookup_InvalidBody(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"missing service", `{"query":{"metadataAssetId":"abc.0"}}`},
		{"missing query", `{"service":"ls_mandala"}`},
		{"non-JSON", `not-json-at-all`},
		{"service wrong type", `{"service":123,"query":{"metadataAssetId":"abc.0"}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil)

			resp := doRequest(t, app, lookupRequest(tc.body))
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body: %s)", resp.StatusCode, readRawBody(t, resp))
			}
			body := decodeJSON(t, resp)
			if body["status"] != "error" {
				t.Fatalf("body = %v, want status:error", body)
			}
			if _, ok := body["message"]; !ok {
				t.Fatalf("body = %v, missing message field", body)
			}
		})
	}
}

func TestLookup_OutputListAnswer(t *testing.T) {
	stub := &stubLookuper{
		answer: &lookup.LookupAnswer{
			Type: lookup.AnswerTypeOutputList,
			Outputs: []*lookup.OutputListItem{
				{Beef: atomicFixture, OutputIndex: 7},
			},
		},
	}
	app := newServer(&stubSubmitter{}, stub, nil, nil)

	resp := doRequest(t, app, lookupRequest(`{"service":"ls_mandala","query":{"metadataAssetId":"abc.0"}}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}

	raw := readRawBody(t, resp)
	if !strings.Contains(string(raw), atomicFixtureJSON) {
		t.Fatalf("body = %s, want to contain the AtomicBEEF bytes", raw)
	}
	if !strings.Contains(string(raw), `"type":"output-list"`) {
		t.Fatalf("body = %s, want to contain \"type\":\"output-list\"", raw)
	}

	var decoded struct {
		Type    string `json:"type"`
		Outputs []struct {
			Beef        []int `json:"beef"`
			OutputIndex int   `json:"outputIndex"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if len(decoded.Outputs) != 1 {
		t.Fatalf("outputs = %v, want 1 item", decoded.Outputs)
	}
	if decoded.Outputs[0].OutputIndex != 7 {
		t.Fatalf("outputIndex = %d, want 7", decoded.Outputs[0].OutputIndex)
	}
}

func TestLookup_AggregationHeaderIgnored(t *testing.T) {
	stub := &stubLookuper{
		answer: &lookup.LookupAnswer{
			Type: lookup.AnswerTypeOutputList,
			Outputs: []*lookup.OutputListItem{
				{Beef: atomicFixture, OutputIndex: 7},
			},
		},
	}
	app := newServer(&stubSubmitter{}, stub, nil, nil)

	req := lookupRequest(`{"service":"ls_mandala","query":{"metadataAssetId":"abc.0"}}`)
	req.Header.Set("X-Aggregation", "yes")
	resp := doRequest(t, app, req)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json (X-Aggregation must be ignored)", ct)
	}

	raw := readRawBody(t, resp)
	if !strings.Contains(string(raw), atomicFixtureJSON) {
		t.Fatalf("body = %s, want to contain the AtomicBEEF bytes even with X-Aggregation set", raw)
	}
}

func TestLookup_ForwardsServiceAndRawQuery(t *testing.T) {
	stub := &stubLookuper{
		answer: &lookup.LookupAnswer{Type: lookup.AnswerTypeOutputList},
	}
	app := newServer(&stubSubmitter{}, stub, nil, nil)

	const query = `{"metadataAssetId":"deadbeef.3","extra":[1,2,3]}`
	body := `{"service":"ls_mandala","query":` + query + `}`
	resp := doRequest(t, app, lookupRequest(body))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}

	if stub.gotService != "ls_mandala" {
		t.Fatalf("gotService = %q, want ls_mandala", stub.gotService)
	}
	if string(stub.gotQuery) != query {
		t.Fatalf("gotQuery = %s, want verbatim %s", stub.gotQuery, query)
	}
	if stub.gotCtx == nil {
		t.Fatalf("gotCtx = nil, want a context")
	}
}

// An untyped lookup error is a fault, never a final refusal: 503 ERR_UNAVAILABLE retryable (contract §6).
func TestLookup_EngineError(t *testing.T) {
	stub := &stubLookuper{err: errors.New("boom")}
	app := newServer(&stubSubmitter{}, stub, nil, nil)

	resp := doRequest(t, app, lookupRequest(`{"service":"ls_mandala","query":{"metadataAssetId":"abc.0"}}`))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" || body["code"] != "ERR_UNAVAILABLE" || body["retryable"] != true ||
		body["message"] != "lookup unavailable: ls_mandala: boom" {
		t.Fatalf("body = %v", body)
	}
}

func TestLookup_EmptyOutputsIsEmptyArrayNotNull(t *testing.T) {
	stub := &stubLookuper{
		answer: &lookup.LookupAnswer{Type: lookup.AnswerTypeOutputList, Outputs: nil},
	}
	app := newServer(&stubSubmitter{}, stub, nil, nil)

	resp := doRequest(t, app, lookupRequest(`{"service":"ls_mandala","query":{"metadataAssetId":"abc.0"}}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}

	raw := readRawBody(t, resp)
	if !strings.Contains(string(raw), `"outputs":[]`) {
		t.Fatalf("body = %s, want \"outputs\":[] (never null)", raw)
	}
}

// atomicFixture is an AtomicBEEF header (01010101 ‖ subject txid in internal byte order) plus one trailing byte;
// atomicFixtureTxid is that subject in display hex (reversed).
var (
	atomicFixture, atomicFixtureTxid, atomicFixtureJSON = func() ([]byte, string, string) {
		b := []byte{1, 1, 1, 1}
		for i := 0; i < 32; i++ {
			b = append(b, byte(i))
		}
		b = append(b, 0xef)
		disp := make([]byte, 32)
		for i := range disp {
			disp[i] = byte(31 - i)
		}
		parts := make([]string, len(b))
		for i, v := range b {
			parts[i] = strconv.Itoa(int(v))
		}
		return b, hex.EncodeToString(disp), `"beef":[` + strings.Join(parts, ",") + `]`
	}()
)

func TestLookupItemCarriesAtomicBeefTxid(t *testing.T) {
	stub := &stubLookuper{answer: &lookup.LookupAnswer{Type: lookup.AnswerTypeOutputList,
		Outputs: []*lookup.OutputListItem{{Beef: atomicFixture, OutputIndex: 7}, {Beef: atomicFixture, OutputIndex: 0}}}}
	app := newServer(&stubSubmitter{}, stub, nil, nil)
	resp := doRequest(t, app, lookupRequest(`{"service":"ls_mandala","query":{}}`))
	raw := readRawBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (%s)", resp.StatusCode, raw)
	}
	var got struct {
		Outputs []struct {
			OutputIndex uint32 `json:"outputIndex"`
			Txid        string `json:"txid"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &got); err != nil || len(got.Outputs) != 2 ||
		got.Outputs[0].Txid != atomicFixtureTxid || got.Outputs[0].OutputIndex != 7 || got.Outputs[1].Txid != atomicFixtureTxid {
		t.Fatalf("outputs = %+v (%v) from %s", got.Outputs, err, raw)
	}
}

// A non-atomic BEEF item cannot name its subject: the answer fails closed with 500, never an item without txid.
func TestLookupNonAtomicBeefIs500(t *testing.T) {
	for name, beef := range map[string][]byte{
		"plain BEEF":       {0x02, 0x00, 0xbe, 0xef, 0x00},
		"short header":     atomicFixture[:35],
		"empty":            {},
		"bad atomic magic": append([]byte{1, 1, 1, 2}, atomicFixture[4:]...),
	} {
		stub := &stubLookuper{answer: &lookup.LookupAnswer{Type: lookup.AnswerTypeOutputList,
			Outputs: []*lookup.OutputListItem{{Beef: atomicFixture, OutputIndex: 1}, {Beef: beef, OutputIndex: 0}}}}
		resp := doRequest(t, newServer(&stubSubmitter{}, stub, nil, nil), lookupRequest(`{"service":"ls_mandala","query":{}}`))
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("%s: status = %d, want 500", name, resp.StatusCode)
		}
		body := decodeJSON(t, resp)
		if body["status"] != "error" || body["message"] != "lookup answer: output is not AtomicBEEF" {
			t.Fatalf("%s: body = %v", name, body)
		}
	}
}

// A lookup store or engine read fault is retryable: 503 ERR_UNAVAILABLE (contract §6); a *LookupQueryError stays 400.
func TestLookupStoreFaultIs503(t *testing.T) {
	stub := &stubLookuper{err: fmt.Errorf("%w: x", mandala.ErrLookupUnavailable)}
	resp := doRequest(t, newServer(&stubSubmitter{}, stub, nil, nil), lookupRequest(`{"service":"ls_mandala","query":{}}`))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" || body["code"] != "ERR_UNAVAILABLE" || body["retryable"] != true ||
		body["description"] != "lookup unavailable: x" || body["message"] != "lookup unavailable: x" {
		t.Fatalf("body = %v", body)
	}
	stub.err = fmt.Errorf("ls_x: %w", mandala.NewLookupQueryError("Invalid lookup query: x"))
	resp = doRequest(t, newServer(&stubSubmitter{}, stub, nil, nil), lookupRequest(`{"service":"ls_mandala","query":{}}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("a query error status = %d, want 400", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["message"] != "ls_x: Invalid lookup query: x" || body["code"] != nil {
		t.Fatalf("query error body = %v", body)
	}
}

// faultStorage is an engine.Storage whose FindOutput always faults; nothing else is called by Engine.Lookup.
type faultStorage struct{ engine.Storage }

var errHydrationDown = errors.New("mongo: server selection timeout")

func (faultStorage) FindOutput(context.Context, *transaction.Outpoint, *string, *bool, bool) (*engine.Output, error) {
	return nil, errHydrationDown
}

// formulaLookup answers one formula, as ls_color_<assetId> answers a color-admission query.
type formulaLookup struct {
	engine.LookupService
	op *transaction.Outpoint
}

func (l formulaLookup) Lookup(context.Context, *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	return &lookup.LookupAnswer{Type: lookup.AnswerTypeFormula, Formulas: []lookup.LookupFormula{{Outpoint: l.op}}}, nil
}

// The real v1.3.7 engine returns a hydration (FindOutput) fault unwrapped: POST /lookup must still answer 503
// ERR_UNAVAILABLE retryable, never a 400 a client takes as final. An unknown service stays 400 unknown-topic.
func TestLookupEngineHydrationFaultIs503(t *testing.T) {
	id := strings.Repeat("ab", 32) + "_0"
	op, err := transaction.OutpointFromString(strings.Repeat("cd", 32) + ".0")
	if err != nil {
		t.Fatal(err)
	}
	eng := engine.NewEngine(&engine.Config{
		Storage:        faultStorage{},
		LookupServices: map[string]engine.LookupService{"ls_color_" + id: formulaLookup{op: op}},
	})
	app := newServer(&stubSubmitter{}, eng, nil, nil)
	query := `{"type":"color-admission","version":1,"assetId":"` + id + `","topic":"tm_color_` + id + `","outpoints":["` + op.String() + `"]}`
	resp := doRequest(t, app, lookupRequest(`{"service":"ls_color_`+id+`","query":`+query+`}`))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" || body["code"] != "ERR_UNAVAILABLE" || body["retryable"] != true ||
		body["message"] != "lookup unavailable: ls_color_"+id+": "+errHydrationDown.Error() {
		t.Fatalf("body = %v", body)
	}
	resp = doRequest(t, app, lookupRequest(`{"service":"ls_nope","query":{}}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown service status = %d, want 400", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["message"] != "unknown-topic" || body["code"] != nil {
		t.Fatalf("unknown service body = %v", body)
	}
}
