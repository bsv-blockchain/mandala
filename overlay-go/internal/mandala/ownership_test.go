package mandala

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	mt "github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// ---- RequireValidTokenOutputs ----

func obOut(i uint32) brc162.Output {
	return brc162.Output{Index: i, Satoshis: 1, Role: brc162.RoleValue, TokenID: strings.Repeat("aa", 32) + "_0", Amount: 5, RestPubKeyHash: make([]byte, 20)}
}

func TestRequireValidTokenOutputsIsRuleMajor(t *testing.T) {
	twoSats := obOut(0)
	twoSats.Satoshis = 2
	if err := RequireValidTokenOutputs(nil, []brc162.Output{obOut(0), obOut(1)}); err != nil {
		t.Fatalf("valid outputs: %v", err)
	}
	// Codec refusals first (vector precedence-codec-before-satoshis).
	err := RequireValidTokenOutputs([]brc162.InvalidOutput{{Index: 3, Detail: "truncated push"}}, []brc162.Output{twoSats})
	requireReject(t, err, CodeShape, "output 3: token-shaped output is not a valid BRC-162 token output (truncated push)")
	// Satoshis before the amount cap (vector precedence-satoshis-before-amount-cap).
	huge := obOut(1)
	huge.Amount = MaxSafeAmount + 1
	requireReject(t, RequireValidTokenOutputs(nil, []brc162.Output{huge, twoSats}), CodeSatoshis, "output 0: token output must carry exactly 1 satoshi")
	requireReject(t, RequireValidTokenOutputs(nil, []brc162.Output{huge}), CodeShape, "output 1: token amount exceeds 2^53-1")
	// Rule-major: the deploy rule scans every output before the P2PKH rule looks at output 0.
	noP2pkh := obOut(0)
	noP2pkh.RestPubKeyHash = nil
	deployAt1 := obOut(1)
	deployAt1.Role = brc162.RoleDeploy
	requireReject(t, RequireValidTokenOutputs(nil, []brc162.Output{noP2pkh, deployAt1}), CodeShape, "output 1: a deploy must be output 0")
	requireReject(t, RequireValidTokenOutputs(nil, []brc162.Output{twoSats, func() brc162.Output { o := obOut(1); o.RestPubKeyHash = nil; return o }()}),
		CodeShape, "output 1: token output remainder must be a P2PKH lock")
	maxSafe := obOut(0)
	maxSafe.Amount = MaxSafeAmount
	if err := RequireValidTokenOutputs(nil, []brc162.Output{maxSafe}); err != nil {
		t.Fatalf("2^53-1 itself is allowed: %v", err)
	}
}

// ---- VerifyOutputOwners ----

func TestKitEnvelopesDecode(t *testing.T) {
	d := mt.Deploy(t, mt.Issuer, "USD")
	is := mt.Issue(t, d, 0, mt.Issuer, mt.Holder, 100)
	tr := mt.Build(t, []mt.In{{Src: is, Vout: 1, WithLinkage: true}}, []mt.Out{{Owner: mt.Receiver, Prover: mt.Holder, TokenID: mt.TokenIDOf(is, 1), Amount: 100}}, nil)
	de, ie, te := envOf(t, d.OffChain), envOf(t, is.OffChain), envOf(t, tr.OffChain)
	if !de.HasDeploySig || len(de.Outputs) != 1 || len(de.Admin) != 0 {
		t.Fatalf("deploy envelope: %+v", de)
	}
	if ie.HasDeploySig || len(ie.Outputs) != 2 || len(ie.Admin) != 1 || ie.Admin[0].Index != 0 || ie.Admin[0].Details != "a1646b696e64656973737565" {
		t.Fatalf("issue envelope: %+v", ie)
	}
	if raw, ok := te.InputLinkage(0); !ok || len(raw) == 0 {
		t.Fatalf("transfer input linkage: %s %v", raw, ok)
	}
	for _, e := range []*Envelope{de, ie, te} {
		for _, o := range e.Outputs {
			if _, err := ParseLinkage(o.Raw); err != nil {
				t.Fatalf("kit linkage does not parse: %v", err)
			}
		}
	}
}

