// Package config parses the fuelKeeper process configuration from the
// environment (spec §4.2). Every knob has the spec default; required values
// fail loudly at startup.
package config

import (
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/defs"
)

// Config is the fully validated process configuration.
type Config struct {
	IssuerRootKeyHex string
	Network          defs.BSVNetwork

	APIPort     int
	APIKey      string
	StorageURL  string // loopback URL of the in-process infra storage server
	StorageConf string // path to the infra yaml handed to infra.NewServer

	DBDriver string // "sqlite" | "postgres"
	DBDSN    string

	Denomination        uint64 // D
	BSVRatePerKb        uint64 // BSV_RATE
	KMax, NMax, MMax    int
	TTLSeconds          int64
	ReservingTTLSeconds int64
	AssetIDs            []string
	MaxOutstanding      int
	DailyPairs          int
	PairsPerMinute      int

	OverlayURL        string
	OverlayAdminToken string

	// Pool keeper (fuelkeeper.Config inputs). Denomination MUST equal the
	// storage server's resolved denomination (infra yaml
	// utxo_management.throughput.denomination_satoshis) or every fan-out is
	// rejected by the server.
	PoolBasket, ReserveBasket string
	PoolTarget                uint64
	LowWaterPercent           uint64
	HighWaterPercent          uint64
	FanoutOutputsPerTx        uint64
	FanoutMaxTxsPerRound      uint64
	KeeperIntervalSeconds     int64
	SweeperIntervalSeconds    int64

	WoCAPIKey string // optional; enables the WhatsOnChain IsUtxo chain check
}

var assetIDRe = regexp.MustCompile(`^[0-9a-f]{64}\.[0-9]+$`)

// AllowsAsset reports whether assetId is on the operator allowlist (§2.1).
func (c Config) AllowsAsset(assetID string) bool {
	for _, a := range c.AssetIDs {
		if a == assetID {
			return true
		}
	}
	return false
}

