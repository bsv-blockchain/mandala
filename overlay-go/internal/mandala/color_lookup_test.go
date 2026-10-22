package mandala

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
)

// memAdmissions is an AdmissionReader over a map; calls counts GetAdmission per txid.
type memAdmissions struct {
	mu    sync.Mutex
	recs  map[string]*AdmissionRecord
	calls map[string]int
	fail  error
}

var _ AdmissionReader = (*memAdmissions)(nil)

func (m *memAdmissions) GetAdmission(_ context.Context, txid string) (*AdmissionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.calls == nil {
		m.calls = map[string]int{}
	}
	m.calls[txid]++
	if m.fail != nil {
		return nil, m.fail
	}
	r, ok := m.recs[txid]
	if !ok {
		return nil, nil
	}
	cp := *r
	return &cp, nil
}

func TestColorQueryValidation(t *testing.T) { // Review Focus 3 (validation half)
	id := strings.Repeat("ab", 32) + "_0"
	svc := "ls_color_" + id
	topic := "tm_color_" + id
	op := strings.Repeat("cd", 32) + ".1"
	q := func(body string) error {
		_, err := ParseColorQuery(&lookup.LookupQuestion{Service: svc, Query: json.RawMessage(body)}, svc, id)
		return err
	}
	ok := `{"type":"color-admission","version":1,"assetId":"` + id + `","topic":"` + topic + `","outpoints":["` + op + `"]}`
	if err := q(ok); err != nil {
		t.Fatal(err)
	}
	cq, err := ParseColorQuery(&lookup.LookupQuestion{Service: svc, Query: json.RawMessage(strings.Replace(ok, `color-admission`, `color-spendability`, 1))}, svc, id)
	if err != nil || cq.Type != "color-spendability" || len(cq.Outpoints) != 1 || cq.Outpoints[0] != (Outpoint{Txid: op[:64], OutputIndex: 1}) {
		t.Fatalf("parsed %+v, %v", cq, err)
	}
	maxVout := strings.Replace(ok, op, op[:64]+".4294967295", 1)
	if cq, err := ParseColorQuery(&lookup.LookupQuestion{Service: svc, Query: json.RawMessage(maxVout)}, svc, id); err != nil || cq.Outpoints[0].OutputIndex != 4294967295 {
		t.Fatalf("vout 2^32-1: %+v, %v", cq, err)
	}
	bad := "outpoints[0] must be <64 lowercase hex txid>.<vout 0..4294967295>"
	for body, msg := range map[string]string{
		strings.Replace(ok, `"version":1,`, `"version":1,"tokenId":"`+id+`",`, 1):                 "unexpected field tokenId",
		strings.Replace(ok, `"version":1,`, ``, 1):                                                "missing field version",
		`{"version":1,"assetId":"` + id + `","topic":"` + topic + `","outpoints":["` + op + `"]}`: "missing field type",
		strings.Replace(ok, `,"outpoints":["`+op+`"]`, ``, 1):                                     "missing field outpoints",
		strings.Replace(ok, `color-admission`, `color-balance`, 1):                                "type must be color-spendability or color-admission",
		strings.Replace(ok, `"color-admission"`, `1`, 1):                                          "type must be color-spendability or color-admission",
		strings.Replace(ok, `"version":1`, `"version":2`, 1):                                      "version must be 1",
		strings.Replace(ok, `"version":1`, `"version":1.0`, 1):                                    "version must be 1",
		strings.Replace(ok, `"version":1`, `"version":"1"`, 1):                                    "version must be 1",
		strings.Replace(ok, `"assetId":"`+id, `"assetId":"`+strings.Repeat("ef", 32)+"_0", 1):     "assetId must be " + id + ", the asset " + svc + " serves",
		strings.Replace(ok, `"topic":"`+topic, `"topic":"tm_`+id[:64], 1):                         "topic must be " + topic,
		strings.Replace(ok, op, strings.ToUpper(op[:64])+".1", 1):                                 bad,
		strings.Replace(ok, op, op[:64]+".01", 1):                                                 bad,
		strings.Replace(ok, op, op[:64]+".4294967296", 1):                                         bad,
		strings.Replace(ok, op, op[:64]+"_1", 1):                                                  bad,
		strings.Replace(ok, `"`+op+`"`, `1`, 1):                                                   bad,
		strings.Replace(ok, `["`+op+`"]`, `["`+op+`","`+op+`"]`, 1):                               "outpoints[1] duplicates an earlier outpoint",
		strings.Replace(ok, `["`+op+`"]`, `[]`, 1):                                                "outpoints must be an array of 1-1000 outpoints",
		strings.Replace(ok, `["`+op+`"]`, `null`, 1):                                              "outpoints must be an array of 1-1000 outpoints",
		strings.Replace(ok, `["`+op+`"]`, `"`+op+`"`, 1):                                          "outpoints must be an array of 1-1000 outpoints",
	} {
		if err := q(body); err == nil || err.Error() != "Invalid lookup query: "+msg {
			t.Fatalf("%s: %v", msg, err)
		}
	}
	many := make([]string, 1001)
	for i := range many {
		many[i] = fmt.Sprintf(`"%s.%d"`, op[:64], i)
	}
	if err := q(strings.Replace(ok, `["`+op+`"]`, "["+strings.Join(many, ",")+"]", 1)); err == nil ||
		err.Error() != "Invalid lookup query: outpoints must be an array of 1-1000 outpoints" {
		t.Fatalf("1001 outpoints: %v", err)
	}
	if err := q(strings.Replace(ok, `["`+op+`"]`, "["+strings.Join(many[:1000], ",")+"]", 1)); err != nil {
		t.Fatalf("1000 outpoints: %v", err)
	}
	if _, err := ParseColorQuery(&lookup.LookupQuestion{Service: "ls_mandala", Query: json.RawMessage(ok)}, svc, id); err == nil ||
		err.Error() != "Lookup service not supported!" {
		t.Fatalf("wrong service: %v", err)
	}
}

