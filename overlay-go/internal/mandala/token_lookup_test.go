package mandala

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

func lkStore(t *testing.T) (*Store, *mongo.Database, context.Context) {
	t.Helper()
	db := testmongo.DB(t, "mandala3_test_lookups")
	st, err := NewStore(db)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return st, db, ctx
}

func lkToken(t *testing.T, store *Store, tokenID string) *TokenLookupService {
	t.Helper()
	ls, err := NewTokenLookupService(tokenID, overlayVerifier(t), store)
	if err != nil {
		t.Fatalf("token lookup: %v", err)
	}
	return ls
}

// lkAdmit notifies ls of b's outputs vouts admitted on topic, as the engine does after a commit.
func lkAdmit(t *testing.T, ls engine.LookupService, b *mandalatest.Built, topic string, vouts ...uint32) {
	t.Helper()
	for _, vout := range vouts {
		p := &engine.OutputAdmittedByTopic{Topic: topic, OutputIndex: vout, AtomicBEEF: b.Beef, OffChainValues: b.OffChain}
		if err := ls.OutputAdmittedByTopic(context.Background(), p); err != nil {
			t.Fatalf("admit %s.%d on %s: %v", b.Txid, vout, topic, err)
		}
	}
}

func lkOutpoint(t *testing.T, txid string, vout uint32) *transaction.Outpoint {
	t.Helper()
	op, err := transaction.OutpointFromString(fmt.Sprintf("%s.%d", txid, vout))
	if err != nil {
		t.Fatal(err)
	}
	return op
}

func lkAsk(t *testing.T, ls engine.LookupService, service, query string) ([]string, error) {
	t.Helper()
	ans, err := ls.Lookup(context.Background(), &lookup.LookupQuestion{Service: service, Query: json.RawMessage(query)})
	if err != nil {
		return nil, err
	}
	if ans.Type != lookup.AnswerTypeFormula {
		t.Fatalf("answer type %s, want formula", ans.Type)
	}
	out := []string{}
	for _, f := range ans.Formulas {
		out = append(out, f.Outpoint.String())
	}
	return out, nil
}

func lkCount(t *testing.T, ctx context.Context, db *mongo.Database, coll string, filter bson.D) int64 {
	t.Helper()
	n, err := db.Collection(coll).CountDocuments(ctx, filter)
	if err != nil {
		t.Fatalf("count %s: %v", coll, err)
	}
	return n
}

func TestTokenLookupIgnoresAnotherTopicsOutputs(t *testing.T) {
	st, db, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	ls := lkToken(t, st, brc162.DeployTokenID(d.Txid, 0))
	lkAdmit(t, ls, d, mgrTopic(t, mgrUntouched), 0)
	lkAdmit(t, ls, d, MandalaTopic, 0)
	for _, coll := range []string{MetadataCollection, AuthoritiesCollection, AssetStatesCollection, LinkageCollection, AdminHistoryCollection, TokensCollection} {
		if n := lkCount(t, ctx, db, coll, bson.D{}); n != 0 {
			t.Fatalf("%s has %d docs after another topic's notification", coll, n)
		}
	}
}

