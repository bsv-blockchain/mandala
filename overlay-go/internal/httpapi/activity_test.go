package httpapi

// Task 17 route tests for GET /admin/activity (Appendix B §3e): invalid
// `before` -> 400, assetId post-classification filtering, and a full wire
// shape assertion against a real classified entry (real mandala.Store +
// enginestore.Store, real BEEF, real MandalaToken locking script — the only
// thing faked is nothing; this exercises internal/activity.Build end to
// end, not just the route glue).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// findRawTxsFromEngine mirrors wiring.findRawTxs (unexported in that
// package) closely enough for tests: one RawTxHexByTxid call per requested
// txid, missing ones simply absent from the result map.
func findRawTxsFromEngine(es *enginestore.Store) FindRawTxsFunc {
	return func(ctx context.Context, txids []string) (map[string]string, error) {
		out := make(map[string]string, len(txids))
		for _, txid := range txids {
			hexStr, ok, err := es.RawTxHexByTxid(ctx, txid)
			if err != nil {
				return nil, err
			}
			if ok {
				out[txid] = hexStr
			}
		}
		return out, nil
	}
}

// seedIssueTx builds a minimal "issue" transaction (one non-FT dummy input,
// one MandalaToken output locked to an arbitrary 20-byte hash) for assetID,
// stores its BEEF via the enginestore and a linkage row for output 0
// (identityKey = toIdentity) via the mandala store, and returns its txid.
// With no linkage on the input's source outpoint, Build has no FT inputs for
// this tx, so summarizeTx classifies it as an issue to toIdentity — exactly
// the TS "classifies a mint" case, but end to end through real raw-tx
// decoding instead of summarizeTx's unit-test fixture.
func seedIssueTx(t *testing.T, store *mandala.Store, es *enginestore.Store, assetID, toIdentity string, amount int64, createdAt time.Time) string {
	t.Helper()
	ctx := context.Background()

	tx := transaction.NewTransaction()
	srcRaw := make([]byte, 32)
	srcRaw[0] = 0x9a
	srcID, err := chainhash.NewHash(srcRaw)
	if err != nil {
		t.Fatal(err)
	}
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID:       srcID,
		SourceTxOutIndex: 0,
		UnlockingScript:  &script.Script{},
	})
	lock, err := mandala.LockToken(assetID, amount, make([]byte, 20))
	if err != nil {
		t.Fatal(err)
	}
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: lock})
	txid := tx.TxID()

	beef := transaction.NewBeefV2()
	if _, err := beef.MergeTransaction(tx); err != nil {
		t.Fatal(err)
	}
	if err := es.InsertOutputs(ctx, "tm_mandala", txid, []uint32{0}, nil, beef, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.StoreLinkage(ctx, mandala.LinkageRow{
		Txid:        txid.String(),
		OutputIndex: 0,
		IdentityKey: toIdentity,
		Linkage: mandala.SpecificLinkage{
			Prover:       toIdentity,
			Verifier:     "verifier-id",
			Counterparty: toIdentity,
			KeyID:        "key-1",
			ProofType:    1,
		},
		CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	return txid.String()
}

func TestActivity_InvalidBeforeIs400(t *testing.T) {
	db := testAdminDB(t)
	store := mustMandalaStore(t, db)
	es := mustEngineStore(t, db)
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithActivity(store, findRawTxsFromEngine(es)))

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity?before=not-a-timestamp", nil))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if _, ok := body["error"]; !ok {
		t.Fatalf("body = %v, want an \"error\" field (admin family, not status/message)", body)
	}
}

func TestActivity_RouteNotMountedWithoutOption(t *testing.T) {
	// Every other httpapi test calls newServer without WithActivity; assert
	// that leaves /admin/activity answering the shared 404, not panicking.
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil)
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity", nil))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 when WithActivity is not supplied", resp.StatusCode)
	}
}

