package mandala

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestFoldRegistry_AdmitRevokeRegister(t *testing.T) {
	row, ok := FoldRegistry(ActionDetails{"kind": "admitIdentity", "identityKey": "02aa"}, "tx", 0, 1)
	if !ok || row.Status != "admitted" || row.IdentityKey != "02aa" {
		t.Fatalf("admit: %+v ok=%v", row, ok)
	}
	row, ok = FoldRegistry(ActionDetails{"kind": "revokeIdentity", "identityKey": "02aa"}, "tx", 1, 2)
	if !ok || row.Status != "revoked" {
		t.Fatalf("revoke: %+v ok=%v", row, ok)
	}
	row, ok = FoldRegistry(ActionDetails{"kind": "register", "issuer": "02bb"}, "tx", 0, 1)
	if !ok || row.IdentityKey != "02bb" || row.Status != "admitted" {
		t.Fatalf("register: %+v ok=%v", row, ok)
	}
	_, ok = FoldRegistry(ActionDetails{"kind": "pause"}, "tx", 0, 1)
	if ok {
		t.Fatal("pause must not fold into registry")
	}
}

// --- registration-chain anchoring -----------------------------------------

type fakeRegistryChain struct{ active bool }

func (f fakeRegistryChain) RegistryActive(context.Context) (bool, error) { return f.active, nil }

// regHarness builds a one-input/one-output registration-chain transaction.
// The input is the chain's prior link; whether the engine counts it as a
// previously admitted coin is what the tests vary.
func regHarness(t *testing.T, kind string, active bool, useRealPrior bool) (overlay.AdmittanceInstructions, error) {
	t.Helper()
	w, err := NewRegistryWallet(adminKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	src := transaction.NewTransaction()
	src.AddInput(dummyInput(0x31, 0))
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: p2pkhScript(t, [20]byte{0x01})})

	tx := transaction.NewTransaction()
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID: src.TxID(), SourceTxOutIndex: 0,
		SourceTransaction: src, UnlockingScript: &script.Script{},
	})
	details := ActionDetails{"kind": kind, "identityKey": "02" + strings.Repeat("aa", 32)}
	if kind != "register" {
		details["priorOutpoint"] = fmtOutpoint(src.TxID().String(), 0)
	}
	pkh, err := w.ExpectedPKH(details)
	if err != nil {
		t.Fatal(err)
	}
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: p2pkhScript(t, pkh)})

	beef := transaction.NewBeefV2()
	if _, err := beef.MergeTransaction(src); err != nil {
		t.Fatal(err)
	}
	if _, err := beef.MergeTransaction(tx); err != nil {
		t.Fatal(err)
	}
	payload := &LinkagePayload{Admin: []IndexedAdmin{{Index: 0, ActionDetails: details}}}
	var prev []uint32
	if useRealPrior {
		prev = []uint32{0}
	}
	tm := NewRegistryTopicManager(w, fakeRegistryChain{active: active})
	return tm.IdentifyAdmissibleOutputs(WithPayload(context.Background(), payload), beef, tx.TxID(), prev)
}

func TestRegistryAdmitRequiresSpendingTheChain(t *testing.T) {
	if _, err := regHarness(t, "admitIdentity", true, false); err == nil {
		t.Fatal("admit accepted without spending a previously admitted registry output")
	}
	if _, err := regHarness(t, "admitIdentity", true, true); err != nil {
		t.Fatalf("legitimate admit chained to the live registry output was rejected: %v", err)
	}
}

func TestRegistryRevokeRequiresSpendingTheChain(t *testing.T) {
	if _, err := regHarness(t, "revokeIdentity", true, false); err == nil {
		t.Fatal("revoke accepted without spending a previously admitted registry output")
	}
}

func TestRegistryRegisterIsGenesisOnly(t *testing.T) {
	if _, err := regHarness(t, "register", false, false); err != nil {
		t.Fatalf("genesis register on an empty registry was rejected: %v", err)
	}
	_, err := regHarness(t, "register", true, false)
	if err == nil {
		t.Fatal("a second register was admitted; that folds another admitted row into the same registry")
	}
	if !strings.Contains(err.Error(), "genesis-only") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- A17: actionDetails parity with the TS registry cache ---------------------

// TestRegistryActionDetailsRoundTripTSShape inserts a raw mandalaRegistry
// document in the EXACT shape overlay/src/registry.ts writes (camelCase keys,
// actionDetails as a nested subdocument) and reads it back through the Go
// store; then writes a row through UpsertRegistry and asserts the raw
// document carries the same shape. lib/src/registryRecover.ts re-spends the
// chain head from these details, so they must survive both directions byte
// for byte.
func TestRegistryActionDetailsRoundTripTSShape(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))

	prior := strings.Repeat("ab", 32) + ".0"
	tsDoc := bson.D{
		{Key: "identityKey", Value: "02aa"},
		{Key: "status", Value: "admitted"},
		{Key: "txid", Value: "deadbeef"},
		{Key: "outputIndex", Value: int32(0)},
		{Key: "admitSeq", Value: int32(2)},
		{Key: "createdAt", Value: time.Now()},
		{Key: "actionDetails", Value: bson.D{
			{Key: "kind", Value: "admitIdentity"},
			{Key: "identityKey", Value: "02aa"},
			{Key: "priorOutpoint", Value: prior},
			{Key: "counterparty", Value: "02bb"},
		}},
	}
	if _, err := s.registry.InsertOne(ctx, tsDoc); err != nil {
		t.Fatal(err)
	}
	rows, err := s.ListRegistry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	d := rows[0].ActionDetails
	if d.Kind() != "admitIdentity" {
		t.Fatalf("kind = %q", d.Kind())
	}
	if v, _ := d.Str("priorOutpoint"); v != prior {
		t.Fatalf("priorOutpoint = %q, want %q", v, prior)
	}
	if v, _ := d.Str("counterparty"); v != "02bb" {
		t.Fatalf("counterparty = %q", v)
	}
	// The wire form (GET /admin/registry) must name the field camelCase and
	// nest the details as a JSON object.
	wire, err := json.Marshal(rows[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(wire), `"actionDetails":{`) || !strings.Contains(string(wire), `"priorOutpoint":"`+prior+`"`) {
		t.Fatalf("wire shape: %s", wire)
	}

	// Write direction.
	row, ok := FoldRegistry(ActionDetails{"kind": "revokeIdentity", "identityKey": "02cc", "priorOutpoint": "feed.1"}, "cafe", 1, 3)
	if !ok {
		t.Fatal("fold")
	}
	if err := s.UpsertRegistry(ctx, row); err != nil {
		t.Fatal(err)
	}
	var raw bson.M
	if err := s.registry.FindOne(ctx, bson.D{{Key: "identityKey", Value: "02cc"}}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	detailsD, ok := raw["actionDetails"].(bson.D)
	if !ok {
		t.Fatalf("actionDetails subdoc: got %T: %+v", raw["actionDetails"], raw["actionDetails"])
	}
	details := bson.M{}
	for _, e := range detailsD {
		details[e.Key] = e.Value
	}
	if details["kind"] != "revokeIdentity" || details["priorOutpoint"] != "feed.1" || details["identityKey"] != "02cc" {
		t.Fatalf("stored actionDetails = %+v", details)
	}
}
