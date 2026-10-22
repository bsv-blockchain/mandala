package mandala

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/amount"
	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/colorprofile"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

var (
	mgrEpoch = time.Unix(0, 0).UTC()
	// mgrUntouched is a canonical token id no fixture deploys.
	mgrUntouched = strings.Repeat("ab", 32) + "_0"
)

func mgrTopic(t *testing.T, tokenID string) string {
	t.Helper()
	topic, err := TokenTopic(tokenID)
	if err != nil {
		t.Fatalf("topic of %s: %v", tokenID, err)
	}
	return topic
}

// mgrSeed leaves st as the lookups would after admitting b: for every token output one journal
// row and its value or authority row, under topic, or under the output's own token topic when
// topic is "".
func mgrSeed(t *testing.T, st *memStore, b *mandalatest.Built, topic string) {
	t.Helper()
	for n, o := range b.Outs {
		vout := uint32(n)
		tokenID, role := o.TokenID, brc162.RoleValue
		switch {
		case tokenID == "":
			tokenID, role = brc162.DeployTokenID(b.Txid, vout), brc162.RoleDeploy
		case o.Amount == 0:
			role = brc162.RoleAuthority
		}
		at := topic
		if at == "" {
			own, err := TokenTopic(tokenID)
			if err != nil {
				continue // a deploy not at vout 0 has no token topic
			}
			at = own
		}
		st.putOwner(OwnerRecord{Txid: b.Txid, OutputIndex: vout, Topic: at, TokenID: tokenID, Role: role,
			Amount: amount.FromUint64(o.Amount), IdentityKey: o.Owner.Identity, CreatedAt: mgrEpoch})
		if role == brc162.RoleValue {
			st.putToken(TokenRecord{Txid: b.Txid, OutputIndex: vout, TokenID: tokenID, Amount: amount.FromUint64(o.Amount),
				IdentityKey: o.Owner.Identity, CreatedAt: mgrEpoch})
		} else {
			st.putAuthority(AuthorityRecord{Txid: b.Txid, OutputIndex: vout, Topic: at, TokenID: tokenID,
				IdentityKey: o.Owner.Identity, CreatedAt: mgrEpoch})
		}
	}
}

func mgrParse(t *testing.T, b *mandalatest.Built) (*transaction.Beef, *chainhash.Hash, *transaction.Transaction) {
	t.Helper()
	beef, _, txid, err := transaction.ParseBeef(b.Beef)
	if err != nil {
		t.Fatalf("parse beef: %v", err)
	}
	tx := beef.FindTransactionForSigningByHash(txid)
	if tx == nil {
		t.Fatalf("tx %s not in its own beef", txid)
	}
	return beef, txid, tx
}

func mgrDeps(t *testing.T, st *memStore, eng EngineOutputReader) TokenTopicDeps {
	t.Helper()
	return TokenTopicDeps{
		Verifier:       overlayVerifier(t),
		TrustedIssuers: []string{mandalatest.Issuer.Identity},
		Store:          st,
		Engine:         eng,
		Screening:      NoSanctions{},
		OnOwnerRepair:  func(string, bool) {},
		// contract §4: the K every deploy's req names
		OverlayIdentityKey: mandalatest.Overlay.Identity,
	}
}

// mgrRunToken offers b to tm_<tokenID> as the engine would: off-chain values in ctx, the engine
// reader answering for the previousCoins sources on that topic.
func mgrRunToken(t *testing.T, tokenID string, b *mandalatest.Built, st *memStore, prev []uint32, mod func(*TokenTopicDeps)) (overlay.AdmittanceInstructions, error) {
	t.Helper()
	beef, txid, tx := mgrParse(t, b)
	d := mgrDeps(t, st, engineFor(mgrTopic(t, tokenID), tx, prev))
	if mod != nil {
		mod(&d)
	}
	m, err := NewTokenTopicManager(tokenID, d)
	if err != nil {
		t.Fatalf("token manager: %v", err)
	}
	return m.IdentifyAdmissibleOutputs(WithOffChainValues(context.Background(), b.OffChain), beef, txid, prev)
}

func mgrRunRegistry(t *testing.T, b *mandalatest.Built, st *memStore, prev []uint32, mod func(*TokenTopicDeps)) (overlay.AdmittanceInstructions, error) {
	t.Helper()
	beef, txid, tx := mgrParse(t, b)
	d := mgrDeps(t, st, engineFor(MandalaTopic, tx, prev))
	if mod != nil {
		mod(&d)
	}
	m, err := NewTokenRegistryTopicManager(d)
	if err != nil {
		t.Fatalf("registry manager: %v", err)
	}
	return m.IdentifyAdmissibleOutputs(WithOffChainValues(context.Background(), b.OffChain), beef, txid, prev)
}

