package wiring

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// seamSpendTx spends each outpoint (by SourceTXID only) and returns its partial atomic BEEF and txid.
func seamSpendTx(t *testing.T, ins ...transaction.Outpoint) ([]byte, *chainhash.Hash) {
	t.Helper()
	tx := transaction.NewTransaction()
	for _, in := range ins {
		src := in.Txid
		tx.AddInput(&transaction.TransactionInput{SourceTXID: &src, SourceTxOutIndex: in.Index, UnlockingScript: &script.Script{}})
	}
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: &script.Script{}})
	beef, err := tx.AtomicBEEF(true)
	if err != nil {
		t.Fatal(err)
	}
	return beef, tx.TxID()
}

func TestSpendCheckerNamesALiveSpenderAndForgivesAnEvictedOne(t *testing.T) {
	es, store := seamStores(t, "mandala3_test_wiring_spendcheck")
	ctx := context.Background()
	topicA, topicB := seamTopic("a"), seamTopic("b")
	coin, spender := seamHash(t, 0x41), seamHash(t, 0x42)
	seamSeedCoin(t, es, topicA, coin, 0)
	checker := spendChecker(es, store)

	if by, err := checker.SpentBy(ctx, topicA, coin.String(), 0); err != nil || by != "" {
		t.Fatalf("live coin: SpentBy = %q, %v; want \"\"", by, err)
	}
	seamMarkSpent(t, es, topicA, coin, 0, spender)
	if by, err := checker.SpentBy(ctx, topicA, coin.String(), 0); err != nil || by != spender.String() {
		t.Fatalf("spent coin: SpentBy = %q, %v; want %s", by, err, spender)
	}
	if by, err := checker.SpentBy(ctx, topicB, coin.String(), 0); err != nil || by != "" {
		t.Fatalf("the spend is per topic: SpentBy(tm_<b>) = %q, %v; want \"\"", by, err)
	}
	if err := store.MarkEvicted(ctx, spender.String()); err != nil {
		t.Fatal(err)
	}
	if by, err := checker.SpentBy(ctx, topicA, coin.String(), 0); err != nil || by != "" {
		t.Fatalf("evicted spender: SpentBy = %q, %v; want \"\" (its spend is undone)", by, err)
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := checker.SpentBy(cctx, topicA, coin.String(), 0); err == nil {
		t.Fatal("a store fault must surface as an error (the manager types it ERR_UNAVAILABLE)")
	}
}

func TestAppliedAdmissionProofListsEveryAppliedTopic(t *testing.T) {
	es, _ := seamStores(t, "mandala3_test_wiring_proof")
	ctx := context.Background()
	topicA := seamTopic("a")
	tx := seamHash(t, 0x51)
	seamSeedCoin(t, es, topicA, tx, 2, 0)
	seamSeedCoin(t, es, mandala.MandalaTopic, tx, 0)
	for _, topic := range []string{topicA, mandala.MandalaTopic, mandala.KYCTopic} {
		if err := es.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: tx, Topic: topic}); err != nil {
			t.Fatal(err)
		}
	}
	proof := appliedAdmissionProof(es)

	got, err := proof(ctx, tx.String())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]uint32{topicA: {0, 2}, mandala.MandalaTopic: {0}, mandala.KYCTopic: {}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("proof = %v, want %v (an applied topic with no outputs keeps its key)", got, want)
	}
	unknown, err := proof(ctx, seamHash(t, 0x52).String())
	if err != nil || unknown == nil || len(unknown) != 0 {
		t.Fatalf("unknown txid: proof = %v, %v; want an empty map", unknown, err)
	}
	junk, err := proof(ctx, "not-a-txid")
	if err != nil || junk == nil || len(junk) != 0 {
		t.Fatalf("non-txid: proof = %v, %v; want an empty map, no error", junk, err)
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := proof(cctx, tx.String()); err == nil {
		t.Fatal("a store fault must surface")
	}
}

func TestPrepareSubmitCompensationSnapshotsEveryInput(t *testing.T) {
	es, store := seamStores(t, "mandala3_test_wiring_prepare")
	prep := prepareSubmitCompensation(es, store)
	a, b := seamHash(t, 0x61), seamHash(t, 0x62)
	beef, _ := seamSpendTx(t, transaction.Outpoint{Txid: *a, Index: 0}, transaction.Outpoint{Txid: *b, Index: 3})

	compensate, restore, err := prep(context.Background(), beef, []string{seamTopic("a")})
	if err != nil || compensate == nil || restore == nil {
		t.Fatalf("prepare = %v, %v, %v", compensate != nil, restore, err)
	}
	if want := []string{a.String() + ".0", b.String() + ".3"}; !reflect.DeepEqual(restore.SpentOutpoints, want) {
		t.Fatalf("spentOutpoints = %v, want %v", restore.SpentOutpoints, want)
	}
	c, r, err := prep(context.Background(), []byte{0xde, 0xad}, nil)
	if c != nil || r != nil || err != nil {
		t.Fatalf("unparseable BEEF: prepare = %v, %v, %v; want nil, nil, nil", c != nil, r, err)
	}
}

