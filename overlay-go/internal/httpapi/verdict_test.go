package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// TestVerdictForRejectReason is the shared substring table of wire contract
// §2, exercised with the REAL reason strings both Go topic managers emit
// (plus the TS-side wordings the contract names), so a reword on either
// stack shows up here rather than as a silently mis-typed wire code.
func TestVerdictForRejectReason(t *testing.T) {
	cases := []struct {
		name      string
		reason    string
		code      string
		http      int
		retryable bool
		final     bool
	}{
		{
			"conservation",
			"conservation violated: outputs exceed authorized inputs/issuance",
			CodeConservation, http.StatusBadRequest, false, true,
		},
		{
			"unlinked token output (FIX A, verbatim)",
			"output 1: MandalaToken-decodable output with no verified linkage",
			CodeLinkage, http.StatusBadRequest, false, true,
		},
		{
			"output linkage verification error",
			"output 1 linkage verification: cipher: message authentication failed",
			CodeLinkage, http.StatusBadRequest, false, true,
		},
		{
			"input linkage does not control the coin",
			"input 0 linkage does not control the coin being spent",
			CodeLinkage, http.StatusBadRequest, false, true,
		},
		{
			"token 1-satoshi rule",
			"token output 0 must carry exactly 1 satoshi",
			CodeSatoshis, http.StatusBadRequest, false, true,
		},
		{
			"admin 1-satoshi rule",
			"admin output 2 must carry exactly 1 satoshi",
			CodeSatoshis, http.StatusBadRequest, false, true,
		},
		{
			"control gate (contains both paused and access mode; first match wins)",
			"control gate rejected the transaction (paused asset or access mode)",
			CodePaused, http.StatusConflict, true, false,
		},
		{
			"frozen input",
			"frozen input may not be spent",
			CodeFrozen, http.StatusConflict, true, false,
		},
		{
			"membership: the upstream 'sanctioned party' wording is NOT a sanctions hit",
			"sanctioned party involved in transfer",
			CodeMembership, http.StatusConflict, true, false,
		},
		{
			"membership: identity not admitted",
			"identity not admitted: 02abc",
			CodeMembership, http.StatusConflict, true, false,
		},
		{
			"sanctions screening proper",
			"sanction list hit for 02abc",
			CodeSanctioned, http.StatusConflict, true, false,
		},
		{
			"access mode",
			"access mode refused the parties",
			CodeAccess, http.StatusConflict, true, false,
		},
		{
			"allowlist",
			"party is not on the allowlist",
			CodeAccess, http.StatusConflict, true, false,
		},
		{
			"denylist",
			"party is on the denylist",
			CodeAccess, http.StatusConflict, true, false,
		},
		{
			"conflicting spend (FIX L)",
			"input aa.0 already spent by bb",
			CodeInputSpent, http.StatusBadRequest, false, true,
		},
		{
			// The TS adminChainGuard reason verbatim. It ends in "...spent by
			// this transaction", so without the pre-empted anchoring row it
			// would mint ERR_INPUT_SPENT and tell the wallet an innocent coin
			// is gone; it also contains "previously admitted", which must not
			// be mistaken for the membership row's "not admitted".
			"admin chain anchoring (TS reason, verbatim) beats the generic spent row",
			"tm_mandala: admin action is not anchored to the asset admin chain " +
				"(priorOutpoint must be a previously admitted admin output of this asset, spent by this transaction)",
			CodeShape, http.StatusBadRequest, false, true,
		},
		{
			// Finding 9: the table has NO Go-only rows. Only the one reason
			// string both engines actually emit is matched; a paraphrase is
			// not in the table and falls where its own substrings put it.
			// This is why mandala.adminNotAnchoredReason is a constant.
			"the exact shared constant is what the anchoring row matches",
			mandala.AdminNotAnchoredReason,
			CodeShape, http.StatusBadRequest, false, true,
		},
		{
			"membership is checked before sanctions (upstream TS wording)",
			"sanctioned party involved in transfer",
			CodeMembership, http.StatusConflict, true, false,
		},
		{
			"admin key derivation is a shape problem",
			"admin output 2 key derivation: invalid counterparty hex",
			CodeShape, http.StatusBadRequest, false, true,
		},
		{
			"freeze with no token row is a shape problem",
			"tm_mandala: freezeOutput targets an outpoint with no token row: aa.0",
			CodeShape, http.StatusBadRequest, false, true,
		},
		{
			"registry genesis-only",
			"tm_mandala_registry: registration chain already exists; register is genesis-only",
			CodeShape, http.StatusBadRequest, false, true,
		},
		{
			"unmatched reason falls back to ERR_SHAPE",
			"something nobody has a substring for",
			CodeShape, http.StatusBadRequest, false, true,
		},
		{
			"matching is case-insensitive",
			"CONSERVATION VIOLATED",
			CodeConservation, http.StatusBadRequest, false, true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := VerdictForRejectReason(tc.reason)
			if got.Code != tc.code || got.HTTP != tc.http || got.Retryable != tc.retryable || got.Final != tc.final {
				t.Fatalf("verdict = %+v, want {%s %d retryable=%v final=%v}",
					got, tc.code, tc.http, tc.retryable, tc.final)
			}
		})
	}
}