func mgrRefusal(t *testing.T, err error, code Code, reason, topic string) *RejectError {
	t.Helper()
	var rej *RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("want a %s refusal, got %v", code, err)
	}
	if rej.Code != code || rej.Reason != reason || rej.Topic != topic {
		t.Fatalf("refusal = {%s %q %s}, want {%s %q %s}", rej.Code, rej.Reason, rej.Topic, code, reason, topic)
	}
	return rej
}

func mgrAdmit(t *testing.T, got overlay.AdmittanceInstructions, err error, outputs, coins []uint32) {
	t.Helper()
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if got.OutputsToAdmit == nil || got.CoinsToRetain == nil {
		t.Fatalf("nil slice in %+v: the wire needs [] not null", got)
	}
	if !slices.Equal(got.OutputsToAdmit, outputs) || !slices.Equal(got.CoinsToRetain, coins) {
		t.Fatalf("admitted {%v %v}, want {%v %v}", got.OutputsToAdmit, got.CoinsToRetain, outputs, coins)
	}
}

// mgrActionOut is an issuer-owned authority output of tokenID committing to d, with d in env.admin.
func mgrActionOut(t *testing.T, tokenID string, d AdminDetails) mandalatest.Out {
	t.Helper()
	details, err := EncodeAdminDetails(d)
	if err != nil {
		t.Fatalf("encode details: %v", err)
	}
	return mandalatest.Out{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer, TokenID: tokenID,
		Payload: mandalatest.AdmPayload(sha256.Sum256(details)), HasPayload: true, Details: details}
}

// mgrWithAdmin replaces the envelope's admin list (off-chain only: the txid is unchanged).
func mgrWithAdmin(t *testing.T, b *mandalatest.Built, admin string) *mandalatest.Built {
	t.Helper()
	var env map[string]json.RawMessage
	if err := json.Unmarshal(b.OffChain, &env); err != nil {
		t.Fatalf("envelope: %v", err)
	}
	env["admin"] = json.RawMessage(admin)
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("envelope: %v", err)
	}
	edited := *b
	edited.OffChain = raw
	return &edited
}

type mgrIssued struct {
	deploy, issue  *mandalatest.Built
	tokenID, topic string
}

// mgrIssue deploys sym and issues 100 of it to Holder (value at issue:1); both seeded into st.
func mgrIssue(t *testing.T, st *memStore, sym string) mgrIssued {
	t.Helper()
	d := mandalatest.Deploy(t, mandalatest.Issuer, sym)
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	mgrSeed(t, st, d, "")
	mgrSeed(t, st, iss, "")
	id := brc162.DeployTokenID(d.Txid, 0)
	return mgrIssued{deploy: d, issue: iss, tokenID: id, topic: mgrTopic(t, id)}
}

// mgrCodecRefusedTx: one token-shaped output whose last push is truncated (vector
// truncated-push-after-prefix: 20<id32> OP_5 OP_2DROP PUSHDATA1 len 5 with 1 byte).
func mgrCodecRefusedTx(t *testing.T) (*transaction.Beef, *chainhash.Hash, *transaction.Transaction) {
	t.Helper()
	raw, err := hex.DecodeString("20" + strings.Repeat("11", 32) + "556d4c05aa")
	if err != nil {
		t.Fatal(err)
	}
	lock := script.Script(raw)
	tx := transaction.NewTransaction()
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: &lock})
	beef, err := transaction.NewBeefFromTransaction(tx)
	if err != nil {
		t.Fatalf("beef: %v", err)
	}
	return beef, tx.TxID(), tx
}

type mgrSpends struct {
	spentBy map[string]string
	err     error
	topics  []string
}

func (s *mgrSpends) SpentBy(_ context.Context, topic, txid string, vout uint32) (string, error) {
	s.topics = append(s.topics, topic)
	if s.err != nil {
		return "", s.err
	}
	return s.spentBy[fmt.Sprintf("%s.%d", txid, vout)], nil
}

func TestTokenTopicAdmitsADeployAndJournalsIt(t *testing.T) {
	st := newMemStore()
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	got, err := mgrRunToken(t, id, d, st, nil, nil)
	mgrAdmit(t, got, err, []uint32{0}, []uint32{})
	if len(st.owners) != 1 {
		t.Fatalf("journal = %+v, want one row", st.owners)
	}
	j := st.owners[0]
	if j.Txid != d.Txid || j.OutputIndex != 0 || j.Topic != mgrTopic(t, id) || j.Role != brc162.RoleDeploy ||
		j.TokenID != id || j.IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("journal row = %+v", j)
	}
}