// colorFixture: A, A2 unspent on one txid; B spent; C unspent+frozen; D unspent+reissued; E unspent but its
// record is evicted; F absent from the engine; G unspent with no admission record. A's record is provisional.
type colorFixture struct {
	id, topic               string
	A, A2, B, C, D, E, F, G Outpoint
	eng                     *memEngine
	adm                     *memAdmissions
	st                      *memStore
	all                     []Outpoint
}

func newColorFixture() *colorFixture {
	id := strings.Repeat("ab", 32) + "_0"
	f := &colorFixture{id: id, topic: "tm_color_" + id}
	tx := func(b string) string { return strings.Repeat(b, 32) }
	f.A, f.A2 = Outpoint{Txid: tx("a1"), OutputIndex: 0}, Outpoint{Txid: tx("a1"), OutputIndex: 1}
	f.B, f.C, f.D = Outpoint{Txid: tx("b2"), OutputIndex: 1}, Outpoint{Txid: tx("c3"), OutputIndex: 0}, Outpoint{Txid: tx("d4"), OutputIndex: 2}
	f.E, f.F, f.G = Outpoint{Txid: tx("e5"), OutputIndex: 0}, Outpoint{Txid: tx("f6"), OutputIndex: 0}, Outpoint{Txid: tx("07"), OutputIndex: 3}
	f.eng = &memEngine{topic: f.topic, coins: map[string][]byte{}}
	for _, op := range []Outpoint{f.A, f.A2, f.B, f.C, f.D, f.E, f.G} {
		f.eng.coins[fmt.Sprintf("%s.%d", op.Txid, op.OutputIndex)] = []byte{0x51}
	}
	f.eng.spend(fmt.Sprintf("%s.%d", f.B.Txid, f.B.OutputIndex), tx("99"))
	f.adm = &memAdmissions{recs: map[string]*AdmissionRecord{
		f.A.Txid: {Txid: f.A.Txid, Pending: true},
		f.B.Txid: {Txid: f.B.Txid, Admissions: map[string]TopicAdmission{f.topic: {}}},
		f.C.Txid: {Txid: f.C.Txid, Admissions: map[string]TopicAdmission{f.topic: {}}},
		f.D.Txid: {Txid: f.D.Txid, Admissions: map[string]TopicAdmission{f.topic: {}}},
		f.E.Txid: {Txid: f.E.Txid, Admissions: map[string]TopicAdmission{f.topic: {}}, EvictedAt: "2026-10-22T00:00:00.000Z"},
		f.F.Txid: {Txid: f.F.Txid, Admissions: map[string]TopicAdmission{f.topic: {}}},
	}}
	f.st = newMemStore()
	st := DefaultAssetState(id, nil)
	st.FrozenOutpoints = []FrozenRef{{Outpoint: strings.ToUpper(f.C.Txid) + ".0", Amount: amt(5), Owner: "02aa"}}
	st.EvictedOutpoints = []string{strings.ToUpper(f.D.Txid) + ".2"}
	f.st.putState(st)
	f.all = []Outpoint{f.G, f.F, f.E, f.D, f.C, f.B, f.A2, f.A}
	return f
}