func TestVerifyOutputOwnersProvesEveryRole(t *testing.T) {
	ctx := context.Background()
	v := overlayVerifier(t)
	d := mt.Deploy(t, mt.Issuer, "USD")
	is := mt.Issue(t, d, 0, mt.Issuer, mt.Holder, 100)
	outs := brc162.ClassifyOutputs(is.Tx).Outputs
	owners, err := VerifyOutputOwners(ctx, outs, envOf(t, is.OffChain), v)
	if err != nil {
		t.Fatal(err)
	}
	if len(owners) != 2 || owners[0].Role != brc162.RoleAuthority || owners[0].IdentityKey != mt.Issuer.Identity || owners[0].Prover != mt.Issuer.Identity {
		t.Fatalf("authority owner: %+v", owners)
	}
	if owners[1].IdentityKey != mt.Holder.Identity || owners[1].Prover != mt.Issuer.Identity || owners[1].Amount != 100 || owners[1].TokenID != d.Txid+"_0" {
		t.Fatalf("value owner: %+v", owners[1])
	}
	dOwners, err := VerifyOutputOwners(ctx, brc162.ClassifyOutputs(d.Tx).Outputs, envOf(t, d.OffChain), v)
	if err != nil || dOwners[0].Role != brc162.RoleDeploy || dOwners[0].IdentityKey != mt.Issuer.Identity {
		t.Fatalf("deploy owner: %+v %v", dOwners, err)
	}
}

func TestVerifyOutputOwnersRefusesEveryUnprovenLinkage(t *testing.T) {
	ctx := context.Background()
	v := overlayVerifier(t)
	d := mt.Deploy(t, mt.Issuer, "USD")
	is := mt.Issue(t, d, 0, mt.Issuer, mt.Holder, 100)
	outs := brc162.ClassifyOutputs(is.Tx).Outputs
	const reason1 = "output 1: token output with no verified linkage"
	cases := map[string][]byte{
		"missing": mutateEnvelope(t, is.OffChain, func(env map[string]any) {
			env["outputs"] = env["outputs"].([]any)[:1]
		}),
		"mistyped protocolID (D-13)": mutateEnvelope(t, is.OffChain, func(env map[string]any) {
			env["outputs"].([]any)[1].(map[string]any)["linkage"].(map[string]any)["protocolID"] = []any{"2", "mandala token"}
		}),
		"empty object": mutateEnvelope(t, is.OffChain, func(env map[string]any) {
			env["outputs"].([]any)[1].(map[string]any)["linkage"] = map[string]any{}
		}),
		"another output's key": mutateEnvelope(t, is.OffChain, func(env map[string]any) {
			o := env["outputs"].([]any)
			o[1].(map[string]any)["linkage"] = o[0].(map[string]any)["linkage"]
		}),
		"no linkage member": mutateEnvelope(t, is.OffChain, func(env map[string]any) {
			delete(env["outputs"].([]any)[1].(map[string]any), "linkage")
		}),
	}
	for name, off := range cases {
		_, err := VerifyOutputOwners(ctx, outs, envOf(t, off), v)
		if err == nil {
			t.Fatalf("%s: admitted", name)
		}
		requireReject(t, err, CodeLinkage, reason1)
	}
	rogue, err := NewVerifier(mt.Rogue.PrivHex())
	if err != nil {
		t.Fatal(err)
	}
	_, err = VerifyOutputOwners(ctx, outs, envOf(t, is.OffChain), rogue)
	requireReject(t, err, CodeLinkage, "output 0: token output with no verified linkage")
}

// ---- ResolveInputOwners and the §4.2a repair matrix ----

type repairFixture struct {
	topic   string
	tok     string
	is, tr  *mt.Built
	inputs  []brc162.Input
	op      string // the spent coin "<issue txid>.1"
	journal OwnerRecord
	store   *memStore
	engine  *memEngine
	repairs []string
}

// newRepairFixture: Holder's value coin is.Txid:1 (100 of token tok) is spent by tr; nothing is
// stored yet; the journal row exists; the engine holds the coin.
func newRepairFixture(t *testing.T) *repairFixture {
	t.Helper()
	d := mt.Deploy(t, mt.Issuer, "USD")
	is := mt.Issue(t, d, 0, mt.Issuer, mt.Holder, 100)
	tr := mt.Transfer(t, is, 1, mt.Receiver, 100)
	f := &repairFixture{topic: "tm_" + d.Txid, tok: d.Txid + "_0", is: is, tr: tr, store: newMemStore()}
	f.inputs = brc162.ClassifyAdmittedInputs(tr.Tx, []uint32{0})
	if len(f.inputs) != 1 || f.inputs[0].Role != brc162.RoleValue || f.inputs[0].Amount != 100 {
		t.Fatalf("classified inputs: %+v", f.inputs)
	}
	f.op = is.Txid + ".1"
	f.journal = OwnerRecord{Txid: is.Txid, OutputIndex: 1, Topic: f.topic, TokenID: f.tok, Role: brc162.RoleValue, Amount: 100, IdentityKey: mt.Holder.Identity}
	f.store.putOwner(f.journal)
	f.engine = engineFor(f.topic, tr.Tx, []uint32{0})
	return f
}

