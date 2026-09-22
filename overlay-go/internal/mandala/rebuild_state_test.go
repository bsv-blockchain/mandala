package mandala

import (
	"context"
	"strings"
	"testing"
)

// RebuildState replays the surviving admin history into a fresh state, so a
// state folded from a since-evicted action is rolled back — including the
// ordering cursor, which must point at the last surviving row.
func TestRebuildStateReplaysHistoryAndRollsBackCursor(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	verifier, err := NewVerifier(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	ls := NewLookupService(verifier, store)

	assetID := strings.Repeat("dd", 32) + ".0"
	issuerKey := strings.Repeat("03", 33)
	blocked := strings.Repeat("02", 33)
	rows := []AdminHistoryEntry{
		{AssetID: assetID, Txid: strings.Repeat("dd", 32), OutputIndex: 0, Height: 100, Offset: 3, AdmitSeq: 1,
			ActionDetails: ActionDetails{"kind": "register", "assetId": assetID, "issuer": issuerKey}},
		{AssetID: assetID, Txid: strings.Repeat("ee", 32), OutputIndex: 1, Height: 9007199254740991, Offset: 0, AdmitSeq: 7,
			ActionDetails: ActionDetails{"kind": "blockIdentity", "assetId": assetID, "identityKey": blocked}},
	}
	for _, r := range rows {
		if err := store.AppendAdminHistory(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	// State as left by a later, since-evicted "pause" (seq 9).
	if err := store.PutAssetState(ctx, AssetAdminState{
		AssetID: assetID, IssuerIdentityKey: issuerKey, IsPaused: true, AccessMode: "denylist",
		BlockedIdentities: []string{blocked}, AllowedIdentities: []string{}, FrozenOutpoints: []FrozenRef{}, EvictedOutpoints: []string{},
		LastProcessedHeight: 9007199254740991, LastAdmitSeq: 9,
	}); err != nil {
		t.Fatal(err)
	}

	got, err := ls.RebuildState(ctx, assetID)
	if err != nil {
		t.Fatal("RebuildState:", err)
	}
	if got.IsPaused {
		t.Fatalf("rebuilt state still paused: %+v", got)
	}
	if got.IssuerIdentityKey != issuerKey || len(got.BlockedIdentities) != 1 || got.BlockedIdentities[0] != blocked {
		t.Fatalf("rebuilt state lost surviving actions: %+v", got)
	}
	if got.LastAdmitSeq != 7 || got.LastProcessedHeight != 9007199254740991 || got.LastProcessedOffset != 0 {
		t.Fatalf("cursor = (%d,%d,%d), want (9007199254740991,0,7)", got.LastProcessedHeight, got.LastProcessedOffset, got.LastAdmitSeq)
	}
	persisted, err := store.GetAssetState(ctx, assetID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.IsPaused || persisted.LastAdmitSeq != 7 {
		t.Fatalf("rebuilt state not persisted: %+v", persisted)
	}

	// No surviving history at all → the default state, cursor at zero.
	empty := strings.Repeat("ff", 32) + ".0"
	if err := store.PutAssetState(ctx, AssetAdminState{AssetID: empty, IsPaused: true, AccessMode: "allowlist", LastAdmitSeq: 4}); err != nil {
		t.Fatal(err)
	}
	got, err = ls.RebuildState(ctx, empty)
	if err != nil {
		t.Fatal(err)
	}
	if got.IsPaused || got.AccessMode != "denylist" || got.LastAdmitSeq != 0 {
		t.Fatalf("rebuild with no history = %+v, want default", got)
	}
}
