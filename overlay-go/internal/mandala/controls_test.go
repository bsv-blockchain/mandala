package mandala

import (
	"context"
	"errors"
	"math/big"
	"slices"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

var (
	ctlTokenA   = strings.Repeat("aa", 32) + "_0"
	ctlTokenB   = strings.Repeat("bb", 32) + "_0"
	ctlCoin     = strings.Repeat("cd", 32) + ".1"
	ctlCoinB    = strings.Repeat("ef", 32) + ".0"
	ctlHolder   = mandalatest.Holder.Identity
	ctlReceiver = mandalatest.Receiver.Identity
)

type ctlScreening struct {
	sanctioned map[string]bool
	err        error
	calls      []string
}

func (s *ctlScreening) IsSanctioned(_ context.Context, key string) (bool, error) {
	s.calls = append(s.calls, key)
	if s.err != nil {
		return false, s.err
	}
	return s.sanctioned[key], nil
}

type ctlMembership struct {
	active      bool
	members     map[string]bool
	activeErr   error
	admittedErr error
}

func (m *ctlMembership) IsActive(context.Context) (bool, error) { return m.active, m.activeErr }

func (m *ctlMembership) IsAdmitted(_ context.Context, key string) (bool, error) {
	if m.admittedErr != nil {
		return false, m.admittedErr
	}
	return m.members[key], nil
}

// ctlTx is one transaction as layer D sees it: classified value outputs and inputs, their
// owners, and the tokens whose authority it spends.
type ctlTx struct {
	outputs     []brc162.Output
	owners      []VerifiedOwner
	inputs      []brc162.Input
	inputOwners map[uint32]string
	admin       map[string]bool
}

func (c *ctlTx) out(tokenID string, amount uint64, owner string) *ctlTx {
	i := uint32(len(c.outputs))
	c.outputs = append(c.outputs, brc162.Output{Index: i, Satoshis: 1, Role: brc162.RoleValue, TokenID: tokenID, Amount: amount})
	c.owners = append(c.owners, VerifiedOwner{Index: i, TokenID: tokenID, Role: brc162.RoleValue, Amount: amount, IdentityKey: owner, Prover: owner})
	return c
}

func (c *ctlTx) in(tokenID string, amount uint64, outpoint, owner string) *ctlTx {
	i := uint32(len(c.inputs))
	c.inputs = append(c.inputs, brc162.Input{Index: i, Role: brc162.RoleValue, TokenID: tokenID, Amount: amount, Outpoint: outpoint})
	if c.inputOwners == nil {
		c.inputOwners = map[uint32]string{}
	}
	c.inputOwners[i] = owner
	return c
}

func (c *ctlTx) check(st *memStore, screening ScreeningProvider, membership MembershipProvider, exempt ...string) error {
	ex := map[string]bool{}
	for _, k := range exempt {
		ex[k] = true
	}
	auth := &AuthorityResult{Deltas: map[string]*big.Int{}, AdminTokens: map[string]bool{}}
	for id := range c.admin {
		auth.AdminTokens[id] = true
	}
	ledger := brc162.BuildLedger(strings.Repeat("ee", 32), c.outputs, c.inputs)
	return CheckControls(context.Background(), ledger, c.inputs, c.inputOwners, c.owners, auth,
		ControlDeps{Store: st, Screening: screening, Membership: membership, Exempt: ex})
}

// ctlTransfer: holder spends ctlCoin (10 of token A) to receiver.
func ctlTransfer() *ctlTx {
	return (&ctlTx{}).out(ctlTokenA, 10, ctlReceiver).in(ctlTokenA, 10, ctlCoin, ctlHolder)
}

func ctlState(tokenID string, mod func(*AssetAdminState)) AssetAdminState {
	s := DefaultAssetState(tokenID, nil)
	mod(&s)
	return s
}

func ctlRefusal(t *testing.T, err error, code Code, reason string) {
	t.Helper()
	var rej *RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("want a %s refusal, got %v", code, err)
	}
	if rej.Code != code || rej.Reason != reason {
		t.Fatalf("refusal = %s %q, want %s %q", rej.Code, rej.Reason, code, reason)
	}
}