func (f *repairFixture) deps(t *testing.T, s StateStore) InputOwnerDeps {
	return InputOwnerDeps{Store: s, Engine: f.engine, Verifier: overlayVerifier(t), Topic: f.topic, Txid: f.tr.Txid,
		OnRepair: func(op string, inserted bool) {
			what := "corrected"
			if inserted {
				what = "inserted"
			}
			f.repairs = append(f.repairs, op+" "+what)
		}}
}

func (f *repairFixture) resolve(t *testing.T, s StateStore) (map[uint32]string, error) {
	t.Helper()
	return ResolveInputOwners(context.Background(), f.inputs, envOf(t, f.tr.OffChain), f.deps(t, s))
}

func TestResolveInputOwnersAcceptsAnAgreeingRow(t *testing.T) {
	f := newRepairFixture(t)
	f.store.putToken(TokenRecord{Txid: f.is.Txid, OutputIndex: 1, TokenID: f.tok, Amount: 100, IdentityKey: mt.Holder.Identity})
	owners, err := f.resolve(t, f.store)
	if err != nil || owners[0] != mt.Holder.Identity || len(f.repairs) != 0 {
		t.Fatalf("owners %v err %v repairs %v", owners, err, f.repairs)
	}
}

func TestRepairInsertsAMissingRowAndCreditsOnce(t *testing.T) {
	f := newRepairFixture(t)
	owners, err := f.resolve(t, f.store)
	if err != nil || owners[0] != mt.Holder.Identity {
		t.Fatalf("owners %v err %v", owners, err)
	}
	if strings.Join(f.repairs, ";") != f.op+" inserted" || f.store.balance(mt.Holder.Identity) != 100 {
		t.Fatalf("repairs %v balance %d", f.repairs, f.store.balance(mt.Holder.Identity))
	}
	if _, err := f.resolve(t, f.store); err != nil || len(f.repairs) != 1 || f.store.balance(mt.Holder.Identity) != 100 {
		t.Fatalf("second spend: %v repairs %v balance %d", err, f.repairs, f.store.balance(mt.Holder.Identity))
	}
}

func TestRepairCorrectsAWrongRowWithoutACredit(t *testing.T) {
	f := newRepairFixture(t)
	f.store.putToken(TokenRecord{Txid: f.is.Txid, OutputIndex: 1, TokenID: f.tok, Amount: 99, IdentityKey: mt.Holder.Identity})
	if _, err := f.resolve(t, f.store); err != nil {
		t.Fatal(err)
	}
	row, _ := f.store.GetTokenRow(context.Background(), f.is.Txid, 1)
	if row.Amount != 100 || strings.Join(f.repairs, ";") != f.op+" corrected" || f.store.balance(mt.Holder.Identity) != 0 {
		t.Fatalf("row %+v repairs %v balance %d", row, f.repairs, f.store.balance(mt.Holder.Identity))
	}
}

func TestUnrepairableInputsAreUnavailable(t *testing.T) {
	want := func(f *repairFixture) string { return "owner index unavailable for " + f.op }
	for name, setup := range map[string]func(f *repairFixture){
		"row and journal missing":     func(f *repairFixture) { f.store.owners = nil },
		"journal disagrees":           func(f *repairFixture) { f.store.owners[0].Amount = 99 },
		"journal names another token": func(f *repairFixture) { f.store.owners[0].TokenID = strings.Repeat("bb", 32) + "_0" },
		"journal key not an identity": func(f *repairFixture) { f.store.owners[0].IdentityKey = strings.ToUpper(mt.Holder.Identity) },
		"journal on another topic":    func(f *repairFixture) { f.store.owners[0].Topic = KYCTopic },
		"engine lost the coin":        func(f *repairFixture) { f.engine.forget(f.op) },
		"engine script differs":       func(f *repairFixture) { f.engine.coins[f.op] = append([]byte{0x51}, f.engine.coins[f.op]...) },
		"engine on another topic":     func(f *repairFixture) { f.engine.topic = KYCTopic },
	} {
		f := newRepairFixture(t)
		setup(f)
		_, err := f.resolve(t, f.store)
		if err == nil {
			t.Fatalf("%s: resolved", name)
		}
		requireReject(t, err, CodeUnavailable, want(f))
		if len(f.repairs) != 0 || f.store.balance(mt.Holder.Identity) != 0 {
			t.Fatalf("%s: repairs %v balance %d", name, f.repairs, f.store.balance(mt.Holder.Identity))
		}
	}
}

