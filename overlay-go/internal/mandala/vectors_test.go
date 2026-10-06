package mandala

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// The Q2 vector file (ts-stack packages/overlays/topics/test/vectors/mandala-rejects.json, format
// version 2), replayed through the Go managers exactly as generate.test.ts replays it through TS.

type rejectVectors struct {
	ID                 string       `json:"id"`
	Version            int          `json:"version"`
	VerifierPrivateKey string       `json:"verifierPrivateKey"`
	TrustedIssuers     []string     `json:"trustedIssuers"`
	Cases              []rejectCase `json:"cases"`
}

type rejectCase struct {
	ID             string         `json:"id"`
	Topic          string         `json:"topic"`
	Beef           string         `json:"beef"`
	OffChainValues string         `json:"offChainValues"`
	PreviousCoins  []uint32       `json:"previousCoins"`
	State          vectorState    `json:"state"`
	Expected       rejectExpected `json:"expected"`
}

type rejectExpected struct {
	Code           string    `json:"code"`
	Reason         string    `json:"reason"`
	OutputsToAdmit *[]uint32 `json:"outputsToAdmit"`
	CoinsToRetain  *[]uint32 `json:"coinsToRetain"`
}

type vectorState struct {
	Tokens          []vectorToken     `json:"tokens"`
	Authorities     []vectorAuthority `json:"authorities"`
	Owners          []OwnerRecord     `json:"owners"`
	AssetStates     []AssetAdminState `json:"assetStates"`
	Sanctioned      []string          `json:"sanctioned,omitempty"`
	Members         *[]string         `json:"members,omitempty"`
	RegistryTokenID *string           `json:"registryTokenId,omitempty"`
}

type vectorToken struct {
	Txid        string `json:"txid"`
	OutputIndex uint32 `json:"outputIndex"`
	TokenID     string `json:"tokenId"`
	Amount      int64  `json:"amount"`
	IdentityKey string `json:"identityKey"`
}

type vectorAuthority struct {
	Txid        string `json:"txid"`
	OutputIndex uint32 `json:"outputIndex"`
	Topic       string `json:"topic"`
	TokenID     string `json:"tokenId"`
	IdentityKey string `json:"identityKey"`
}

// vectorRefusals is the TS REFUSALS list: every code the file must exercise.
var vectorRefusals = []string{"ERR_SHAPE", "ERR_SATOSHIS", "ERR_LINKAGE", "ERR_CONSERVATION", "ERR_AUTHORITY", "ERR_UNTRUSTED",
	"ERR_PAUSED", "ERR_FROZEN", "ERR_ACCESS", "ERR_SANCTIONED", "ERR_MEMBERSHIP", "ERR_UNAVAILABLE"}

func loadRejectVectors(t *testing.T) rejectVectors {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/mandala-rejects.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v rejectVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	return v
}

// memStore is TS storeOver(state): rows dated at the epoch, journal first-write-wins.
func (s vectorState) memStore() *memStore {
	st := newMemStore()
	epoch := time.Unix(0, 0).UTC()
	for _, r := range s.Tokens {
		st.putToken(TokenRecord{Txid: r.Txid, OutputIndex: r.OutputIndex, TokenID: r.TokenID, Amount: Amount(r.Amount), IdentityKey: r.IdentityKey, CreatedAt: epoch})
	}
	for _, r := range s.Authorities {
		st.putAuthority(AuthorityRecord{Txid: r.Txid, OutputIndex: r.OutputIndex, Topic: r.Topic, TokenID: r.TokenID, IdentityKey: r.IdentityKey, CreatedAt: epoch})
	}
	for _, r := range s.Owners {
		r.CreatedAt = epoch
		st.putOwner(r)
	}
	for _, a := range s.AssetStates {
		st.putState(a)
	}
	if s.RegistryTokenID != nil {
		st.setClaim(*s.RegistryTokenID)
	}
	return st
}

// vectorScreening is TS InMemoryScreeningProvider: it lowercases its list and the query.
type vectorScreening map[string]bool

func (s vectorScreening) IsSanctioned(_ context.Context, key string) (bool, error) {
	return s[strings.ToLower(key)], nil
}

// vectorMembership is the TS harness provider: always active, admitted iff listed (exact match).
type vectorMembership []string

func (m vectorMembership) IsActive(context.Context) (bool, error) { return true, nil }

func (m vectorMembership) IsAdmitted(_ context.Context, key string) (bool, error) {
	return slices.Contains(m, key), nil
}

func screeningOver(keys []string) ScreeningProvider {
	s := vectorScreening{}
	for _, k := range keys {
		s[strings.ToLower(k)] = true
	}
	return s
}

// membershipOver returns a nil interface (no membership gate) when the case has no members.
func membershipOver(members *[]string) MembershipProvider {
	if members == nil {
		return nil
	}
	return vectorMembership(*members)
}

