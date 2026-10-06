package mandalatest

import (
	"crypto/sha256"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

func mustCbor(m brc162.CborMap) []byte {
	b, err := brc162.EncodeStrictCbor(m)
	if err != nil {
		panic("mandalatest: strict CBOR: " + err.Error())
	}
	return b
}

// DeployPayload is the strict-CBOR deploy map {sym, dec, label}.
func DeployPayload(sym string, dec uint64, label string) []byte {
	return mustCbor(brc162.CborMap{"sym": sym, "dec": dec, "label": label})
}

// Details is the strict-CBOR encoding of admin details kv.
func Details(kv brc162.CborMap) []byte { return mustCbor(kv) }

// AdmPayload is an authority payload {adm: commitment}.
func AdmPayload(commitment [32]byte) []byte {
	return mustCbor(brc162.CborMap{"adm": commitment[:]})
}

// Deploy builds a signed deploy at output 0, owned and proved by issuer, payload {sym, dec:2, label:"US Dollar"}.
func Deploy(t testing.TB, issuer Party, sym string) *Built {
	t.Helper()
	return Build(t, nil, []Out{{
		Owner: issuer, Prover: issuer, Payload: DeployPayload(sym, 2, "US Dollar"), HasPayload: true,
	}}, &issuer)
}

// Issue spends auth:authVout (the deploy or the current authority). Output 0 is the new authority
// (issuer) committing {kind:"issue"}; output 1 is amount to `to`, proved by the issuer.
func Issue(t testing.TB, auth *Built, authVout uint32, issuer, to Party, amount uint64) *Built {
	t.Helper()
	tokenID := TokenIDOf(auth, authVout)
	details := Details(brc162.CborMap{"kind": "issue"})
	return Build(t, []In{{Src: auth, Vout: authVout}}, []Out{
		{Owner: issuer, Prover: issuer, TokenID: tokenID, Payload: AdmPayload(sha256.Sum256(details)), HasPayload: true, Details: details},
		{Owner: to, Prover: issuer, TokenID: tokenID, Amount: amount},
	}, nil)
}

// Transfer spends src:vout (owner = src.Outs[vout].Owner): output 0 pays amount to `to`; output 1
// returns the change to the owner and is omitted when the change is 0.
func Transfer(t testing.TB, src *Built, vout uint32, to Party, amount uint64) *Built {
	t.Helper()
	spec := src.Outs[vout]
	if amount > spec.Amount {
		t.Fatalf("mandalatest: Transfer of %d from a %d coin; build an overspend with Build", amount, spec.Amount)
	}
	tokenID := TokenIDOf(src, vout)
	outs := []Out{{Owner: to, Prover: spec.Owner, TokenID: tokenID, Amount: amount}}
	if change := spec.Amount - amount; change > 0 {
		outs = append(outs, Out{Owner: spec.Owner, Prover: spec.Owner, TokenID: tokenID, Amount: change})
	}
	return Build(t, []In{{Src: src, Vout: vout}}, outs, nil)
}

// TwoTokenTransfer spends a:av (token A) and b:bv (token B) and pays both whole coins to `to`:
// output 0 is A, output 1 is B.
func TwoTokenTransfer(t testing.TB, a *Built, av uint32, b *Built, bv uint32, to Party) *Built {
	t.Helper()
	sa, sb := a.Outs[av], b.Outs[bv]
	return Build(t, []In{{Src: a, Vout: av}, {Src: b, Vout: bv}}, []Out{
		{Owner: to, Prover: sa.Owner, TokenID: TokenIDOf(a, av), Amount: sa.Amount},
		{Owner: to, Prover: sb.Owner, TokenID: TokenIDOf(b, bv), Amount: sb.Amount},
	}, nil)
}