func TestTokenTopicRetainsOnlyClassifiedInputs(t *testing.T) {
	st := newMemStore()
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	mgrSeed(t, st, d, "")
	id := brc162.DeployTokenID(d.Txid, 0)
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	// input 1 is the P2PKH funding coin: previous on the topic, but not a token coin
	got, err := mgrRunToken(t, id, iss, st, []uint32{0, 1}, nil)
	mgrAdmit(t, got, err, []uint32{0, 1}, []uint32{0})
	var journaled []uint32
	for _, o := range st.owners {
		if o.Txid == iss.Txid {
			journaled = append(journaled, o.OutputIndex)
		}
	}
	if !slices.Equal(journaled, []uint32{0, 1}) {
		t.Fatalf("journaled outputs %v, want [0 1]", journaled)
	}
}

func TestTokenTopicIgnoresATransactionWithNothingOfItsToken(t *testing.T) {
	st := newMemStore()
	a := mgrIssue(t, st, "USD")
	tr := mandalatest.Transfer(t, a.issue, 1, mandalatest.Receiver, 40)
	before := len(st.owners)
	got, err := mgrRunToken(t, mgrUntouched, tr, st, nil, nil)
	mgrAdmit(t, got, err, []uint32{}, []uint32{})
	if len(st.owners) != before {
		t.Fatal("an untouched token topic journaled")
	}
}

func TestTokenTopicOrphanAdminEntryRefusesEveryTokenTopic(t *testing.T) {
	st := newMemStore()
	a := mgrIssue(t, st, "USD")
	tr := mgrWithAdmin(t, mandalatest.Transfer(t, a.issue, 1, mandalatest.Receiver, 40), `[{"index":7,"details":"a0"}]`)
	const reason = "admin entry 7 does not name a committed authority output"
	_, err := mgrRunToken(t, mgrUntouched, tr, st, nil, nil)
	mgrRefusal(t, err, CodeShape, reason, mgrTopic(t, mgrUntouched))
	_, err = mgrRunToken(t, a.tokenID, tr, st, []uint32{0}, nil)
	mgrRefusal(t, err, CodeShape, reason, a.topic)
	_, err = mgrRunRegistry(t, tr, st, nil, nil)
	mgrRefusal(t, err, CodeShape, reason, MandalaTopic)
}

func TestTokenTopicCodecRefusedOutputRefusesEveryTopic(t *testing.T) {
	beef, txid, tx := mgrCodecRefusedTx(t)
	const reason = "output 0: token-shaped output is not a valid BRC-162 token output (truncated push)"
	d := mgrDeps(t, newMemStore(), engineFor(MandalaTopic, tx, nil))
	untouched, err := NewTokenTopicManager(mgrUntouched, d)
	if err != nil {
		t.Fatal(err)
	}
	_, err = untouched.IdentifyAdmissibleOutputs(context.Background(), beef, txid, nil)
	mgrRefusal(t, err, CodeShape, reason, mgrTopic(t, mgrUntouched))
	ownID := brc162.DeployTokenID(txid.String(), 0)
	own, err := NewTokenTopicManager(ownID, d)
	if err != nil {
		t.Fatal(err)
	}
	_, err = own.IdentifyAdmissibleOutputs(context.Background(), beef, txid, nil)
	mgrRefusal(t, err, CodeShape, reason, mgrTopic(t, ownID))
	reg, err := NewTokenRegistryTopicManager(d)
	if err != nil {
		t.Fatal(err)
	}
	_, err = reg.IdentifyAdmissibleOutputs(context.Background(), beef, txid, nil)
	mgrRefusal(t, err, CodeShape, reason, MandalaTopic)
}