func TestTokenLookupIndexesADeploy(t *testing.T) {
	st, db, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := lkToken(t, st, id)
	lkAdmit(t, ls, d, ls.Topic(), 0)
	md, err := st.FindMetadata(ctx, id)
	if err != nil || md == nil || md.Txid != d.Txid || md.OutputIndex != 0 || md.Sym != "USD" || md.Dec != 2 || md.Label != "US Dollar" || md.FeeRatePerKb != nil {
		t.Fatalf("metadata = %+v, %v", md, err)
	}
	if n := lkCount(t, ctx, db, AssetStatesCollection, bson.D{{Key: "tokenId", Value: id}}); n != 1 {
		t.Fatalf("%d asset state docs, want the default persisted", n)
	}
	a, err := st.GetAuthorityRow(ctx, d.Txid, 0)
	if err != nil || a == nil || a.Topic != ls.Topic() || a.TokenID != id || a.IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("deploy authority row = %+v, %v", a, err)
	}
	links, err := st.FindLinkageByOutpoints(ctx, []Outpoint{{Txid: d.Txid, OutputIndex: 0}})
	if err != nil || len(links) != 1 || links[0].IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("linkage = %+v, %v", links, err)
	}

	feePayload := mandalatest.Details(brc162.CborMap{"sym": "FEE", "dec": uint64(2), "label": "Fee Dollar", "feeRatePerKb": uint64(50)})
	fee := mandalatest.Build(t, nil, []mandalatest.Out{{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer, Payload: feePayload, HasPayload: true}}, &mandalatest.Issuer)
	feeID := brc162.DeployTokenID(fee.Txid, 0)
	feeLs := lkToken(t, st, feeID)
	lkAdmit(t, feeLs, fee, feeLs.Topic(), 0)
	if md, _ := st.FindMetadata(ctx, feeID); md == nil || md.FeeRatePerKb == nil || *md.FeeRatePerKb != 50 {
		t.Fatalf("fee metadata = %+v", md)
	}
	if s, _ := st.GetAssetState(ctx, feeID); s.FeeRatePerKb == nil || *s.FeeRatePerKb != 50 {
		t.Fatalf("first state fee = %v, want 50", s.FeeRatePerKb)
	}
}

func TestTokenLookupRecordsAnIssueOnceAndCreditsOnce(t *testing.T) {
	st, _, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := lkToken(t, st, id)
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	lkAdmit(t, ls, d, ls.Topic(), 0)
	lkAdmit(t, ls, iss, ls.Topic(), 0, 1)

	history, err := st.FindAdminHistory(ctx, id, 0, 0)
	if err != nil || len(history) != 1 {
		t.Fatalf("history = %+v, %v; want one row", history, err)
	}
	h := history[0]
	if h.Kind != "issue" || h.Txid != iss.Txid || h.OutputIndex != 0 || h.Delta != 100 || h.Height != 9007199254740991 ||
		h.Offset != 0 || len(h.Commitment) != 64 || h.FrozenAmount != nil || h.AdmitSeq < 1 {
		t.Fatalf("history row = %+v", h)
	}
	state, _ := st.GetAssetState(ctx, id)
	if state.LastAdmitSeq != h.AdmitSeq || state.LastProcessedHeight != h.Height {
		t.Fatalf("state not folded at the action: %+v", state)
	}
	row, _ := st.GetTokenRow(ctx, iss.Txid, 1)
	if row == nil || row.Amount != 100 || row.IdentityKey != mandalatest.Holder.Identity || row.TokenID != id {
		t.Fatalf("value row = %+v", row)
	}
	if a, _ := st.GetAuthorityRow(ctx, iss.Txid, 0); a == nil || a.Topic != ls.Topic() {
		t.Fatalf("new authority row = %+v", a)
	}
	// a linkage record for every role: the authority (owner issuer) and the value (owner holder)
	links, err := st.FindLinkageByOutpoints(ctx, []Outpoint{{Txid: iss.Txid, OutputIndex: 0}, {Txid: iss.Txid, OutputIndex: 1}})
	if err != nil || len(links) != 2 {
		t.Fatalf("linkage records = %+v, %v; want one per output", links, err)
	}

	lkAdmit(t, ls, iss, ls.Topic(), 0, 1) // a replayed notification
	if bal, _ := st.GetBalance(ctx, mandalatest.Holder.Identity); bal != 100 {
		t.Fatalf("balance = %d after a replay, want 100", bal)
	}
	if again, _ := st.FindAdminHistory(ctx, id, 0, 0); len(again) != 1 {
		t.Fatalf("%d history rows after a replay, want 1", len(again))
	}
	if s, _ := st.GetAssetState(ctx, id); s.LastAdmitSeq != h.AdmitSeq {
		t.Fatalf("a replay refolded: lastAdmitSeq %d, want %d", s.LastAdmitSeq, h.AdmitSeq)
	}
}