// spendRaceStore spends the coin in the engine right after the repair inserts its row (D §4.2a
// amendment: the engine spent the coin between the read and the insert).
type spendRaceStore struct {
	*memStore
	engine *memEngine
	op     string
}

func (s spendRaceStore) RepairOwnerRow(ctx context.Context, j OwnerRecord) (bool, error) {
	inserted, err := s.memStore.RepairOwnerRow(ctx, j)
	s.engine.forget(s.op)
	return inserted, err
}

func TestRepairTakesTheRowBackWhenTheEngineSpentTheCoin(t *testing.T) {
	f := newRepairFixture(t)
	_, err := f.resolve(t, spendRaceStore{memStore: f.store, engine: f.engine, op: f.op})
	requireReject(t, err, CodeUnavailable, "owner index unavailable for "+f.op)
	if row, _ := f.store.GetTokenRow(context.Background(), f.is.Txid, 1); row != nil {
		t.Fatalf("the repaired row was not taken back: %+v", row)
	}
	if b := f.store.balance(mt.Holder.Identity); b != 0 {
		t.Fatalf("credit not undone: balance %d", b)
	}
	if len(f.repairs) != 0 {
		t.Fatalf("a taken-back repair must not be reported: %v", f.repairs)
	}
	// The take-back write itself failing is a write fault.
	g := newRepairFixture(t)
	g.store.failNext("TakeToken", errStoreDown)
	_, err = g.resolve(t, spendRaceStore{memStore: g.store, engine: g.engine, op: g.op})
	requireReject(t, err, CodeUnavailable, "the owner index could not be written; retry")
}

// V-16 (final review §C2-§C4, §C7-§C10, §C18): the engine marks a transaction's inputs spent and runs every lookup's
// OutputSpent (which takes their rows) before it broadcasts and writes the applied record, so a fault or crash in
// between leaves the coin marked spent by that very transaction, its row gone and no applied record. The resubmit's
// repair reads that coin as admitted (its script from the spent document) under the same journal and byte checks, and
// keeps the repaired row for the resubmit's own OutputSpent to take, so the insert's credit and that debit cancel.
func TestRepairTreatsACoinSpentByTheTransactionItselfAsAdmitted(t *testing.T) {
	for _, spender := range []func(f *repairFixture) string{
		func(f *repairFixture) string { return f.tr.Txid },
		func(f *repairFixture) string { return strings.ToUpper(f.tr.Txid) }, // EqualFold, as the spend guard
	} {
		f := newRepairFixture(t)
		f.engine.spend(f.op, spender(f))
		owners, err := f.resolve(t, f.store)
		if err != nil || owners[0] != mt.Holder.Identity {
			t.Fatalf("owners %v err %v", owners, err)
		}
		if strings.Join(f.repairs, ";") != f.op+" inserted" || f.store.balance(mt.Holder.Identity) != 100 {
			t.Fatalf("repairs %v balance %d", f.repairs, f.store.balance(mt.Holder.Identity))
		}
		if row, _ := f.store.GetTokenRow(context.Background(), f.is.Txid, 1); row == nil || row.IdentityKey != mt.Holder.Identity {
			t.Fatalf("the repaired row of a self-spent coin was not kept: %+v", row)
		}
	}
	// The same checks as for an unspent coin.
	for name, setup := range map[string]func(f *repairFixture){
		"journal missing":       func(f *repairFixture) { f.store.owners = nil },
		"journal disagrees":     func(f *repairFixture) { f.store.owners[0].Amount = 99 },
		"engine script differs": func(f *repairFixture) { f.engine.coins[f.op] = append([]byte{0x51}, f.engine.coins[f.op]...) },
		"spent on another topic": func(f *repairFixture) {
			f.engine.topic = KYCTopic
		},
		"spent with no recorded spender": func(f *repairFixture) { f.engine.spend(f.op, "") },
	} {
		f := newRepairFixture(t)
		f.engine.spend(f.op, f.tr.Txid)
		setup(f)
		_, err := f.resolve(t, f.store)
		requireReject(t, err, CodeUnavailable, "owner index unavailable for "+f.op)
		if len(f.repairs) != 0 || f.store.balance(mt.Holder.Identity) != 0 {
			t.Fatalf("%s: repairs %v balance %d", name, f.repairs, f.store.balance(mt.Holder.Identity))
		}
	}
}