func TestTokenTopicScopesATwoTokenTransfer(t *testing.T) {
	st := newMemStore()
	a := mgrIssue(t, st, "USD")
	b := mgrIssue(t, st, "EUR")
	two := mandalatest.TwoTokenTransfer(t, a.issue, 1, b.issue, 1, mandalatest.Receiver)
	got, err := mgrRunToken(t, a.tokenID, two, st, []uint32{0}, nil)
	mgrAdmit(t, got, err, []uint32{0}, []uint32{0})
	got, err = mgrRunToken(t, b.tokenID, two, st, []uint32{1}, nil)
	mgrAdmit(t, got, err, []uint32{1}, []uint32{1})

	burn := mandalatest.Build(t,
		[]mandalatest.In{{Src: a.issue, Vout: 1}, {Src: b.issue, Vout: 1}},
		[]mandalatest.Out{
			{Owner: mandalatest.Receiver, Prover: mandalatest.Holder, TokenID: a.tokenID, Amount: 100},
			{Owner: mandalatest.Receiver, Prover: mandalatest.Holder, TokenID: b.tokenID, Amount: 40},
		}, nil)
	got, err = mgrRunToken(t, a.tokenID, burn, st, []uint32{0}, nil)
	mgrAdmit(t, got, err, []uint32{0}, []uint32{0})
	_, err = mgrRunToken(t, b.tokenID, burn, st, []uint32{1}, nil)
	mgrRefusal(t, err, CodeConservation, "token "+b.tokenID+": value in 100 != value out 40 without an authority", b.topic)
}

func TestTokenTopicForeignAdminEntryIsNotAnOrphan(t *testing.T) {
	st := newMemStore()
	a := mgrIssue(t, st, "USD")
	bDeploy := mandalatest.Deploy(t, mandalatest.Issuer, "EUR")
	mgrSeed(t, st, bDeploy, "")
	bID := brc162.DeployTokenID(bDeploy.Txid, 0)
	mixed := mandalatest.Build(t,
		[]mandalatest.In{{Src: a.issue, Vout: 1}, {Src: bDeploy, Vout: 0}},
		[]mandalatest.Out{
			{Owner: mandalatest.Receiver, Prover: mandalatest.Holder, TokenID: a.tokenID, Amount: 100},
			mgrActionOut(t, bID, AdminDetails{Kind: "issue"}),
			{Owner: mandalatest.Holder, Prover: mandalatest.Issuer, TokenID: bID, Amount: 30},
		}, nil)
	got, err := mgrRunToken(t, a.tokenID, mixed, st, []uint32{0}, nil)
	mgrAdmit(t, got, err, []uint32{0}, []uint32{0})
	got, err = mgrRunToken(t, bID, mixed, st, []uint32{1}, nil)
	mgrAdmit(t, got, err, []uint32{1, 2}, []uint32{1})
}

func TestTokenTopicDeployNotAtZeroIsNotItsToken(t *testing.T) {
	b := mandalatest.Build(t, nil, []mandalatest.Out{
		{Owner: mandalatest.Holder, Prover: mandalatest.Issuer, TokenID: mgrUntouched, Amount: 5},
		{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer, Payload: mandalatest.DeployPayload("USD", 2, "US Dollar"), HasPayload: true},
	}, nil)
	got, err := mgrRunToken(t, brc162.DeployTokenID(b.Txid, 0), b, newMemStore(), nil, nil)
	mgrAdmit(t, got, err, []uint32{}, []uint32{})
	got, err = mgrRunRegistry(t, b, newMemStore(), nil, nil)
	mgrAdmit(t, got, err, []uint32{}, []uint32{})
}

// legacyIDFixture spends the issue's 100-unit value coin into output 0, a token-shaped output
// carrying the legacy 36-byte id <deploy txid>_1, and output 1, all 100 units of the topic's own
// token. Scoped to the token, output 0 is a foreign asset and the rest conserves, so only a
// refusal that runs before ScopeToToken refuses it.
func legacyIDFixture(t *testing.T, st *memStore) (mgrIssued, *mandalatest.Built, string) {
	t.Helper()
	a := mgrIssue(t, st, "USD")
	legacyID := a.deploy.Txid + "_1"
	b := mandalatest.Build(t, []mandalatest.In{{Src: a.issue, Vout: 1}}, []mandalatest.Out{
		{Owner: mandalatest.Receiver, Prover: mandalatest.Holder, TokenID: legacyID, Amount: 5},
		{Owner: mandalatest.Receiver, Prover: mandalatest.Holder, TokenID: a.tokenID, Amount: 100},
	}, nil)
	return a, b, legacyID
}