func TestCompensationUnmarksAndRestoresOnlyLiveCoins(t *testing.T) {
	es, store := seamStores(t, "mandala3_test_wiring_compensate")
	ctx := context.Background()
	topicA := seamTopic("a")
	src, competitor := seamHash(t, 0x71), seamHash(t, 0x72)
	beef, txid := seamSpendTx(t, transaction.Outpoint{Txid: *src, Index: 0}, transaction.Outpoint{Txid: *src, Index: 1})
	seamSeedCoin(t, es, topicA, src, 0, 1)
	if err := store.RecordOwners(ctx, []mandala.OwnerRecord{
		seamValueJournal(src.String(), 0, topicA, 40),
		seamValueJournal(src.String(), 1, topicA, 60),
	}); err != nil {
		t.Fatal(err)
	}
	seamMarkSpent(t, es, topicA, src, 0, txid)       // marked by this submit before its broadcast failed
	seamMarkSpent(t, es, topicA, src, 1, competitor) // held by a live competitor

	compensate, _, err := prepareSubmitCompensation(es, store)(ctx, beef, []string{topicA})
	if err != nil {
		t.Fatal(err)
	}
	if err := compensate(ctx); err != nil {
		t.Fatal(err)
	}
	if live, err := es.IsUnspent(ctx, topicA, src.String(), 0); err != nil || !live {
		t.Fatalf("this submit's spend must be unmarked: live=%v %v", live, err)
	}
	if by, _ := es.SpendStateOf(ctx, topicA, src.String(), 1); by != competitor.String() {
		t.Fatalf("the competitor's spend was clobbered: spent by %q", by)
	}
	if row, _ := store.GetTokenRow(ctx, src.String(), 0); row == nil || row.Amount != 40 {
		t.Fatalf("the live coin's row must come back from the journal: %+v", row)
	}
	if row, _ := store.GetTokenRow(ctx, src.String(), 1); row != nil {
		t.Fatalf("the competitor's coin got a row: %+v", row)
	}
	if bal, _ := store.GetBalance(ctx, mandalatest.Holder.Identity); bal != 40 {
		t.Fatalf("holder balance = %d, want 40", bal)
	}
}

// A duplicate resubmit whose broadcast fails must not undo the committed original: one applied named topic skips
// the whole compensation.
func TestCompensationIsSkippedWhenAnyNamedTopicIsApplied(t *testing.T) {
	es, store := seamStores(t, "mandala3_test_wiring_compensate_dupe")
	ctx := context.Background()
	topicA, topicB := seamTopic("a"), seamTopic("b")
	src := seamHash(t, 0x81)
	beef, txid := seamSpendTx(t, transaction.Outpoint{Txid: *src, Index: 0})
	seamSeedCoin(t, es, topicA, src, 0)
	if err := store.RecordOwners(ctx, []mandala.OwnerRecord{seamValueJournal(src.String(), 0, topicA, 40)}); err != nil {
		t.Fatal(err)
	}
	seamMarkSpent(t, es, topicA, src, 0, txid)
	if err := es.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: topicB}); err != nil {
		t.Fatal(err)
	}

	compensate, _, err := prepareSubmitCompensation(es, store)(ctx, beef, []string{topicA, topicB})
	if err != nil {
		t.Fatal(err)
	}
	if err := compensate(ctx); err != nil {
		t.Fatal(err)
	}
	if by, _ := es.SpendStateOf(ctx, topicA, src.String(), 0); by != txid.String() {
		t.Fatalf("compensation ran over an applied topic: spent by %q, want %s", by, txid)
	}
	if row, _ := store.GetTokenRow(ctx, src.String(), 0); row != nil {
		t.Fatalf("compensation restored a row over an applied topic: %+v", row)
	}
}

func TestJournalTokenIDsFiltersTokenTopics(t *testing.T) {
	_, store := seamStores(t, "mandala3_test_wiring_journalids")
	ctx := context.Background()
	coin := seamHash(t, 0x91).String()
	rows := []mandala.OwnerRecord{
		seamValueJournal(coin, 0, seamTopic("b"), 1),
		seamValueJournal(coin, 0, seamTopic("a"), 1),
		seamValueJournal(coin, 0, mandala.KYCTopic, 1),
		seamValueJournal(coin, 0, "tm_"+strings.Repeat("A", 64), 1),
	}
	if err := store.RecordOwners(ctx, rows); err != nil {
		t.Fatal(err)
	}
	got, err := journalTokenIDs(store)(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{strings.Repeat("a", 64) + "_0", strings.Repeat("b", 64) + "_0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("journal token ids = %v, want %v", got, want)
	}
}

// The factory builds every token manager with the shared spend checker: a second issue spending the same deploy coin
// is refused by the manager with ERR_INPUT_SPENT naming the first, instead of tripping the engine's untyped mark-spent CAS.
func TestFactoryTokenTopicCarriesTheSharedSpendChecker(t *testing.T) {
	app := buildV3App(t, v3Config("mandala3_test_wiring_factory"), WithChainTracker(mandalatest.ScriptsOnlyTracker()))
	dep := deployToken(t, app, "USD")
	topic := tokenTopicOf(t, dep)
	first := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	mustSubmitBuilt(t, app, first, topic)

	second := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Receiver, 50)
	_, err := submitBuilt(t, app, second, topic)
	var rej *mandala.RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("err = %v (%T), want a *mandala.RejectError from the token manager", err, err)
	}
	if rej.Code != mandala.CodeInputSpent || rej.SpendTxid != first.Txid || rej.Topic != topic {
		t.Fatalf("reject = %+v, want ERR_INPUT_SPENT by %s on %s", rej, first.Txid, topic)
	}
	if want := "input " + dep.Txid + ".0: already spent by " + first.Txid; rej.Reason != want {
		t.Fatalf("reason = %q, want %q", rej.Reason, want)
	}
}
