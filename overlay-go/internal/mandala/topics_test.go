package mandala

import (
	"strings"
	"testing"
)

var (
	hexA = strings.Repeat("ab", 32)
	hexB = strings.Repeat("cd", 32)
)

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
	if got, err := TokenTopic(id); err != nil || got != "tm_"+hexA {
		t.Fatalf("TokenTopic = %q, %v", got, err)
	}
	if got, err := TokenLookup(id); err != nil || got != "ls_"+hexA {
		t.Fatalf("TokenLookup = %q, %v", got, err)
	}
	if !IsTokenTopic("tm_" + hexA) {
		t.Fatal("IsTokenTopic(tm_<hex>) = false")
	}
	if got, ok := TokenIDOfTopic("tm_" + hexA); !ok || got != id {
		t.Fatalf("TokenIDOfTopic = %q, %v", got, ok)
	}
}

// The Q2 near-miss table (Q2/mandala/__tests/topics.test.ts), plus Go-only
// probes for a trailing newline and a leading space.
func TestNearMissesAreNotTokenTopics(t *testing.T) {
	for _, name := range []string{
		"tm_" + strings.ToUpper(hexA),
		"tm_" + hexA[1:],
		"tm_" + hexA + "0",
		"tm_" + hexA + "_0",
		"ls_" + hexA,
		MandalaTopic,
		KYCTopic,
		"",
		"tm_",
		"tm_" + hexA + "\n",
		" tm_" + hexA,
	} {
		if IsTokenTopic(name) {
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
		"tm_" + hexA,
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

func TestIsSigmaTopic(t *testing.T) {
	for name, want := range map[string]bool{
		MandalaTopic:                  true,
		"tm_" + hexA:                  true,
		KYCTopic:                      false,
		MandalaLookup:                 false,
		KYCLookup:                     false,
		"ls_" + hexA:                  false,
		"tm_mandala_registry":         false,
		"tm_" + strings.ToUpper(hexA): false,
		"":                            false,
	} {
		if got := IsSigmaTopic(name); got != want {
			t.Errorf("IsSigmaTopic(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestDeployTokenOf(t *testing.T) {
	for _, c := range []struct {
		name   string
		topics []string
		txid   string
		want   string
		ok     bool
	}{
		{"both named", []string{MandalaTopic, "tm_" + hexA}, hexA, hexA + "_0", true},
		{"both named, reversed, repeated", []string{"tm_" + hexA, MandalaTopic, MandalaTopic}, hexA, hexA + "_0", true},
		{"with the kyc topic too", []string{KYCTopic, MandalaTopic, "tm_" + hexA}, hexA, hexA + "_0", true},
		{"registry only", []string{MandalaTopic}, hexA, "", false},
		{"own token topic only", []string{"tm_" + hexA}, hexA, "", false},
		{"another token's topic", []string{MandalaTopic, "tm_" + hexB}, hexA, "", false},
		{"uppercase txid", []string{MandalaTopic, "tm_" + strings.ToUpper(hexA)}, strings.ToUpper(hexA), "", false},
		{"63-hex txid", []string{MandalaTopic, "tm_" + hexA[1:]}, hexA[1:], "", false},
		{"empty txid", []string{MandalaTopic, "tm_"}, "", "", false},
		{"no topics", nil, hexA, "", false},
	} {
		got, ok := DeployTokenOf(c.topics, c.txid)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: DeployTokenOf = %q, %v; want %q, %v", c.name, got, ok, c.want, c.ok)
		}
	}
}