func TestTokenTopicRefusesLegacyTokenID(t *testing.T) {
	st := newMemStore()
	a, b, legacyID := legacyIDFixture(t, st)
	if len(b.Tx.Outputs[0].LockingScript.Bytes()) == 0 || b.Tx.Outputs[0].LockingScript.Bytes()[0] != 36 {
		t.Fatalf("fixture output 0 is not a 36-byte id push: %x", b.Tx.Outputs[0].LockingScript.Bytes())
	}
	reason := "output 0: legacy 36-byte token id " + legacyID + " is refused by Mandala policy (32-byte ids only)"
	_, err := mgrRunToken(t, a.tokenID, b, st, []uint32{0}, nil)
	mgrRefusal(t, err, CodeShape, reason, a.topic)
	// a topic with nothing of this transaction refuses it too: the check runs before scoping
	_, err = mgrRunToken(t, mgrUntouched, b, st, nil, nil)
	mgrRefusal(t, err, CodeShape, reason, mgrTopic(t, mgrUntouched))
	_, err = mgrRunRegistry(t, b, st, nil, nil)
	mgrRefusal(t, err, CodeShape, reason, MandalaTopic)
	if len(st.owners) != 3 { // mgrIssue's seed (deploy 1 row, issue 2 rows): the refusal journals nothing
		t.Fatalf("journal grew to %d rows", len(st.owners))
	}
}

func TestRequireNoLegacyTokenIDs(t *testing.T) {
	txid := strings.Repeat("cd", 32)
	outs := []brc162.Output{
		{Index: 0, Role: brc162.RoleValue, TokenID: txid + "_0"},
		{Index: 1, Role: brc162.RoleDeploy, TokenID: brc162.DeployTokenID(txid, 1)}, // a deploy names itself; not a wire id
		{Index: 2, Role: brc162.RoleAuthority, TokenID: txid + "_9"},
		{Index: 3, Role: brc162.RoleValue, TokenID: txid + "_4"},
	}
	if err := RequireNoLegacyTokenIDs(outs[:2]); err != nil {
		t.Fatalf("no legacy wire id: %v", err)
	}
	requireReject(t, RequireNoLegacyTokenIDs(outs), CodeShape,
		"output 2: legacy 36-byte token id "+txid+"_9 is refused by Mandala policy (32-byte ids only)")
}

func TestTokenTopicConflictingSpendGuard(t *testing.T) {
	other := strings.Repeat("99", 32)
	setup := func(t *testing.T) (*memStore, *mandalatest.Built, *mandalatest.Built, string) {
		st := newMemStore()
		d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
		mgrSeed(t, st, d, "")
		return st, d, mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100), brc162.DeployTokenID(d.Txid, 0)
	}
	t.Run("spent by another transaction", func(t *testing.T) {
		st, d, iss, id := setup(t)
		spends := &mgrSpends{spentBy: map[string]string{d.Txid + ".0": other}}
		_, err := mgrRunToken(t, id, iss, st, []uint32{0}, func(dd *TokenTopicDeps) { dd.Spends = spends })
		rej := mgrRefusal(t, err, CodeInputSpent, "input "+d.Txid+".0: already spent by "+other, mgrTopic(t, id))
		if rej.SpendTxid != other {
			t.Fatalf("SpendTxid = %q, want %q", rej.SpendTxid, other)
		}
		if !slices.Equal(spends.topics, []string{mgrTopic(t, id)}) {
			t.Fatalf("SpentBy asked topics %v", spends.topics)
		}
	})
	t.Run("spent by itself", func(t *testing.T) {
		st, d, iss, id := setup(t)
		spends := &mgrSpends{spentBy: map[string]string{d.Txid + ".0": strings.ToUpper(iss.Txid)}}
		got, err := mgrRunToken(t, id, iss, st, []uint32{0}, func(dd *TokenTopicDeps) { dd.Spends = spends })
		mgrAdmit(t, got, err, []uint32{0, 1}, []uint32{0})
	})
	t.Run("store fault", func(t *testing.T) {
		st, _, iss, id := setup(t)
		boom := errors.New("boom")
		_, err := mgrRunToken(t, id, iss, st, []uint32{0}, func(dd *TokenTopicDeps) { dd.Spends = &mgrSpends{err: boom} })
		mgrRefusal(t, err, CodeUnavailable, "the engine output store could not be read; retry", mgrTopic(t, id))
		if !errors.Is(err, boom) {
			t.Fatalf("cause lost: %v", err)
		}
	})
	t.Run("before the envelope", func(t *testing.T) {
		st, d, iss, id := setup(t)
		malformed := *iss
		malformed.OffChain = []byte("[]")
		spends := &mgrSpends{spentBy: map[string]string{d.Txid + ".0": other}}
		_, err := mgrRunToken(t, id, &malformed, st, []uint32{0}, func(dd *TokenTopicDeps) { dd.Spends = spends })
		mgrRefusal(t, err, CodeInputSpent, "input "+d.Txid+".0: already spent by "+other, mgrTopic(t, id))
	})
}

