package wiring

// Why the Go spend guard does not need the TS overlay's every-input scan and
// self-heal (wire contract v2.3 §11.2).
//
// mandala.TopicManager.noConflictingSpend (FIX L) inspects only the inputs the
// engine lists in previousCoins. That is complete because the pinned
// go-overlay-services engine (v1.3.7, as v1.3.2 before it) builds previousCoins
// in mergeExistingOutputs with Storage.FindOutputs(ctx, inpoints, topic, nil,
// true): spent=nil means no spent filter, and tm_mandala retains every previous
// coin (CoinsToRetain: previousCoins), so a coin another transaction already
// spent is still listed and the guard names the competitor (ERR_INPUT_SPENT).
//
// @bsv/overlay 2.6 stopped listing spent coins, which is why the TS guard
// (overlay/src/spentGuard.ts) inspects every input of the transaction. If a
// future engine bump starts filtering spent coins here too, this test fails:
// port the TS guard to Go before taking that bump.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"

	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

var errStopAfterRecording = errors.New("previousCoins recorded; stop before any mutation")

// previousCoinsRecorder is a topic manager that records the previousCoins the
// engine hands it and then refuses, so Submit stops before markSpentAndNotify
// and nothing in storage changes.
type previousCoinsRecorder struct {
	calls int
	got   []uint32
}

func (r *previousCoinsRecorder) IdentifyAdmissibleOutputs(_ context.Context, _ *transaction.Beef, _ *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	r.calls++
	r.got = append([]uint32(nil), previousCoins...)
	return overlay.AdmittanceInstructions{}, errStopAfterRecording
}

func (r *previousCoinsRecorder) IdentifyNeededInputs(context.Context, *transaction.Beef, *chainhash.Hash) ([]*transaction.Outpoint, error) {
	return nil, nil
}

func (r *previousCoinsRecorder) GetDocumentation() string { return "" }

func (r *previousCoinsRecorder) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{Name: "tm_mandala"}
}

func TestEngineListsACoinAlreadySpentByAnotherTxInPreviousCoins(t *testing.T) {
	db := testmongo.DB(t, "mandala3_test_wiring_previous_coins")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	es, err := enginestore.New(db)
	if err != nil {
		t.Fatal(err)
	}

	const topic = "tm_mandala"
	rec := &previousCoinsRecorder{}
	eng := engine.NewEngine(&engine.Config{
		Managers:       map[string]engine.TopicManager{topic: rec},
		LookupServices: map[string]engine.LookupService{},
		Storage:        es,
		ChainTracker:   scriptsOnlyTracker{},
	})

	// A topic coin, already spent by a different, still-recorded transaction.
	key, lock := p2pkhKeyAndLock(t)
	src := provenSource(t, 2, lock)
	srcID := src.TxID()
	if err := es.InsertOutputs(ctx, topic, srcID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	competitor, err := chainhash.NewHashFromHex("cc" + srcID.String()[2:])
	if err != nil {
		t.Fatal(err)
	}
	if err := es.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *srcID, Index: 0}}, topic, competitor); err != nil {
		t.Fatal(err)
	}
	if by, err := es.SpendStateOf(ctx, topic, srcID.String(), 0); err != nil || by != competitor.String() {
		t.Fatalf("precondition: coin spent by %q (%v), want %s", by, err, competitor)
	}

	// A second spend of that coin, valid under SPV so the engine reaches the
	// topic manager.
	double := signedSpend(t, key, src, 2, sighash.AllForkID, lock)
	beef, err := double.AtomicBEEF(false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = eng.Submit(ctx, overlay.TaggedBEEF{Beef: beef, Topics: []string{topic}}, engine.SubmitModeCurrent, nil)
	if !errors.Is(err, errStopAfterRecording) {
		t.Fatalf("Submit error = %v, want the recorder's stop (the engine must reach the topic manager)", err)
	}
	if rec.calls != 1 {
		t.Fatalf("topic manager called %d times, want 1", rec.calls)
	}
	if len(rec.got) != 1 || rec.got[0] != 0 {
		t.Fatalf("previousCoins = %v, want [0]: the engine dropped a spent coin, so the Go guard can no longer see a double spend", rec.got)
	}

	// Refusing in the manager left the competitor's spend untouched.
	if by, err := es.SpendStateOf(ctx, topic, srcID.String(), 0); err != nil || by != competitor.String() {
		t.Fatalf("after Submit: coin spent by %q (%v), want %s", by, err, competitor)
	}
}
