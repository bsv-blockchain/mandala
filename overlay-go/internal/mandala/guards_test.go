package mandala

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Wire contract §9.5 / §9.6 — the guard pipeline, proven from the outside:
// the ORDER refusals are minted in, and the rule that no dependency fault
// inside any guard may ever be minted as a verdict.

// ---------------------------------------------------------------------------
// §9.6 — canonical guard order
// ---------------------------------------------------------------------------

// breakLinkage removes output 1's linkage entry, so guard 1 (unlinked-token
// reject) has something to refuse.
func breakLinkage(h *harness) {
	h.payload.Outputs = h.payload.Outputs[:1]
}

// conflictingSpend points the FIX L guard at a competitor that already spent
// the harness input.
func conflictingSpend(h *harness) string {
	competitor := strings.Repeat("cd", 32)
	h.tm.WithSpendChecker(fakeSpendChecker{h.srcOutpoint: competitor})
	return competitor
}

// unanchoredAdmin appends an admin action whose priorOutpoint is an input this
// topic never admitted as an admin output of the asset — the §9.6 guard-3
// refusal.
func unanchoredAdmin(t *testing.T, h *harness) {
	t.Helper()
	prior := h.addPriorAuthInput(0xAB, 3)
	h.addAdminOutput(t, ActionDetails{
		"kind": "pause", "assetId": h.assetID, "priorOutpoint": prior,
	})
}

// pauseAsset makes the harness asset paused, which the manager's own control
// gate (guard 4) refuses for a peer transfer.
func pauseAsset(h *harness) {
	st := DefaultAssetState(h.assetID)
	st.IsPaused = true
	h.state.states[h.assetID] = st
}

// TestGuardOrderIsCanonical pins wire contract §9.6: when a transaction trips
// several guards at once, the FIRST one in the canonical order is the verdict
// the submitter gets — unlinked-token → conflicting-spend → admin-chain →
// manager. Both engines must agree, so a transaction cannot earn ERR_LINKAGE
// here and ERR_INPUT_SPENT there.
func TestGuardOrderIsCanonical(t *testing.T) {
	t.Run("unlinked token beats every later guard", func(t *testing.T) {
		h := newHarness(t)
		breakLinkage(h)
		conflictingSpend(h)
		unanchoredAdmin(t, h)
		pauseAsset(h)
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, "output 1: MandalaToken-decodable output with no verified linkage")
	})

	t.Run("conflicting spend beats admin-chain and the manager", func(t *testing.T) {
		h := newHarness(t)
		competitor := conflictingSpend(h)
		unanchoredAdmin(t, h)
		pauseAsset(h)
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, "already spent by "+competitor)
	})

	t.Run("admin-chain beats the manager's own rules", func(t *testing.T) {
		h := newHarness(t)
		unanchoredAdmin(t, h)
		pauseAsset(h)
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, AdminNotAnchoredReason)
	})

	t.Run("with every earlier guard clear the manager rules apply", func(t *testing.T) {
		h := newHarness(t)
		pauseAsset(h)
		_, err := h.run(t, []uint32{0})
		wantReject(t, err, "control gate rejected")
	})
}

// ---------------------------------------------------------------------------
// §9.6 — an unanchored admin action rejects the WHOLE submission
// ---------------------------------------------------------------------------

// TestUnanchoredAdminActionRejectsTheWholeSubmission is the Go half of the
// contract's "never a silent skip": an admin entry that does not chain to the
// asset's recorded admin output used to be dropped, leaving the transaction to
// be admitted (minus that output) with the submitter told nothing. The TS
// engine has always rejected; now so does this one, with the same sentence.
func TestUnanchoredAdminActionRejectsTheWholeSubmission(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, h *harness) []uint32
	}{
		{"prior is not an admin output of the asset", func(t *testing.T, h *harness) []uint32 {
			prior := h.addPriorAuthInput(0xAB, 3)
			h.addAdminOutput(t, ActionDetails{
				"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
			})
			return []uint32{0, 1}
		}},
		{"prior is recorded but not spent by this tx", func(t *testing.T, h *harness) []uint32 {
			prior := h.addRecordedAdminPrior(0x77, 1)
			h.addAdminOutput(t, ActionDetails{
				"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
			})
			return []uint32{0} // the prior is not among previousCoins
		}},
		{"no priorOutpoint at all", func(t *testing.T, h *harness) []uint32 {
			h.addAdminOutput(t, ActionDetails{"kind": "unpause", "assetId": h.assetID})
			return []uint32{0}
		}},
		{"payload entry names an output that is not admin-shaped", func(t *testing.T, h *harness) []uint32 {
			// The entry asserts authority even though no admin output backs
			// it; TS refuses on the payload entry alone, and so must Go.
			prior := h.addPriorAuthInput(0xAB, 3)
			h.payload.Admin = append(h.payload.Admin, IndexedAdmin{
				Index: 0, // output 0 is a token output
				ActionDetails: ActionDetails{
					"kind": "unpause", "assetId": h.assetID, "priorOutpoint": prior,
				},
			})
			return []uint32{0}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			previousCoins := tc.setup(t, h)
			res, err := h.run(t, previousCoins)
			wantReject(t, err, AdminNotAnchoredReason)
			if len(res.OutputsToAdmit) != 0 {
				t.Fatalf("an unanchored admin action must reject the whole submission, admitted %v", res.OutputsToAdmit)
			}
			var rej *RejectError
			if !errors.As(err, &rej) {
				t.Fatalf("an unanchored admin action must be a manager verdict, got %#v", err)
			}
		})
	}
}