func TestTokenTopicEnvelopeBeforeCodec(t *testing.T) {
	beef, txid, tx := mgrCodecRefusedTx(t)
	m, err := NewTokenTopicManager(mgrUntouched, mgrDeps(t, newMemStore(), engineFor(mgrTopic(t, mgrUntouched), tx, nil)))
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.IdentifyAdmissibleOutputs(WithOffChainValues(context.Background(), []byte("[]")), beef, txid, nil)
	mgrRefusal(t, err, CodeShape, "Mandala payload must be an object", mgrTopic(t, mgrUntouched))
}

func TestTokenTopicTxidNotInBeefIsUntyped(t *testing.T) {
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	beef, _, tx := mgrParse(t, d)
	m, err := NewTokenTopicManager(id, mgrDeps(t, newMemStore(), engineFor(mgrTopic(t, id), tx, nil)))
	if err != nil {
		t.Fatal(err)
	}
	missing := chainhash.Hash{0x01}
	_, err = m.IdentifyAdmissibleOutputs(context.Background(), beef, &missing, nil)
	var rej *RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("want a *RejectError, got %v", err)
	}
	if rej.Code != "" || rej.Reason == "" || rej.Topic != mgrTopic(t, id) {
		t.Fatalf("untyped refusal = %+v; want Code \"\", a reason, Topic %s", rej, mgrTopic(t, id))
	}
}

func TestTokenTopicConstructorsAndMetaData(t *testing.T) {
	d := mgrDeps(t, newMemStore(), nil)
	if _, err := NewTokenTopicManager("ab", d); err == nil || err.Error() != "not a canonical Mandala token id: ab" {
		t.Fatalf("bad id error = %v", err)
	}
	empty := d
	empty.TrustedIssuers = nil
	if _, err := NewTokenTopicManager(mgrUntouched, empty); err == nil || err.Error() != "TokenTopicManager: trustedIssuers must be a non-empty array" {
		t.Fatalf("empty trusted error = %v", err)
	}
	upper := strings.ToUpper(mandalatest.Holder.Identity)
	badExempt := d
	badExempt.MembershipExempt = []string{upper}
	if _, err := NewTokenTopicManager(mgrUntouched, badExempt); err == nil ||
		err.Error() != "TokenTopicManager: membership-exempt key "+upper+" is not a compressed lowercase public key" {
		t.Fatalf("bad exempt error = %v", err)
	}
	m, err := NewTokenTopicManager(mgrUntouched, d)
	if err != nil {
		t.Fatal(err)
	}
	if m.Topic() != mgrTopic(t, mgrUntouched) || m.TokenID() != mgrUntouched {
		t.Fatalf("Topic/TokenID = %s %s", m.Topic(), m.TokenID())
	}
	md := m.GetMetaData()
	want := "Mandala BRC-162 token " + mgrUntouched + ": authority and value outputs, identity linkage, issuer controls."
	if md.Name != m.Topic() || md.Description != want {
		t.Fatalf("metadata = %+v", md)
	}
	if ins, err := m.IdentifyNeededInputs(context.Background(), nil, nil); ins != nil || err != nil {
		t.Fatalf("IdentifyNeededInputs = %v, %v", ins, err)
	}
	if m.GetDocumentation() == "" {
		t.Fatal("empty documentation")
	}
}

// identifyDeploy runs a deploy as the HTTP deploy path does: the token registry's dry run, then the
// deploy's own token topic tm_color_<txid>_0, each over a fresh store. It returns the token topic's
// admittance, or the first refusal.
func identifyDeploy(t *testing.T, b *mandalatest.Built) (overlay.AdmittanceInstructions, error) {
	t.Helper()
	if _, err := mgrRunRegistry(t, b, newMemStore(), nil, nil); err != nil {
		return overlay.AdmittanceInstructions{}, err
	}
	return mgrRunToken(t, brc162.DeployTokenID(b.Txid, 0), b, newMemStore(), nil, nil)
}

