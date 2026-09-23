package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func minimal() map[string]string {
	return map[string]string{
		"ISSUER_ROOT_KEY":   "dc745c57de627a6d3a3ca549e0f9fb6b8f779108a1fe6fe290cc4df3461125d6",
		"FK_API_KEY":        "0123456789abcdef0123456789abcdef",
		"FK_STORAGE_CONFIG": "/etc/fk/infra.yaml",
		"FK_NETWORK":        "test",
		"FUEL_ASSET_IDS":    "abababababababababababababababababababababababababababababababab.0",
	}
}

func TestLoad_DefaultsAndRequired(t *testing.T) {
	cfg, err := Load(env(minimal()))
	require.NoError(t, err)
	require.Equal(t, uint64(200), cfg.Denomination)
	require.Equal(t, uint64(100), cfg.BSVRatePerKb)
	require.Equal(t, 4, cfg.KMax)
	require.Equal(t, 20, cfg.NMax)
	require.Equal(t, 10, cfg.MMax)
	require.Equal(t, int64(600), cfg.TTLSeconds)
	require.Equal(t, int64(60), cfg.ReservingTTLSeconds)
	require.Equal(t, 2, cfg.MaxOutstanding)
	require.Equal(t, 20, cfg.DailyPairs)
	require.Equal(t, 60, cfg.PairsPerMinute)
	require.Equal(t, "http://127.0.0.1:8100", cfg.StorageURL)
	require.Equal(t, 8090, cfg.APIPort)
	require.Equal(t, "sqlite", cfg.DBDriver)
	require.Equal(t, "fuelkeeper.sqlite", cfg.DBDSN)
	require.Equal(t, "fuel", cfg.PoolBasket)
	require.Equal(t, "reserve", cfg.ReserveBasket)
	require.Equal(t, uint64(100), cfg.PoolTarget)
	require.Equal(t, []string{"abababababababababababababababababababababababababababababababab.0"}, cfg.AssetIDs)
	require.True(t, cfg.AllowsAsset("abababababababababababababababababababababababababababababababab.0"))
	require.False(t, cfg.AllowsAsset("cd.0"))
}

func TestLoad_Rejects(t *testing.T) {
	cases := []struct {
		name string
		mut  func(map[string]string)
		want string
	}{
		{"missing root key", func(m map[string]string) { delete(m, "ISSUER_ROOT_KEY") }, "ISSUER_ROOT_KEY"},
		{"bad root key", func(m map[string]string) { m["ISSUER_ROOT_KEY"] = "zz" }, "ISSUER_ROOT_KEY"},
		{"short api key", func(m map[string]string) { m["FK_API_KEY"] = "short" }, "FK_API_KEY"},
		{"bad network", func(m map[string]string) { m["FK_NETWORK"] = "moon" }, "FK_NETWORK"},
		{"port below 1025", func(m map[string]string) { m["FK_API_PORT"] = "80" }, "FK_API_PORT"},
		{"bad asset id", func(m map[string]string) { m["FUEL_ASSET_IDS"] = "nope" }, "FUEL_ASSET_IDS"},
		{"zero denomination", func(m map[string]string) { m["FUEL_D"] = "0" }, "FUEL_D"},
		{"kmax zero", func(m map[string]string) { m["FUEL_K_MAX"] = "0" }, "FUEL_K_MAX"},
		{"bad driver", func(m map[string]string) { m["FK_DB_DRIVER"] = "mysql" }, "FK_DB_DRIVER"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := minimal()
			c.mut(m)
			_, err := Load(env(m))
			require.Error(t, err)
			require.Contains(t, err.Error(), c.want)
		})
	}
}

func TestLoad_EmptyAllowlistIsAllowed(t *testing.T) {
	m := minimal()
	m["FUEL_ASSET_IDS"] = ""
	cfg, err := Load(env(m))
	require.NoError(t, err)
	require.Empty(t, cfg.AssetIDs)
	require.False(t, cfg.AllowsAsset("abababababababababababababababababababababababababababababababab.0"))
}
