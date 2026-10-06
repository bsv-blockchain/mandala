package wiring

// TT §6.5 eviction on the real engine: inputs restored per journal row and per topic, only where the engine shows the
// coin live again; the evicted tx's own index rows retired (debiting once); the engine forgets it on every topic; the
// tokens its history touched are refolded; and the whole run is quiesced and idempotent.

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/sirdeggen/mandala/overlay-go/internal/maintenance"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

func evictionApp(t *testing.T, node string) *App {
	t.Helper()
	app := buildV3App(t, v3Config(node), WithChainTracker(mandalatest.ScriptsOnlyTracker()))
	if app.EvictTx == nil {
		t.Fatal("App.EvictTx must always be set")
	}
	return app
}

// admitAsHost admits b the way /submit does: the snapshot (PrepareSubmitCompensation), the provisional record, the
// engine submit, then the final per-topic record with real σI.
func admitAsHost(t *testing.T, app *App, b *mandalatest.Built, topics ...string) overlay.Steak {
	t.Helper()
	ctx := context.Background()
	_, restore, err := app.PrepareSubmitCompensation(ctx, b.Beef, topics)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Store.RecordAdmission(ctx, mandala.AdmissionRecord{Txid: b.Txid, Topics: topics, Restore: restore, Pending: true}); err != nil {
		t.Fatal(err)
	}
	steak := mustSubmitBuilt(t, app, b, topics...)
	signer, err := mandala.NewECAdmissionSigner(mandalatest.Overlay.PrivHex())
	if err != nil {
		t.Fatal(err)
	}
	admissions := map[string]mandala.TopicAdmission{}
	ident := ""
	for topic, ai := range steak {
		if ai == nil || !mandala.IsSigmaTopic(topic) || len(ai.OutputsToAdmit) == 0 {
			continue
		}
		outs := mandala.CanonicalOutputs(ai.OutputsToAdmit)
		sig, key, err := signer.SignAdmission(topic, b.Txid, outs)
		if err != nil {
			t.Fatal(err)
		}
		admissions[topic] = mandala.TopicAdmission{OutputsToAdmit: outs, AdmissionSignature: sig}
		ident = key
	}
	if len(admissions) > 0 {
		if err := app.Store.RecordAdmission(ctx, mandala.AdmissionRecord{Txid: b.Txid, Topics: topics, Admissions: admissions, AdmissionIdentityKey: ident, Restore: restore}); err != nil {
			t.Fatal(err)
		}
	}
	return steak
}

// hostDeploy registers and admits a deploy through tm_mandala and tm_<txid>, returning it and its token topic.
func hostDeploy(t *testing.T, app *App, sym string) (*mandalatest.Built, string) {
	t.Helper()
	dep := mandalatest.Deploy(t, mandalatest.Issuer, sym)
	if ok, err := app.Tokens.Ensure(dep.Txid + "_0"); err != nil || !ok {
		t.Fatalf("Ensure: %v %v", ok, err)
	}
	topic := tokenTopicOf(t, dep)
	admitAsHost(t, app, dep, mandala.MandalaTopic, topic)
	return dep, topic
}

