package mandala

import (
	"slices"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// TxView is one transaction as layers B-D see it (Q2 scope.ts TxView).
type TxView struct {
	Outputs []brc162.Output
	Invalid []brc162.InvalidOutput
	Inputs  []brc162.Input
	Env     *Envelope
}

// ScopeToToken is Q2 scope.ts exactly (ts-stack 37468f290 src/mandala/scope.ts:15-34; fact base gaps §2.2): outputs and
// inputs of tokenID; every Invalid; env outputs/inputs by kept indices; env admin entries naming a kept output OR naming
// no token output of any token; DeploySig only with a kept deploy. Returns a new *Envelope; never mutates v.
func ScopeToToken(tokenID string, v TxView) TxView {
	env := v.Env
	if env == nil {
		env = emptyEnvelope()
	}
	outputs := []brc162.Output{}
	mine := map[uint64]bool{}
	anyToken := map[uint64]bool{}
	deployHere := false
	for _, o := range v.Outputs {
		anyToken[uint64(o.Index)] = true
		if o.TokenID != tokenID {
			continue
		}
		outputs = append(outputs, o)
		mine[uint64(o.Index)] = true
		if o.Role == brc162.RoleDeploy {
			deployHere = true
		}
	}
	inputs := []brc162.Input{}
	myInputs := map[uint64]bool{}
	for _, in := range v.Inputs {
		if in.TokenID == tokenID {
			inputs = append(inputs, in)
			myInputs[uint64(in.Index)] = true
		}
	}
	scoped := emptyEnvelope()
	for _, e := range env.Outputs {
		if mine[e.Index] {
			scoped.Outputs = append(scoped.Outputs, e)
		}
	}
	for _, e := range env.Inputs {
		if myInputs[e.Index] {
			scoped.Inputs = append(scoped.Inputs, e)
		}
	}
	for _, e := range env.Admin {
		if mine[e.Index] || !anyToken[e.Index] {
			scoped.Admin = append(scoped.Admin, e)
		}
	}
	if deployHere && env.HasDeploySig {
		scoped.DeploySig, scoped.HasDeploySig = env.DeploySig, true
	}
	return TxView{Outputs: outputs, Invalid: slices.Clone(v.Invalid), Inputs: inputs, Env: scoped}
}
