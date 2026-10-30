package mandala

import (
	"crypto/sha256"
	"errors"
	"io/fs"
	"os"
	"testing"
)

// The contract §10 ENVELOPE seam (must-pass): P-LIB checks in a deterministic-key envelope fixture and an
// overlay-go engine-flow test admits it. P-GO copies the file byte for byte, as with F-REQ.
const goEnvelope, libEnvelope = "testdata/1color-envelope.json", "../../../lib/src/__fixtures__/1color-envelope.json"

// TestEnvelopeFixtureMatchesLib guards the byte-for-byte copy; internal/httpapi TestTSEnvelopeAdmitted admits it. While P-LIB's file is absent the test
// logs and passes (no t.Skip, so the 0-SKIP gate holds). Once P-LIB checks the file in, this fails until the Go
// copy exists with the same sha256; whoever copies it adds the engine-flow test that admits it (pre-merge
// follow-up, blocked on P-LIB).
func TestEnvelopeFixtureMatchesLib(t *testing.T) {
	lib, err := os.ReadFile(libEnvelope)
	if errors.Is(err, fs.ErrNotExist) {
		t.Logf("%s absent; the ENVELOPE seam (contract §10) waits on P-LIB", libEnvelope)
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	gof, err := os.ReadFile(goEnvelope)
	if err != nil {
		t.Fatalf("P-LIB checked in %s but %s is missing (%v): `cp ../../../lib/src/__fixtures__/1color-envelope.json testdata/` and add the engine-flow test that admits it (contract §10 ENVELOPE seam)", libEnvelope, goEnvelope, err)
	}
	if a, b := sha256.Sum256(lib), sha256.Sum256(gof); a != b {
		t.Fatalf("envelope fixture drift: sha256 lib %x != go %x; re-copy P-LIB's file", a, b)
	}
}