func TestTokenLookupRecordsTheFreezeContext(t *testing.T) {
	st, _, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := lkToken(t, st, id)
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	lkAdmit(t, ls, d, ls.Topic(), 0)
	lkAdmit(t, ls, iss, ls.Topic(), 0, 1)
	frozenOp := iss.Txid + ".1"
	freeze := mandalatest.Build(t, []mandalatest.In{{Src: iss, Vout: 0}},
		[]mandalatest.Out{mgrActionOut(t, id, AdminDetails{Kind: "freezeOutput", Outpoint: frozenOp})}, nil)
	lkAdmit(t, ls, freeze, ls.Topic(), 0)

	history, _ := st.FindAdminHistory(ctx, id, 0, 0)
	var row *AdminHistoryEntry
	for i := range history {
		if history[i].Txid == freeze.Txid {
			row = &history[i]
		}
	}
	if row == nil || row.FrozenAmount == nil || *row.FrozenAmount != 100 || row.FrozenOwner == nil || *row.FrozenOwner != mandalatest.Holder.Identity {
		t.Fatalf("freeze history row = %+v", row)
	}
	state, _ := st.GetAssetState(ctx, id)
	want := []FrozenRef{{Outpoint: frozenOp, Amount: 100, Owner: mandalatest.Holder.Identity}}
	if !slices.Equal(state.FrozenOutpoints, want) {
		t.Fatalf("frozen = %+v, want %+v", state.FrozenOutpoints, want)
	}
}

func TestTokenLookupSpendsAndEvictions(t *testing.T) {
	st, _, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := lkToken(t, st, id)
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	lkAdmit(t, ls, d, ls.Topic(), 0)
	lkAdmit(t, ls, iss, ls.Topic(), 0, 1)
	holder, receiver := mandalatest.Holder.Identity, mandalatest.Receiver.Identity

	if err := ls.OutputSpent(ctx, &engine.OutputSpent{Outpoint: lkOutpoint(t, iss.Txid, 1), Topic: mgrTopic(t, mgrUntouched)}); err != nil {
		t.Fatal(err)
	}
	if bal, _ := st.GetBalance(ctx, holder); bal != 100 {
		t.Fatalf("another topic's spend debited: balance %d", bal)
	}
	for i := 0; i < 2; i++ {
		if err := ls.OutputSpent(ctx, &engine.OutputSpent{Outpoint: lkOutpoint(t, iss.Txid, 1), Topic: ls.Topic()}); err != nil {
			t.Fatal(err)
		}
		if row, _ := st.GetTokenRow(ctx, iss.Txid, 1); row != nil {
			t.Fatalf("spent row kept: %+v", row)
		}
		if bal, _ := st.GetBalance(ctx, holder); bal != 0 {
			t.Fatalf("balance after spend #%d = %d, want 0", i+1, bal)
		}
	}

	iss2 := mandalatest.Issue(t, iss, 0, mandalatest.Issuer, mandalatest.Receiver, 30)
	lkAdmit(t, ls, iss2, ls.Topic(), 0, 1)
	if err := ls.OutputEvicted(ctx, lkOutpoint(t, iss2.Txid, 1)); err != nil {
		t.Fatal(err)
	}
	if bal, _ := st.GetBalance(ctx, receiver); bal != 0 {
		t.Fatalf("eviction did not debit: balance %d", bal)
	}
	if err := ls.OutputEvicted(ctx, lkOutpoint(t, iss2.Txid, 0)); err != nil {
		t.Fatal(err)
	}
	if a, _ := st.GetAuthorityRow(ctx, iss2.Txid, 0); a != nil {
		t.Fatalf("evicted authority kept: %+v", a)
	}
	if err := ls.OutputEvicted(ctx, lkOutpoint(t, d.Txid, 0)); err != nil {
		t.Fatal(err)
	}
	if md, _ := st.FindMetadata(ctx, id); md != nil {
		t.Fatalf("metadata kept after evicting the deploy: %+v", md)
	}
	if err := ls.OutputNoLongerRetainedInHistory(ctx, lkOutpoint(t, d.Txid, 0), ls.Topic()); err != nil {
		t.Fatal(err)
	}
	if err := ls.OutputBlockHeightUpdated(ctx, nil, 1, 0); err != nil {
		t.Fatal(err)
	}
}