func vectorBeef(t *testing.T, c rejectCase) (*transaction.Beef, *chainhash.Hash, *transaction.Transaction) {
	t.Helper()
	raw, err := hex.DecodeString(c.Beef)
	if err != nil {
		t.Fatalf("%s: beef hex: %v", c.ID, err)
	}
	beef, _, txid, err := transaction.ParseBeef(raw)
	if err != nil || beef == nil || txid == nil {
		t.Fatalf("%s: parse beef: %v", c.ID, err)
	}
	tx := beef.FindTransactionForSigningByHash(txid)
	if tx == nil {
		t.Fatalf("%s: subject tx not in its beef", c.ID)
	}
	return beef, txid, tx
}

// managerFor is TS managerFor (generate.test.ts:289-319): the topic picks the manager; the engine
// reader answers for the previousCoins sources on that topic only.
func managerFor(t *testing.T, f rejectVectors, c rejectCase, st *memStore, repairs *[]string) engine.TopicManager {
	t.Helper()
	_, _, tx := vectorBeef(t, c)
	v, err := NewVerifier(f.VerifierPrivateKey)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	onRepair := func(outpoint string, _ bool) { *repairs = append(*repairs, outpoint) }
	eng := engineFor(c.Topic, tx, c.PreviousCoins)
	deps := TokenTopicDeps{
		Verifier:       v,
		TrustedIssuers: f.TrustedIssuers,
		Store:          st,
		Engine:         eng,
		Screening:      screeningOver(c.State.Sanctioned),
		Membership:     membershipOver(c.State.Members),
		OnOwnerRepair:  onRepair,
	}
	var m engine.TopicManager
	switch {
	case IsTokenTopic(c.Topic):
		tokenID, _ := TokenIDOfTopic(c.Topic)
		m, err = NewTokenTopicManager(tokenID, deps)
	case c.Topic == MandalaTopic:
		m, err = NewTokenRegistryTopicManager(deps)
	case c.Topic == KYCTopic:
		m, err = NewKYCTopicManager(KYCTopicDeps{Verifier: v, TrustedIssuers: f.TrustedIssuers, Store: st, Engine: eng, Claims: st, OnOwnerRepair: onRepair})
	default:
		t.Fatalf("%s: unknown topic %s", c.ID, c.Topic)
	}
	if err != nil {
		t.Fatalf("%s: manager: %v", c.ID, err)
	}
	return m
}

// runVector offers one case to its manager over st (which the call may journal into).
func runVector(t *testing.T, f rejectVectors, c rejectCase, st *memStore, repairs *[]string) (overlay.AdmittanceInstructions, error) {
	t.Helper()
	beef, txid, _ := vectorBeef(t, c)
	off, err := hex.DecodeString(c.OffChainValues)
	if err != nil {
		t.Fatalf("%s: offChainValues hex: %v", c.ID, err)
	}
	m := managerFor(t, f, c, st, repairs)
	return m.IdentifyAdmissibleOutputs(WithOffChainValues(context.Background(), off), beef, txid, c.PreviousCoins)
}