func TestControlsFrozenThenEvictedPerInput(t *testing.T) {
	st := newMemStore()
	st.putState(ctlState(ctlTokenA, func(s *AssetAdminState) {
		s.FrozenOutpoints = []FrozenRef{{Outpoint: strings.ToUpper(ctlCoin), Amount: 10, Owner: ctlHolder}}
		s.EvictedOutpoints = []string{ctlCoin}
	}))
	ctlRefusal(t, ctlTransfer().check(st, NoSanctions{}, nil), CodeFrozen, "input 0: coin "+ctlCoin+" is frozen")

	admin := ctlTransfer()
	admin.admin = map[string]bool{ctlTokenA: true}
	ctlRefusal(t, admin.check(st, NoSanctions{}, nil), CodeFrozen, "input 0: coin "+ctlCoin+" is frozen")

	evicted := newMemStore()
	evicted.putState(ctlState(ctlTokenA, func(s *AssetAdminState) { s.EvictedOutpoints = []string{strings.ToUpper(ctlCoin)} }))
	ctlRefusal(t, ctlTransfer().check(evicted, NoSanctions{}, nil), CodeFrozen, "input 0: coin "+ctlCoin+" was evicted by a reissue")
}

func TestControlsAdminTxSkipsPauseAndAccess(t *testing.T) {
	st := newMemStore()
	st.putState(ctlState(ctlTokenA, func(s *AssetAdminState) {
		s.IsPaused = true
		s.BlockedIdentities = []string{ctlHolder}
	}))
	admin := ctlTransfer()
	admin.admin = map[string]bool{ctlTokenA: true}
	if err := admin.check(st, NoSanctions{}, nil); err != nil {
		t.Fatalf("admin tx refused: %v", err)
	}
	ctlRefusal(t, ctlTransfer().check(st, NoSanctions{}, nil), CodePaused, "token "+ctlTokenA+" is paused")
}

func TestControlsDenylistNamesOutputOwnersFirst(t *testing.T) {
	st := newMemStore()
	st.putState(ctlState(ctlTokenA, func(s *AssetAdminState) {
		s.BlockedIdentities = []string{strings.ToUpper(ctlHolder), strings.ToUpper(ctlReceiver)}
	}))
	ctlRefusal(t, ctlTransfer().check(st, NoSanctions{}, nil), CodeAccess, "token "+ctlTokenA+": "+ctlReceiver+" is blocked (denylist)")
}

func TestControlsAllowlistAndUnknownModesFailClosed(t *testing.T) {
	allow := newMemStore()
	allow.putState(ctlState(ctlTokenA, func(s *AssetAdminState) {
		s.AccessMode = "allowlist"
		s.AllowedIdentities = []string{ctlReceiver}
	}))
	ctlRefusal(t, ctlTransfer().check(allow, NoSanctions{}, nil), CodeAccess, "token "+ctlTokenA+": "+ctlHolder+" is not allowlisted (allowlist)")

	unknown := newMemStore()
	unknown.putState(ctlState(ctlTokenA, func(s *AssetAdminState) { s.AccessMode = "openlist" }))
	ctlRefusal(t, ctlTransfer().check(unknown, NoSanctions{}, nil), CodeAccess, "token "+ctlTokenA+": "+ctlReceiver+" is not allowlisted (allowlist)")

	both := newMemStore()
	both.putState(ctlState(ctlTokenA, func(s *AssetAdminState) {
		s.AccessMode = "allowlist"
		s.AllowedIdentities = []string{strings.ToUpper(ctlReceiver), ctlHolder}
	}))
	if err := ctlTransfer().check(both, NoSanctions{}, nil); err != nil {
		t.Fatalf("both parties allowlisted, refused: %v", err)
	}
}