func TestTokenLookupAnswersOutpointFormulasOnly(t *testing.T) {
	st, _, _ := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := lkToken(t, st, id)
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	lkAdmit(t, ls, d, ls.Topic(), 0)
	lkAdmit(t, ls, iss, ls.Topic(), 0, 1)
	auths := []string{d.Txid + ".0", iss.Txid + ".0"}
	sort.Strings(auths)
	want := func(query string, ops ...string) {
		t.Helper()
		got, err := lkAsk(t, ls, ls.Name(), query)
		if err != nil || !slices.Equal(got, append([]string{}, ops...)) {
			t.Fatalf("%s = %v, %v; want %v", query, got, err, ops)
		}
	}
	wantErr := func(query, message string) {
		t.Helper()
		if _, err := lkAsk(t, ls, ls.Name(), query); err == nil || err.Error() != message {
			t.Fatalf("%s error = %v, want %q", query, err, message)
		}
	}
	want(`{"metadataTokenId":"`+id+`"}`, d.Txid+".0")
	wantErr(`{"metadataTokenId":"`+mgrUntouched+`"}`, "Invalid lookup query: metadataTokenId must be "+id+", the token "+ls.Name()+" serves")
	want(`{"authoritiesTokenId":"`+id+`"}`, auths...)
	want(`{"authoritiesTokenId":"`+id+`","limit":1,"skip":1}`, auths[1])
	want(`{"authoritiesTokenId":"` + id + `","skip":5}`)
	want(`{"tokenId":"`+id+`"}`, iss.Txid+".1")
	want(`{"txid":"`+strings.ToUpper(iss.Txid)+`","outputIndex":1}`, iss.Txid+".1")
	want(`{"txid":"`+iss.Txid+`","outputIndex":0}`, iss.Txid+".0")
	want(`{"txid":"` + iss.Txid + `","outputIndex":7}`)
	want(`{"txid":"`+iss.Txid+`","outputIndex":null}`, iss.Txid+".0") // TS: a null outputIndex reads its default 0
	wantErr(`{"txid":"`+iss.Txid+`"}`, "Unsupported query")
	wantErr(`{"assetStateTokenId":"`+id+`"}`, "Unsupported query")
	wantErr(`{"adminHistoryTokenId":"`+id+`"}`, "Unsupported query")
	wantErr(`{}`, "Unsupported query")
	wantErr(`{"bogus":1}`, "Invalid lookup query: unexpected field bogus")
	wantErr(`{"tokenId":"`+strings.ToUpper(id)+`","limit":0}`, "Invalid lookup query: tokenId must be a token id (<64 lowercase hex>_0)")
	wantErr(`{"tokenId":"`+id+`","limit":0}`, "Invalid lookup query: limit must be an integer from 1 to 100")
	if _, err := lkAsk(t, ls, MandalaLookup, `{}`); err == nil || err.Error() != "Lookup service not supported!" {
		t.Fatalf("another service = %v", err)
	}
}