// markRaceStore marks the coin spent by spender in the engine right after the repair inserts its row.
type markRaceStore struct {
	*memStore
	engine  *memEngine
	op      string
	spender string
}

func (s markRaceStore) RepairOwnerRow(ctx context.Context, j OwnerRecord) (bool, error) {
	inserted, err := s.memStore.RepairOwnerRow(ctx, j)
	s.engine.spend(s.op, s.spender)
	return inserted, err
}

// The post-insert re-read applies the same rule: a mark by the transaction itself (a concurrent submit of the same
// bytes) keeps the row; a mark by another transaction takes it back.
func TestRepairReReadAppliesTheSelfSpendRule(t *testing.T) {
	f := newRepairFixture(t)
	if _, err := f.resolve(t, markRaceStore{memStore: f.store, engine: f.engine, op: f.op, spender: f.tr.Txid}); err != nil {
		t.Fatalf("a self mark between the insert and the re-read: %v", err)
	}
	if row, _ := f.store.GetTokenRow(context.Background(), f.is.Txid, 1); row == nil || f.store.balance(mt.Holder.Identity) != 100 {
		t.Fatalf("row %+v balance %d: the repaired row must stay", row, f.store.balance(mt.Holder.Identity))
	}

	g := newRepairFixture(t)
	other := strings.Repeat("cd", 32)
	_, err := g.resolve(t, markRaceStore{memStore: g.store, engine: g.engine, op: g.op, spender: other})
	if rej := requireReject(t, err, CodeInputSpent, "input "+g.op+": already spent by "+other); rej.SpendTxid != other {
		t.Fatalf("SpendTxid = %q, want %s", rej.SpendTxid, other)
	}
	if row, _ := g.store.GetTokenRow(context.Background(), g.is.Txid, 1); row != nil || g.store.balance(mt.Holder.Identity) != 0 || len(g.repairs) != 0 {
		t.Fatalf("row %+v balance %d repairs %v: the repaired row must be taken back", row, g.store.balance(mt.Holder.Identity), g.repairs)
	}
}

// Final review §C5 / FW2 item 3: a coin another transaction marked spent is that transaction's conflicting spend, a
// final ERR_INPUT_SPENT naming it whatever the index says, never the retryable "owner index unavailable" (defence in
// depth behind the conflicting-spend guard, for any path that reaches the repair).
func TestRepairAnswersInputSpentForAnotherTransactionsSpend(t *testing.T) {
	other := strings.Repeat("cd", 32)
	for name, setup := range map[string]func(f *repairFixture){
		"journal agrees":  func(*repairFixture) {},
		"journal missing": func(f *repairFixture) { f.store.owners = nil },
	} {
		f := newRepairFixture(t)
		f.engine.spend(f.op, other)
		setup(f)
		_, err := f.resolve(t, f.store)
		if rej := requireReject(t, err, CodeInputSpent, "input "+f.op+": already spent by "+other); rej.SpendTxid != other {
			t.Fatalf("%s: SpendTxid = %q, want %s", name, rej.SpendTxid, other)
		}
		if row, _ := f.store.GetTokenRow(context.Background(), f.is.Txid, 1); row != nil || len(f.repairs) != 0 || f.store.balance(mt.Holder.Identity) != 0 {
			t.Fatalf("%s: row %+v repairs %v balance %d", name, row, f.repairs, f.store.balance(mt.Holder.Identity))
		}
	}
}

