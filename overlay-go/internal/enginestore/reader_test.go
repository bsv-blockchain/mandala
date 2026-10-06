package enginestore

import (
	"bytes"
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

// Plan D-2: the engine store is the mandala engine-output reader, with no adapter.
var _ mandala.EngineOutputReader = (*Store)(nil)

var (
	tokenTopicA = "tm_" + strings.Repeat("aa", 32)
	tokenTopicB = "tm_" + strings.Repeat("bb", 32)
)

func readerStore(t *testing.T) *Store {
	t.Helper()
	return mustNew(t, testmongo.DB(t, "mandala3_test_enginestore"))
}

// scriptTx is a distinct transaction (fill varies the txid) with one output per script, output i
// carrying 10+i satoshis.
func scriptTx(fill byte, scripts ...[]byte) *transaction.Transaction {
	tx := newTx(fill, 0)
	for i, s := range scripts {
		ls := script.Script(s)
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(10 + i), LockingScript: &ls})
	}
	return tx
}

func TestFindAdmittedOutputReadsTheStoredBEEF(t *testing.T) {
	ctx := context.Background()
	st := readerStore(t)
	tx := scriptTx(0x11, []byte{0x51}, []byte{0x00, 0x00, 0x6d, 0x76, 0xa9})
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, tokenTopicA, txid, []uint32{0, 1}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	script1, sats, found, err := st.FindAdmittedOutput(ctx, txid.String(), 1, tokenTopicA)
	if err != nil || !found || sats != 11 || !bytes.Equal(script1, []byte{0x00, 0x00, 0x6d, 0x76, 0xa9}) {
		t.Fatalf("output 1: %x %d %v %v", script1, sats, found, err)
	}
	if _, _, found, err := st.FindAdmittedOutput(ctx, txid.String(), 1, tokenTopicB); err != nil || found {
		t.Fatalf("another topic must read absent: %v %v", found, err)
	}
	if _, _, found, err := st.FindAdmittedOutput(ctx, txid.String(), 7, tokenTopicA); err != nil || found {
		t.Fatalf("an unadmitted vout must read absent: %v %v", found, err)
	}
	spender, _ := chainhash.NewHashFromHex(strings.Repeat("cd", 32))
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(txid, 0)}, tokenTopicA, spender); err != nil {
		t.Fatal(err)
	}
	if _, _, found, err := st.FindAdmittedOutput(ctx, txid.String(), 0, tokenTopicA); err != nil || found {
		t.Fatalf("a spent output must read absent: %v %v", found, err)
	}
}

func TestFindAdmittedOutputFailsClosedOnACorruptBEEF(t *testing.T) {
	ctx := context.Background()
	st := readerStore(t)
	tx := scriptTx(0x12, []byte{0x51})
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, tokenTopicA, txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	for name, beef := range map[string][]byte{"garbage": {0x01, 0x02, 0x03}, "empty": {}} {
		if _, err := st.outputs.UpdateOne(ctx, bson.D{{Key: "txid", Value: txid.String()}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "beef", Value: beef}}}}); err != nil {
			t.Fatal(err)
		}
		if _, _, found, err := st.FindAdmittedOutput(ctx, txid.String(), 0, tokenTopicA); err == nil || found {
			t.Fatalf("%s BEEF: found=%v err=%v, want an error", name, found, err)
		}
	}
}