// Q2 ac8d82732 (TT §6.3): ls_<A> answers for token A only, although the store it reads holds token B's rows too.
func TestTokenLookupAnswersForItsOwnTokenOnly(t *testing.T) {
	st, _, _ := lkStore(t)
	dA := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	idA := brc162.DeployTokenID(dA.Txid, 0)
	lsA := lkToken(t, st, idA)
	issA := mandalatest.Issue(t, dA, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	lkAdmit(t, lsA, dA, lsA.Topic(), 0)
	lkAdmit(t, lsA, issA, lsA.Topic(), 0, 1)
	dB := mandalatest.Deploy(t, mandalatest.Issuer, "EUR")
	idB := brc162.DeployTokenID(dB.Txid, 0)
	lsB := lkToken(t, st, idB)
	issB := mandalatest.Issue(t, dB, 0, mandalatest.Issuer, mandalatest.Holder, 50)
	lkAdmit(t, lsB, dB, lsB.Topic(), 0)
	lkAdmit(t, lsB, issB, lsB.Topic(), 0, 1)

	refusal := func(field string) string {
		return "Invalid lookup query: " + field + " must be " + idA + ", the token " + lsA.Name() + " serves"
	}
	for _, field := range tokenLookupTokenKeys {
		for _, other := range []string{idB, mgrUntouched} {
			if _, err := lkAsk(t, lsA, lsA.Name(), `{"`+field+`":"`+other+`"}`); err == nil || err.Error() != refusal(field) {
				t.Fatalf("%s naming %s on ls_<A>: %v, want %q", field, other, err, refusal(field))
			}
		}
	}
	// Refused even behind a key ls_<A> answers.
	for _, field := range tokenLookupTokenKeys[1:] {
		if _, err := lkAsk(t, lsA, lsA.Name(), `{"metadataTokenId":"`+idA+`","`+field+`":"`+idB+`"}`); err == nil || err.Error() != refusal(field) {
			t.Fatalf("%s naming B behind metadataTokenId: %v, want %q", field, err, refusal(field))
		}
	}
	// Every key is validated before the own-token check runs.
	if _, err := lkAsk(t, lsA, lsA.Name(), `{"tokenId":"`+idB+`","limit":0}`); err == nil || err.Error() != "Invalid lookup query: limit must be an integer from 1 to 100" {
		t.Fatalf("validation order: %v", err)
	}
	// Token B's value and authority rows answer [] on ls_<A> and themselves on ls_<B>.
	for _, op := range []struct {
		txid string
		vout uint32
	}{{issB.Txid, 1}, {issB.Txid, 0}, {dB.Txid, 0}} {
		q := fmt.Sprintf(`{"txid":"%s","outputIndex":%d}`, op.txid, op.vout)
		if got, err := lkAsk(t, lsA, lsA.Name(), q); err != nil || len(got) != 0 {
			t.Fatalf("ls_<A> %s = %v, %v; want [] (a row of token B)", q, got, err)
		}
		if got, err := lkAsk(t, lsB, lsB.Name(), q); err != nil || !slices.Equal(got, []string{fmt.Sprintf("%s.%d", op.txid, op.vout)}) {
			t.Fatalf("ls_<B> %s = %v, %v; want its own row", q, got, err)
		}
	}
	if got, err := lkAsk(t, lsA, lsA.Name(), `{"tokenId":"`+idA+`"}`); err != nil || !slices.Equal(got, []string{issA.Txid + ".1"}) {
		t.Fatalf("ls_<A> own coins = %v, %v", got, err)
	}
}

func TestTokenLookupNamesAndMetaData(t *testing.T) {
	st, _, _ := lkStore(t)
	hexID := strings.TrimSuffix(mgrUntouched, "_0")
	ls := lkToken(t, st, mgrUntouched)
	if ls.Name() != "ls_"+hexID || ls.Topic() != "tm_"+hexID {
		t.Fatalf("names = %s %s", ls.Name(), ls.Topic())
	}
	md := ls.GetMetaData()
	if md.Name != ls.Name() || md.Description != "Mandala BRC-162 token index by tokenId and outpoint: metadata, admin state and history, authorities. No identity-balance query." {
		t.Fatalf("metadata = %+v", md)
	}
	if ls.GetDocumentation() == "" {
		t.Fatal("empty documentation")
	}
	if _, err := NewTokenLookupService("nope", overlayVerifier(t), st); err == nil || err.Error() != "not a canonical Mandala token id: nope" {
		t.Fatalf("bad id = %v", err)
	}
}
