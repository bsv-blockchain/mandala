package mandala

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestFoldActionTable(t *testing.T) {
	s0 := DefaultAssetState("a.0")
	cases := []struct {
		name    string
		details ActionDetails
		ctx     FoldContext
		check   func(t *testing.T, s AssetAdminState)
	}{
		{"register sets issuer", ActionDetails{"kind": "register"}, FoldContext{Issuer: "02iss"},
			func(t *testing.T, s AssetAdminState) {
				if s.IssuerIdentityKey != "02iss" {
					t.Fatal(s.IssuerIdentityKey)
				}
			}},
		{"pause", ActionDetails{"kind": "pause"}, FoldContext{},
			func(t *testing.T, s AssetAdminState) {
				if !s.IsPaused {
					t.Fatal("not paused")
				}
			}},
		{"block unique-append", ActionDetails{"kind": "blockIdentity", "identityKey": "02x"}, FoldContext{},
			func(t *testing.T, s AssetAdminState) {
				s2 := FoldAction(s, ActionDetails{"kind": "blockIdentity", "identityKey": "02x"}, FoldContext{})
				if len(s2.BlockedIdentities) != 1 {
					t.Fatal(s2.BlockedIdentities)
				}
			}},
		{"setAccessMode allowlist", ActionDetails{"kind": "setAccessMode", "mode": "allowlist"}, FoldContext{},
			func(t *testing.T, s AssetAdminState) {
				if s.AccessMode != "allowlist" {
					t.Fatal(s.AccessMode)
				}
			}},
		{"setAccessMode invalid ignored", ActionDetails{"kind": "setAccessMode", "mode": "wat"}, FoldContext{},
			func(t *testing.T, s AssetAdminState) {
				if s.AccessMode != "denylist" {
					t.Fatal(s.AccessMode)
				}
			}},
		{"freeze records amount+owner", ActionDetails{"kind": "freezeOutput", "outpoint": "t.1"},
			FoldContext{FrozenAmount: 40, FrozenOwner: "02own", HasFrozenRow: true},
			func(t *testing.T, s AssetAdminState) {
				want := []FrozenRef{{Outpoint: "t.1", Amount: 40, Owner: "02own"}}
				if !reflect.DeepEqual(s.FrozenOutpoints, want) {
					t.Fatalf("%+v", s.FrozenOutpoints)
				}
			}},
		{"freeze records reason", ActionDetails{"kind": "freezeOutput", "outpoint": "t.1", "reason": "court order 12/A"},
			FoldContext{FrozenAmount: 40, FrozenOwner: "02own", HasFrozenRow: true},
			func(t *testing.T, s AssetAdminState) {
				want := []FrozenRef{{Outpoint: "t.1", Amount: 40, Owner: "02own", Reason: "court order 12/A"}}
				if !reflect.DeepEqual(s.FrozenOutpoints, want) {
					t.Fatalf("%+v", s.FrozenOutpoints)
				}
			}},
		{"issue is a no-op", ActionDetails{"kind": "issue", "amount": float64(5)}, FoldContext{},
			func(t *testing.T, s AssetAdminState) {
				if !reflect.DeepEqual(s, s0) {
					t.Fatal("issue must not change state")
				}
			}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.check(t, FoldAction(s0, c.details, c.ctx))
		})
	}
}

func TestReissueEvictsAndUnfreezes(t *testing.T) {
	s := DefaultAssetState("a.0")
	s = FoldAction(s, ActionDetails{"kind": "freezeOutput", "outpoint": "t.1"},
		FoldContext{FrozenAmount: 40, FrozenOwner: "02own", HasFrozenRow: true})
	s = FoldAction(s, ActionDetails{"kind": "reissue", "outpoint": "t.1"}, FoldContext{})
	if len(s.FrozenOutpoints) != 0 {
		t.Fatalf("frozen not cleared: %+v", s.FrozenOutpoints)
	}
	if len(s.EvictedOutpoints) != 1 || s.EvictedOutpoints[0] != "t.1" {
		t.Fatalf("evicted: %+v", s.EvictedOutpoints)
	}
}

