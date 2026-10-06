package mandala

import (
	"reflect"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

func foldInt64(v int64) *int64    { return &v }
func foldAmount(v int64) *Amount  { a := Amount(v); return &a }
func foldString(v string) *string { return &v }

func TestFoldActionTable(t *testing.T) {
	tok := strings.Repeat("ab", 32) + "_0"
	key := mandalatest.Holder.Identity
	op := strings.Repeat("cd", 32) + ".3"
	base := func(mod func(*AssetAdminState)) AssetAdminState {
		s := DefaultAssetState(tok, nil)
		if mod != nil {
			mod(&s)
		}
		return s
	}
	frozen := func(amount int64, owner string) func(*AssetAdminState) {
		return func(s *AssetAdminState) {
			s.FrozenOutpoints = []FrozenRef{{Outpoint: op, Amount: Amount(amount), Owner: owner}}
		}
	}
	cases := []struct {
		name string
		prev AssetAdminState
		d    AdminDetails
		fc   FoldContext
		want AssetAdminState
	}{
		{"pause", base(nil), AdminDetails{Kind: "pause"}, FoldContext{}, base(func(s *AssetAdminState) { s.IsPaused = true })},
		{"unpause", base(func(s *AssetAdminState) { s.IsPaused = true }), AdminDetails{Kind: "unpause"}, FoldContext{}, base(nil)},
		{"blockIdentity lowercases", base(nil), AdminDetails{Kind: "blockIdentity", IdentityKey: strings.ToUpper(key)}, FoldContext{},
			base(func(s *AssetAdminState) { s.BlockedIdentities = []string{key} })},
		{"blockIdentity adds once", base(func(s *AssetAdminState) { s.BlockedIdentities = []string{key} }),
			AdminDetails{Kind: "blockIdentity", IdentityKey: strings.ToUpper(key)}, FoldContext{},
			base(func(s *AssetAdminState) { s.BlockedIdentities = []string{key} })},
		{"unblockIdentity", base(func(s *AssetAdminState) { s.BlockedIdentities = []string{key} }),
			AdminDetails{Kind: "unblockIdentity", IdentityKey: strings.ToUpper(key)}, FoldContext{}, base(nil)},
		{"allowIdentity", base(nil), AdminDetails{Kind: "allowIdentity", IdentityKey: key}, FoldContext{},
			base(func(s *AssetAdminState) { s.AllowedIdentities = []string{key} })},
		{"unallowIdentity", base(func(s *AssetAdminState) { s.AllowedIdentities = []string{key} }),
			AdminDetails{Kind: "unallowIdentity", IdentityKey: key}, FoldContext{}, base(nil)},
		{"setAccessMode", base(nil), AdminDetails{Kind: "setAccessMode", Mode: "allowlist"}, FoldContext{},
			base(func(s *AssetAdminState) { s.AccessMode = "allowlist" })},
		{"setAccessMode ignores another mode", base(nil), AdminDetails{Kind: "setAccessMode", Mode: "openlist"}, FoldContext{}, base(nil)},
		{"freezeOutput records its fold context", base(nil), AdminDetails{Kind: "freezeOutput", Outpoint: strings.ToUpper(op)},
			FoldContext{FrozenAmount: foldAmount(100), FrozenOwner: foldString(strings.ToUpper(key))}, base(frozen(100, key))},
		{"freezeOutput without a context freezes 0", base(nil), AdminDetails{Kind: "freezeOutput", Outpoint: op}, FoldContext{}, base(frozen(0, ""))},
		{"re-freeze is a no-op", base(frozen(100, key)), AdminDetails{Kind: "freezeOutput", Outpoint: op},
			FoldContext{FrozenAmount: foldAmount(7), FrozenOwner: foldString("")}, base(frozen(100, key))},
		{"unfreezeOutput", base(frozen(100, key)), AdminDetails{Kind: "unfreezeOutput", Outpoint: strings.ToUpper(op)}, FoldContext{}, base(nil)},
		{"reissue unfreezes and evicts", base(frozen(100, key)), AdminDetails{Kind: "reissue", Outpoint: op, Recipient: key}, FoldContext{},
			base(func(s *AssetAdminState) { s.EvictedOutpoints = []string{op} })},
		{"setFeeRate", base(nil), AdminDetails{Kind: "setFeeRate", FeeRatePerKb: foldInt64(25), HasFeeRatePerKb: true}, FoldContext{},
			base(func(s *AssetAdminState) { s.FeeRatePerKb = foldInt64(25) })},
		{"setFeeRate null turns fees off", base(func(s *AssetAdminState) { s.FeeRatePerKb = foldInt64(25) }),
			AdminDetails{Kind: "setFeeRate", HasFeeRatePerKb: true}, FoldContext{}, base(nil)},
		{"issue changes no control state", base(nil), AdminDetails{Kind: "issue"}, FoldContext{}, base(nil)},
		{"redeem changes no control state", base(nil), AdminDetails{Kind: "redeem"}, FoldContext{}, base(nil)},
		{"a registry kind changes nothing", base(nil), AdminDetails{Kind: "admitIdentity", IdentityKey: key}, FoldContext{}, base(nil)},
		{"an unknown kind changes nothing", base(nil), AdminDetails{Kind: "bogus"}, FoldContext{}, base(nil)},
		{"the fold position is untouched", base(func(s *AssetAdminState) { s.LastProcessedHeight, s.LastProcessedOffset, s.LastAdmitSeq = 9, 8, 7 }),
			AdminDetails{Kind: "pause"}, FoldContext{},
			base(func(s *AssetAdminState) {
				s.IsPaused = true
				s.LastProcessedHeight, s.LastProcessedOffset, s.LastAdmitSeq = 9, 8, 7
			})},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FoldAction(c.prev, c.d, c.fc); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("FoldAction(%s) =\n%+v\nwant\n%+v", c.d.Kind, got, c.want)
			}
		})
	}
}

