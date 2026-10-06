package mandala

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

// keysetEngine is an EngineOutputReader over one topic's unspent outputs in keyset (txid, outputIndex) order.
type keysetEngine struct {
	topic        string
	order        []transaction.Outpoint
	scripts      map[transaction.Outpoint][]byte
	goneOnReread map[transaction.Outpoint]bool
	reads        map[transaction.Outpoint]int
	findErr      error
	listErr      error
	stuck        bool // every page restarts at the beginning (the progress guard's case)
	listCalls    int
}

var _ EngineOutputReader = (*keysetEngine)(nil)

func newKeysetEngine(topic string) *keysetEngine {
	return &keysetEngine{topic: topic, scripts: map[transaction.Outpoint][]byte{}, goneOnReread: map[transaction.Outpoint]bool{}, reads: map[transaction.Outpoint]int{}}
}

// add lists txid.vout; a nil script lists an output the engine no longer reads (spent or evicted since listing).
func (e *keysetEngine) add(t *testing.T, txid string, vout uint32, script []byte) transaction.Outpoint {
	t.Helper()
	h, err := chainhash.NewHashFromHex(txid)
	if err != nil {
		t.Fatal(err)
	}
	op := transaction.Outpoint{Txid: *h, Index: vout}
	e.order = append(e.order, op)
	slices.SortFunc(e.order, func(a, b transaction.Outpoint) int {
		if c := strings.Compare(a.Txid.String(), b.Txid.String()); c != 0 {
			return c
		}
		return cmp.Compare(a.Index, b.Index)
	})
	if script != nil {
		e.scripts[op] = script
	}
	return op
}

func (e *keysetEngine) FindAdmittedOutput(_ context.Context, txid string, vout uint32, topic string) ([]byte, uint64, bool, error) {
	if e.findErr != nil {
		return nil, 0, false, e.findErr
	}
	if topic != e.topic {
		return nil, 0, false, nil
	}
	h, err := chainhash.NewHashFromHex(txid)
	if err != nil {
		return nil, 0, false, err
	}
	op := transaction.Outpoint{Txid: *h, Index: vout}
	e.reads[op]++
	if e.goneOnReread[op] && e.reads[op] > 1 {
		return nil, 0, false, nil
	}
	s, ok := e.scripts[op]
	return s, 1, ok, nil
}

func (e *keysetEngine) ListUnspentAdmittedOutputs(_ context.Context, topic string, after *transaction.Outpoint, limit int) ([]transaction.Outpoint, error) {
	e.listCalls++
	if e.listErr != nil {
		return nil, e.listErr
	}
	if topic != e.topic {
		return nil, nil
	}
	start := 0
	if after != nil && !e.stuck {
		for i, op := range e.order {
			if op == *after {
				start = i + 1
			}
		}
	}
	end := min(start+limit, len(e.order))
	return slices.Clone(e.order[start:end]), nil
}

var reconcilePKH = bytes.Repeat([]byte{0x11}, 20)

