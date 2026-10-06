package mandala

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
)

func lqAsk(service, query string) *lookup.LookupQuestion {
	return &lookup.LookupQuestion{Service: service, Query: json.RawMessage(query)}
}

func TestRequireLookupQueryRefusals(t *testing.T) {
	allowed := []string{"tokenId", "limit", "constructor"}
	cases := []struct {
		name string
		q    *lookup.LookupQuestion
		want string
	}{
		{"no question", nil, "Invalid lookup query: a question object is required"},
		{"another service", lqAsk("ls_other", `{}`), "Lookup service not supported!"},
		{"no query", lqAsk("ls_x", ``), "Invalid lookup query: query must be an object"},
		{"null query", lqAsk("ls_x", `null`), "Invalid lookup query: query must be an object"},
		{"array query", lqAsk("ls_x", `[]`), "Invalid lookup query: query must be an object"},
		{"string query", lqAsk("ls_x", `"x"`), "Invalid lookup query: query must be an object"},
		{"number query", lqAsk("ls_x", `5`), "Invalid lookup query: query must be an object"},
		{"unknown key", lqAsk("ls_x", `{"limit":1,"nope":2}`), "Invalid lookup query: unexpected field nope"},
		{"__proto__", lqAsk("ls_x", `{"__proto__":{}}`), "Invalid lookup query: unexpected field __proto__"},
		{"an allowed but unsafe key", lqAsk("ls_x", `{"constructor":1}`), "Invalid lookup query: unexpected field constructor"},
		{"array-index keys come first (JS own-key order)", lqAsk("ls_x", `{"zeta":1,"10":1,"2":1}`), "Invalid lookup query: unexpected field 2"},
		{"then insertion order", lqAsk("ls_x", `{"zeta":1,"alpha":1}`), "Invalid lookup query: unexpected field zeta"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := RequireLookupQuery(c.q, "ls_x", allowed); err == nil || err.Error() != c.want {
				t.Fatalf("error = %v, want %q", err, c.want)
			}
		})
	}
}

func TestRequireLookupQueryKeepsTheLastDuplicate(t *testing.T) {
	q, err := RequireLookupQuery(lqAsk("ls_x", `{"limit":1,"limit":5}`), "ls_x", []string{"limit"})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := q.Integer("limit", 100, 1, 100); err != nil || n != 5 {
		t.Fatalf("limit = %d, %v; want 5 (JSON.parse keeps the last duplicate)", n, err)
	}
}

func lqQuery(t *testing.T, query string) LookupQuery {
	t.Helper()
	q, err := RequireLookupQuery(lqAsk("ls_x", query), "ls_x", []string{"tokenId", "txid", "limit", "skip", "list"})
	if err != nil {
		t.Fatalf("RequireLookupQuery(%s): %v", query, err)
	}
	return q
}

func TestLookupQueryTokenID(t *testing.T) {
	id := strings.Repeat("ab", 32) + "_0"
	const bad = "Invalid lookup query: tokenId must be a token id (<64 lowercase hex>_0)"
	if got, present, err := lqQuery(t, `{}`).TokenID("tokenId"); got != "" || present || err != nil {
		t.Fatalf("absent = %q %v %v", got, present, err)
	}
	if got, present, err := lqQuery(t, `{"tokenId":"`+id+`"}`).TokenID("tokenId"); got != id || !present || err != nil {
		t.Fatalf("valid = %q %v %v", got, present, err)
	}
	for _, raw := range []string{`"` + strings.ToUpper(id) + `"`, `null`, `5`, `"` + strings.Repeat("ab", 32) + `"`} {
		if _, present, err := lqQuery(t, `{"tokenId":`+raw+`}`).TokenID("tokenId"); !present || err == nil || err.Error() != bad {
			t.Fatalf("tokenId %s: present=%v err=%v, want %q", raw, present, err, bad)
		}
	}
}

func TestLookupQueryTxid(t *testing.T) {
	txid := strings.Repeat("cd", 32)
	if got, present, err := lqQuery(t, `{}`).Txid("txid"); got != "" || present || err != nil {
		t.Fatalf("absent = %q %v %v", got, present, err)
	}
	if got, present, err := lqQuery(t, `{"txid":"`+strings.ToUpper(txid)+`"}`).Txid("txid"); got != txid || !present || err != nil {
		t.Fatalf("upper case = %q %v %v; want the lowercased txid", got, present, err)
	}
	cases := []struct{ raw, want string }{
		{`null`, "Invalid lookup query: txid must be a string"},
		{`5`, "Invalid lookup query: txid must be a string"},
		{`""`, "Invalid lookup query: txid must contain 1-64 UTF-8 bytes"},
		{`"` + strings.Repeat("a", 65) + `"`, "Invalid lookup query: txid must contain 1-64 UTF-8 bytes"},
		{`"` + strings.Repeat("zz", 32) + `"`, "Invalid lookup query: txid must be a transaction ID"},
		{`"abc"`, "Invalid lookup query: txid must be a transaction ID"},
	}
	for _, c := range cases {
		if _, _, err := lqQuery(t, `{"txid":`+c.raw+`}`).Txid("txid"); err == nil || err.Error() != c.want {
			t.Fatalf("txid %s: %v, want %q", c.raw, err, c.want)
		}
	}
}

func TestLookupQueryInteger(t *testing.T) {
	const limitRule = "Invalid lookup query: limit must be an integer from 1 to 100"
	ok := []struct {
		query string
		want  int64
	}{
		{`{}`, 100}, {`{"limit":null}`, 100}, {`{"limit":7}`, 7}, {`{"limit":1.0}`, 1}, {`{"limit":1e1}`, 10},
	}
	for _, c := range ok {
		if n, err := lqQuery(t, c.query).Integer("limit", 100, 1, 100); err != nil || n != c.want {
			t.Fatalf("%s: %d, %v; want %d", c.query, n, err, c.want)
		}
	}
	for _, query := range []string{`{"limit":0}`, `{"limit":101}`, `{"limit":1.5}`, `{"limit":"5"}`, `{"limit":true}`, `{"limit":[1]}`, `{"limit":1e400}`} {
		if _, err := lqQuery(t, query).Integer("limit", 100, 1, 100); err == nil || err.Error() != limitRule {
			t.Fatalf("%s: %v, want %q", query, err, limitRule)
		}
	}
	if n, err := lqQuery(t, `{"skip":-0}`).Integer("skip", 0, 0, 100000); err != nil || n != 0 {
		t.Fatalf("-0 = %d, %v; want 0", n, err)
	}
	if _, err := lqQuery(t, `{"skip":9007199254740992}`).Integer("skip", 0, 0, math.MaxInt64); err == nil {
		t.Fatal("2^53 accepted: it is not a JS safe integer")
	}
}

func TestLookupQueryBool(t *testing.T) {
	if b, err := lqQuery(t, `{}`).Bool("list", false); err != nil || b {
		t.Fatalf("absent = %v, %v", b, err)
	}
	if b, err := lqQuery(t, `{"list":true}`).Bool("list", false); err != nil || !b {
		t.Fatalf("true = %v, %v", b, err)
	}
	if b, err := lqQuery(t, `{"list":false}`).Bool("list", true); err != nil || b {
		t.Fatalf("false = %v, %v", b, err)
	}
	for _, raw := range []string{`null`, `"true"`, `1`} {
		if _, err := lqQuery(t, `{"list":`+raw+`}`).Bool("list", false); err == nil || err.Error() != "Invalid lookup query: list must be a boolean" {
			t.Fatalf("list %s: %v", raw, err)
		}
	}
}