func TestActivity_WireShapeForAClassifiedIssueEntry(t *testing.T) {
	db := testAdminDB(t)
	store := mustMandalaStore(t, db)
	es := mustEngineStore(t, db)
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithActivity(store, findRawTxsFromEngine(es)))

	assetID := strings.Repeat("cd", 32) + ".0"
	txid := seedIssueTx(t, store, es, assetID, "02alice", 100, time.Now().UTC())

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)

	entriesRaw, ok := body["entries"].([]any)
	if !ok {
		t.Fatalf("entries not an array: %+v", body)
	}
	if len(entriesRaw) != 1 {
		t.Fatalf("len(entries) = %d, want 1 (body: %+v)", len(entriesRaw), body)
	}
	entry, ok := entriesRaw[0].(map[string]any)
	if !ok {
		t.Fatalf("entry not an object: %+v", entriesRaw[0])
	}

	// Exact wire shape: {txid, when, assetId, kind, from, to, amount, proofs}.
	for _, field := range []string{"txid", "when", "assetId", "kind", "from", "to", "amount", "proofs"} {
		if _, ok := entry[field]; !ok {
			t.Fatalf("entry missing field %q: %+v", field, entry)
		}
	}
	if entry["txid"] != txid {
		t.Fatalf("txid = %v, want %v", entry["txid"], txid)
	}
	if entry["kind"] != "issue" {
		t.Fatalf("kind = %v, want issue", entry["kind"])
	}
	if entry["from"] != nil {
		t.Fatalf("from = %v, want null (issue has no sender)", entry["from"])
	}
	if entry["to"] != "02alice" {
		t.Fatalf("to = %v, want 02alice", entry["to"])
	}
	if entry["amount"] != float64(100) {
		t.Fatalf("amount = %v, want 100", entry["amount"])
	}
	if entry["assetId"] != assetID {
		t.Fatalf("assetId = %v, want %v", entry["assetId"], assetID)
	}
	whenStr, ok := entry["when"].(string)
	if !ok || !strings.HasSuffix(whenStr, "Z") || !strings.Contains(whenStr, ".") {
		t.Fatalf("when = %v, want an ISO-8601 UTC millisecond timestamp", entry["when"])
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", whenStr); err != nil {
		t.Fatalf("when = %q not in exact toISOString() millisecond format: %v", whenStr, err)
	}

	proofsRaw, ok := entry["proofs"].([]any)
	if !ok || len(proofsRaw) != 1 {
		t.Fatalf("proofs = %+v, want a single-element array", entry["proofs"])
	}
	proof, ok := proofsRaw[0].(map[string]any)
	if !ok {
		t.Fatalf("proof not an object: %+v", proofsRaw[0])
	}
	for _, field := range []string{"outputIndex", "identityKey", "keyID", "counterparty", "proofType"} {
		if _, ok := proof[field]; !ok {
			t.Fatalf("proof missing field %q: %+v", field, proof)
		}
	}
	if proof["identityKey"] != "02alice" || proof["keyID"] != "key-1" || proof["counterparty"] != "02alice" {
		t.Fatalf("proof = %+v", proof)
	}

	if _, ok := body["nextCursor"]; !ok {
		t.Fatalf("body missing nextCursor field: %+v", body)
	}
}

func TestActivity_AssetIDFilterAppliesPostClassification(t *testing.T) {
	db := testAdminDB(t)
	store := mustMandalaStore(t, db)
	es := mustEngineStore(t, db)
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithActivity(store, findRawTxsFromEngine(es)))

	assetA := strings.Repeat("aa", 32) + ".0"
	assetB := strings.Repeat("bb", 32) + ".0"
	now := time.Now().UTC()
	seedIssueTx(t, store, es, assetA, "02a", 10, now)
	seedIssueTx(t, store, es, assetB, "02b", 20, now.Add(-time.Second))

	// Matching filter: only assetA's entry comes back.
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity?assetId="+assetA, nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	entries, _ := body["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1 (body: %+v)", len(entries), body)
	}
	entry := entries[0].(map[string]any)
	if entry["assetId"] != assetA {
		t.Fatalf("assetId = %v, want %v", entry["assetId"], assetA)
	}

	// Non-matching filter: no entries, but still 200 with an empty array.
	resp2 := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity?assetId=no-such-asset.0", nil))
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp2.StatusCode, readRawBody(t, resp2))
	}
	body2 := decodeJSON(t, resp2)
	entries2, ok := body2["entries"].([]any)
	if !ok {
		t.Fatalf("entries not an array: %+v", body2)
	}
	if len(entries2) != 0 {
		t.Fatalf("len(entries) = %d, want 0 for a non-matching assetId filter", len(entries2))
	}

	// No filter: both entries come back.
	resp3 := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity", nil))
	body3 := decodeJSON(t, resp3)
	entries3, _ := body3["entries"].([]any)
	if len(entries3) != 2 {
		t.Fatalf("len(entries) = %d, want 2 with no assetId filter", len(entries3))
	}
}
