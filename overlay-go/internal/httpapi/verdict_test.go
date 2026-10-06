package httpapi

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// D §6.3 / F/p2-parity §4, row for row: every manager code has exactly one row.
func TestVerdictForCodeCoversEveryManagerCode(t *testing.T) {
	cases := []struct {
		code      mandala.Code
		http      int
		retryable bool
		final     bool
	}{
		{mandala.CodeConservation, 400, false, true},
		{mandala.CodeLinkage, 400, false, true},
		{mandala.CodeShape, 400, false, true},
		{mandala.CodeSatoshis, 400, false, true},
		{mandala.CodeAuthority, 400, false, true},
		{mandala.CodeInputSpent, 400, false, true},
		{mandala.CodeUntrusted, 409, true, false},
		{mandala.CodePaused, 409, true, false},
		{mandala.CodeFrozen, 409, true, false},
		{mandala.CodeSanctioned, 409, true, false},
		{mandala.CodeAccess, 409, true, false},
		{mandala.CodeMembership, 409, true, false},
		{mandala.CodeUnavailable, 503, true, false},
	}
	for _, c := range cases {
		v, ok := VerdictForCode(c.code)
		if !ok || v.Code != string(c.code) || v.HTTP != c.http || v.Retryable != c.retryable || v.Final != c.final {
			t.Errorf("%s: verdict %+v (found=%v), want HTTP %d retryable=%v final=%v", c.code, v, ok, c.http, c.retryable, c.final)
		}
	}
	if len(verdictRows) != len(cases) {
		t.Fatalf("verdictRows has %d rows, want exactly the %d manager codes", len(verdictRows), len(cases))
	}
	if _, ok := VerdictForCode("ERR_FUEL"); ok {
		t.Fatal("a code outside the table must not resolve")
	}
	if verdictEvicted != (Verdict{Code: "ERR_EVICTED", HTTP: 410, Retryable: false, Final: true}) {
		t.Fatalf("verdictEvicted = %+v", verdictEvicted)
	}
}

func TestVerdictForSubmitError(t *testing.T) {
	typed := &mandala.RejectError{Code: mandala.CodeAuthority, Reason: "output 0: deploy requires a valid deploySig over this txid", Topic: mandala.MandalaTopic}
	cases := []struct {
		name   string
		err    error
		http   int
		code   string
		desc   string
		topic  string
		spend  string
		typedV bool
	}{
		{"typed", typed, 400, CodeAuthority, typed.Reason, mandala.MandalaTopic, "", true},
		{"typed through a wrap", fmt.Errorf("engine: %w", typed), 400, CodeAuthority, typed.Reason, mandala.MandalaTopic, "", true},
		{"untrusted", &mandala.RejectError{Code: mandala.CodeUntrusted, Reason: "output 0: owner 02aa is not a trusted issuer", Topic: testTopicA},
			409, CodeUntrusted, "output 0: owner 02aa is not a trusted issuer", testTopicA, "", true},
		{"input spent", &mandala.RejectError{Code: mandala.CodeInputSpent, Reason: "input " + vectorTxid + ".0: already spent by " + strings.Repeat("c", 64), Topic: testTopicA, SpendTxid: strings.Repeat("c", 64)},
			400, CodeInputSpent, "input " + vectorTxid + ".0: already spent by " + strings.Repeat("c", 64), testTopicA, strings.Repeat("c", 64), true},
		{"typed unavailable", &mandala.RejectError{Code: mandala.CodeUnavailable, Reason: "the owner journal could not be written; retry", Topic: testTopicA, Cause: errors.New("mongo")},
			503, CodeUnavailable, "the owner journal could not be written; retry", testTopicA, "", true},
		{"untyped manager fault", &mandala.RejectError{Reason: "txid not in BEEF", Topic: testTopicA}, 400, CodeShape, "txid not in BEEF", testTopicA, "", false},
		{"code outside the table", &mandala.RejectError{Code: "ERR_FUEL", Reason: "no fuel", Topic: testTopicA}, 400, CodeShape, "no fuel", testTopicA, "", false},
		{"engine unknown topic", engine.ErrUnknownTopic, 400, CodeShape, "unknown-topic", "", "", false},
		{"wrapped unknown topic", fmt.Errorf("submit: %w", engine.ErrUnknownTopic), 400, CodeShape, "unknown-topic", "", "", false},
		{"dependency fault", errors.New("mongo down"), 503, CodeUnavailable, "mongo down", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sv := VerdictForSubmitError(c.err)
			if sv.Verdict.HTTP != c.http || sv.Verdict.Code != c.code || sv.Description != c.desc || sv.Topic != c.topic || sv.SpendTxid != c.spend || sv.Typed != c.typedV {
				t.Fatalf("verdict = %+v, want HTTP %d %s %q topic %q spend %q typed %v", sv, c.http, c.code, c.desc, c.topic, c.spend, c.typedV)
			}
		})
	}
}

// A1.3: typed, final, refused by tm_mandala or a tm_<id>, and not ERR_INPUT_SPENT.
func TestSubmitVerdictPersistableFollowsA13(t *testing.T) {
	sv := func(code mandala.Code, topic string) SubmitVerdict {
		return VerdictForSubmitError(&mandala.RejectError{Code: code, Reason: "r", Topic: topic})
	}
	cases := []struct {
		name string
		v    SubmitVerdict
		want bool
	}{
		{"conservation on a token topic", sv(mandala.CodeConservation, testTopicA), true},
		{"linkage on a token topic", sv(mandala.CodeLinkage, testTopicA), true},
		{"satoshis on a token topic", sv(mandala.CodeSatoshis, testTopicA), true},
		{"authority on a token topic", sv(mandala.CodeAuthority, testTopicA), true},
		{"shape on the registry", sv(mandala.CodeShape, mandala.MandalaTopic), true},
		{"shape on KYC", sv(mandala.CodeShape, mandala.KYCTopic), false},
		{"authority on KYC", sv(mandala.CodeAuthority, mandala.KYCTopic), false},
		{"input spent", sv(mandala.CodeInputSpent, testTopicA), false},
		{"untrusted", sv(mandala.CodeUntrusted, testTopicA), false},
		{"paused", sv(mandala.CodePaused, testTopicA), false},
		{"unavailable", sv(mandala.CodeUnavailable, testTopicA), false},
		{"untyped", sv("", testTopicA), false},
		{"engine unknown topic", VerdictForSubmitError(engine.ErrUnknownTopic), false},
		{"not a topic name", sv(mandala.CodeShape, "tm_"+strings.Repeat("A", 64)), false},
	}
	for _, c := range cases {
		if got := c.v.Persistable(); got != c.want {
			t.Errorf("%s: Persistable() = %v, want %v (%+v)", c.name, got, c.want, c.v)
		}
	}
}

// The v2 substring classifier is gone: codes travel structurally.
func TestRejectReasonTableIsDeleted(t *testing.T) {
	src, err := os.ReadFile("verdict.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"rejectReasonTable", "VerdictForRejectReason"} {
		if strings.Contains(string(src), gone) {
			t.Fatalf("verdict.go still mentions %s", gone)
		}
	}
}
