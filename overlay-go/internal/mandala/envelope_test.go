package mandala

import (
	"errors"
	"testing"
)

func TestDecodeEnvelopeEmpty(t *testing.T) {
	for _, b := range [][]byte{nil, {}} {
		env, err := DecodeEnvelope(b)
		if err != nil || env == nil || env.Inputs == nil || env.Outputs == nil || env.Admin == nil ||
			len(env.Inputs)+len(env.Outputs)+len(env.Admin) != 0 || env.HasDeploySig {
			t.Fatalf("DecodeEnvelope(%v) = %+v, %v", b, env, err)
		}
	}
}

func TestDecodeEnvelopeAccepts(t *testing.T) {
	env, err := DecodeEnvelope([]byte(` {"inputs":[{"index":0,"linkage":{"prover":"x"}}],` +
		`"outputs":[{"index":1e0,"linkage":"mistyped"},{"index":2.0},{"index":-0}],` +
		`"admin":[{"index":9007199254740991,"details":"a1616101"}],"deploySig":"3044","extra":true} `))
	if err != nil {
		t.Fatal(err)
	}
	if len(env.Inputs) != 1 || env.Inputs[0].Index != 0 || string(env.Inputs[0].Raw) != `{"prover":"x"}` {
		t.Errorf("inputs = %+v", env.Inputs)
	}
	if len(env.Outputs) != 3 || env.Outputs[0].Index != 1 || string(env.Outputs[0].Raw) != `"mistyped"` ||
		env.Outputs[1].Index != 2 || env.Outputs[1].Raw != nil || env.Outputs[2].Index != 0 {
		t.Errorf("outputs = %+v", env.Outputs)
	}
	if len(env.Admin) != 1 || env.Admin[0].Index != 9007199254740991 || env.Admin[0].Details != "a1616101" {
		t.Errorf("admin = %+v", env.Admin)
	}
	if !env.HasDeploySig || env.DeploySig != "3044" {
		t.Errorf("deploySig = %q %v", env.DeploySig, env.HasDeploySig)
	}
	if raw, found := env.OutputLinkage(1); !found || string(raw) != `"mistyped"` {
		t.Errorf("OutputLinkage(1) = %s, %v", raw, found)
	}
	if raw, found := env.OutputLinkage(2); !found || raw != nil {
		t.Errorf("OutputLinkage(2) = %s, %v (entry without linkage)", raw, found)
	}
	if _, found := env.OutputLinkage(7); found {
		t.Error("OutputLinkage(7) found")
	}
	if raw, found := env.InputLinkage(0); !found || raw == nil {
		t.Errorf("InputLinkage(0) = %s, %v", raw, found)
	}
	if _, found := env.InputLinkage(1); found {
		t.Error("InputLinkage(1) found")
	}
}

func TestDecodeEnvelopeKeysAreExactAndLastDuplicateWins(t *testing.T) {
	env, err := DecodeEnvelope([]byte(`{"Outputs":[{"index":0}],"ADMIN":"junk","deploysig":null}`))
	if err != nil || len(env.Outputs) != 0 || len(env.Admin) != 0 || env.HasDeploySig {
		t.Fatalf("case-variant keys bound: %+v, %v", env, err)
	}
	env, err = DecodeEnvelope([]byte(`{"outputs":null,"outputs":[{"index":4}]}`))
	if err != nil || len(env.Outputs) != 1 || env.Outputs[0].Index != 4 {
		t.Fatalf("last duplicate: %+v, %v", env, err)
	}
	_, err = DecodeEnvelope([]byte(`{"outputs":[],"outputs":null}`))
	assertEnvelopeRefusal(t, err, "Mandala payload outputs must be an array")
}

func assertEnvelopeRefusal(t *testing.T, err error, reason string) {
	t.Helper()
	var re *RejectError
	if !errors.As(err, &re) || re.Code != CodeShape || re.Reason != reason {
		t.Fatalf("error = %v, want ERR_SHAPE %q", err, reason)
	}
}

func TestDecodeEnvelopeRefusals(t *testing.T) {
	const (
		utf8JSON = "Mandala payload must be UTF-8 JSON"
		object   = "Mandala payload must be an object"
		idxOut   = "Mandala payload outputs must contain unique non-negative integer indices"
		details  = "Mandala payload admin details must be lowercase hex"
		sig      = "Mandala payload deploySig must be lowercase hex"
	)
	for _, c := range []struct {
		name, body, reason string
	}{
		{"BOM", "\xef\xbb\xbf{}", utf8JSON},
		{"invalid UTF-8 inside a string", "{\"admin\":[{\"index\":0,\"details\":\"\xff\"}]}", utf8JSON},
		{"not JSON", `{`, utf8JSON},
		{"trailing garbage", `{} x`, utf8JSON},
		{"array", `[]`, object},
		{"null", `null`, object},
		{"string", `"x"`, object},
		{"number", `1`, object},
		{"null list", `{"outputs":null}`, "Mandala payload outputs must be an array"},
		{"object list", `{"inputs":{}}`, "Mandala payload inputs must be an array"},
		{"string list", `{"admin":"x"}`, "Mandala payload admin must be an array"},
		{"non-object entry", `{"outputs":[1]}`, idxOut},
		{"missing index", `{"outputs":[{}]}`, idxOut},
		{"string index", `{"outputs":[{"index":"1"}]}`, idxOut},
		{"null index", `{"outputs":[{"index":null}]}`, idxOut},
		{"negative index", `{"outputs":[{"index":-1}]}`, idxOut},
		{"fractional index", `{"outputs":[{"index":1.5}]}`, idxOut},
		{"2^53 index", `{"outputs":[{"index":9007199254740992}]}`, idxOut},
		{"1e400 index", `{"outputs":[{"index":1e400}]}`, idxOut},
		{"duplicate index", `{"outputs":[{"index":0},{"index":0}]}`, idxOut},
		{"duplicate index 1 and 1.0", `{"outputs":[{"index":1},{"index":1.0}]}`, idxOut},
		{"uppercase details", `{"admin":[{"index":0,"details":"A1"}]}`, details},
		{"empty details", `{"admin":[{"index":0,"details":""}]}`, details},
		{"missing details", `{"admin":[{"index":0}]}`, details},
		{"odd details", `{"admin":[{"index":0,"details":"abc"}]}`, details},
		{"numeric details", `{"admin":[{"index":0,"details":12}]}`, details},
		{"null deploySig", `{"deploySig":null}`, sig},
		{"empty deploySig", `{"deploySig":""}`, sig},
		{"uppercase deploySig", `{"deploySig":"AB"}`, sig},
		{"lists before details", `{"admin":[{"index":0,"details":"ZZ"}],"inputs":null}`, "Mandala payload inputs must be an array"},
		{"inputs before outputs", `{"outputs":null,"inputs":[{"index":0},{"index":0}]}`, "Mandala payload inputs must contain unique non-negative integer indices"},
		{"outputs before admin", `{"admin":[{"index":-1}],"outputs":[{"index":-1}]}`, idxOut},
		{"details before deploySig", `{"deploySig":null,"admin":[{"index":0,"details":"zz"}]}`, details},
	} {
		t.Run(c.name, func(t *testing.T) {
			env, err := DecodeEnvelope([]byte(c.body))
			if env != nil {
				t.Fatalf("env = %+v on a refusal", env)
			}
			assertEnvelopeRefusal(t, err, c.reason)
		})
	}
}
