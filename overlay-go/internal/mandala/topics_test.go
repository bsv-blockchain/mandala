package mandala

import (
	"fmt"
	"strings"
	"testing"
)

var (
	hexA = strings.Repeat("ab", 32)
	hexB = strings.Repeat("cd", 32)
)

// legacyTopic is the pre-1Color token topic spelling tm_<txid>, which no predicate accepts any more.
func legacyTopic(txid string) string { return fmt.Sprintf("tm_%s", txid) }

func TestTopicNameConstants(t *testing.T) {
	for got, want := range map[string]string{
		MandalaTopic: "tm_mandala", MandalaLookup: "ls_mandala",
		KYCTopic: "tm_mandala_kyc", KYCLookup: "ls_mandala_kyc",
	} {
		if got != want {
			t.Fatalf("constant = %q, want %q", got, want)
		}
	}
}

func TestTokenTopicAndLookupOfACanonicalID(t *testing.T) {
	id := hexA + "_0"
	if !IsTokenID(id) {
		t.Fatalf("IsTokenID(%q) = false", id)
	}
	if got, err := TokenTopic(id); err != nil || got != "tm_color_"+id || got != TokenTopicOfTxid(hexA) {
		t.Fatalf("TokenTopic = %q, %v", got, err)
	}
	if got, err := TokenLookup(id); err != nil || got != "ls_color_"+id {
		t.Fatalf("TokenLookup = %q, %v", got, err)
	}
	if !IsTokenTopic("tm_color_"+id) || !IsColorTopic("tm_color_"+id) {
		t.Fatal("IsTokenTopic(tm_color_<hex>_0) = false")
	}
	if got, ok := TokenIDOfTopic("tm_color_" + id); !ok || got != id {
		t.Fatalf("TokenIDOfTopic = %q, %v", got, ok)
	}
}

// The Q2 near-miss table (Q2/mandala/__tests/topics.test.ts) on the 1Color names, plus Go-only
// probes for a trailing newline and a leading space, and the pre-1Color spelling.
func TestNearMissesAreNotTokenTopics(t *testing.T) {
	for _, name := range []string{
		"tm_color_" + strings.ToUpper(hexA) + "_0",
		"tm_color_" + hexA[1:] + "_0",
		"tm_color_" + hexA + "0_0",
		"tm_color_" + hexA + "_0_0",
		"tm_color_" + hexA + "_1",
		"tm_color_" + hexA + "_00",
		"tm_color_" + hexA,
		"ls_color_" + hexA + "_0",
		legacyTopic(hexA),
		legacyTopic(hexA) + "_0",
		MandalaTopic,
		KYCTopic,
		"",
		"tm_color_",
		"tm_color_" + hexA + "_0\n",
		" tm_color_" + hexA + "_0",
	} {
		if IsTokenTopic(name) || IsColorTopic(name) {
			t.Errorf("IsTokenTopic(%q) = true", name)
		}
		if id, ok := TokenIDOfTopic(name); ok || id != "" {
			t.Errorf("TokenIDOfTopic(%q) = %q, %v; want \"\", false", name, id, ok)
		}
	}
}

func TestTokenTopicRefusesNonCanonicalIDs(t *testing.T) {
	for _, id := range []string{
		hexA + "_1",
		hexA + ".0",
		hexA,
		strings.ToUpper(hexA) + "_0",
		hexA[1:] + "_0",
		hexA + "_0\n",
		"tm_color_" + hexA + "_0",
		"",
	} {
		want := "not a canonical Mandala token id: " + id
		if IsTokenID(id) {
			t.Errorf("IsTokenID(%q) = true", id)
		}
		if got, err := TokenTopic(id); err == nil || err.Error() != want || got != "" {
			t.Errorf("TokenTopic(%q) = %q, %v; want error %q", id, got, err, want)
		}
		if got, err := TokenLookup(id); err == nil || err.Error() != want || got != "" {
			t.Errorf("TokenLookup(%q) = %q, %v; want error %q", id, got, err, want)
		}
	}
}