func (f *colorFixture) answer(t *testing.T, typ string, ops []Outpoint) ([]Outpoint, error) {
	t.Helper()
	return colorAnswer(context.Background(), ColorQuery{Type: typ, Outpoints: ops}, f.topic, f.id, f.eng, f.adm, f.st)
}

func TestColorAnswersFollowAdmissionSpendFreezeEviction(t *testing.T) {
	f := newColorFixture()
	got, err := f.answer(t, ColorAdmission, f.all)
	if err != nil || !sameJSON(got, []Outpoint{f.D, f.C, f.B, f.A2, f.A}) {
		t.Fatalf("admission = %+v, %v (want D, C, B, A2, A in query order)", got, err)
	}
	if f.adm.calls[f.A.Txid] != 1 {
		t.Fatalf("GetAdmission(%s) called %d times, want once per txid", f.A.Txid, f.adm.calls[f.A.Txid])
	}
	got, err = f.answer(t, ColorSpendability, f.all)
	if err != nil || !sameJSON(got, []Outpoint{f.A2, f.A}) {
		t.Fatalf("spendability = %+v, %v (want A2, A)", got, err)
	}
	if got, err = f.answer(t, ColorSpendability, []Outpoint{f.F}); err != nil || len(got) != 0 {
		t.Fatalf("spendability of an absent output = %+v, %v", got, err)
	}

	f.eng.fail = errStoreDown
	if _, err := f.answer(t, ColorAdmission, f.all); !errors.Is(err, ErrLookupUnavailable) || !errors.Is(err, errStoreDown) {
		t.Fatalf("engine fault = %v, want ErrLookupUnavailable", err)
	}
	f.eng.fail = nil
	f.adm.fail = errStoreDown
	if _, err := f.answer(t, ColorAdmission, f.all); !errors.Is(err, ErrLookupUnavailable) {
		t.Fatalf("admission store fault = %v, want ErrLookupUnavailable", err)
	}
	f.adm.fail = nil
	f.st.failNext("GetAssetState", errStoreDown)
	if _, err := f.answer(t, ColorSpendability, f.all); !errors.Is(err, ErrLookupUnavailable) {
		t.Fatalf("asset state fault = %v, want ErrLookupUnavailable", err)
	}
}

// The discriminator: a query with "type" takes the color branch only (a legacy key mixed in is unexpected), and
// the color branch answers formulas in query order.
func TestTokenLookupColorBranch(t *testing.T) {
	f := newColorFixture()
	ls := &TokenLookupService{tokenID: f.id, topic: f.topic, name: "ls_color_" + f.id, eng: f.eng, admissions: f.adm, states: f.st}
	ask := func(query string) (*lookup.LookupAnswer, error) {
		return ls.Lookup(context.Background(), &lookup.LookupQuestion{Service: ls.name, Query: json.RawMessage(query)})
	}
	ops := `["` + f.B.Txid + `.1","` + f.A.Txid + `.0","` + f.F.Txid + `.0"]`
	base := `"version":1,"assetId":"` + f.id + `","topic":"` + f.topic + `","outpoints":` + ops
	ans, err := ask(`{"type":"color-admission",` + base + `}`)
	if err != nil || ans.Type != lookup.AnswerTypeFormula || len(ans.Formulas) != 2 ||
		ans.Formulas[0].Outpoint.String() != f.B.Txid+".1" || ans.Formulas[1].Outpoint.String() != f.A.Txid+".0" {
		t.Fatalf("admission answer = %+v, %v", ans, err)
	}
	if _, err := ask(`{"type":"color-admission","tokenId":"` + f.id + `",` + base + `}`); err == nil ||
		err.Error() != "Invalid lookup query: unexpected field tokenId" {
		t.Fatalf("mixed query: %v", err)
	}
	f.eng.fail = errStoreDown
	if _, err := ask(`{"type":"color-spendability",` + base + `}`); !errors.Is(err, ErrLookupUnavailable) {
		t.Fatalf("engine fault through Lookup = %v", err)
	}
}