func TestFoldIsPure(t *testing.T) {
	s := DefaultAssetState("a.0")
	s = FoldAction(s, ActionDetails{"kind": "blockIdentity", "identityKey": "02x"}, FoldContext{})
	before := append([]string(nil), s.BlockedIdentities...)
	_ = FoldAction(s, ActionDetails{"kind": "blockIdentity", "identityKey": "02y"}, FoldContext{})
	if !reflect.DeepEqual(before, s.BlockedIdentities) {
		t.Fatal("FoldAction mutated its input")
	}
}

func TestFreezeReasonRebuildParity(t *testing.T) {
	// Folding the same persisted details twice (live admit vs later rebuild)
	// must reproduce the identical FrozenRef, reason included.
	details := ActionDetails{"kind": "freezeOutput", "outpoint": "t.9", "reason": "aml hold"}
	fctx := FoldContext{FrozenAmount: 7, FrozenOwner: "02z", HasFrozenRow: true}
	live := FoldAction(DefaultAssetState("a.0"), details, fctx)
	rebuilt := FoldAction(DefaultAssetState("a.0"), details, fctx)
	if !reflect.DeepEqual(live.FrozenOutpoints, rebuilt.FrozenOutpoints) {
		t.Fatalf("live %+v != rebuilt %+v", live.FrozenOutpoints, rebuilt.FrozenOutpoints)
	}
	if live.FrozenOutpoints[0].Reason != "aml hold" {
		t.Fatalf("reason lost: %+v", live.FrozenOutpoints[0])
	}
}

func TestFoldActionFeeRate(t *testing.T) {
	s0 := DefaultAssetState("a.0")
	seven := int64(7)
	twelve := int64(12)
	cases := []struct {
		name    string
		prev    AssetAdminState
		details ActionDetails
		want    *int64
	}{
		{"register sets rate", s0, ActionDetails{"kind": "register", "feeRatePerKb": 7.0}, &seven},
		{"register without rate leaves nil", s0, ActionDetails{"kind": "register"}, nil},
		{"setFeeRate sets", withRate(s0, 7), ActionDetails{"kind": "setFeeRate", "feeRatePerKb": 12.0}, &twelve},
		{"setFeeRate null disables", withRate(s0, 7), ActionDetails{"kind": "setFeeRate", "feeRatePerKb": nil}, nil},
		{"setFeeRate absent disables", withRate(s0, 7), ActionDetails{"kind": "setFeeRate"}, nil},
		{"setFeeRate zero disables", withRate(s0, 7), ActionDetails{"kind": "setFeeRate", "feeRatePerKb": 0.0}, nil},
		{"setFeeRate negative disables", withRate(s0, 7), ActionDetails{"kind": "setFeeRate", "feeRatePerKb": -3.0}, nil},
		{"setFeeRate fraction disables", withRate(s0, 7), ActionDetails{"kind": "setFeeRate", "feeRatePerKb": 1.5}, nil},
		{"setFeeRate string disables", withRate(s0, 7), ActionDetails{"kind": "setFeeRate", "feeRatePerKb": "7"}, nil},
		{"setFeeRate unsafe integer disables", withRate(s0, 7), ActionDetails{"kind": "setFeeRate", "feeRatePerKb": 9007199254740994.0}, nil},
		{"pause leaves rate alone", withRate(s0, 7), ActionDetails{"kind": "pause"}, &seven},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := FoldAction(c.prev, c.details, FoldContext{}).FeeRatePerKb
			switch {
			case c.want == nil && got != nil:
				t.Fatalf("feeRatePerKb = %d, want nil", *got)
			case c.want != nil && (got == nil || *got != *c.want):
				t.Fatalf("feeRatePerKb = %v, want %d", got, *c.want)
			}
		})
	}
}

func withRate(s AssetAdminState, r int64) AssetAdminState {
	s.FeeRatePerKb = &r
	return s
}

func TestAssetStateJSONFeeRateShape(t *testing.T) {
	raw, err := json.Marshal(DefaultAssetState("a.0"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"feeRatePerKb":null`) {
		t.Fatalf("default state must serialize feeRatePerKb as null: %s", raw)
	}
	raw, err = json.Marshal(withRate(DefaultAssetState("a.0"), 7))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"feeRatePerKb":7`) {
		t.Fatalf("set state must serialize the number: %s", raw)
	}
}