func TestControlsExemptSkipsAccessAndMembershipButNotSanctions(t *testing.T) {
	st := newMemStore()
	st.putState(ctlState(ctlTokenA, func(s *AssetAdminState) { s.BlockedIdentities = []string{ctlHolder} }))
	members := &ctlMembership{active: true, members: map[string]bool{ctlReceiver: true}}
	if err := ctlTransfer().check(st, NoSanctions{}, members, ctlHolder); err != nil {
		t.Fatalf("exempt holder refused: %v", err)
	}
	screening := &ctlScreening{sanctioned: map[string]bool{ctlHolder: true}}
	ctlRefusal(t, ctlTransfer().check(st, screening, members, ctlHolder), CodeSanctioned, "identity "+ctlHolder+" is sanctioned")
}

func TestControlsScreenEveryIdentityOnceInOrder(t *testing.T) {
	tx := (&ctlTx{}).out(ctlTokenA, 4, ctlReceiver).out(ctlTokenA, 6, strings.ToUpper(ctlHolder)).in(ctlTokenA, 10, ctlCoin, ctlHolder)
	screening := &ctlScreening{}
	if err := tx.check(newMemStore(), screening, nil); err != nil {
		t.Fatalf("refused: %v", err)
	}
	if want := []string{ctlReceiver, ctlHolder}; !slices.Equal(screening.calls, want) {
		t.Fatalf("screened %v, want %v (lowercased, first occurrence wins)", screening.calls, want)
	}
}

func TestControlsProviderFaultsAreUnavailable(t *testing.T) {
	boom := errors.New("boom")
	err := ctlTransfer().check(newMemStore(), &ctlScreening{err: boom}, nil)
	ctlRefusal(t, err, CodeUnavailable, "the screening provider could not be read; retry")
	if !errors.Is(err, boom) {
		t.Fatalf("the screening fault lost its cause: %v", err)
	}
	ctlRefusal(t, ctlTransfer().check(newMemStore(), NoSanctions{}, &ctlMembership{activeErr: boom}),
		CodeUnavailable, "the membership provider could not be read; retry")
	ctlRefusal(t, ctlTransfer().check(newMemStore(), NoSanctions{}, &ctlMembership{active: true, admittedErr: boom}),
		CodeUnavailable, "the membership provider could not be read; retry")
	st := newMemStore()
	st.failNext("GetAssetState", boom)
	ctlRefusal(t, ctlTransfer().check(st, NoSanctions{}, nil), CodeUnavailable, "the asset state could not be read; retry")
}

func TestControlsMembership(t *testing.T) {
	if err := ctlTransfer().check(newMemStore(), NoSanctions{}, &ctlMembership{active: false}); err != nil {
		t.Fatalf("an inactive registry refused: %v", err)
	}
	ctlRefusal(t, ctlTransfer().check(newMemStore(), NoSanctions{}, &ctlMembership{active: true, members: map[string]bool{ctlHolder: true}}),
		CodeMembership, "identity "+ctlReceiver+" is not an admitted registry member")
	if err := ctlTransfer().check(newMemStore(), NoSanctions{}, &ctlMembership{active: true, members: map[string]bool{ctlHolder: true, ctlReceiver: true}}); err != nil {
		t.Fatalf("both members, refused: %v", err)
	}
}

func TestControlsRunPerTokenInLedgerOrder(t *testing.T) {
	st := newMemStore()
	st.putState(ctlState(ctlTokenA, func(s *AssetAdminState) { s.IsPaused = true }))
	st.putState(ctlState(ctlTokenB, func(s *AssetAdminState) { s.IsPaused = true }))
	tx := (&ctlTx{}).out(ctlTokenB, 5, ctlReceiver).out(ctlTokenA, 5, ctlReceiver).
		in(ctlTokenA, 5, ctlCoin, ctlHolder).in(ctlTokenB, 5, ctlCoinB, ctlHolder)
	ctlRefusal(t, tx.check(st, NoSanctions{}, nil), CodePaused, "token "+ctlTokenB+" is paused")
}

func TestControlsMissingInputOwnerIsAPlainError(t *testing.T) {
	tx := ctlTransfer()
	tx.inputOwners = map[uint32]string{}
	err := tx.check(newMemStore(), NoSanctions{}, nil)
	var rej *RejectError
	if err == nil || errors.As(err, &rej) {
		t.Fatalf("want a plain error for a missing input owner, got %v", err)
	}
}