func balanceOf(t *testing.T, app *App, p mandalatest.Party) int64 {
	t.Helper()
	b, err := app.Store.GetBalance(context.Background(), p.Identity)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func tokenRowOf(t *testing.T, app *App, txid string, vout uint32) *mandala.TokenRecord {
	t.Helper()
	r, err := app.Store.GetTokenRow(context.Background(), txid, vout)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func authorityRowOf(t *testing.T, app *App, txid string, vout uint32) *mandala.AuthorityRecord {
	t.Helper()
	r, err := app.Store.GetAuthorityRow(context.Background(), txid, vout)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func evictedAt(t *testing.T, app *App, txid string) string {
	t.Helper()
	rec, err := app.Store.GetAdmission(context.Background(), txid)
	if err != nil {
		t.Fatal(err)
	}
	if rec == nil {
		return ""
	}
	return rec.EvictedAt
}

// Review Focus 5 — eviction of a two-token transfer: each spent input row is restored from its own topic's journal row,
// only where the engine shows the coin live again on that topic; the retired output rows debit their balances exactly
// once; both asset states are untouched (a plain transfer has no admin history to purge); a replay changes nothing.
func TestEvictTwoTokenTransferRestoresEachInputUnderItsOwnTopic(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction")
	ctx := context.Background()
	depA, topicA := hostDeploy(t, app, "AAA")
	depB, topicB := hostDeploy(t, app, "BBB")
	issA := mandalatest.Issue(t, depA, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	admitAsHost(t, app, issA, topicA)
	issB := mandalatest.Issue(t, depB, 0, mandalatest.Issuer, mandalatest.Holder, 70)
	admitAsHost(t, app, issB, topicB)
	x := mandalatest.TwoTokenTransfer(t, issA, 1, issB, 1, mandalatest.Receiver)
	admitAsHost(t, app, x, topicA, topicB)

	if h, r := balanceOf(t, app, mandalatest.Holder), balanceOf(t, app, mandalatest.Receiver); h != 0 || r != 170 {
		t.Fatalf("precondition balances holder %d receiver %d, want 0 / 170", h, r)
	}
	stateA, err := app.Store.GetAssetState(ctx, depA.Txid+"_0")
	if err != nil {
		t.Fatal(err)
	}
	stateB, err := app.Store.GetAssetState(ctx, depB.Txid+"_0")
	if err != nil {
		t.Fatal(err)
	}

	out, err := app.EvictTx(ctx, x.Txid)
	if err != nil {
		t.Fatalf("EvictTx: %v", err)
	}
	if out != (mandala.EvictionOutcome{RestoredOutpoints: 2, RestoredTokenRows: 2}) {
		t.Fatalf("outcome = %+v, want 2 coins unmarked (one per topic) and 2 owner rows restored", out)
	}
	for _, c := range []struct {
		topic, txid, tokenID string
		amount               int64
	}{
		{topicA, issA.Txid, depA.Txid + "_0", 100},
		{topicB, issB.Txid, depB.Txid + "_0", 70},
	} {
		if live, err := app.EngineStore.IsUnspent(ctx, c.topic, c.txid, 1); err != nil || !live {
			t.Fatalf("%s.1 is not live again on %s (%v)", c.txid, c.topic, err)
		}
		row := tokenRowOf(t, app, c.txid, 1)
		if row == nil || row.TokenID != c.tokenID || int64(row.Amount) != c.amount || row.IdentityKey != mandalatest.Holder.Identity {
			t.Fatalf("restored row %+v, want %s %d owned by the holder", row, c.tokenID, c.amount)
		}
		rows, err := app.Store.OwnerJournalByOutpoint(ctx, c.txid, 1)
		if err != nil || len(rows) != 1 || rows[0].Topic != c.topic {
			t.Fatalf("journal of %s.1 = %+v (%v), want its one row under %s", c.txid, rows, err, c.topic)
		}
	}
	if live, _ := app.EngineStore.IsUnspent(ctx, topicB, issA.Txid, 1); live {
		t.Fatal("A's coin reads live on tm_<B>, a topic that never held it")
	}
	if tokenRowOf(t, app, x.Txid, 0) != nil || tokenRowOf(t, app, x.Txid, 1) != nil {
		t.Fatal("the evicted transfer's own output rows survived")
	}
	if h, r := balanceOf(t, app, mandalatest.Holder), balanceOf(t, app, mandalatest.Receiver); h != 170 || r != 0 {
		t.Fatalf("balances holder %d receiver %d, want 170 / 0 (each retired row debited once, each restored row credited once)", h, r)
	}
	if ops, err := app.EngineStore.FindOutputsByTxid(ctx, x.Txid); err != nil || len(ops) != 0 {
		t.Fatalf("engine still holds the transfer's outputs: %v (%v)", ops, err)
	}
	if topics, err := app.EngineStore.AppliedTopics(ctx, x.Txid); err != nil || len(topics) != 0 {
		t.Fatalf("engine still holds applied records %v (%v)", topics, err)
	}
	if afterA, _ := app.Store.GetAssetState(ctx, depA.Txid+"_0"); !reflect.DeepEqual(afterA, stateA) {
		t.Fatalf("asset state A changed: %+v -> %+v", stateA, afterA)
	}
	if afterB, _ := app.Store.GetAssetState(ctx, depB.Txid+"_0"); !reflect.DeepEqual(afterB, stateB) {
		t.Fatalf("asset state B changed: %+v -> %+v", stateB, afterB)
	}
	if evictedAt(t, app, x.Txid) == "" {
		t.Fatal("eviction not stamped")
	}

	again, err := app.EvictTx(ctx, x.Txid)
	if err != nil {
		t.Fatalf("replayed EvictTx: %v", err)
	}
	if again != (mandala.EvictionOutcome{AlreadyEvicted: true}) {
		t.Fatalf("replay outcome = %+v, want alreadyEvicted with nothing restored", again)
	}
	if h, r := balanceOf(t, app, mandalatest.Holder), balanceOf(t, app, mandalatest.Receiver); h != 170 || r != 0 {
		t.Fatalf("a replay moved balances: holder %d receiver %d", h, r)
	}
}

// The refold where it applies: an evicted issue's history row is purged and its token refolds without it.
func TestEvictIssueRefoldsTheTokenWithoutIt(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction_issue")
	ctx := context.Background()
	dep, topic := hostDeploy(t, app, "USD")
	tokenID := dep.Txid + "_0"
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	admitAsHost(t, app, iss, topic)

	before, err := app.Store.GetAssetState(ctx, tokenID)
	if err != nil || before.LastAdmitSeq == 0 {
		t.Fatalf("precondition: the issue must have folded (lastAdmitSeq %d, %v)", before.LastAdmitSeq, err)
	}
	if hist, _ := app.Store.FindAdminHistory(ctx, tokenID, 0, 0); len(hist) != 1 || hist[0].Txid != iss.Txid {
		t.Fatalf("precondition: history = %+v", hist)
	}

	out, err := app.EvictTx(ctx, iss.Txid)
	if err != nil {
		t.Fatal(err)
	}
	if out != (mandala.EvictionOutcome{RestoredOutpoints: 1, RestoredTokenRows: 1}) {
		t.Fatalf("outcome = %+v, want the deploy coin unmarked and its authority row restored", out)
	}
	after, err := app.Store.GetAssetState(ctx, tokenID)
	if err != nil || after.LastAdmitSeq != 0 || after.LastProcessedHeight != 0 {
		t.Fatalf("refolded state %+v (%v), want the default state (the only action is gone)", after, err)
	}
	if hist, _ := app.Store.FindAdminHistory(ctx, tokenID, 0, 0); len(hist) != 0 {
		t.Fatalf("history after eviction = %+v, want none", hist)
	}
	if auth := authorityRowOf(t, app, dep.Txid, 0); auth == nil || auth.IdentityKey != mandalatest.Issuer.Identity || auth.TokenID != tokenID {
		t.Fatalf("deploy authority row = %+v, want it back for the issuer", auth)
	}
	if authorityRowOf(t, app, iss.Txid, 0) != nil || tokenRowOf(t, app, iss.Txid, 1) != nil || balanceOf(t, app, mandalatest.Holder) != 0 {
		t.Fatal("the issue's own rows (new authority, minted value) must be retired and the holder debited")
	}
}

func TestEvictDeployDeletesItsRegistryRecordAndMetadata(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction_deploy")
	ctx := context.Background()
	dep, topic := hostDeploy(t, app, "USD")
	tokenID := dep.Txid + "_0"
	if rec, _ := app.Store.FindRegistryRecord(ctx, tokenID); rec == nil {
		t.Fatal("precondition: registry record missing")
	}
	if md, _ := app.Store.FindMetadata(ctx, tokenID); md == nil {
		t.Fatal("precondition: metadata missing")
	}

	if _, err := app.EvictTx(ctx, dep.Txid); err != nil {
		t.Fatal(err)
	}
	if rec, err := app.Store.FindRegistryRecord(ctx, tokenID); err != nil || rec != nil {
		t.Fatalf("registry record after eviction = %+v (%v)", rec, err)
	}
	if md, err := app.Store.FindMetadata(ctx, tokenID); err != nil || md != nil {
		t.Fatalf("metadata after eviction = %+v (%v)", md, err)
	}
	if authorityRowOf(t, app, dep.Txid, 0) != nil {
		t.Fatal("the deploy's authority row survived")
	}
	for _, tp := range []string{mandala.MandalaTopic, topic} {
		if out, err := app.EngineStore.FindOutput(ctx, &transaction.Outpoint{Txid: *dep.Tx.TxID(), Index: 0}, &tp, nil, false); err != nil || out != nil {
			t.Fatalf("engine still holds the deploy on %s: %v (%v)", tp, out, err)
		}
	}
}

func TestEvictKYCActionTakesItsAuthorityRow(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction_kyc")
	ctx := context.Background()
	kyc := mandalatest.Deploy(t, mandalatest.Issuer, "KYC")
	admitAsHost(t, app, kyc, mandala.KYCTopic)
	if authorityRowOf(t, app, kyc.Txid, 0) == nil {
		t.Fatal("precondition: ls_mandala_kyc did not index the registry authority")
	}
	if _, err := app.EvictTx(ctx, kyc.Txid); err != nil {
		t.Fatal(err)
	}
	if authorityRowOf(t, app, kyc.Txid, 0) != nil {
		t.Fatal("the evicted KYC action's authority row survived")
	}
}

// Never clobber a live spend: a coin another transaction holds keeps no row and stays spent by it.
func TestEvictDoesNotRestoreACoinACompetitorHolds(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction_competitor")
	ctx := context.Background()
	dep, topic := hostDeploy(t, app, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	admitAsHost(t, app, iss, topic)
	t1 := mandalatest.Transfer(t, iss, 1, mandalatest.Receiver, 100)
	admitAsHost(t, app, t1, topic)

	// The coin passed to a competitor after t1's mark was released.
	competitor := seamHash(t, 0xc1)
	if _, err := app.EngineStore.UnmarkSpentBySpendTxid(ctx, t1.Txid); err != nil {
		t.Fatal(err)
	}
	if err := app.EngineStore.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *iss.Tx.TxID(), Index: 1}}, topic, competitor); err != nil {
		t.Fatal(err)
	}

	out, err := app.EvictTx(ctx, t1.Txid)
	if err != nil {
		t.Fatal(err)
	}
	if out != (mandala.EvictionOutcome{}) {
		t.Fatalf("outcome = %+v, want nothing restored", out)
	}
	if tokenRowOf(t, app, iss.Txid, 1) != nil || balanceOf(t, app, mandalatest.Holder) != 0 {
		t.Fatal("a coin a live competitor holds got its row back")
	}
	if by, _ := app.EngineStore.SpendStateOf(ctx, topic, iss.Txid, 1); by != competitor.String() {
		t.Fatalf("the coin is spent by %q, want the competitor", by)
	}
	if evictedAt(t, app, t1.Txid) == "" {
		t.Fatal("the eviction must still be stamped")
	}
}

// A gate that cannot drain surfaces the TS busy text, and nothing is unmarked or stamped.
func TestEvictBusyGateStampsNothing(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction_busy")
	ctx := context.Background()
	dep, topic := hostDeploy(t, app, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	admitAsHost(t, app, iss, topic)
	t1 := mandalatest.Transfer(t, iss, 1, mandalatest.Receiver, 100)
	admitAsHost(t, app, t1, topic)

	gate, lock := maintenance.NewGate(50*time.Millisecond), maintenance.NewGate(50*time.Millisecond)
	release, err := gate.Enter(ctx) // an in-flight submit that never drains in time
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	evict := evictTx(evictDeps{es: app.EngineStore, store: app.Store, quiesce: maintenance.ReconcileThenSubmit(lock, gate)})

	_, err = evict(ctx, t1.Txid)
	want := fmt.Sprintf("the overlay is busy with maintenance, so %s could not be evicted; retry", t1.Txid)
	var busy *maintenance.BusyError
	if err == nil || err.Error() != want || !errors.As(err, &busy) {
		t.Fatalf("err = %v, want %q wrapping *maintenance.BusyError", err, want)
	}
	if evictedAt(t, app, t1.Txid) != "" {
		t.Fatal("a busy gate stamped the eviction")
	}
	if by, _ := app.EngineStore.SpendStateOf(ctx, topic, iss.Txid, 1); by != t1.Txid {
		t.Fatalf("a busy gate unmarked a spend: spent by %q", by)
	}
}

// §9.8 ordering: when an input restore fails nothing is stamped or deleted, and the retry completes the unwind.
func TestEvictStampsNothingWhenTheRestoreFails(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction_restore_fault")
	ctx := context.Background()
	dep, topic := hostDeploy(t, app, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	admitAsHost(t, app, iss, topic)
	t1 := mandalatest.Transfer(t, iss, 1, mandalatest.Receiver, 100)
	admitAsHost(t, app, t1, topic)

	// An undecodable journal row (fractional amount) under the spent outpoint breaks the journal read.
	junkTopic := "tm_" + strings.Repeat("e", 64)
	owners := app.Mongo.Collection(mandala.OwnersCollection)
	if _, err := owners.InsertOne(ctx, bson.D{
		{Key: "txid", Value: iss.Txid}, {Key: "outputIndex", Value: int64(1)}, {Key: "topic", Value: junkTopic},
		{Key: "tokenId", Value: strings.Repeat("e", 64) + "_0"}, {Key: "role", Value: "value"}, {Key: "amount", Value: 1.5},
		{Key: "identityKey", Value: mandalatest.Holder.Identity}, {Key: "createdAt", Value: time.Now()},
	}); err != nil {
		t.Fatal(err)
	}

	_, err := app.EvictTx(ctx, t1.Txid)
	if want := fmt.Sprintf("could not restore the owner row for %s.1; retry", iss.Txid); err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	if evictedAt(t, app, t1.Txid) != "" {
		t.Fatal("evictedAt was stamped over a failed restore")
	}
	if ops, _ := app.EngineStore.FindOutputsByTxid(ctx, t1.Txid); len(ops) == 0 {
		t.Fatal("the outputs were deleted despite the failed restore")
	}
	if topics, _ := app.EngineStore.AppliedTopics(ctx, t1.Txid); !reflect.DeepEqual(topics, []string{topic}) {
		t.Fatalf("applied records = %v, want them kept for the retry", topics)
	}

	if _, err := owners.DeleteOne(ctx, bson.D{{Key: "topic", Value: junkTopic}}); err != nil {
		t.Fatal(err)
	}
	out, err := app.EvictTx(ctx, t1.Txid)
	if err != nil {
		t.Fatal(err)
	}
	// The failed attempt already unmarked the coin, so the retry unmarks nothing but restores its row.
	if out != (mandala.EvictionOutcome{RestoredOutpoints: 0, RestoredTokenRows: 1}) {
		t.Fatalf("retry outcome = %+v", out)
	}
	if evictedAt(t, app, t1.Txid) == "" || tokenRowOf(t, app, iss.Txid, 1) == nil {
		t.Fatal("the retry must stamp the eviction and restore the row")
	}
	if h, r := balanceOf(t, app, mandalatest.Holder), balanceOf(t, app, mandalatest.Receiver); h != 100 || r != 0 {
		t.Fatalf("balances holder %d receiver %d, want 100 / 0", h, r)
	}
}

// No record at all (admitted outside /submit): the spend is still unmarked and the eviction stamped; with no
// snapshot there is no input to hand a row back to (the reconciler repairs it later from the journal).
func TestEvictWithoutARecordStillUnmarksAndStamps(t *testing.T) {
	app := evictionApp(t, "mandala3_test_eviction_norecord")
	ctx := context.Background()
	dep, topic := hostDeploy(t, app, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	admitAsHost(t, app, iss, topic)
	t1 := mandalatest.Transfer(t, iss, 1, mandalatest.Receiver, 100)
	mustSubmitBuilt(t, app, t1, topic)

	out, err := app.EvictTx(ctx, t1.Txid)
	if err != nil {
		t.Fatal(err)
	}
	if out != (mandala.EvictionOutcome{RestoredOutpoints: 1}) {
		t.Fatalf("outcome = %+v, want the one coin unmarked and no row restored", out)
	}
	if live, _ := app.EngineStore.IsUnspent(ctx, topic, iss.Txid, 1); !live {
		t.Fatal("the coin must be live again")
	}
	if tokenRowOf(t, app, iss.Txid, 1) != nil {
		t.Fatal("no snapshot, so no row is restored here")
	}
	if evictedAt(t, app, t1.Txid) == "" {
		t.Fatal("MarkEvicted must create the record and stamp it")
	}
}
