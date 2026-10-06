package mandala

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

var (
	scopeA  = strings.Repeat("aa", 32) + "_0"
	scopeB  = strings.Repeat("bb", 32) + "_0"
	scopeTx = strings.Repeat("cc", 32)
)

func scopeOut(index uint32, tokenID string, amount uint64, role brc162.Role) brc162.Output {
	return brc162.Output{Index: index, Satoshis: 1, Role: role, TokenID: tokenID, Amount: amount, PayloadCanonical: true}
}

func scopeIn(index uint32, tokenID string, amount uint64) brc162.Input {
	role := brc162.RoleValue
	if amount == 0 {
		role = brc162.RoleAuthority
	}
	return brc162.Input{Index: index, Role: role, TokenID: tokenID, Amount: amount, Outpoint: strings.Repeat("dd", 32) + ".0"}
}

func scopeLink(index uint64, raw string) IndexedLinkage {
	return IndexedLinkage{Index: index, Raw: json.RawMessage(raw)}
}

func scopeOutIdx(os []brc162.Output) []uint32 {
	r := []uint32{}
	for _, o := range os {
		r = append(r, o.Index)
	}
	return r
}

func scopeLinkIdx(ls []IndexedLinkage) []uint64 {
	r := []uint64{}
	for _, l := range ls {
		r = append(r, l.Index)
	}
	return r
}

func TestScopeKeepsOnlyTheTokensOwnEntries(t *testing.T) {
	env := &Envelope{
		Outputs: []IndexedLinkage{scopeLink(0, `"la"`), scopeLink(1, `"lb"`), scopeLink(2, `"la2"`)},
		Inputs:  []IndexedLinkage{scopeLink(0, `1`), scopeLink(1, `2`)},
		Admin:   []AdminEntry{{Index: 2, Details: "da"}, {Index: 1, Details: "db"}},
	}
	v := TxView{
		Outputs: []brc162.Output{scopeOut(0, scopeA, 5, brc162.RoleValue), scopeOut(1, scopeB, 7, brc162.RoleValue), scopeOut(2, scopeA, 0, brc162.RoleAuthority)},
		Invalid: []brc162.InvalidOutput{},
		Inputs:  []brc162.Input{scopeIn(0, scopeA, 5), scopeIn(1, scopeB, 7)},
		Env:     env,
	}
	before := *env
	a := ScopeToToken(scopeA, v)
	if got := scopeOutIdx(a.Outputs); !reflect.DeepEqual(got, []uint32{0, 2}) {
		t.Errorf("outputs = %v", got)
	}
	if len(a.Inputs) != 1 || a.Inputs[0].Index != 0 {
		t.Errorf("inputs = %+v", a.Inputs)
	}
	if got := scopeLinkIdx(a.Env.Outputs); !reflect.DeepEqual(got, []uint64{0, 2}) {
		t.Errorf("env outputs = %v", got)
	}
	if got := scopeLinkIdx(a.Env.Inputs); !reflect.DeepEqual(got, []uint64{0}) {
		t.Errorf("env inputs = %v", got)
	}
	if !reflect.DeepEqual(a.Env.Admin, []AdminEntry{{Index: 2, Details: "da"}}) {
		t.Errorf("env admin = %+v (B's admin entry must be dropped)", a.Env.Admin)
	}
	if a.Env == env || !reflect.DeepEqual(*env, before) || len(v.Outputs) != 3 {
		t.Error("ScopeToToken mutated or aliased its input")
	}
}

func TestScopeKeepsOrphanAdminAndInvalidOutputsEverywhere(t *testing.T) {
	v := TxView{
		Outputs: []brc162.Output{scopeOut(0, scopeA, 5, brc162.RoleValue)},
		Invalid: []brc162.InvalidOutput{{Index: 3, Detail: "bad"}},
		Env:     &Envelope{Admin: []AdminEntry{{Index: 9, Details: "x"}, {Index: 3, Details: "y"}}},
	}
	for _, id := range []string{scopeA, scopeB} {
		s := ScopeToToken(id, v)
		if !reflect.DeepEqual(s.Env.Admin, []AdminEntry{{Index: 9, Details: "x"}, {Index: 3, Details: "y"}}) {
			t.Errorf("%s admin = %+v", id, s.Env.Admin)
		}
		if !reflect.DeepEqual(s.Invalid, []brc162.InvalidOutput{{Index: 3, Detail: "bad"}}) {
			t.Errorf("%s invalid = %+v", id, s.Invalid)
		}
	}
	if b := ScopeToToken(scopeB, v); len(b.Outputs) != 0 || len(b.Inputs) != 0 {
		t.Errorf("B scope = %+v", b)
	}
}

func TestScopeKeepsDeploySigOnlyWithTheDeploy(t *testing.T) {
	deployID := scopeTx + "_0"
	v := TxView{
		Outputs: []brc162.Output{scopeOut(0, deployID, 0, brc162.RoleDeploy), scopeOut(1, scopeA, 3, brc162.RoleValue)},
		Env:     &Envelope{DeploySig: "sig", HasDeploySig: true},
	}
	if d := ScopeToToken(deployID, v); !d.Env.HasDeploySig || d.Env.DeploySig != "sig" || !reflect.DeepEqual(scopeOutIdx(d.Outputs), []uint32{0}) {
		t.Errorf("deploy scope = %+v", d.Env)
	}
	a := ScopeToToken(scopeA, v)
	if a.Env.HasDeploySig || a.Env.DeploySig != "" || !reflect.DeepEqual(scopeOutIdx(a.Outputs), []uint32{1}) {
		t.Errorf("A scope = %+v", a.Env)
	}
	v.Env = &Envelope{}
	if d := ScopeToToken(deployID, v); d.Env.HasDeploySig {
		t.Error("deploy without a deploySig gained one")
	}
}

func TestScopeNilEnvelopeIsEmpty(t *testing.T) {
	s := ScopeToToken(scopeA, TxView{Outputs: []brc162.Output{scopeOut(0, scopeA, 1, brc162.RoleValue)}})
	if s.Env == nil || len(s.Env.Outputs)+len(s.Env.Inputs)+len(s.Env.Admin) != 0 || len(s.Outputs) != 1 {
		t.Fatalf("scope over a nil envelope = %+v", s)
	}
}
