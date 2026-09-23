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

// RebuildStateExcluding folds the history minus one txid's rows (eviction,
// rebuild-first: the rows are still present when it runs). A setFeeRate from
// the excluded txid must not survive; the cursor follows the last surviving
// row, exactly as RebuildState's does. Nothing is deleted.
func TestRebuildStateExcludingSkipsTxidRowsAndRate(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	verifier, err := NewVerifier(lsVerifierKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	ls := NewLookupService(verifier, store)

	genesis := strings.Repeat("dd", 32)
	assetID := genesis + ".0"
	evicted := strings.Repeat("ee", 32)
	issuerKey := strings.Repeat("03", 33)
	rows := []AdminHistoryEntry{
		{AssetID: assetID, Txid: genesis, OutputIndex: 0, Height: 100, Offset: 3, AdmitSeq: 1,
			ActionDetails: ActionDetails{"kind": "register", "assetId": assetID, "issuer": issuerKey, "feeRatePerKb": float64(7)}},
		{AssetID: assetID, Txid: evicted, OutputIndex: 0, Height: 9007199254740991, Offset: 0, AdmitSeq: 2,
			ActionDetails: ActionDetails{"kind": "setFeeRate", "assetId": assetID, "feeRatePerKb": float64(50)}},
		{AssetID: assetID, Txid: evicted, OutputIndex: 1, Height: 9007199254740991, Offset: 0, AdmitSeq: 3,
			ActionDetails: ActionDetails{"kind": "pause", "assetId": assetID}},
	}
	for _, r := range rows {
		if err := store.AppendAdminHistory(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	fifty := int64(50)
	if err := store.PutAssetState(ctx, AssetAdminState{
		AssetID: assetID, IssuerIdentityKey: issuerKey, IsPaused: true, AccessMode: "denylist", FeeRatePerKb: &fifty,
		BlockedIdentities: []string{}, AllowedIdentities: []string{}, FrozenOutpoints: []FrozenRef{}, EvictedOutpoints: []string{},
		LastProcessedHeight: 9007199254740991, LastAdmitSeq: 3,
	}); err != nil {
		t.Fatal(err)
	}

	got, err := ls.RebuildStateExcluding(ctx, assetID, evicted)
	if err != nil {
		t.Fatal("RebuildStateExcluding:", err)
	}
	if got.IsPaused || got.IssuerIdentityKey != issuerKey {
		t.Fatalf("rebuilt state = %+v, want unpaused, issuer kept", got)
	}
	if got.FeeRatePerKb == nil || *got.FeeRatePerKb != 7 {
		t.Fatalf("feeRatePerKb = %v, want 7 (excluded setFeeRate must not survive)", got.FeeRatePerKb)
	}
	if got.LastProcessedHeight != 100 || got.LastProcessedOffset != 3 || got.LastAdmitSeq != 1 {
		t.Fatalf("cursor = (%d,%d,%d), want (100,3,1)", got.LastProcessedHeight, got.LastProcessedOffset, got.LastAdmitSeq)
	}
	persisted, err := store.GetAssetState(ctx, assetID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.IsPaused || persisted.FeeRatePerKb == nil || *persisted.FeeRatePerKb != 7 {
		t.Fatalf("not persisted: %+v", persisted)
	}
	all, err := store.FindAdminHistoryByAssetID(ctx, assetID)
	if err != nil || len(all) != 3 {
		t.Fatalf("history after rebuild = %d rows (%v), want 3 untouched", len(all), err)
	}

	// Excluding the genesis too leaves nothing: default state, no rate.
	got, err = ls.RebuildStateExcluding(ctx, assetID, genesis)
	if err != nil {
		t.Fatal(err)
	}
	if got.IssuerIdentityKey != "" || got.FeeRatePerKb == nil || *got.FeeRatePerKb != 50 || !got.IsPaused {
		t.Fatalf("excluding genesis = %+v, want only the ee rows folded", got)
	}
}