// reconcileScript is a BRC-162 lock: tokenID "" = deploy; amount 0 = authority; else value.
func reconcileScript(t *testing.T, tokenID string, amount uint64) []byte {
	t.Helper()
	s, err := brc162.Lock(brc162.LockParams{TokenID: tokenID, Amount: amount, PubKeyHash: reconcilePKH})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func reconcileHex(c string) string { return strings.Repeat(c, 64) }

func TestReconcileOutcomes(t *testing.T) {
	ctx := context.Background()
	tokA, topicA, topicB := reconcileHex("a")+"_0", "tm_"+reconcileHex("a"), "tm_"+reconcileHex("b")
	holder, issuer := mandalatest.Holder.Identity, mandalatest.Issuer.Identity
	eng := newKeysetEngine(topicA)
	st := newMemStore()

	// ok: the value row agrees.
	eng.add(t, reconcileHex("1"), 0, reconcileScript(t, tokA, 40))
	st.putToken(TokenRecord{Txid: reconcileHex("1"), OutputIndex: 0, TokenID: tokA, Amount: 40, IdentityKey: holder})
	// ok: the authority row agrees; its topic is not compared (F/ts-layers §14.7).
	eng.add(t, reconcileHex("2"), 0, reconcileScript(t, tokA, 0))
	st.putAuthority(AuthorityRecord{Txid: reconcileHex("2"), OutputIndex: 0, Topic: "tm_" + reconcileHex("f"), TokenID: tokA, IdentityKey: issuer})
	// repaired (inserted, credited once): the value row is missing, the journal agrees.
	eng.add(t, reconcileHex("3"), 1, reconcileScript(t, tokA, 25))
	st.putOwner(OwnerRecord{Txid: reconcileHex("3"), OutputIndex: 1, Topic: topicA, TokenID: tokA, Role: brc162.RoleValue, Amount: 25, IdentityKey: holder})
	// repaired (corrected, not credited): the value row has the wrong amount.
	eng.add(t, reconcileHex("4"), 0, reconcileScript(t, tokA, 10))
	st.putToken(TokenRecord{Txid: reconcileHex("4"), OutputIndex: 0, TokenID: tokA, Amount: 99, IdentityKey: holder})
	st.putOwner(OwnerRecord{Txid: reconcileHex("4"), OutputIndex: 0, Topic: topicA, TokenID: tokA, Role: brc162.RoleValue, Amount: 10, IdentityKey: holder})
	// repaired (inserted, never credited): a deploy at vout 0 without its authority row.
	eng.add(t, reconcileHex("5"), 0, reconcileScript(t, "", 0))
	st.putOwner(OwnerRecord{Txid: reconcileHex("5"), OutputIndex: 0, Topic: topicA, TokenID: reconcileHex("5") + "_0", Role: brc162.RoleDeploy, IdentityKey: issuer})
	// unrepairable: no journal.
	eng.add(t, reconcileHex("6"), 0, reconcileScript(t, tokA, 5))
	// unrepairable: the journal disagrees with the script (amount).
	eng.add(t, reconcileHex("7"), 0, reconcileScript(t, tokA, 5))
	st.putOwner(OwnerRecord{Txid: reconcileHex("7"), OutputIndex: 0, Topic: topicA, TokenID: tokA, Role: brc162.RoleValue, Amount: 6, IdentityKey: holder})
	// unrepairable: the only journal row is another token topic's.
	eng.add(t, reconcileHex("8"), 0, reconcileScript(t, tokA, 5))
	st.putOwner(OwnerRecord{Txid: reconcileHex("8"), OutputIndex: 0, Topic: topicB, TokenID: tokA, Role: brc162.RoleValue, Amount: 5, IdentityKey: holder})
	// unrepairable: not a token script.
	eng.add(t, reconcileHex("9"), 0, []byte{0x76, 0xa9})
	// unrepairable: a deploy anywhere but vout 0.
	eng.add(t, reconcileHex("c"), 2, reconcileScript(t, "", 0))
	// ok: listed, but the engine no longer reads it.
	eng.add(t, reconcileHex("d"), 0, nil)

	var repairs []string
	onRepair := func(op string, inserted bool) { repairs = append(repairs, fmt.Sprintf("%s:%v", op, inserted)) }
	res, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: topicA, OnRepair: onRepair})
	if err != nil {
		t.Fatal(err)
	}
	want := ReconcileResult{Scanned: 11, Repaired: 3, Unrepairable: []string{reconcileHex("6") + ".0", reconcileHex("7") + ".0", reconcileHex("8") + ".0", reconcileHex("9") + ".0", reconcileHex("c") + ".2"}}
	if !reflect.DeepEqual(res, want) {
		t.Fatalf("result = %+v\nwant     %+v", res, want)
	}
	if wantRepairs := []string{reconcileHex("3") + ".1:true", reconcileHex("4") + ".0:false", reconcileHex("5") + ".0:true"}; !reflect.DeepEqual(repairs, wantRepairs) {
		t.Fatalf("repairs = %v, want %v", repairs, wantRepairs)
	}
	if got := st.balance(holder); got != 25 {
		t.Fatalf("holder balance = %d, want 25 (only the inserted value row credits)", got)
	}
	if row, _ := st.GetTokenRow(ctx, reconcileHex("4"), 0); row == nil || row.Amount != 10 {
		t.Fatalf("corrected row = %+v, want amount 10", row)
	}
	if auth, _ := st.GetAuthorityRow(ctx, reconcileHex("5"), 0); auth == nil || auth.TokenID != reconcileHex("5")+"_0" {
		t.Fatalf("deploy authority row = %+v", auth)
	}

	// A rerun is harmless: nothing left to repair, the same rows reported.
	again, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: topicA, OnRepair: onRepair})
	if err != nil || again.Repaired != 0 || !reflect.DeepEqual(again.Unrepairable, want.Unrepairable) || st.balance(holder) != 25 {
		t.Fatalf("rerun = %+v (%v), balance %d", again, err, st.balance(holder))
	}
}