// Only a topic manager's own verdict may become a 400/409. Everything else —
// SPV, storage, broadcast, screening provider, plain unknown errors — is
// ERR_UNAVAILABLE, even when its text happens to contain a word from the
// table.
func TestVerdictForSubmitErrorOnlyTrustsManagerVerdicts(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code string
		http int
		// description defaults to err.Error(); a wrapped verdict reports the
		// manager's OWN reason, not the wrapper's prefix.
		description string
	}{
		{"plain unknown error", errors.New("unknown-topic"), CodeUnavailable, http.StatusServiceUnavailable, ""},
		{
			"an infra error that merely mentions a table word",
			errors.New("mongo: conservation collection unreachable"),
			CodeUnavailable, http.StatusServiceUnavailable, "",
		},
		{
			"a store fault wrapping the word spent",
			fmt.Errorf("enginestore: refusing to mark inputs spent for aa: %w", errors.New("timeout")),
			CodeUnavailable, http.StatusServiceUnavailable, "",
		},
		{
			"a manager verdict",
			&mandala.RejectError{Topic: "tm_mandala", Err: errors.New("conservation violated")},
			CodeConservation, http.StatusBadRequest, "",
		},
		{
			"a manager verdict wrapped by a caller",
			fmt.Errorf("submit: %w", &mandala.RejectError{Topic: "tm_mandala", Err: errors.New("token output 0 must carry exactly 1 satoshi")}),
			CodeSatoshis, http.StatusBadRequest,
			"token output 0 must carry exactly 1 satoshi",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sv := VerdictForSubmitError(tc.err)
			if sv.Verdict.Code != tc.code || sv.Verdict.HTTP != tc.http {
				t.Fatalf("verdict = %+v, want %s/%d", sv.Verdict, tc.code, tc.http)
			}
			want := tc.description
			if want == "" {
				want = tc.err.Error()
			}
			if sv.Description != want {
				t.Fatalf("description = %q, want %q", sv.Description, want)
			}
		})
	}
}

// The FIX L competitor rides on the verdict structurally, not as a substring
// the HTTP layer has to parse back out of prose.
func TestVerdictForSubmitErrorCarriesTheCompetingSpendTxid(t *testing.T) {
	competitor := "bb" + vectorTxid[2:]
	err := &mandala.RejectError{
		Topic:     "tm_mandala",
		Err:       errors.New("input aa.0 already spent by " + competitor),
		SpendTxid: competitor,
	}
	sv := VerdictForSubmitError(err)
	if sv.Verdict.Code != CodeInputSpent {
		t.Fatalf("code = %s, want %s", sv.Verdict.Code, CodeInputSpent)
	}
	if sv.SpendTxid != competitor {
		t.Fatalf("spendTxid = %q, want %q", sv.SpendTxid, competitor)
	}
	// §9.2: ERR_INPUT_SPENT is re-derived from live state on every submit and
	// is NEVER persisted, even though it is final on the wire.
	if sv.Persistable() {
		t.Fatal("ERR_INPUT_SPENT must never be persisted (§9.2)")
	}
}

// A final refusal from a DIFFERENT topic's manager still gets its accurate
// 4xx, but must never become the txid's permanent verdict: the admission
// record is keyed by txid alone, so a registry refusal would otherwise
// poison a later, valid tm_mandala-only submission of the same bytes.
func TestSubmitVerdictPersistableIsScopedToTheTokenTopic(t *testing.T) {
	registryRefusal := &mandala.RejectError{
		Topic: mandala.RegistryTopic,
		Err:   errors.New("tm_mandala_registry: no admissible registry outputs"),
	}
	sv := VerdictForSubmitError(registryRefusal)
	if sv.Verdict.Code != CodeShape || sv.Verdict.HTTP != http.StatusBadRequest {
		t.Fatalf("verdict = %+v, want a final ERR_SHAPE 400 on this call", sv.Verdict)
	}
	if sv.Persistable() {
		t.Fatal("a registry refusal must not be persisted as the txid's verdict")
	}

	liftable := &mandala.RejectError{
		Topic: "tm_mandala",
		Err:   errors.New("control gate rejected the transaction (paused asset or access mode)"),
	}
	if VerdictForSubmitError(liftable).Persistable() {
		t.Fatal("a liftable 409 must not be persisted")
	}
	if (SubmitVerdict{Verdict: verdictUnavailable}).Persistable() {
		t.Fatal("a dependency fault must not be persisted")
	}
}

// Finding 9 / wire contract §2 — the substring table is the SAME table as the
// TS engine's REASON_TABLE (overlay/src/submitVerdict.ts): same rows, same
// codes, same order, no Go-only additions. TS groups several substrings under
// one code in a single row; Go lists them as consecutive single-substring
// rows, which is the identical first-hit-wins table flattened. This golden
// list is the check: if either stack's table moves, this fails and the two are
// reconciled deliberately rather than drifting.
func TestRejectReasonTableMatchesTheTSTableRowForRow(t *testing.T) {
	// overlay/src/submitVerdict.ts REASON_TABLE, flattened in order.
	want := []struct {
		substring string
		code      string
	}{
		{"not anchored to the asset admin chain", CodeShape},
		{"conservation", CodeConservation},
		{"no verified linkage", CodeLinkage},
		{"linkage", CodeLinkage},
		{"satoshi", CodeSatoshis},
		{"sanctioned party", CodeMembership},
		{"not admitted", CodeMembership},
		{"membership", CodeMembership},
		{"paused", CodePaused},
		{"frozen", CodeFrozen},
		{"sanction", CodeSanctioned},
		{"access mode", CodeAccess},
		{"allowlist", CodeAccess},
		{"denylist", CodeAccess},
		{"spent", CodeInputSpent},
	}
	if len(rejectReasonTable) != len(want) {
		t.Fatalf("table has %d rows, want %d (TS REASON_TABLE flattened)", len(rejectReasonTable), len(want))
	}
	for i, w := range want {
		got := rejectReasonTable[i]
		if got.Substring != w.substring || got.Verdict.Code != w.code {
			t.Fatalf("row %d = {%q -> %s}, want {%q -> %s}", i, got.Substring, got.Verdict.Code, w.substring, w.code)
		}
	}
}