// swapFirstTwoKeys re-serializes the strict-CBOR map payload with its first two entries (canonical
// order) swapped: every key and value is the codec's own encoding, only the order is wrong.
func swapFirstTwoKeys(t *testing.T, payload []byte) []byte {
	t.Helper()
	m, err := brc162.DecodeStrictCbor(payload)
	if err != nil || len(m) < 2 || len(m) > 23 {
		t.Fatalf("swapFirstTwoKeys: %d keys, %v", len(m), err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, detKeyLess)
	keys[0], keys[1] = keys[1], keys[0]
	out := []byte{0xa0 | byte(len(keys))}
	for _, k := range keys {
		kb, err := brc162.EncodeStrictCborValue(k)
		if err != nil {
			t.Fatal(err)
		}
		vb, err := brc162.EncodeStrictCborValue(m[k])
		if err != nil {
			t.Fatal(err)
		}
		out = append(append(out, kb...), vb...)
	}
	return out
}

// Review Focus 4: the deploy req is exactly attested(identity K) + issuer-v1(K) for this overlay's
// K; ext is absent; icon is [text, bytes]. Every refusal is the final ERR_SHAPE deploy-payload one.
func TestDeployReqPolicy(t *testing.T) {
	K := mandalatest.Overlay.Identity
	good := colorprofile.MandalaReq(K)
	extra := colorprofile.MandalaReq(K)
	extra["https://example.com/p"] = brc162.CborMap{"version": uint64(1), "params": nil}
	anyMode := colorprofile.MandalaReq(K)
	anyMode[colorprofile.AttestedProfileID].(brc162.CborMap)["params"].(brc162.CborMap)["trustMode"] = "any"
	noAttested := colorprofile.MandalaReq(K)
	delete(noAttested, colorprofile.AttestedProfileID)
	v2 := colorprofile.MandalaReq(K)
	v2[colorprofile.MandalaProfileID].(brc162.CborMap)["version"] = uint64(2)
	upperK := colorprofile.MandalaReq(strings.ToUpper(K))
	base := func(extraKV brc162.CborMap) brc162.CborMap {
		m := brc162.CborMap{"sym": "TUSD", "dec": uint64(2), "label": "Test Dollar"}
		for k, v := range extraKV {
			m[k] = v
		}
		return m
	}
	cases := []struct {
		name   string
		m      brc162.CborMap
		reason string
	}{
		{"no req", base(nil), "missing key req"},
		{"other key", base(brc162.CborMap{"req": colorprofile.MandalaReq(mandalatest.Rogue.Identity)}), "req does not match this overlay's Mandala profiles"},
		{"uppercase key", base(brc162.CborMap{"req": upperK}), "req does not match this overlay's Mandala profiles"},
		{"extra profile", base(brc162.CborMap{"req": extra}), "req does not match this overlay's Mandala profiles"},
		{"missing attested", base(brc162.CborMap{"req": noAttested}), "req does not match this overlay's Mandala profiles"},
		{"issuer version 2", base(brc162.CborMap{"req": v2}), "req does not match this overlay's Mandala profiles"},
		{"trustMode any", base(brc162.CborMap{"req": anyMode}), "req does not match this overlay's Mandala profiles"},
		{"empty req", base(brc162.CborMap{"req": brc162.CborMap{}}), "req does not match this overlay's Mandala profiles"},
		{"req text", base(brc162.CborMap{"req": "x"}), "req must be a map"},
		{"req null", base(brc162.CborMap{"req": nil}), "req must be a map"},
		{"ext", base(brc162.CborMap{"req": good, "ext": brc162.CborMap{}}), "ext is not allowed on a Mandala deploy"},
		{"ext without req", base(brc162.CborMap{"ext": brc162.CborMap{}}), "ext is not allowed on a Mandala deploy"},
		{"bad icon", base(brc162.CborMap{"req": good, "icon": []any{"image/png"}}), "icon must be [mediaType, bytes]"},
		{"icon swapped", base(brc162.CborMap{"req": good, "icon": []any{[]byte{0x89}, "image/png"}}), "icon must be [mediaType, bytes]"},
		{"icon text", base(brc162.CborMap{"req": good, "icon": "image/png"}), "icon must be [mediaType, bytes]"},
		{"icon three", base(brc162.CborMap{"req": good, "icon": []any{"image/png", []byte{0x89}, "x"}}), "icon must be [mediaType, bytes]"},
		// existing rules keep their reasons and run before the new ones
		{"sym before req", brc162.CborMap{"dec": uint64(2), "label": "Test Dollar", "ext": brc162.CborMap{}}, "missing key sym"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := identifyDeploy(t, mandalatest.DeployWithPayload(t, mandalatest.Issuer, mandalatest.DeployPayloadWith(c.m)))
			requireReject(t, err, "ERR_SHAPE", "output 0: deploy payload is not a valid Mandala deploy map ("+c.reason+")")
		})
	}
	for _, ok := range []brc162.CborMap{base(brc162.CborMap{"req": good}), base(brc162.CborMap{"req": good, "icon": []any{"image/png", []byte{0x89, 0x50}}})} {
		adm, err := identifyDeploy(t, mandalatest.DeployWithPayload(t, mandalatest.Issuer, mandalatest.DeployPayloadWith(ok)))
		if err != nil || !slices.Equal(adm.OutputsToAdmit, []uint32{0}) {
			t.Fatal(adm, err)
		}
	}
	unsorted := mandalatest.DeployPayloadWith(base(brc162.CborMap{"req": good}))
	_, err := identifyDeploy(t, mandalatest.DeployWithPayload(t, mandalatest.Issuer, swapFirstTwoKeys(t, unsorted)))
	requireReject(t, err, "ERR_SHAPE", "output 0: deploy payload is not a valid Mandala deploy map (map keys unsorted or duplicated)")
}