// The KYC topic reconciles like a token topic, from journal rows under tm_mandala_kyc.
func TestReconcileTheKYCTopic(t *testing.T) {
	ctx := context.Background()
	kycTok := reconcileHex("e") + "_0"
	eng := newKeysetEngine(KYCTopic)
	st := newMemStore()
	eng.add(t, reconcileHex("1"), 0, reconcileScript(t, kycTok, 0))
	st.putOwner(OwnerRecord{Txid: reconcileHex("1"), OutputIndex: 0, Topic: KYCTopic, TokenID: kycTok, Role: brc162.RoleAuthority, IdentityKey: mandalatest.Issuer.Identity})
	res, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: KYCTopic, OnRepair: func(string, bool) {}})
	if err != nil || res.Repaired != 1 || len(res.Unrepairable) != 0 {
		t.Fatalf("result = %+v (%v), want one repair", res, err)
	}
	if auth, _ := st.GetAuthorityRow(ctx, reconcileHex("1"), 0); auth == nil || auth.IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("KYC authority row = %+v", auth)
	}
}

// The engine spent the coin between the listing and the repair: the inserted row is taken back, uncredited.
func TestReconcileTakesBackARepairTheEngineSpentMeanwhile(t *testing.T) {
	ctx := context.Background()
	tokA, topicA := reconcileHex("a")+"_0", "tm_"+reconcileHex("a")
	eng := newKeysetEngine(topicA)
	st := newMemStore()
	op := eng.add(t, reconcileHex("1"), 0, reconcileScript(t, tokA, 40))
	eng.goneOnReread[op] = true
	st.putOwner(OwnerRecord{Txid: reconcileHex("1"), OutputIndex: 0, Topic: topicA, TokenID: tokA, Role: brc162.RoleValue, Amount: 40, IdentityKey: mandalatest.Holder.Identity})
	repaired := 0
	res, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: topicA, OnRepair: func(string, bool) { repaired++ }})
	if err != nil || !reflect.DeepEqual(res, ReconcileResult{Scanned: 1, Unrepairable: []string{}}) || repaired != 0 {
		t.Fatalf("result = %+v (%v), repairs logged %d; want scanned 1, nothing repaired or unrepairable", res, err, repaired)
	}
	if row, _ := st.GetTokenRow(ctx, reconcileHex("1"), 0); row != nil {
		t.Fatalf("a row for a coin the engine spent survived: %+v", row)
	}
	if got := st.balance(mandalatest.Holder.Identity); got != 0 {
		t.Fatalf("balance = %d, want 0 (credited by the insert, debited by the take-back)", got)
	}
}

func TestReconcilePagingAndProgressGuard(t *testing.T) {
	ctx := context.Background()
	tokA, topicA := reconcileHex("a")+"_0", "tm_"+reconcileHex("a")
	agreeing := func(n int) (*keysetEngine, *memStore) {
		eng, st := newKeysetEngine(topicA), newMemStore()
		for i := 0; i < n; i++ {
			txid := reconcileHex(fmt.Sprintf("%x", i+1))
			eng.add(t, txid, 0, reconcileScript(t, tokA, 1))
			st.putToken(TokenRecord{Txid: txid, OutputIndex: 0, TokenID: tokA, Amount: 1, IdentityKey: mandalatest.Holder.Identity})
		}
		return eng, st
	}
	for _, c := range []struct {
		outputs, batch, calls int
	}{{5, 2, 3}, {4, 2, 3}, {3, 0, 1}, {0, 2, 1}} {
		eng, st := agreeing(c.outputs)
		res, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: topicA, BatchSize: c.batch})
		if err != nil || res.Scanned != c.outputs || eng.listCalls != c.calls {
			t.Fatalf("%d outputs, batch %d: %+v (%v), %d listing calls; want %d scanned in %d calls", c.outputs, c.batch, res, err, eng.listCalls, c.outputs, c.calls)
		}
	}

	eng, st := agreeing(2)
	eng.stuck = true
	_, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: topicA, BatchSize: 2})
	if want := "reconcileOwnerIndex: the engine listing did not advance past " + reconcileHex("2") + ".0"; err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}

	if _, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: topicA, BatchSize: -1}); err == nil ||
		err.Error() != "reconcileOwnerIndex: batchSize must be a positive integer" {
		t.Fatalf("negative batch: err = %v", err)
	}
}