// Load reads and validates the configuration. getenv is injected for tests.
func Load(getenv func(string) string) (Config, error) {
	var c Config
	var errs []string
	fail := func(f string, a ...any) { errs = append(errs, fmt.Sprintf(f, a...)) }

	c.IssuerRootKeyHex = strings.TrimSpace(getenv("ISSUER_ROOT_KEY"))
	if b, err := hex.DecodeString(c.IssuerRootKeyHex); err != nil || len(b) != 32 {
		fail("ISSUER_ROOT_KEY must be 32 bytes hex")
	}
	c.APIKey = getenv("FK_API_KEY")
	if len(c.APIKey) < 32 {
		fail("FK_API_KEY must be at least 32 characters")
	}
	net, err := defs.ParseBSVNetworkStr(strings.TrimSpace(getenv("FK_NETWORK")))
	if err != nil {
		fail("FK_NETWORK: %v", err)
	}
	c.Network = net
	c.StorageConf = getenv("FK_STORAGE_CONFIG")
	if c.StorageConf == "" {
		fail("FK_STORAGE_CONFIG is required")
	}
	c.StorageURL = orDefault(getenv("FK_STORAGE_URL"), "http://127.0.0.1:8100")
	c.APIPort = intOr(getenv, "FK_API_PORT", 8090, &errs)
	if c.APIPort < 1025 || c.APIPort > 65535 {
		fail("FK_API_PORT must be in [1025, 65535]")
	}
	c.DBDriver = orDefault(getenv("FK_DB_DRIVER"), "sqlite")
	if c.DBDriver != "sqlite" && c.DBDriver != "postgres" {
		fail("FK_DB_DRIVER must be sqlite or postgres")
	}
	c.DBDSN = orDefault(getenv("FK_DB_DSN"), "fuelkeeper.sqlite")

	c.Denomination = u64Or(getenv, "FUEL_D", 200, &errs)
	if c.Denomination == 0 {
		fail("FUEL_D must be > 0")
	}
	c.BSVRatePerKb = u64Or(getenv, "FUEL_BSV_RATE", 100, &errs)
	if c.BSVRatePerKb == 0 {
		fail("FUEL_BSV_RATE must be > 0")
	}
	c.KMax = intOr(getenv, "FUEL_K_MAX", 4, &errs)
	c.NMax = intOr(getenv, "FUEL_N_MAX", 20, &errs)
	c.MMax = intOr(getenv, "FUEL_M_MAX", 10, &errs)
	for name, v := range map[string]int{"FUEL_K_MAX": c.KMax, "FUEL_N_MAX": c.NMax, "FUEL_M_MAX": c.MMax} {
		if v < 1 {
			fail("%s must be >= 1", name)
		}
	}
	c.TTLSeconds = int64(intOr(getenv, "FUEL_TTL_SECONDS", 600, &errs))
	c.ReservingTTLSeconds = int64(intOr(getenv, "FUEL_RESERVING_TTL_SECONDS", 60, &errs))
	if c.TTLSeconds < 1 || c.ReservingTTLSeconds < 1 {
		fail("FUEL_TTL_SECONDS and FUEL_RESERVING_TTL_SECONDS must be >= 1")
	}
	for _, raw := range strings.Split(getenv("FUEL_ASSET_IDS"), ",") {
		a := strings.TrimSpace(raw)
		if a == "" {
			continue
		}
		if !assetIDRe.MatchString(a) {
			fail("FUEL_ASSET_IDS: %q is not <64 hex>.<vout>", a)
			continue
		}
		c.AssetIDs = append(c.AssetIDs, a)
	}
	c.MaxOutstanding = intOr(getenv, "FUEL_MAX_OUTSTANDING", 2, &errs)
	c.DailyPairs = intOr(getenv, "FUEL_DAILY_PAIRS", 20, &errs)
	c.PairsPerMinute = intOr(getenv, "FUEL_PAIRS_PER_MIN", 60, &errs)
	c.OverlayURL = strings.TrimRight(getenv("FK_OVERLAY_URL"), "/")
	c.OverlayAdminToken = getenv("FK_OVERLAY_ADMIN_TOKEN")

	c.PoolBasket = orDefault(getenv("FK_POOL_BASKET"), "fuel")
	c.ReserveBasket = orDefault(getenv("FK_RESERVE_BASKET"), "reserve")
	c.PoolTarget = u64Or(getenv, "FK_POOL_TARGET", 100, &errs)
	c.LowWaterPercent = u64Or(getenv, "FK_LOW_WATER_PERCENT", 60, &errs)
	c.HighWaterPercent = u64Or(getenv, "FK_HIGH_WATER_PERCENT", 100, &errs)
	c.FanoutOutputsPerTx = u64Or(getenv, "FK_FANOUT_OUTPUTS_PER_TX", 20, &errs)
	c.FanoutMaxTxsPerRound = u64Or(getenv, "FK_FANOUT_MAX_TXS_PER_ROUND", 5, &errs)
	c.KeeperIntervalSeconds = int64(intOr(getenv, "FK_KEEPER_INTERVAL_SECONDS", 30, &errs))
	c.SweeperIntervalSeconds = int64(intOr(getenv, "FK_SWEEPER_INTERVAL_SECONDS", 30, &errs))
	c.WoCAPIKey = getenv("FK_WOC_API_KEY")

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("fuelkeeper config: %s", strings.Join(errs, "; "))
	}
	return c, nil
}

func orDefault(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return strings.TrimSpace(v)
}

func intOr(getenv func(string) string, key string, d int, errs *[]string) int {
	v := strings.TrimSpace(getenv(key))
	if v == "" {
		return d
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		*errs = append(*errs, key+" must be an integer")
		return d
	}
	return n
}

func u64Or(getenv func(string) string, key string, d uint64, errs *[]string) uint64 {
	v := strings.TrimSpace(getenv(key))
	if v == "" {
		return d
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		*errs = append(*errs, key+" must be a non-negative integer")
		return d
	}
	return n
}
