package mandala

import (
	"slices"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

func TestTrustedSet(t *testing.T) {
	issuer := mandalatest.Issuer.Identity
	set, err := TrustedSet([]string{issuer}, "TokenTopicManager")
	if err != nil || len(set) != 1 || !set[issuer] {
		t.Fatalf("TrustedSet(issuer) = %v, %v", set, err)
	}
	upper := strings.ToUpper(issuer)
	offCurve := "02" + strings.Repeat("ff", 32)
	cases := []struct {
		name string
		keys []string
		want string
	}{
		{"empty", nil, "TokenTopicManager: trustedIssuers must be a non-empty array"},
		{"upper case", []string{upper}, "TokenTopicManager: trusted issuer " + upper + " is not a compressed lowercase public key"},
		{"not on the curve", []string{offCurve}, "TokenTopicManager: trusted issuer " + offCurve + " is not a compressed lowercase public key"},
		{"duplicate", []string{issuer, issuer}, "TokenTopicManager: trusted issuer " + issuer + " is listed more than once"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := TrustedSet(c.keys, "TokenTopicManager"); err == nil || err.Error() != c.want {
				t.Fatalf("TrustedSet error = %v, want %q", err, c.want)
			}
		})
	}
}

func TestExemptKeys(t *testing.T) {
	keys, err := ExemptKeys(nil, "TokenRegistryTopicManager")
	if err != nil || keys == nil || len(keys) != 0 {
		t.Fatalf("ExemptKeys(nil) = %v, %v; want an empty non-nil slice", keys, err)
	}
	in := []string{mandalatest.Overlay.Identity}
	keys, err = ExemptKeys(in, "TokenRegistryTopicManager")
	if err != nil || !slices.Equal(keys, in) {
		t.Fatalf("ExemptKeys(overlay) = %v, %v", keys, err)
	}
	keys[0] = "mutated"
	if in[0] != mandalatest.Overlay.Identity {
		t.Fatal("ExemptKeys returned its input slice instead of a copy")
	}
	upper := strings.ToUpper(mandalatest.Holder.Identity)
	want := "TokenRegistryTopicManager: membership-exempt key " + upper + " is not a compressed lowercase public key"
	if _, err := ExemptKeys([]string{upper}, "TokenRegistryTopicManager"); err == nil || err.Error() != want {
		t.Fatalf("ExemptKeys(upper) error = %v, want %q", err, want)
	}
}