func TestAnchoredAdminActionStillAdmits(t *testing.T) {
	h := newHarness(t)
	prior := h.addRecordedAdminPrior(0x77, 1)
	h.addAdminOutput(t, ActionDetails{
		"kind": "pause", "assetId": h.assetID, "priorOutpoint": prior,
	})
	res, err := h.run(t, []uint32{0, 1})
	if err != nil {
		t.Fatalf("a properly anchored admin action was rejected: %v", err)
	}
	wantAdmitted(t, res, 0, 1, 2)
}

// A genesis register has no prior to chain to, and guard 3 must not invent one.
func TestRegisterIsExemptFromTheAnchoringGuard(t *testing.T) {
	h := newHarness(t)
	h.addAdminOutput(t, ActionDetails{"kind": "register"})
	if _, err := h.run(t, []uint32{0}); err != nil {
		t.Fatalf("genesis register rejected by the anchoring guard: %v", err)
	}
}

// ---------------------------------------------------------------------------
// §9.5 — infra faults are never final, and never dropped
// ---------------------------------------------------------------------------

// faultyState fails exactly one store read and passes everything else through
// to the harness fake, so each guard's dependency can be broken in isolation.
type faultyState struct {
	*fakeState
	tokenRowErr      error
	assetStateErr    error
	assetStateErrFor map[string]error
	adminOutpointErr error
	issuerKeysErr    error
}

func (f faultyState) GetTokenRow(ctx context.Context, txid string, vout uint32) (*TokenRow, error) {
	if f.tokenRowErr != nil {
		return nil, f.tokenRowErr
	}
	return f.fakeState.GetTokenRow(ctx, txid, vout)
}

func (f faultyState) GetAssetState(ctx context.Context, id string) (AssetAdminState, error) {
	if f.assetStateErr != nil {
		return AssetAdminState{}, f.assetStateErr
	}
	if err := f.assetStateErrFor[id]; err != nil {
		return AssetAdminState{}, err
	}
	return f.fakeState.GetAssetState(ctx, id)
}

func (f faultyState) IsAdminOutpoint(ctx context.Context, assetID, txid string, vout uint32) (bool, error) {
	if f.adminOutpointErr != nil {
		return false, f.adminOutpointErr
	}
	return f.fakeState.IsAdminOutpoint(ctx, assetID, txid, vout)
}

func (f faultyState) IssuerIdentityKeys(ctx context.Context) ([]string, error) {
	if f.issuerKeysErr != nil {
		return nil, f.issuerKeysErr
	}
	return f.fakeState.IssuerIdentityKeys(ctx)
}

// faultyRegistry breaks either half of the RegistryReader seam.
type faultyRegistry struct {
	activeErr   error
	admittedErr error
}

func (f faultyRegistry) RegistryActive(context.Context) (bool, error) {
	if f.activeErr != nil {
		return false, f.activeErr
	}
	return true, nil
}

func (f faultyRegistry) IsAdmitted(context.Context, string) (bool, error) {
	return false, f.admittedErr
}