// Contract §4 step 2: deploySig and the trusted-issuer rules run before the req check, so a deploy
// with no req is refused for those first.
func TestDeployReqCheckedAfterDeploySigAndTrust(t *testing.T) {
	noReq := mandalatest.DeployPayloadWith(brc162.CborMap{"sym": "TUSD", "dec": uint64(2), "label": "Test Dollar"})
	unsigned := mandalatest.Build(t, nil, []mandalatest.Out{{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer, Payload: noReq, HasPayload: true}}, nil)
	_, err := identifyDeploy(t, unsigned)
	requireReject(t, err, "ERR_AUTHORITY", "output 0: deploy requires a valid deploySig over this txid")
	rogue := mandalatest.DeployWithPayload(t, mandalatest.Rogue, noReq)
	_, err = identifyDeploy(t, rogue)
	requireReject(t, err, "ERR_UNTRUSTED", "output 0: owner "+mandalatest.Rogue.Identity+" is not a trusted issuer")
}

// Contract §4 step 5: req and ext are deploy-only; an authority {adm} payload is unchanged.
func TestNonDeployOutputWithReqRefused(t *testing.T) {
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := mandalatest.TokenIDOf(dep, 0)
	details := mandalatest.Details(brc162.CborMap{"kind": "issue"})
	issueWith := func(payload []byte) *mandalatest.Built {
		return mandalatest.Build(t, []mandalatest.In{{Src: dep, Vout: 0}}, []mandalatest.Out{
			{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer, TokenID: id, Payload: mandalatest.AdmPayload(sha256.Sum256(details)), HasPayload: true, Details: details},
			{Owner: mandalatest.Holder, Prover: mandalatest.Issuer, TokenID: id, Amount: 100, Payload: payload, HasPayload: true},
		}, nil)
	}
	for _, m := range []brc162.CborMap{{"req": brc162.CborMap{}}, {"ext": nil}, {"note": "x", "req": colorprofile.MandalaReq(mandalatest.Overlay.Identity)}} {
		st := newMemStore()
		mgrSeed(t, st, dep, "")
		_, err := mgrRunToken(t, id, issueWith(mandalatest.DeployPayloadWith(m)), st, []uint32{0}, nil)
		requireReject(t, err, "ERR_SHAPE", "output 1: req and ext are deploy-only under Mandala policy")
	}
	// any other value payload (a map without req/ext, or bytes that are not a strict map) is not this rule's business
	for _, payload := range [][]byte{mandalatest.DeployPayloadWith(brc162.CborMap{"note": "x"}), {0x01, 0x02}} {
		st := newMemStore()
		mgrSeed(t, st, dep, "")
		adm, err := mgrRunToken(t, id, issueWith(payload), st, []uint32{0}, nil)
		if err != nil || !slices.Equal(adm.OutputsToAdmit, []uint32{0, 1}) {
			t.Fatal(adm, err)
		}
	}
}

func TestNewTokenTopicManagerNeedsOverlayKey(t *testing.T) {
	const want = "TokenTopicManager: OverlayIdentityKey must be a compressed lowercase identity key"
	for _, k := range []string{"", strings.ToUpper(mandalatest.Overlay.Identity), mandalatest.Overlay.Identity[:64], "04" + mandalatest.Overlay.Identity[2:]} {
		d := mgrDeps(t, newMemStore(), nil)
		d.OverlayIdentityKey = k
		if _, err := NewTokenTopicManager(mgrUntouched, d); err == nil || err.Error() != want {
			t.Fatalf("%q: %v", k, err)
		}
		if _, err := NewTokenRegistryTopicManager(d); err == nil || err.Error() != "TokenRegistryTopicManager: OverlayIdentityKey must be a compressed lowercase identity key" {
			t.Fatalf("registry %q: %v", k, err)
		}
	}
}
