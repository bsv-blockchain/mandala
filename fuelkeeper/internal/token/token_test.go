package token

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

type vectors struct {
	TokenScripts []struct {
		AssetID    string `json:"assetId"`
		Amount     int64  `json:"amount"`
		PubKeyHash []byte `json:"pubKeyHash"`
		ScriptHex  string `json:"scriptHex"`
	} `json:"tokenScripts"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "overlay-go", "testdata", "vectors.json"))
	require.NoError(t, err, "overlay-go/testdata/vectors.json must exist (shared golden fixtures)")
	var v vectors
	require.NoError(t, json.Unmarshal(raw, &v))
	require.NotEmpty(t, v.TokenScripts)
	return v
}

func TestLockToken_ParityWithOverlayVectors(t *testing.T) {
	for _, tc := range loadVectors(t).TokenScripts {
		s, err := LockToken(tc.AssetID, tc.Amount, tc.PubKeyHash)
		require.NoError(t, err, tc.AssetID)
		require.Equal(t, tc.ScriptHex, hex.EncodeToString(*s), "amount %d", tc.Amount)
	}
}

func TestLockToken_Bounds(t *testing.T) {
	pkh := make([]byte, 20)
	_, err := LockToken("abababababababababababababababababababababababababababababababab.0", 0, pkh)
	require.Error(t, err)
	_, err = LockToken("abababababababababababababababababababababababababababababababab.0", MaxSafeAmount+1, pkh)
	require.Error(t, err)
	_, err = LockToken("abababababababababababababababababababababababababababababababab.0", 1, pkh[:19])
	require.Error(t, err)
	_, err = LockToken("nope", 1, pkh)
	require.Error(t, err)
}

func TestValidAssetID(t *testing.T) {
	require.True(t, ValidAssetID("abababababababababababababababababababababababababababababababab.0"))
	require.False(t, ValidAssetID("ABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABAB.0"))
	require.False(t, ValidAssetID("abab.0"))
	require.False(t, ValidAssetID("abababababababababababababababababababababababababababababababab"))
}

func TestScriptHash(t *testing.T) {
	scr := []byte{0x76, 0xa9}
	sum := sha256.Sum256(scr)
	want := make([]byte, 32)
	for i := range sum {
		want[31-i] = sum[i]
	}
	require.Equal(t, hex.EncodeToString(want), ScriptHash(scr))
}