func TestOwnerIndexFaultsAreTypedUnavailable(t *testing.T) {
	read := "the owner index could not be read; retry"
	for name, c := range map[string]struct {
		setup  func(f *repairFixture)
		reason string
	}{
		"row read":     {func(f *repairFixture) { f.store.failNext("GetTokenRow", errStoreDown) }, read},
		"journal read": {func(f *repairFixture) { f.store.failNext("GetOwnerJournal", errStoreDown) }, read},
		"engine read":  {func(f *repairFixture) { f.engine.fail = errStoreDown }, read},
		"repair write": {func(f *repairFixture) { f.store.failNext("RepairOwnerRow", errStoreDown) }, "the owner index could not be written; retry"},
	} {
		f := newRepairFixture(t)
		c.setup(f)
		_, err := f.resolve(t, f.store)
		rej := requireReject(t, err, CodeUnavailable, c.reason)
		if !errors.Is(rej, errStoreDown) {
			t.Fatalf("%s: the cause is lost: %v", name, rej.Cause)
		}
	}
}

func TestRepairOfASpentDeployUsesTheScriptRole(t *testing.T) {
	ctx := context.Background()
	d := mt.Deploy(t, mt.Issuer, "USD")
	is := mt.Issue(t, d, 0, mt.Issuer, mt.Holder, 100)
	topic, tok := "tm_"+d.Txid, d.Txid+"_0"
	inputs := brc162.ClassifyAdmittedInputs(is.Tx, []uint32{0})
	if inputs[0].Role != brc162.RoleAuthority || inputs[0].SourceRole != brc162.RoleDeploy {
		t.Fatalf("a spent deploy is an authority input with source role deploy: %+v", inputs[0])
	}
	resolve := func(s *memStore) error {
		_, err := ResolveInputOwners(ctx, inputs, envOf(t, is.OffChain), InputOwnerDeps{
			Store: s, Engine: engineFor(topic, is.Tx, []uint32{0}), Verifier: overlayVerifier(t), Topic: topic, OnRepair: func(string, bool) {}})
		return err
	}
	s := newMemStore()
	s.putOwner(OwnerRecord{Txid: d.Txid, OutputIndex: 0, Topic: topic, TokenID: tok, Role: brc162.RoleDeploy, Amount: 0, IdentityKey: mt.Issuer.Identity})
	if err := resolve(s); err != nil {
		t.Fatalf("deploy journal: %v", err)
	}
	if a, _ := s.GetAuthorityRow(ctx, d.Txid, 0); a == nil || a.Topic != topic || a.IdentityKey != mt.Issuer.Identity {
		t.Fatalf("repaired authority row: %+v", a)
	}
	wrongRole := newMemStore()
	wrongRole.putOwner(OwnerRecord{Txid: d.Txid, OutputIndex: 0, Topic: topic, TokenID: tok, Role: brc162.RoleAuthority, Amount: 0, IdentityKey: mt.Issuer.Identity})
	requireReject(t, resolve(wrongRole), CodeUnavailable, "owner index unavailable for "+d.Txid+".0")
	// The stored authority row's topic is not compared (F/ts-layers §14.7).
	other := newMemStore()
	other.putAuthority(AuthorityRecord{Txid: d.Txid, OutputIndex: 0, Topic: KYCTopic, TokenID: tok, IdentityKey: mt.Issuer.Identity})
	if err := resolve(other); err != nil {
		t.Fatalf("an agreeing row on another topic: %v", err)
	}
}

// R9: the repair compares the engine's bytes with the source's raw bytes, so a source whose
// payload push is non-minimal (PUSHDATA1 of one byte) still repairs.
func TestRepairComparesRawSourceBytes(t *testing.T) {
	ctx := context.Background()
	topic := "tm_" + strings.Repeat("ab", 32)
	id, _ := hex.DecodeString(strings.Repeat("ab", 32))
	raw := append([]byte{0x20}, id...)        // 32-byte id (byte order irrelevant here)
	raw = append(raw, 0x01, 0x64, 0x6d)       // amount 100, OP_2DROP
	raw = append(raw, 0x4c, 0x01, 0xaa, 0x75) // PUSHDATA1 <aa> OP_DROP: a non-minimal payload push
	raw = append(raw, 0x76, 0xa9, 0x14)       // P2PKH
	raw = append(raw, bytes.Repeat([]byte{0x11}, 20)...)
	raw = append(raw, 0x88, 0xac)
	srcScript := script.Script(raw)
	src := transaction.NewTransaction()
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: &srcScript})
	spend := transaction.NewTransaction()
	spend.AddInput(&transaction.TransactionInput{SourceTXID: src.TxID(), SourceTxOutIndex: 0, SourceTransaction: src, UnlockingScript: &script.Script{}})
	inputs := brc162.ClassifyAdmittedInputs(spend, []uint32{0})
	if len(inputs) != 1 || !bytes.Equal(inputs[0].Source, raw) {
		t.Fatalf("classified: %+v", inputs)
	}
	tokID := inputs[0].TokenID
	s := newMemStore()
	s.putOwner(OwnerRecord{Txid: src.TxID().String(), OutputIndex: 0, Topic: topic, TokenID: tokID, Role: brc162.RoleValue, Amount: 100, IdentityKey: mt.Holder.Identity})
	owners, err := ResolveInputOwners(ctx, inputs, &Envelope{}, InputOwnerDeps{Store: s, Engine: engineFor(topic, spend, []uint32{0}), Verifier: overlayVerifier(t), Topic: topic, OnRepair: func(string, bool) {}})
	if err != nil || owners[0] != mt.Holder.Identity {
		t.Fatalf("owners %v err %v", owners, err)
	}
}