// Every engine or store fault propagates; the caller reruns (repairs are idempotent).
func TestReconcileFaultsPropagate(t *testing.T) {
	ctx := context.Background()
	tokA, topicA := reconcileHex("a")+"_0", "tm_"+reconcileHex("a")
	boom := errors.New("boom")
	setup := func() (*keysetEngine, *memStore) {
		eng, st := newKeysetEngine(topicA), newMemStore()
		eng.add(t, reconcileHex("1"), 0, reconcileScript(t, tokA, 7))
		st.putOwner(OwnerRecord{Txid: reconcileHex("1"), OutputIndex: 0, Topic: topicA, TokenID: tokA, Role: brc162.RoleValue, Amount: 7, IdentityKey: mandalatest.Holder.Identity})
		return eng, st
	}
	for _, c := range []struct {
		name   string
		break_ func(*keysetEngine, *memStore)
	}{
		{"listing", func(e *keysetEngine, _ *memStore) { e.listErr = boom }},
		{"engine read", func(e *keysetEngine, _ *memStore) { e.findErr = boom }},
		{"row read", func(_ *keysetEngine, s *memStore) { s.failNext("GetTokenRow", boom) }},
		{"journal read", func(_ *keysetEngine, s *memStore) { s.failNext("GetOwnerJournal", boom) }},
		{"repair write", func(_ *keysetEngine, s *memStore) { s.failNext("RepairOwnerRow", boom) }},
	} {
		eng, st := setup()
		c.break_(eng, st)
		if _, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: st, Engine: eng, Topic: topicA, OnRepair: func(string, bool) {}}); !errors.Is(err, boom) {
			t.Errorf("%s fault: err = %v, want it propagated", c.name, err)
		}
	}
}

// On the real stores: a backlog left by lost lookup writes (engine outputs and journal rows, no index rows) is repaired
// on one token topic, and nothing is listed for another topic.
func TestReconcileRepairsABacklogOnTheRealStores(t *testing.T) {
	db := testmongo.DB(t, "mandala3_test_reconcile")
	ctx := context.Background()
	store, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	es, err := enginestore.New(db)
	if err != nil {
		t.Fatal(err)
	}
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	tokenID := dep.Txid + "_0"
	topic, err := TokenTopic(tokenID)
	if err != nil {
		t.Fatal(err)
	}
	beef, _, _, err := transaction.ParseBeef(iss.Beef)
	if err != nil {
		t.Fatal(err)
	}
	if err := es.InsertOutputs(ctx, topic, iss.Tx.TxID(), []uint32{0, 1}, nil, beef, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := store.RecordOwners(ctx, []OwnerRecord{
		{Txid: iss.Txid, OutputIndex: 0, Topic: topic, TokenID: tokenID, Role: brc162.RoleAuthority, IdentityKey: mandalatest.Issuer.Identity, CreatedAt: now},
		{Txid: iss.Txid, OutputIndex: 1, Topic: topic, TokenID: tokenID, Role: brc162.RoleValue, Amount: 100, IdentityKey: mandalatest.Holder.Identity, CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}

	res, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: store, Engine: es, Topic: topic, OnRepair: func(string, bool) {}})
	if err != nil || !reflect.DeepEqual(res, ReconcileResult{Scanned: 2, Repaired: 2, Unrepairable: []string{}}) {
		t.Fatalf("result = %+v (%v), want 2 scanned, 2 repaired", res, err)
	}
	if row, _ := store.GetTokenRow(ctx, iss.Txid, 1); row == nil || row.Amount != 100 || row.IdentityKey != mandalatest.Holder.Identity || row.TokenID != tokenID {
		t.Fatalf("value row = %+v", row)
	}
	if auth, _ := store.GetAuthorityRow(ctx, iss.Txid, 0); auth == nil || auth.IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("authority row = %+v", auth)
	}
	if bal, _ := store.GetBalance(ctx, mandalatest.Holder.Identity); bal != 100 {
		t.Fatalf("balance = %d, want 100", bal)
	}
	again, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: store, Engine: es, Topic: topic})
	if err != nil || again.Repaired != 0 || again.Scanned != 2 {
		t.Fatalf("rerun = %+v (%v)", again, err)
	}
	other, err := ReconcileOwnerIndex(ctx, ReconcileDeps{Store: store, Engine: es, Topic: KYCTopic})
	if err != nil || other.Scanned != 0 {
		t.Fatalf("KYC topic = %+v (%v), want nothing listed", other, err)
	}
}