// V-16: AdmittedOutputState reads the same document without the spent filter: the script of a spent output too, and
// its spender; found=false only for no document; the same BEEF faults are errors, spent or not.
func TestAdmittedOutputStateReadsSpentOutputsAndTheirSpender(t *testing.T) {
	ctx := context.Background()
	st := readerStore(t)
	tx := scriptTx(0x13, []byte{0x51}, []byte{0x00, 0x00, 0x6d, 0x76, 0xa9})
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, tokenTopicA, txid, []uint32{0, 1}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	spender, _ := chainhash.NewHashFromHex(strings.Repeat("cd", 32))
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(txid, 1)}, tokenTopicA, spender); err != nil {
		t.Fatal(err)
	}
	if s, spent, by, found, err := st.AdmittedOutputState(ctx, txid.String(), 0, tokenTopicA); err != nil || !found || spent || by != "" || !bytes.Equal(s, []byte{0x51}) {
		t.Fatalf("unspent output 0: %x %v %q %v %v", s, spent, by, found, err)
	}
	if s, spent, by, found, err := st.AdmittedOutputState(ctx, txid.String(), 1, tokenTopicA); err != nil || !found || !spent || by != spender.String() ||
		!bytes.Equal(s, []byte{0x00, 0x00, 0x6d, 0x76, 0xa9}) {
		t.Fatalf("spent output 1: %x %v %q %v %v", s, spent, by, found, err)
	}
	if _, _, found, err := st.FindAdmittedOutput(ctx, txid.String(), 1, tokenTopicA); err != nil || found {
		t.Fatalf("FindAdmittedOutput must still read the spent output absent: %v %v", found, err)
	}
	for name, c := range map[string]struct {
		vout  uint32
		topic string
	}{"another topic": {1, tokenTopicB}, "an unadmitted vout": {7, tokenTopicA}} {
		if s, spent, by, found, err := st.AdmittedOutputState(ctx, txid.String(), c.vout, c.topic); err != nil || found || spent || by != "" || s != nil {
			t.Fatalf("%s: %x %v %q %v %v, want absent", name, s, spent, by, found, err)
		}
	}
	if _, err := st.outputs.UpdateOne(ctx, bson.D{{Key: "txid", Value: txid.String()}, {Key: "outputIndex", Value: 1}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "beef", Value: []byte{0x01, 0x02}}}}}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, found, err := st.AdmittedOutputState(ctx, txid.String(), 1, tokenTopicA); err == nil || found {
		t.Fatalf("a spent output's corrupt BEEF: found=%v err=%v, want an error", found, err)
	}
}

func TestListUnspentAdmittedOutputsKeysetNeverSkipsASibling(t *testing.T) {
	ctx := context.Background()
	st := readerStore(t)
	var want []string
	var first *chainhash.Hash
	for _, fill := range []byte{0x31, 0x32, 0x33} {
		tx := scriptTx(fill, []byte{0x51}, []byte{0x52}, []byte{0x53})
		txid := tx.TxID()
		if first == nil {
			first = txid
		}
		// One InsertOutputs call: the three siblings share one score (F/gaps G15).
		if err := st.InsertOutputs(ctx, tokenTopicA, txid, []uint32{0, 1, 2}, nil, beefFor(t, tx), nil); err != nil {
			t.Fatal(err)
		}
		if err := st.InsertOutputs(ctx, tokenTopicB, txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
			t.Fatal(err)
		}
	}
	spender, _ := chainhash.NewHashFromHex(strings.Repeat("ef", 32))
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(first, 1)}, tokenTopicA, spender); err != nil {
		t.Fatal(err)
	}
	cur, err := st.outputs.Find(ctx, bson.D{{Key: "topic", Value: tokenTopicA}, {Key: "spent", Value: false}})
	if err != nil {
		t.Fatal(err)
	}
	var docs []outputDoc
	if err := cur.All(ctx, &docs); err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		want = append(want, fmt.Sprintf("%s.%d", d.Txid, d.OutputIndex))
	}
	slices.Sort(want)
	if len(want) != 8 {
		t.Fatalf("setup: %d unspent outputs, want 8", len(want))
	}
	var got []string
	var after *transaction.Outpoint
	for page := 0; page < 10; page++ {
		ops, err := st.ListUnspentAdmittedOutputs(ctx, tokenTopicA, after, 3)
		if err != nil {
			t.Fatal(err)
		}
		for i := range ops {
			got = append(got, ops[i].String())
		}
		if len(ops) > 0 {
			last := ops[len(ops)-1]
			after = &last
		}
		if len(ops) < 3 {
			break
		}
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("paged %v\nwant  %v", got, want)
	}
	// The cursor is exclusive: starting after the last outpoint returns nothing.
	rest, err := st.ListUnspentAdmittedOutputs(ctx, tokenTopicA, after, 3)
	if err != nil || len(rest) != 0 {
		t.Fatalf("after the last outpoint: %v %v", rest, err)
	}
	if _, err := st.ListUnspentAdmittedOutputs(ctx, tokenTopicA, nil, 0); err == nil {
		t.Fatal("limit 0 must be refused")
	}
}