func TestInputLinkageMustControlTheCoinAndNameItsOwner(t *testing.T) {
	ctx := context.Background()
	d := mt.Deploy(t, mt.Issuer, "USD")
	is := mt.Issue(t, d, 0, mt.Issuer, mt.Holder, 100)
	tok, topic := d.Txid+"_0", "tm_"+d.Txid
	tr := mt.Build(t, []mt.In{{Src: is, Vout: 1, WithLinkage: true}}, []mt.Out{{Owner: mt.Receiver, Prover: mt.Holder, TokenID: tok, Amount: 100}}, nil)
	inputs := brc162.ClassifyAdmittedInputs(tr.Tx, []uint32{0})
	stored := func(owner string) *memStore {
		s := newMemStore()
		s.putToken(TokenRecord{Txid: is.Txid, OutputIndex: 1, TokenID: tok, Amount: 100, IdentityKey: owner})
		return s
	}
	resolve := func(s *memStore, off []byte) error {
		_, err := ResolveInputOwners(ctx, inputs, envOf(t, off), InputOwnerDeps{Store: s, Engine: engineFor(topic, tr.Tx, []uint32{0}), Verifier: overlayVerifier(t), Topic: topic, OnRepair: func(string, bool) {}})
		return err
	}
	if err := resolve(stored(mt.Holder.Identity), tr.OffChain); err != nil {
		t.Fatalf("a linkage proving the owner: %v", err)
	}
	requireReject(t, resolve(stored(mt.Rogue.Identity), tr.OffChain), CodeLinkage,
		"input 0: linkage names "+mt.Holder.Identity+" but the coin is owned by "+mt.Rogue.Identity)
	// A linkage for another coin (the issue's output 0 key, revealed by the issuer).
	other := mt.Build(t, []mt.In{{Src: is, Vout: 0, WithLinkage: true}}, []mt.Out{{Owner: mt.Issuer, Prover: mt.Issuer, TokenID: tok}}, nil)
	var otherEnv map[string]any
	_ = json.Unmarshal(other.OffChain, &otherEnv)
	foreign := mutateEnvelope(t, tr.OffChain, func(env map[string]any) {
		env["inputs"].([]any)[0].(map[string]any)["linkage"] = otherEnv["inputs"].([]any)[0].(map[string]any)["linkage"]
	})
	for name, off := range map[string][]byte{
		"another coin's linkage": foreign,
		"empty object":           mutateEnvelope(t, tr.OffChain, func(env map[string]any) { env["inputs"].([]any)[0].(map[string]any)["linkage"] = map[string]any{} }),
		"no linkage member":      mutateEnvelope(t, tr.OffChain, func(env map[string]any) { delete(env["inputs"].([]any)[0].(map[string]any), "linkage") }),
	} {
		err := resolve(stored(mt.Holder.Identity), off)
		if err == nil {
			t.Fatalf("%s: accepted", name)
		}
		requireReject(t, err, CodeLinkage, "input 0: linkage does not control the coin being spent")
	}
	// An index fault on the owner is decided before the linkage: ERR_UNAVAILABLE, never ERR_LINKAGE.
	empty := newMemStore()
	requireReject(t, resolve(empty, foreign), CodeUnavailable, "owner index unavailable for "+is.Txid+".1")
}

// ---- journal, take-back, helpers ----