// topicEngines is an EngineOutputReader over several topics, one keysetEngine each; any other topic lists nothing.
type topicEngines map[string]*keysetEngine

var _ EngineOutputReader = topicEngines(nil)

func (m topicEngines) FindAdmittedOutput(ctx context.Context, txid string, vout uint32, topic string) ([]byte, uint64, bool, error) {
	if e := m[topic]; e != nil {
		return e.FindAdmittedOutput(ctx, txid, vout, topic)
	}
	return nil, 0, false, nil
}

func (m topicEngines) ListUnspentAdmittedOutputs(ctx context.Context, topic string, after *transaction.Outpoint, limit int) ([]transaction.Outpoint, error) {
	if e := m[topic]; e != nil {
		return e.ListUnspentAdmittedOutputs(ctx, topic, after, limit)
	}
	return nil, nil
}

// V-13: the sweep takes back every value and authority row of a registered token whose coin the engine does not list
// as unspent on that token's own topic, debiting a value row's owner, and leaves every other row alone.
func TestSweepOwnerIndexTakesThePhantomRowsOfRegisteredTokens(t *testing.T) {
	ctx := context.Background()
	tokA, topicA := reconcileHex("a")+"_0", "tm_"+reconcileHex("a")
	tokB, topicB := reconcileHex("b")+"_0", "tm_"+reconcileHex("b")
	tokU, topicU := reconcileHex("f")+"_0", "tm_"+reconcileHex("f")
	holder, issuer := mandalatest.Holder.Identity, mandalatest.Issuer.Identity
	engA, engB := newKeysetEngine(topicA), newKeysetEngine(topicB)
	eng := topicEngines{topicA: engA, topicB: engB}
	st := newMemStore()

	// Token A. Live (listed on tm_A): an authority row and a value row.
	engA.add(t, reconcileHex("1"), 0, reconcileScript(t, tokA, 0))
	engA.add(t, reconcileHex("1"), 1, reconcileScript(t, tokA, 40))
	st.putAuthority(AuthorityRecord{Txid: reconcileHex("1"), OutputIndex: 0, Topic: topicA, TokenID: tokA, IdentityKey: issuer})
	st.putToken(TokenRecord{Txid: reconcileHex("1"), OutputIndex: 1, TokenID: tokA, Amount: 40, IdentityKey: holder})
	// Phantoms (not listed): an authority row and a value row.
	st.putAuthority(AuthorityRecord{Txid: reconcileHex("2"), OutputIndex: 0, Topic: topicA, TokenID: tokA, IdentityKey: issuer})
	st.putToken(TokenRecord{Txid: reconcileHex("2"), OutputIndex: 1, TokenID: tokA, Amount: 25, IdentityKey: holder})
	// A reissued outpoint (asset state evictedOutpoints) keeps its row: FindTokensByTokenID leaves it out.
	st.putToken(TokenRecord{Txid: reconcileHex("3"), OutputIndex: 0, TokenID: tokA, Amount: 5, IdentityKey: holder})
	reissued := DefaultAssetState(tokA, nil)
	reissued.EvictedOutpoints = []string{reconcileHex("3") + ".0"}
	st.putState(reissued)
	// Token A's id on another topic (KYC): only tm_A's authority rows are swept.
	st.putAuthority(AuthorityRecord{Txid: reconcileHex("4"), OutputIndex: 0, Topic: KYCTopic, TokenID: tokA, IdentityKey: issuer})

	// Token B. Live on tm_B; and a row whose coin is listed on tm_A only: a value row's topic comes from its token id.
	engB.add(t, reconcileHex("5"), 0, reconcileScript(t, tokB, 3))
	st.putToken(TokenRecord{Txid: reconcileHex("5"), OutputIndex: 0, TokenID: tokB, Amount: 3, IdentityKey: holder})
	engA.add(t, reconcileHex("6"), 0, reconcileScript(t, tokB, 7))
	st.putToken(TokenRecord{Txid: reconcileHex("6"), OutputIndex: 0, TokenID: tokB, Amount: 7, IdentityKey: holder})

	// Token U is not registered: its rows stay, although the engine lists nothing for it.
	st.putToken(TokenRecord{Txid: reconcileHex("7"), OutputIndex: 0, TokenID: tokU, Amount: 9, IdentityKey: holder})
	st.putAuthority(AuthorityRecord{Txid: reconcileHex("7"), OutputIndex: 1, Topic: topicU, TokenID: tokU, IdentityKey: issuer})

	if err := st.AdjustBalance(ctx, holder, 40+25+5+3+7+9); err != nil {
		t.Fatal(err)
	}
	taken, err := SweepOwnerIndex(ctx, SweepDeps{Store: st, Engine: eng, TokenIDs: []string{tokA, tokB}, BatchSize: 1})
	if err != nil || taken != 3 {
		t.Fatalf("sweep = %d (%v), want 3 rows taken", taken, err)
	}
	if got, want := st.balance(holder), int64(40+5+3+9); got != want {
		t.Fatalf("holder balance = %d, want %d (each phantom value row debited once)", got, want)
	}
	for _, c := range []struct {
		txid  string
		vout  uint32
		value bool
		kept  bool
	}{
		{reconcileHex("1"), 0, false, true},
		{reconcileHex("1"), 1, true, true},
		{reconcileHex("2"), 0, false, false},
		{reconcileHex("2"), 1, true, false},
		{reconcileHex("3"), 0, true, true},
		{reconcileHex("4"), 0, false, true},
		{reconcileHex("5"), 0, true, true},
		{reconcileHex("6"), 0, true, false},
		{reconcileHex("7"), 0, true, true},
		{reconcileHex("7"), 1, false, true},
	} {
		var present bool
		if c.value {
			row, err := st.GetTokenRow(ctx, c.txid, c.vout)
			present = err == nil && row != nil
		} else {
			row, err := st.GetAuthorityRow(ctx, c.txid, c.vout)
			present = err == nil && row != nil
		}
		if present != c.kept {
			t.Errorf("%s.%d (value %v): present %v, want %v", c.txid, c.vout, c.value, present, c.kept)
		}
	}

	// A rerun takes nothing.
	again, err := SweepOwnerIndex(ctx, SweepDeps{Store: st, Engine: eng, TokenIDs: []string{tokA, tokB}})
	if err != nil || again != 0 || st.balance(holder) != 40+5+3+9 {
		t.Fatalf("rerun = %d (%v), balance %d; want nothing taken", again, err, st.balance(holder))
	}
}