// AdmissionSchemeOf is the one admission predicate (contract §3): tm_mandala and every color topic carry a signature,
// with their own schemes; KYC, lookups and near misses carry none.
func TestAdmissionSchemeOf(t *testing.T) {
	for name, want := range map[string]AdmissionScheme{
		MandalaTopic:              SchemeMandalaV3,
		"tm_color_" + hexA + "_0": SchemeAttestedV1,
		KYCTopic:                  SchemeNone,
		MandalaLookup:             SchemeNone,
		KYCLookup:                 SchemeNone,
		"ls_color_" + hexA + "_0": SchemeNone,
		"tm_mandala_registry":     SchemeNone,
		"tm_color_" + strings.ToUpper(hexA) + "_0": SchemeNone,
		legacyTopic(hexA):                          SchemeNone,
		"":                                         SchemeNone,
	} {
		if got := AdmissionSchemeOf(name); got != want {
			t.Errorf("AdmissionSchemeOf(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestDeployTokenOf(t *testing.T) {
	own, other := "tm_color_"+hexA+"_0", "tm_color_"+hexB+"_0"
	for _, c := range []struct {
		name   string
		topics []string
		txid   string
		want   string
		ok     bool
	}{
		{"both named", []string{MandalaTopic, own}, hexA, hexA + "_0", true},
		{"both named, reversed, repeated", []string{own, MandalaTopic, MandalaTopic}, hexA, hexA + "_0", true},
		{"with the kyc topic too", []string{KYCTopic, MandalaTopic, own}, hexA, hexA + "_0", true},
		{"registry only", []string{MandalaTopic}, hexA, "", false},
		{"own token topic only", []string{own}, hexA, "", false},
		{"another token's topic", []string{MandalaTopic, other}, hexA, "", false},
		{"pre-1Color own topic", []string{MandalaTopic, legacyTopic(hexA)}, hexA, "", false},
		{"own topic at vout 1", []string{MandalaTopic, "tm_color_" + hexA + "_1"}, hexA, "", false},
		{"uppercase txid", []string{MandalaTopic, "tm_color_" + strings.ToUpper(hexA) + "_0"}, strings.ToUpper(hexA), "", false},
		{"63-hex txid", []string{MandalaTopic, "tm_color_" + hexA[1:] + "_0"}, hexA[1:], "", false},
		{"empty txid", []string{MandalaTopic, "tm_color__0", ""}, "", "", false},
		{"no topics", nil, hexA, "", false},
	} {
		got, ok := DeployTokenOf(c.topics, c.txid)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: DeployTokenOf = %q, %v; want %q, %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestColorTopicNames(t *testing.T) {
	h := strings.Repeat("c7", 32)
	if s, _ := TokenTopic(h + "_0"); s != "tm_color_"+h+"_0" {
		t.Fatal(s)
	}
	if s, _ := TokenLookup(h + "_0"); s != "ls_color_"+h+"_0" {
		t.Fatal(s)
	}
	if _, err := TokenTopic(h + "_1"); err == nil || err.Error() != "not a canonical Mandala token id: "+h+"_1" {
		t.Fatal(err)
	}
	for _, n := range []string{legacyTopic(h), "tm_color_" + h + "_1", "tm_color_" + h + "_0\n", "tm_color_" + strings.ToUpper(h) + "_0"} {
		if IsColorTopic(n) {
			t.Fatalf("%q", n)
		}
	}
	if !IsColorTopic("tm_color_"+h+"_0") || !IsTokenTopic("tm_color_"+h+"_0") {
		t.Fatal("tm_color_<id> is not a color topic")
	}
	if got := TokenTopicOfTxid(h); got != "tm_color_"+h+"_0" {
		t.Fatal(got)
	}
	for _, bad := range []string{"", strings.ToUpper(h), h[1:], h + "_0", h + "\n"} {
		if got := TokenTopicOfTxid(bad); got != "" {
			t.Fatalf("TokenTopicOfTxid(%q) = %q, want \"\"", bad, got)
		}
	}
	if id, ok := TokenIDOfTopic("tm_color_" + h + "_0"); !ok || id != h+"_0" {
		t.Fatal(id)
	}
	if _, ok := DeployTokenOf([]string{MandalaTopic, legacyTopic(h)}, h); ok {
		t.Fatal("old pairing accepted")
	}
	if id, ok := DeployTokenOf([]string{"tm_color_" + h + "_0", MandalaTopic}, h); !ok || id != h+"_0" {
		t.Fatal(id)
	}
	want := map[string]AdmissionScheme{"tm_color_" + h + "_0": SchemeAttestedV1, MandalaTopic: SchemeMandalaV3, KYCTopic: SchemeNone, legacyTopic(h): SchemeNone, "": SchemeNone}
	for n, s := range want {
		if AdmissionSchemeOf(n) != s {
			t.Fatal(n)
		}
	}
}