func TestJournalOwnersWritesOneRowPerOwner(t *testing.T) {
	ctx := context.Background()
	s := newMemStore()
	owners := []VerifiedOwner{
		{Index: 0, TokenID: "t_0", Role: brc162.RoleAuthority, Amount: 0, IdentityKey: mt.Issuer.Identity, Prover: mt.Issuer.Identity},
		{Index: 1, TokenID: "t_0", Role: brc162.RoleValue, Amount: 100, IdentityKey: mt.Holder.Identity, Prover: mt.Issuer.Identity},
	}
	if err := JournalOwners(ctx, s, "tm_x", "ab", owners); err != nil {
		t.Fatal(err)
	}
	if len(s.owners) != 2 || s.owners[1].Topic != "tm_x" || s.owners[1].Amount != 100 || s.owners[1].Role != brc162.RoleValue || !s.owners[0].CreatedAt.Equal(s.owners[1].CreatedAt) {
		t.Fatalf("journal rows: %+v", s.owners)
	}
	s.failNext("RecordOwners", errStoreDown)
	err := JournalOwners(ctx, s, "tm_x", "cd", owners)
	if rej := requireReject(t, err, CodeUnavailable, "the owner journal could not be written; retry"); !errors.Is(rej, errStoreDown) {
		t.Fatal("cause lost")
	}
}

func TestTakeBackRepairDebitsOnlyWhatItRemoves(t *testing.T) {
	ctx := context.Background()
	s := newMemStore()
	s.putToken(TokenRecord{Txid: "aa", OutputIndex: 1, TokenID: "t_0", Amount: 40, IdentityKey: mt.Holder.Identity})
	s.putAuthority(AuthorityRecord{Txid: "aa", OutputIndex: 0, TokenID: "t_0", IdentityKey: mt.Issuer.Identity})
	for i := 0; i < 2; i++ {
		if err := TakeBackRepair(ctx, s, "aa", 1, brc162.RoleValue); err != nil {
			t.Fatal(err)
		}
	}
	if b := s.balance(mt.Holder.Identity); b != -40 {
		t.Fatalf("balance %d, want one debit of 40", b)
	}
	if err := TakeBackRepair(ctx, s, "aa", 0, brc162.RoleDeploy); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.GetAuthorityRow(ctx, "aa", 0); a != nil {
		t.Fatal("authority not taken")
	}
}

func TestJournalAgrees(t *testing.T) {
	j := &OwnerRecord{TokenID: "t_0", Role: brc162.RoleValue, Amount: 5, IdentityKey: mt.Holder.Identity}
	if !journalAgrees(j, "t_0", brc162.RoleValue, 5) {
		t.Fatal("agreeing journal")
	}
	for name, ok := range map[string]bool{
		"nil":           journalAgrees(nil, "t_0", brc162.RoleValue, 5),
		"token":         journalAgrees(j, "u_0", brc162.RoleValue, 5),
		"role":          journalAgrees(j, "t_0", brc162.RoleAuthority, 5),
		"amount":        journalAgrees(j, "t_0", brc162.RoleValue, 6),
		"unsafe":        journalAgrees(&OwnerRecord{TokenID: "t_0", Role: brc162.RoleValue, Amount: Amount(MaxSafeAmount + 1), IdentityKey: mt.Holder.Identity}, "t_0", brc162.RoleValue, MaxSafeAmount+1),
		"negative":      journalAgrees(&OwnerRecord{TokenID: "t_0", Role: brc162.RoleValue, Amount: -5, IdentityKey: mt.Holder.Identity}, "t_0", brc162.RoleValue, 5),
		"uppercase key": journalAgrees(&OwnerRecord{TokenID: "t_0", Role: brc162.RoleValue, Amount: 5, IdentityKey: strings.ToUpper(mt.Holder.Identity)}, "t_0", brc162.RoleValue, 5),
	} {
		if ok {
			t.Fatalf("%s: agreed", name)
		}
	}
}

func TestLogOwnerRepairText(t *testing.T) {
	var buf bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) }()
	LogOwnerRepair("tm_x")("aa.1", true)
	LogOwnerRepair("reconcileOwnerIndex")("bb.0", false)
	want := "[tm_x] owner index repaired for aa.1 from the owner journal (row inserted)\n[reconcileOwnerIndex] owner index repaired for bb.0 from the owner journal (row corrected)\n"
	if buf.String() != want {
		t.Fatalf("log = %q", buf.String())
	}
}