func TestSweepOwnerIndexFaultsAndGuards(t *testing.T) {
	ctx := context.Background()
	tokA, topicA := reconcileHex("a")+"_0", "tm_"+reconcileHex("a")
	boom := errors.New("boom")
	setup := func() (*keysetEngine, *memStore) {
		eng, st := newKeysetEngine(topicA), newMemStore()
		eng.add(t, reconcileHex("1"), 0, reconcileScript(t, tokA, 0))
		eng.add(t, reconcileHex("1"), 1, reconcileScript(t, tokA, 4))
		st.putAuthority(AuthorityRecord{Txid: reconcileHex("2"), OutputIndex: 0, Topic: topicA, TokenID: tokA, IdentityKey: mandalatest.Issuer.Identity})
		st.putToken(TokenRecord{Txid: reconcileHex("2"), OutputIndex: 1, TokenID: tokA, Amount: 4, IdentityKey: mandalatest.Holder.Identity})
		return eng, st
	}
	for _, c := range []struct {
		name   string
		break_ func(*keysetEngine, *memStore)
	}{
		{"listing", func(e *keysetEngine, _ *memStore) { e.listErr = boom }},
		{"value rows", func(_ *keysetEngine, s *memStore) { s.failNext("FindTokensByTokenID", boom) }},
		{"authority rows", func(_ *keysetEngine, s *memStore) { s.failNext("ListAuthorities", boom) }},
		{"value take", func(_ *keysetEngine, s *memStore) { s.failNext("TakeToken", boom) }},
		{"debit", func(_ *keysetEngine, s *memStore) { s.failNext("AdjustBalance", boom) }},
		{"authority take", func(_ *keysetEngine, s *memStore) { s.failNext("TakeAuthority", boom) }},
	} {
		eng, st := setup()
		c.break_(eng, st)
		if _, err := SweepOwnerIndex(ctx, SweepDeps{Store: st, Engine: eng, TokenIDs: []string{tokA}}); !errors.Is(err, boom) {
			t.Errorf("%s fault: err = %v, want it propagated", c.name, err)
		}
	}

	eng, st := setup()
	eng.stuck = true
	_, err := SweepOwnerIndex(ctx, SweepDeps{Store: st, Engine: eng, TokenIDs: []string{tokA}, BatchSize: 1})
	if want := "sweepOwnerIndex: the engine listing did not advance past " + reconcileHex("1") + ".0"; err == nil || err.Error() != want {
		t.Fatalf("stuck listing: err = %v, want %q", err, want)
	}
	if _, err := SweepOwnerIndex(ctx, SweepDeps{Store: st, Engine: eng, TokenIDs: []string{tokA}, BatchSize: -1}); err == nil ||
		err.Error() != "sweepOwnerIndex: batchSize must be a positive integer" {
		t.Fatalf("negative batch: err = %v", err)
	}
	if _, err := SweepOwnerIndex(ctx, SweepDeps{Store: st, Engine: eng, TokenIDs: []string{reconcileHex("a")}}); err == nil ||
		err.Error() != "not a canonical Mandala token id: "+reconcileHex("a") {
		t.Fatalf("non-canonical token id: err = %v", err)
	}
	if st.balance(mandalatest.Holder.Identity) != 0 || len(st.tokens) != 1 || len(st.authorities) != 1 {
		t.Fatal("a refused sweep took rows")
	}
}