func TestAppliedTopicsListsEveryTopicOfATxid(t *testing.T) {
	ctx := context.Background()
	st := readerStore(t)
	txid, _ := chainhash.NewHashFromHex(strings.Repeat("ab", 32))
	if got, err := st.AppliedTopics(ctx, txid.String()); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("no record: %#v %v, want []string{}", got, err)
	}
	for _, topic := range []string{tokenTopicB, "tm_mandala", tokenTopicA} {
		if err := st.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: topic}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := st.AppliedTopics(ctx, txid.String())
	if err != nil || strings.Join(got, ",") != tokenTopicA+","+tokenTopicB+",tm_mandala" {
		t.Fatalf("applied topics = %v %v", got, err)
	}
}

// V-12: AppliedTopics filters on {txid} alone, which the unique {topic, txid} index cannot serve
// (a compound index needs its leading field), so New must also create a plain {txid: 1} index or
// every call is a scan of a collection that grows one document per (topic, tx) forever.
func TestNewStoreIndexesAppliedTransactionsByTxid(t *testing.T) {
	ctx := context.Background()
	st := readerStore(t)
	cur, err := st.applied.Indexes().List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var specs []struct {
		Key    bson.D `bson:"key"`
		Unique bool   `bson:"unique"`
	}
	if err := cur.All(ctx, &specs); err != nil {
		t.Fatal(err)
	}
	keyed := func(spec bson.D, fields ...string) bool {
		if len(spec) != len(fields) {
			return false
		}
		for i, e := range spec {
			if e.Key != fields[i] || fmt.Sprint(e.Value) != "1" {
				return false
			}
		}
		return true
	}
	var haveTxid, haveUniqueTopicTxid bool
	for _, spec := range specs {
		switch {
		case keyed(spec.Key, "txid"):
			haveTxid = true
			if spec.Unique {
				t.Fatalf("the {txid:1} index must not be unique: one txid has a record per topic (%v)", specs)
			}
		case keyed(spec.Key, "topic", "txid"):
			haveUniqueTopicTxid = spec.Unique
		}
	}
	if !haveTxid {
		t.Fatalf("engineAppliedTransactions has no {txid:1} index, so AppliedTopics scans the collection: %v", specs)
	}
	if !haveUniqueTopicTxid {
		t.Fatalf("the unique {topic:1, txid:1} dupe-gate index must stay: %v", specs)
	}
}

func TestOutputBeefWhereChoosesTheAcceptedTopic(t *testing.T) {
	ctx := context.Background()
	st := readerStore(t)
	tx := scriptTx(0x41, []byte{0x51})
	txid := tx.TxID()
	// A deploy's vout 0 lives in tm_mandala and in its own token topic.
	for _, topic := range []string{"tm_mandala", tokenTopicA} {
		if err := st.InsertOutputs(ctx, topic, txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
			t.Fatal(err)
		}
	}
	beef, topic, found, err := st.OutputBeefWhere(ctx, txid.String(), 0, mandala.IsTokenTopic)
	if err != nil || !found || topic != tokenTopicA || len(beef) == 0 {
		t.Fatalf("token topic: %q %v %v", topic, found, err)
	}
	if _, topic, found, err := st.OutputBeefWhere(ctx, txid.String(), 0, func(t string) bool { return t == "tm_mandala" }); err != nil || !found || topic != "tm_mandala" {
		t.Fatalf("registry topic: %q %v %v", topic, found, err)
	}
	if _, _, found, err := st.OutputBeefWhere(ctx, txid.String(), 0, func(string) bool { return false }); err != nil || found {
		t.Fatalf("nothing accepted: %v %v", found, err)
	}
	spender, _ := chainhash.NewHashFromHex(strings.Repeat("12", 32))
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(txid, 0)}, tokenTopicA, spender); err != nil {
		t.Fatal(err)
	}
	if _, topic, found, err := st.OutputBeefWhere(ctx, txid.String(), 0, mandala.IsTokenTopic); err != nil || !found || topic != tokenTopicA {
		t.Fatalf("a spent output is still served: %q %v %v", topic, found, err)
	}
}
