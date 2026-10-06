package wiring

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// Review Focus 4 — a restart after a lost registry record, a narrowed allowlist or a read fault.
//   - X has a registry record. Y has only its deploy's owner-journal row and its deploy metadata (its tm_mandala record
//     write was lost). Z has a journal row and no metadata. A KYC journal row, even with metadata, must register and
//     restore nothing. Start registers exactly [X, Y, Z] and restores Y's record from the journal (D-21): issuer = the
//     journalled owner, createdAt = the journal row's. Z stays unrecorded.
//   - A second Build on the same db with allowlist [X]: X hosted, Y not, Y's journal rows and restored record untouched.
//   - A Mongo read fault during the boot union with a live ctx (the client is disconnected) fails Start and registers
//     nothing.
func TestStartBootUnionJournalOnlyNarrowedAndReadFault(t *testing.T) {
	const node = "mandala3_test_wiring_boot"
	x, y, z, k := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("4", 64), strings.Repeat("3", 64)
	cfg := v3Config(node)
	app := buildV3App(t, cfg)
	ctx := context.Background()
	journaled := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)

	if _, err := app.Store.StoreRegistryRecord(ctx, mandala.TokenRegistryRecord{
		TokenID: x + "_0", DeployTxid: x, Sym: "X", Dec: 2, Label: "X", Issuer: mandalatest.Issuer.Identity, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	journal := []mandala.OwnerRecord{
		{Txid: y, OutputIndex: 0, Topic: "tm_" + y, TokenID: y + "_0", Role: brc162.RoleDeploy, Amount: 0, IdentityKey: mandalatest.Issuer.Identity, CreatedAt: journaled},
		{Txid: z, OutputIndex: 0, Topic: "tm_" + z, TokenID: z + "_0", Role: brc162.RoleDeploy, Amount: 0, IdentityKey: mandalatest.Issuer.Identity, CreatedAt: journaled},
		{Txid: k, OutputIndex: 0, Topic: mandala.KYCTopic, TokenID: k + "_0", Role: brc162.RoleDeploy, Amount: 0, IdentityKey: mandalatest.Issuer.Identity, CreatedAt: journaled},
	}
	if err := app.Store.RecordOwners(ctx, journal); err != nil {
		t.Fatal(err)
	}
	for _, md := range []mandala.MetadataRecord{
		{TokenID: y + "_0", Txid: y, OutputIndex: 0, Sym: "Y", Dec: 2, Label: "Y"},
		{TokenID: k + "_0", Txid: k, OutputIndex: 0, Sym: "K", Dec: 2, Label: "K"},
	} {
		if err := app.Store.StoreMetadata(ctx, md); err != nil {
			t.Fatal(err)
		}
	}

	if err := app.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got, want := app.Tokens.Registered(), []string{x + "_0", y + "_0", z + "_0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Registered() = %v, want %v", got, want)
	}
	for _, id := range []string{x, y, z} {
		if !app.Engine.HasTopicManager("tm_"+id) || !app.Engine.HasLookupService("ls_"+id) {
			t.Fatalf("tm_/ls_%s not registered", id)
		}
	}
	if app.Engine.HasTopicManager("tm_" + k) {
		t.Fatal("a KYC journal row registered a token topic")
	}
	rec, err := app.Store.FindRegistryRecord(ctx, y+"_0")
	if err != nil || rec == nil || rec.DeployTxid != y || rec.Sym != "Y" || rec.Issuer != mandalatest.Issuer.Identity || !rec.CreatedAt.Equal(journaled) {
		t.Fatalf("Y's restored registry record = %+v, %v; want it rebuilt from the metadata and the journal row", rec, err)
	}
	for _, id := range []string{z, k} {
		if rec, err := app.Store.FindRegistryRecord(ctx, id+"_0"); err != nil || rec != nil {
			t.Fatalf("a record for %s_0 = %+v, %v; want none (no metadata, or no deploy row on tm_<txid>)", id, rec, err)
		}
	}

	// Restart with the allowlist narrowed to X.
	narrowed := cfg
	narrowed.TokenAllowlist = []string{x}
	narrowed.TokenAllowlistSet = true
	app2 := rebuildV3App(t, narrowed)
	if err := app2.Start(ctx); err != nil {
		t.Fatalf("Start (narrowed): %v", err)
	}
	if !app2.Tokens.Hosted(x+"_0") || app2.Tokens.Hosted(y+"_0") || app2.Engine.HasTopicManager("tm_"+y) {
		t.Fatalf("narrowed: hosted X=%v Y=%v tm_Y=%v; want X only", app2.Tokens.Hosted(x+"_0"), app2.Tokens.Hosted(y+"_0"), app2.Engine.HasTopicManager("tm_"+y))
	}
	rows, err := app2.Store.OwnerJournalByOutpoint(ctx, y, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Topic != "tm_"+y || rows[0].TokenID != y+"_0" || rows[0].IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("Y's journal rows changed by narrowing: %+v", rows)
	}
	for _, id := range []string{x, y} {
		if rec, err := app2.Store.FindRegistryRecord(ctx, id+"_0"); err != nil || rec == nil {
			t.Fatalf("%s_0's registry record after narrowing: %v %v", id, rec, err)
		}
	}

	// A read fault during the boot union fails Start instead of serving unknown-topic for every token. The ctx is live:
	// the client is disconnected, so the first store read itself fails.
	app3 := rebuildV3App(t, cfg)
	if err := app3.Mongo.Client().Disconnect(ctx); err != nil {
		t.Fatal(err)
	}
	err = app3.Start(ctx)
	if err == nil || !strings.HasPrefix(err.Error(), "wiring: start: token topics boot: ") {
		t.Fatalf("Start with a failing read = %v, want a \"wiring: start: token topics boot: \" error", err)
	}
	if got := app3.Tokens.Registered(); len(got) != 0 || app3.Engine.HasTopicManager("tm_"+x) {
		t.Fatalf("a failed boot registered %v", got)
	}
}
