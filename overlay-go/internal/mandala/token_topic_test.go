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

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
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
			Amount: Amount(o.Amount), IdentityKey: o.Owner.Identity, CreatedAt: mgrEpoch})
		if role == brc162.RoleValue {
			st.putToken(TokenRecord{Txid: b.Txid, OutputIndex: vout, TokenID: tokenID, Amount: Amount(o.Amount),
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