func caseNamed(t *testing.T, v rejectVectors, id string) rejectCase {
	t.Helper()
	for _, c := range v.Cases {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no case %s", id)
	return rejectCase{}
}

func TestRejectVectorsHaveTheShapeGoReads(t *testing.T) {
	v := loadRejectVectors(t)
	if v.ID != "mandala.rejects" || v.Version != 2 {
		t.Fatalf("id/version = %s/%d, want mandala.rejects/2", v.ID, v.Version)
	}
	if v.VerifierPrivateKey != mandalatest.Overlay.PrivHex() || !slices.Equal(v.TrustedIssuers, []string{mandalatest.Issuer.Identity}) {
		t.Fatalf("cast differs from internal/mandalatest: verifier %s, trusted %v", v.VerifierPrivateKey, v.TrustedIssuers)
	}
	if len(v.Cases) < 40 {
		t.Fatalf("%d cases, want at least 40", len(v.Cases))
	}
	ids := map[string]bool{}
	codes := map[string]bool{}
	tokenTopics := map[string]bool{}
	registry, kyc, admissions, empty := 0, 0, 0, 0
	for _, c := range v.Cases {
		if ids[c.ID] {
			t.Fatalf("duplicate case id %s", c.ID)
		}
		ids[c.ID] = true
		switch {
		case IsTokenTopic(c.Topic):
			tokenTopics[c.Topic] = true
		case c.Topic == MandalaTopic:
			registry++
		case c.Topic == KYCTopic:
			kyc++
		default:
			t.Fatalf("%s: topic %q is neither a token topic, tm_mandala nor tm_mandala_kyc", c.ID, c.Topic)
		}
		e := c.Expected
		admits := e.OutputsToAdmit != nil || e.CoinsToRetain != nil
		if admits == (e.Code != "") || (admits && (e.OutputsToAdmit == nil || e.CoinsToRetain == nil)) {
			t.Fatalf("%s: expected must be {code, reason} or {outputsToAdmit, coinsToRetain}: %+v", c.ID, e)
		}
		if admits {
			admissions++
			if len(*e.OutputsToAdmit) == 0 {
				empty++
			}
		} else {
			codes[e.Code] = true
		}
	}
	for _, code := range vectorRefusals {
		if !codes[code] {
			t.Fatalf("no case refuses with %s", code)
		}
	}
	if len(codes) != len(vectorRefusals) {
		t.Fatalf("codes %v outside the catalogue", codes)
	}
	if registry == 0 || kyc == 0 || len(tokenTopics) <= 2 {
		t.Fatalf("topic coverage: %d tm_mandala, %d tm_mandala_kyc, %d token topics", registry, kyc, len(tokenTopics))
	}
	t.Logf("%d cases: %d token-topic cases over %d topics, %d tm_mandala, %d tm_mandala_kyc; %d admissions (%d empty)",
		len(v.Cases), len(v.Cases)-registry-kyc, len(tokenTopics), registry, kyc, admissions, empty)
}

func TestRejectVectorsReplay(t *testing.T) {
	v := loadRejectVectors(t)
	for _, c := range v.Cases {
		t.Run(c.ID, func(t *testing.T) {
			var repairs []string
			got, err := runVector(t, v, c, c.State.memStore(), &repairs)
			e := c.Expected
			if e.Code != "" {
				var rej *RejectError
				if !errors.As(err, &rej) || rej.Code == "" {
					t.Fatalf("want typed %s %q, got %v (admitted %+v)", e.Code, e.Reason, err, got)
				}
				if string(rej.Code) != e.Code || rej.Reason != e.Reason || rej.Topic != c.Topic {
					t.Fatalf("refusal = {%s %q %s}\nwant      {%s %q %s}", rej.Code, rej.Reason, rej.Topic, e.Code, e.Reason, c.Topic)
				}
				return
			}
			if err != nil {
				t.Fatalf("want {%v %v}, refused: %v", *e.OutputsToAdmit, *e.CoinsToRetain, err)
			}
			if !slices.Equal(got.OutputsToAdmit, *e.OutputsToAdmit) || !slices.Equal(got.CoinsToRetain, *e.CoinsToRetain) {
				t.Fatalf("admitted {%v %v}, want {%v %v}", got.OutputsToAdmit, got.CoinsToRetain, *e.OutputsToAdmit, *e.CoinsToRetain)
			}
		})
	}
}

func TestRejectVectorsJournalEveryAdmittedOutput(t *testing.T) {
	v := loadRejectVectors(t)
	for _, c := range v.Cases {
		if c.Expected.OutputsToAdmit == nil {
			continue
		}
		t.Run(c.ID, func(t *testing.T) {
			st := c.State.memStore()
			var repairs []string
			if _, err := runVector(t, v, c, st, &repairs); err != nil {
				t.Fatalf("refused: %v", err)
			}
			_, txid, _ := vectorBeef(t, c)
			want := []uint32{}
			if c.Topic != MandalaTopic { // tm_mandala journals nothing: the deploy's own topic does
				want = *c.Expected.OutputsToAdmit
			}
			journaled := []uint32{}
			for _, o := range st.owners {
				if o.Txid == txid.String() {
					journaled = append(journaled, o.OutputIndex)
				}
			}
			if !slices.Equal(journaled, want) {
				t.Fatalf("journaled outputs %v, want %v", journaled, want)
			}
		})
	}
}

func TestRejectVectorsRepairTheMissingOwnerRowInline(t *testing.T) {
	v := loadRejectVectors(t)
	c := caseNamed(t, v, "admit-transfer-repairing-the-owner-row")
	var lost *OwnerRecord
	for i := range c.State.Owners {
		if c.State.Owners[i].Role == "value" {
			lost = &c.State.Owners[i]
			break
		}
	}
	if lost == nil || len(c.State.Tokens) != 0 {
		t.Fatalf("case shape changed: lost=%+v tokens=%+v", lost, c.State.Tokens)
	}
	st := c.State.memStore()
	var repairs []string
	if _, err := runVector(t, v, c, st, &repairs); err != nil {
		t.Fatalf("refused: %v", err)
	}
	if want := []string{fmt.Sprintf("%s.%d", lost.Txid, lost.OutputIndex)}; !slices.Equal(repairs, want) {
		t.Fatalf("repairs = %v, want %v", repairs, want)
	}
	if len(st.tokens) != 1 {
		t.Fatalf("token rows = %+v, want exactly the repaired row", st.tokens)
	}
	r := st.tokens[0]
	if r.Txid != lost.Txid || r.OutputIndex != lost.OutputIndex || r.TokenID != lost.TokenID || r.Amount != lost.Amount || r.IdentityKey != lost.IdentityKey {
		t.Fatalf("repaired row = %+v, want the journal row %+v", r, *lost)
	}
}
