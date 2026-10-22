package mandala

import (
	"strings"
	"testing"
)

// The six GetDocumentation strings name the per-asset color topics, the attested admission signature and the
// color-* lookups, and never claim 1Color/color-service conformance (design §3; 0207:775-786).
func TestDocsNameColorTopicsWithoutConformanceClaim(t *testing.T) {
	for _, d := range []string{docTokenTopic, docTokenRegistryTopic, docTokenLookup, docTokenRegistryLookup, docKYCTopic, docKYCLookup} {
		if strings.Contains(d, "tm_<deploy txid>") || strings.Contains(d, "ls_<deploy txid>") {
			t.Fatal(d)
		}
		if strings.Contains(strings.ToLower(d), "conforming") {
			t.Fatal("conformance claim: " + d)
		}
	}
	if !strings.Contains(docTokenTopic, "tm_color_<assetId>") || !strings.Contains(docTokenLookup, "color-spendability") {
		t.Fatal("missing names")
	}
}
