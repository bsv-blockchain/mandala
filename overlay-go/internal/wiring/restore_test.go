package wiring

// D-7: a spent input's owner row comes back from the owner journal, per journal row, and only where the engine shows
// the coin live again on THAT row's topic (TT §6.5; the TS evictWithRestore never-clobber rule).

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

// seamStores opens both stores on a fresh test database (no Build: the seams are plain functions over them).
func seamStores(t *testing.T, name string) (*enginestore.Store, *mandala.Store) {
	t.Helper()
	db := testmongo.DB(t, name)
	es, err := enginestore.New(db)
	if err != nil {
		t.Fatalf("enginestore.New: %v", err)
	}
	store, err := mandala.NewStore(db)
	if err != nil {
		t.Fatalf("mandala.NewStore: %v", err)
	}
	return es, store
}

func seamHash(t *testing.T, fill byte) *chainhash.Hash {
	t.Helper()
	h, err := chainhash.NewHash(bytes.Repeat([]byte{fill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func seamTopic(fill string) string { return "tm_" + strings.Repeat(fill, 64) }

// seamValueJournal is a journal row for a value coin of tm_<fill…> owned by the kit's holder.
func seamValueJournal(txid string, vout uint32, topic string, amount int64) mandala.OwnerRecord {
	tokenID, _ := mandala.TokenIDOfTopic(topic)
	return mandala.OwnerRecord{
		Txid: txid, OutputIndex: vout, Topic: topic, TokenID: tokenID, Role: brc162.RoleValue,
		Amount: mandala.Amount(amount), IdentityKey: mandalatest.Holder.Identity, CreatedAt: time.Now(),
	}
}

func seamSeedCoin(t *testing.T, es *enginestore.Store, topic string, h *chainhash.Hash, vouts ...uint32) {
	t.Helper()
	if err := es.InsertOutputs(context.Background(), topic, h, vouts, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func seamMarkSpent(t *testing.T, es *enginestore.Store, topic string, h *chainhash.Hash, vout uint32, spender *chainhash.Hash) {
	t.Helper()
	if err := es.MarkUTXOsAsSpent(context.Background(), []*transaction.Outpoint{{Txid: *h, Index: vout}}, topic, spender); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreLiveInputsRestoresEachRowUnderItsOwnTopic(t *testing.T) {
	es, store := seamStores(t, "mandala3_test_wiring_restore")
	ctx := context.Background()
	topicA, topicB := seamTopic("a"), seamTopic("b")
	coinA, coinB, coinC, ghost := seamHash(t, 0x11), seamHash(t, 0x12), seamHash(t, 0x13), seamHash(t, 0x14)
	competitor := seamHash(t, 0x15)

	seamSeedCoin(t, es, topicA, coinA, 0)              // live on tm_<a>
	seamSeedCoin(t, es, topicB, coinB, 0)              // live on tm_<b>
	seamSeedCoin(t, es, topicA, coinC, 0)              // spent by a live competitor
	seamMarkSpent(t, es, topicA, coinC, 0, competitor) // never clobbered
	if err := store.RecordOwners(ctx, []mandala.OwnerRecord{
		seamValueJournal(coinA.String(), 0, topicA, 40),
		seamValueJournal(coinB.String(), 0, topicB, 60),
		seamValueJournal(coinC.String(), 0, topicA, 5),
		seamValueJournal(ghost.String(), 0, topicA, 7), // the engine holds no output for it: not live
	}); err != nil {
		t.Fatal(err)
	}

	ops := []string{coinA.String() + ".0", coinB.String() + ".0", coinC.String() + ".0", ghost.String() + ".0", "not-an-outpoint"}
	n, err := restoreLiveInputs(ctx, es, store, ops)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("restored %d rows, want 2 (coinA under tm_<a>, coinB under tm_<b>)", n)
	}
	for _, c := range []struct {
		h      *chainhash.Hash
		topic  string
		amount int64
	}{{coinA, topicA, 40}, {coinB, topicB, 60}} {
		row, err := store.GetTokenRow(ctx, c.h.String(), 0)
		if err != nil || row == nil {
			t.Fatalf("row for %s: %v %v", c.h, row, err)
		}
		wantID, _ := mandala.TokenIDOfTopic(c.topic)
		if row.TokenID != wantID || int64(row.Amount) != c.amount || row.IdentityKey != mandalatest.Holder.Identity {
			t.Fatalf("row = %+v, want token %s amount %d owned by the holder", row, wantID, c.amount)
		}
	}
	for _, h := range []*chainhash.Hash{coinC, ghost} {
		if row, _ := store.GetTokenRow(ctx, h.String(), 0); row != nil {
			t.Fatalf("a coin that is not live got a row back: %+v", row)
		}
	}
	if bal, err := store.GetBalance(ctx, mandalatest.Holder.Identity); err != nil || bal != 100 {
		t.Fatalf("holder balance = %d (%v), want 100 (40 + 60, credited once each)", bal, err)
	}

	// Idempotent: the rows are present, nothing is inserted or credited again.
	again, err := restoreLiveInputs(ctx, es, store, ops)
	if err != nil || again != 0 {
		t.Fatalf("second run restored %d (%v), want 0", again, err)
	}
	if bal, _ := store.GetBalance(ctx, mandalatest.Holder.Identity); bal != 100 {
		t.Fatalf("holder balance after a repeat = %d, want 100", bal)
	}
}

// Liveness is read on the journal row's own topic: the same outpoint live on another topic does not count.
func TestRestoreLiveInputsReadsLivenessOnTheJournalRowsTopic(t *testing.T) {
	es, store := seamStores(t, "mandala3_test_wiring_restore_topic")
	ctx := context.Background()
	topicA, topicB := seamTopic("a"), seamTopic("b")
	coin, spender := seamHash(t, 0x21), seamHash(t, 0x22)
	seamSeedCoin(t, es, topicA, coin, 0)
	seamMarkSpent(t, es, topicA, coin, 0, spender)
	seamSeedCoin(t, es, topicB, coin, 0) // live, but on a topic with no journal row for it
	if err := store.RecordOwners(ctx, []mandala.OwnerRecord{seamValueJournal(coin.String(), 0, topicA, 9)}); err != nil {
		t.Fatal(err)
	}
	n, err := restoreLiveInputs(ctx, es, store, []string{coin.String() + ".0"})
	if err != nil || n != 0 {
		t.Fatalf("restored %d (%v), want 0", n, err)
	}
	if row, _ := store.GetTokenRow(ctx, coin.String(), 0); row != nil {
		t.Fatalf("row restored from a topic where the coin is still spent: %+v", row)
	}
}

// A read fault fails closed and names the outpoint (Task 21 turns it into "could not restore the owner row for <op>; retry").
func TestRestoreLiveInputsFailsClosedAndNamesTheOutpoint(t *testing.T) {
	es, store := seamStores(t, "mandala3_test_wiring_restore_fault")
	coin := seamHash(t, 0x31)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	n, err := restoreLiveInputs(ctx, es, store, []string{strings.ToUpper(coin.String()) + ".3"})
	if err == nil {
		t.Fatal("a cancelled read restored without error")
	}
	var re *inputRestoreError
	if !errors.As(err, &re) || re.Outpoint != coin.String()+".3" {
		t.Fatalf("err = %v, want *inputRestoreError for %s.3 (lowercased)", err, coin)
	}
	if !errors.Is(err, context.Canceled) || n != 0 {
		t.Fatalf("err = %v n = %d, want the cause kept and nothing restored", err, n)
	}
	if want := "restore input " + coin.String() + ".3: "; !strings.HasPrefix(err.Error(), want) {
		t.Fatalf("err text = %q, want prefix %q", err.Error(), want)
	}
}

func TestParseOutpoint(t *testing.T) {
	txid := strings.Repeat("ab", 32)
	cases := []struct {
		in   string
		txid string
		vout uint32
		ok   bool
	}{
		{txid + ".0", txid, 0, true},
		{strings.ToUpper(txid) + ".12", txid, 12, true},
		{txid + ".4294967295", txid, 4294967295, true},
		{txid + ".4294967296", "", 0, false},
		{txid + ".-1", "", 0, false},
		{txid + ".", "", 0, false},
		{txid[:62] + ".0", "", 0, false},
		{strings.Repeat("zz", 32) + ".0", "", 0, false},
		{"", "", 0, false},
	}
	for _, c := range cases {
		gotTxid, gotVout, ok := parseOutpoint(c.in)
		if ok != c.ok || gotTxid != c.txid || gotVout != c.vout {
			t.Errorf("parseOutpoint(%q) = %q, %d, %v; want %q, %d, %v", c.in, gotTxid, gotVout, ok, c.txid, c.vout, c.ok)
		}
	}
}