func TestFoldActionNeverMutatesItsInput(t *testing.T) {
	key := mandalatest.Holder.Identity
	other := mandalatest.Receiver.Identity
	op := strings.Repeat("cd", 32) + ".3"
	otherOp := strings.Repeat("ef", 32) + ".0"
	prev := DefaultAssetState(strings.Repeat("ab", 32)+"_0", foldInt64(5))
	prev.BlockedIdentities = append(make([]string, 0, 8), key)
	prev.AllowedIdentities = append(make([]string, 0, 8), key)
	prev.FrozenOutpoints = append(make([]FrozenRef, 0, 8), FrozenRef{Outpoint: op, Amount: 1, Owner: key})
	prev.EvictedOutpoints = make([]string, 0, 8)
	for _, d := range []AdminDetails{
		{Kind: "blockIdentity", IdentityKey: other}, {Kind: "unblockIdentity", IdentityKey: key},
		{Kind: "allowIdentity", IdentityKey: other}, {Kind: "unallowIdentity", IdentityKey: key},
		{Kind: "freezeOutput", Outpoint: otherOp}, {Kind: "unfreezeOutput", Outpoint: op},
		{Kind: "reissue", Outpoint: op}, {Kind: "setFeeRate", FeeRatePerKb: foldInt64(9), HasFeeRatePerKb: true},
	} {
		FoldAction(prev, d, FoldContext{})
		if len(prev.BlockedIdentities) != 1 || prev.BlockedIdentities[0] != key || prev.BlockedIdentities[:2][1] != "" ||
			len(prev.AllowedIdentities) != 1 || prev.AllowedIdentities[:2][1] != "" ||
			len(prev.FrozenOutpoints) != 1 || prev.FrozenOutpoints[0].Outpoint != op || prev.FrozenOutpoints[:2][1] != (FrozenRef{}) ||
			len(prev.EvictedOutpoints) != 0 || prev.EvictedOutpoints[:1][0] != "" || *prev.FeeRatePerKb != 5 {
			t.Fatalf("%s mutated its input: %+v", d.Kind, prev)
		}
	}
}

func TestFoldEntryStampsTheFoldPosition(t *testing.T) {
	s := foldEntry(DefaultAssetState(strings.Repeat("ab", 32)+"_0", nil), AdminDetails{Kind: "pause"},
		AdminHistoryEntry{Height: 812345, Offset: 7, AdmitSeq: 42}, FoldContext{})
	if !s.IsPaused || s.LastProcessedHeight != 812345 || s.LastProcessedOffset != 7 || s.LastAdmitSeq != 42 {
		t.Fatalf("foldEntry = %+v", s)
	}
}