// TestInfraFaultInEveryGuardIsNeverAVerdict is wire contract §9.5 in one
// table: a store, provider or chaintracker fault raised ANYWHERE in the
// admission pipeline — identity resolution, the spent check, the admin-outpoint
// lookup, the registry/screening providers, asset state — must surface as a
// dependency fault (so the HTTP layer answers 503 ERR_UNAVAILABLE), must never
// be minted as a 4xx verdict, and must never be swallowed so the guard it
// gates fails OPEN.
func TestInfraFaultInEveryGuardIsNeverAVerdict(t *testing.T) {
	boom := errors.New("mongo down")

	cases := []struct {
		name  string
		build func(t *testing.T) (*harness, []uint32)
	}{
		{"token row lookup in identity resolution", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
				faultyState{fakeState: h.state, tokenRowErr: boom})
			return h, []uint32{0}
		}},
		{"token row lookup behind a freeze target", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			prior := h.addRecordedAdminPrior(0x77, 1)
			h.addAdminOutput(t, ActionDetails{
				"kind": "freezeOutput", "assetId": h.assetID,
				"outpoint": h.srcOutpoint, "priorOutpoint": prior,
			})
			h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
				faultyState{fakeState: h.state, tokenRowErr: boom})
			return h, []uint32{0, 1}
		}},
		{"admin outpoint lookup in the anchoring guard", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			prior := h.addPriorAuthInput(0x77, 1)
			h.addAdminOutput(t, ActionDetails{
				"kind": "pause", "assetId": h.assetID, "priorOutpoint": prior,
			})
			h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
				faultyState{fakeState: h.state, adminOutpointErr: boom})
			return h, []uint32{0, 1}
		}},
		{"asset state in the control gates", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
				faultyState{fakeState: h.state, assetStateErr: boom})
			return h, []uint32{0}
		}},
		{"spent state in the conflicting-spend guard", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			h.tm.WithSpendChecker(failingSpendChecker{err: boom})
			return h, []uint32{0}
		}},
		{"sanctions provider", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			h.tm = NewTopicManager(h.verifier, h.adminW, failingScreen{err: boom}, h.state)
			return h, []uint32{0}
		}},
		{"registry liveness probe", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			h.tm.WithRegistry(faultyRegistry{activeErr: boom})
			return h, []uint32{0}
		}},
		{"registry membership probe", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			h.tm.WithRegistry(faultyRegistry{admittedErr: boom})
			return h, []uint32{0}
		}},
		{"asset state behind the membership issuer exemption", func(t *testing.T) (*harness, []uint32) {
			// The admin action names a DIFFERENT asset than the one moving, so
			// only the membership gate reads that asset's state — the loop
			// that used to drop its error on the floor.
			h := newHarness(t)
			otherAsset := strings.Repeat("cd", 32) + ".0"
			prior := h.addPriorAuthInput(0x77, 1)
			h.state.adminOutpoints[otherAsset+"|"+prior] = true
			h.addAdminOutput(t, ActionDetails{
				"kind": "pause", "assetId": otherAsset, "priorOutpoint": prior,
			})
			h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
				faultyState{fakeState: h.state, assetStateErrFor: map[string]error{otherAsset: boom}}).
				WithRegistry(admittedRegistry{h.holderID: true, h.recipientID: true})
			return h, []uint32{0, 1}
		}},
		{"issuer key list behind the membership exemption", func(t *testing.T) (*harness, []uint32) {
			h := newHarness(t)
			h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
				faultyState{fakeState: h.state, issuerKeysErr: boom}).
				WithRegistry(admittedRegistry{h.holderID: true, h.recipientID: true})
			return h, []uint32{0}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, previousCoins := tc.build(t)
			res, err := h.run(t, previousCoins)
			if err == nil {
				t.Fatalf("the fault was swallowed: the guard failed OPEN and admitted %v", res.OutputsToAdmit)
			}
			if len(res.OutputsToAdmit) != 0 {
				t.Fatalf("a faulted submission must admit nothing, admitted %v", res.OutputsToAdmit)
			}
			var rej *RejectError
			if errors.As(err, &rej) {
				t.Fatalf("a dependency fault was minted as a manager verdict (a permanent 4xx): %v", err)
			}
			var fault *infraError
			if !errors.As(err, &fault) {
				t.Fatalf("a dependency fault must be typed as infra so the HTTP layer answers 503, got %#v", err)
			}
			if !errors.Is(err, boom) {
				t.Fatalf("the underlying fault must stay wrapped for the operator, got %v", err)
			}
		})
	}
}

// A guard that cannot read the state it gates on must fail CLOSED: the
// sanctioned/non-admitted party below is named ONLY by the stored token row,
// so a token-row fault is the difference between refusing the spend and
// letting a sanctioned holder move coins.
func TestTokenRowFaultFailsTheSanctionsAndMembershipGatesClosed(t *testing.T) {
	boom := errors.New("mongo down")

	t.Run("sanctions", func(t *testing.T) {
		h := newHarness(t)
		h.payload.Inputs = nil // blinded sender: only the stored row names them
		h.state.tokens[h.srcOutpoint] = &TokenRow{
			Txid: h.srcTx.TxID().String(), OutputIndex: 0,
			AssetID: h.assetID, Amount: 100, IdentityKey: h.holderID,
		}
		h.screen[h.holderID] = true
		if _, err := h.run(t, []uint32{0}); err == nil {
			t.Fatal("control: a sanctioned owner was admitted with a healthy store")
		}

		h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
			faultyState{fakeState: h.state, tokenRowErr: boom})
		res, err := h.run(t, []uint32{0})
		if err == nil {
			t.Fatalf("FAIL-OPEN: a sanctioned owner was admitted under a store fault: %v", res.OutputsToAdmit)
		}
	})

	t.Run("membership", func(t *testing.T) {
		h := newHarness(t)
		h.payload.Inputs = nil
		h.state.tokens[h.srcOutpoint] = &TokenRow{
			Txid: h.srcTx.TxID().String(), OutputIndex: 0,
			AssetID: h.assetID, Amount: 100, IdentityKey: h.holderID,
		}
		h.tm.WithRegistry(admittedRegistry{h.recipientID: true}) // holder revoked
		if _, err := h.run(t, []uint32{0}); err == nil {
			t.Fatal("control: a revoked owner was admitted with a healthy store")
		}

		h.tm = NewTopicManager(h.verifier, h.adminW, h.screen,
			faultyState{fakeState: h.state, tokenRowErr: boom}).
			WithRegistry(admittedRegistry{h.recipientID: true})
		res, err := h.run(t, []uint32{0})
		if err == nil {
			t.Fatalf("FAIL-OPEN: a revoked owner was admitted under a store fault: %v", res.OutputsToAdmit)
		}
	})
}