// On the real stores: a coin the engine marked spent and a coin the engine never held both lose their value and
// authority rows (the value rows debited), live and reissued rows stay, an unregistered token's rows stay.
func TestSweepOwnerIndexOnTheRealStores(t *testing.T) {
	db := testmongo.DB(t, "mandala3_test_reconcile_sweep")
	ctx := context.Background()
	store, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	es, err := enginestore.New(db)
	if err != nil {
		t.Fatal(err)
	}
	holder, issuer := mandalatest.Holder.Identity, mandalatest.Issuer.Identity
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	tr := mandalatest.Transfer(t, iss, 1, mandalatest.Holder, 30)
	tokenID, topic := dep.Txid+"_0", "tm_"+dep.Txid
	tokU, topicU := reconcileHex("8")+"_0", "tm_"+reconcileHex("8")

	// The engine: the deploy spent by the issue, the issue's value coin spent by the transfer.
	for _, c := range []struct {
		b     *mandalatest.Built
		vouts []uint32
	}{{dep, []uint32{0}}, {iss, []uint32{0, 1}}, {tr, []uint32{0, 1}}} {
		beef, _, _, err := transaction.ParseBeef(c.b.Beef)
		if err != nil {
			t.Fatal(err)
		}
		if err := es.InsertOutputs(ctx, topic, c.b.Tx.TxID(), c.vouts, nil, beef, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, spend := range []struct {
		src     *mandalatest.Built
		vout    uint32
		spender *mandalatest.Built
	}{{dep, 0, iss}, {iss, 1, tr}} {
		if err := es.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *spend.src.Tx.TxID(), Index: spend.vout}}, topic, spend.spender.Tx.TxID()); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now()
	for _, r := range []AuthorityRecord{
		{Txid: dep.Txid, OutputIndex: 0, Topic: topic, TokenID: tokenID, IdentityKey: issuer, CreatedAt: now},          // spent: taken
		{Txid: iss.Txid, OutputIndex: 0, Topic: topic, TokenID: tokenID, IdentityKey: issuer, CreatedAt: now},          // live
		{Txid: reconcileHex("9"), OutputIndex: 1, Topic: topic, TokenID: tokenID, IdentityKey: issuer, CreatedAt: now}, // absent: taken
		{Txid: reconcileHex("8"), OutputIndex: 1, Topic: topicU, TokenID: tokU, IdentityKey: issuer, CreatedAt: now},   // unregistered
	} {
		if _, err := store.StoreAuthorityIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range []TokenRecord{
		{Txid: iss.Txid, OutputIndex: 1, TokenID: tokenID, Amount: 100, IdentityKey: holder, CreatedAt: now},         // spent: taken
		{Txid: tr.Txid, OutputIndex: 0, TokenID: tokenID, Amount: 30, IdentityKey: holder, CreatedAt: now},           // live
		{Txid: tr.Txid, OutputIndex: 1, TokenID: tokenID, Amount: 70, IdentityKey: holder, CreatedAt: now},           // live
		{Txid: reconcileHex("9"), OutputIndex: 0, TokenID: tokenID, Amount: 11, IdentityKey: holder, CreatedAt: now}, // absent: taken
		{Txid: reconcileHex("7"), OutputIndex: 0, TokenID: tokenID, Amount: 5, IdentityKey: holder, CreatedAt: now},  // absent but reissued: kept
		{Txid: reconcileHex("8"), OutputIndex: 0, TokenID: tokU, Amount: 13, IdentityKey: holder, CreatedAt: now},    // unregistered
	} {
		if _, err := store.StoreTokenIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	reissued := DefaultAssetState(tokenID, nil)
	reissued.EvictedOutpoints = []string{reconcileHex("7") + ".0"}
	if err := store.PutAssetState(ctx, reissued); err != nil {
		t.Fatal(err)
	}
	if err := store.AdjustBalance(ctx, holder, 100+30+70+11+5+13); err != nil {
		t.Fatal(err)
	}

	taken, err := SweepOwnerIndex(ctx, SweepDeps{Store: store, Engine: es, TokenIDs: []string{tokenID}, BatchSize: 2})
	if err != nil || taken != 4 {
		t.Fatalf("sweep = %d (%v), want 4 rows taken", taken, err)
	}
	if bal, _ := store.GetBalance(ctx, holder); bal != 30+70+5+13 {
		t.Fatalf("holder balance = %d, want %d", bal, 30+70+5+13)
	}
	for _, c := range []struct {
		txid  string
		vout  uint32
		value bool
		kept  bool
	}{
		{dep.Txid, 0, false, false},
		{iss.Txid, 0, false, true},
		{reconcileHex("9"), 1, false, false},
		{reconcileHex("8"), 1, false, true},
		{iss.Txid, 1, true, false},
		{tr.Txid, 0, true, true},
		{tr.Txid, 1, true, true},
		{reconcileHex("9"), 0, true, false},
		{reconcileHex("7"), 0, true, true},
		{reconcileHex("8"), 0, true, true},
	} {
		var present bool
		if c.value {
			row, err := store.GetTokenRow(ctx, c.txid, c.vout)
			if err != nil {
				t.Fatal(err)
			}
			present = row != nil
		} else {
			row, err := store.GetAuthorityRow(ctx, c.txid, c.vout)
			if err != nil {
				t.Fatal(err)
			}
			present = row != nil
		}
		if present != c.kept {
			t.Errorf("%s.%d (value %v): present %v, want %v", c.txid, c.vout, c.value, present, c.kept)
		}
	}

	again, err := SweepOwnerIndex(ctx, SweepDeps{Store: store, Engine: es, TokenIDs: []string{tokenID}})
	if bal, _ := store.GetBalance(ctx, holder); err != nil || again != 0 || bal != 30+70+5+13 {
		t.Fatalf("rerun = %d (%v), balance %d; want nothing taken", again, err, bal)
	}
}
