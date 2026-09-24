# Token-fee P2 — fuelKeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the fuelKeeper service: a new Go module that keeps a pool of denominated BSV "fuel" outputs in the issuer's go-wallet-toolbox wallet, signs fuel-pair drafts (`SIGHASH_SINGLE|ANYONECANPAY|FORKID`) for verified requesters, tracks reservations through a CAS state machine, consumes/releases/settles them for the overlay, and sweeps stale rows.

**Architecture:** One binary (`fuelkeeper/cmd/fuelkeeper`) runs (1) a go-wallet-toolbox `infra` storage server on loopback, (2) an in-process toolbox wallet holding the issuer root key, (3) the upstream `pkg/wallet/fuelkeeper` pool keeper verbatim, (4) a small `net/http` API guarded by `X-Fuel-Key` that only the overlay calls, and (5) a sweeper goroutine. Reservation state lives in a `database/sql` schema (SQLite or Postgres) separate from the toolbox storage. Every step in the draft flow is a compare-and-swap on the reservation row so crashes and concurrent drafts converge without locks held across storage calls.

**Tech Stack:** Go 1.27.0 (toolchain auto-download from 1.26.x is fine), `github.com/bsv-blockchain/go-wallet-toolbox v0.186.3` (published tag; brings go-sdk v1.5.1), `database/sql` with `github.com/mattn/go-sqlite3` (CGO) and `github.com/jackc/pgx/v5/stdlib`, stdlib `net/http` (Go 1.22 method patterns), `log/slog`, `testing` + `github.com/stretchr/testify` (transitive, already in the module graph).

**Spec:** `docs/design/2026-09-22-mandala-token-fee-design.md` — §1 (fuel pair, economics), §3.1–3.3 (request/response shapes and codes the keeper mirrors), §4 (the whole fuelKeeper section), §9, §10, §11 D4/D5/D7/D8, §12 P2. Read §1.1–1.3 and §4 in full before starting.

## Global Constraints

- Work on `master` of `/Users/personal/git/demos/mandala` (maintainer decision, same as P0/P1). Commit per task; do not push.
- New module path `github.com/sirdeggen/mandala/fuelkeeper`, directory `fuelkeeper/` (sibling of `overlay-go/`). `go.mod` says `go 1.27.0`, requires `github.com/bsv-blockchain/go-wallet-toolbox v0.186.3`, and carries **exactly these four** `replace` lines copied from that tag's `go.mod` (Go ignores a dependency's replaces, so the consumer must repeat them):
  ```
  replace github.com/libp2p/go-libp2p => github.com/libp2p/go-libp2p v0.48.1-0.20260709142922-ec408fcc60c9
  replace github.com/quic-go/webtransport-go => github.com/quic-go/webtransport-go v0.11.1
  replace github.com/quic-go/quic-go => github.com/quic-go/quic-go v0.60.0
  replace k8s.io/kube-openapi => k8s.io/kube-openapi v0.0.0-20260721132016-d427ff9ee9ad
  ```
  This exact set was verified to build a probe binary (with `brc29.Unlock`, `fuelkeeper.FromThroughput`, `infra.NewServer`, `interpreter.NewEngine`) on 2026-09-23. Always run Go commands in `fuelkeeper/` with `GOTOOLCHAIN=auto` so go1.27.0 is fetched when the host has 1.26.x.
- Import the sighash package with an explicit alias — `sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"` — because in go-sdk 1.5.1 that directory's package clause is `package transaction`. The fuel flag is `sighash.SingleForkID | sighash.AnyOneCanPay` (= 0xC3).
- `pkg/wallet/fuelkeeper` is reused verbatim: never copy or fork it. Only `fuelkeeper.Config` is built by this repo. `internal/` packages of go-wallet-toolbox are not importable; anything needed from them (script-hash helper, connect retry loop) is re-implemented in this module as documented per task.
- The key-derivation facts are binding: toolbox change outputs are locked with `brc29.LockForCounterparty(keyDeriver, KeyID{prefix,suffix}, keyDeriver)` (self → self) and unlocked with `brc29.Unlock(brc29.PubHex(<own identity key hex>), brc29.KeyID{prefix,suffix}, keyDeriver)` (`pkg/internal/assembler/create_action_tx_assembler.go:157` and `:296` at v0.186.3). The keeper signs fuel exactly that way plus `brc29.WithSigHash(&f)`.
- The fee output is `LockToken(assetId, F, pkh)` where `pkh = hash160(GetPublicKey({protocolID: [2,'mandala token'], keyID: "fee-"+outpoint, counterparty: requester, forSelf: true}))`. Never `lockBRC29`/`LockForCounterparty` for the fee output (spec §1.2).
- All amounts are integers. Token amounts are `int64` bounded by `9007199254740991` (2^53−1) on the way in and out; every multiplication that can exceed 2^63 uses `math/bits.Mul64` with a hi≠0 → error check. Amounts on the wire are decimal strings.
- Rejection codes and HTTP statuses are exactly those of spec §3.1 / §4.5; reason strings for `/consume` are byte-identical: `consumed by another txid`, `reserved by another request`, `unknown`.
- Never treat a chain-check error as "unspent" (spec §4.7 rule 2). Never release `consumed` rows except via the eviction form of `/release` or sweeper rule 4 with proof.
- No DB transaction stays open across a storage RPC, a signing call, or an HTTP call.
- Tests: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./...` must pass with no network and no Postgres. Store tests run on a temp-file SQLite always, and additionally on Postgres when `FK_TEST_PG_URL` is set (skip otherwise with `t.Skip`). The wallet-backed fuel source is exercised only by fakes in unit tests; its real integration is P5's testnet smoke.
- Commit messages: conventional (`feat(fuelkeeper): …`), end with the Co-Authored-By line the session's attribution reminder specifies.

---

## File map

| file | responsibility |
|---|---|
| `fuelkeeper/go.mod`, `go.sum` | module, pins, four replaces |
| `fuelkeeper/Dockerfile` | CGO build (SQLite) → `gcr.io/distroless/base-debian12` |
| `fuelkeeper/README.md` | how to run locally (env, infra yaml) |
| `fuelkeeper/cmd/fuelkeeper/main.go` | process wiring (§4.2): infra server, wallet, keeper, sweeper, API |
| `fuelkeeper/internal/config/config.go` (+test) | env parsing/validation for every knob in §4.2 |
| `fuelkeeper/internal/token/token.go` (+test) | `LockToken`, `EncodeAssetID`, `ScriptHash`; parity with `overlay-go/testdata/vectors.json` |
| `fuelkeeper/internal/econ/econ.go` (+test) | `CoveredBytes`, `FeePerPair`, `EstSize`, `Need`, `SizeDraft` (§1.3) |
| `fuelkeeper/internal/auth/auth.go` (+test) | canonical messages, shape checks, `ProtoWallet(anyone)` verification (§3.1/§3.3) |
| `fuelkeeper/internal/store/store.go`, `schema.go`, `store_test.go` | reservation tables, CAS transitions, batch consume, quotas, deny list, sweeper queries (§4.4/§4.5) |
| `fuelkeeper/internal/fuel/source.go`, `wallet_source.go`, `fake_source.go` | `Source` interface over the toolbox wallet + storage client; in-memory fake for tests |
| `fuelkeeper/internal/draft/draft.go` (+test) | `Drafter`: §4.3 steps 1–10, skeleton build and signing; go-sdk verification test |
| `fuelkeeper/internal/chain/chain.go` | `Checker` (IsUtxo via toolbox services) + disabled checker |
| `fuelkeeper/internal/settle/settle.go` (+test) | `/settle` (§4.6) |
| `fuelkeeper/internal/sweeper/sweeper.go` (+test) | rules 0–4 (§4.7), overlay admission client |
| `fuelkeeper/internal/httpapi/api.go` (+test) | routes, `X-Fuel-Key`, error bodies, `/health` (§4.8) |
| `docs/design/2026-09-22-mandala-token-fee-design.md` | §13 revision-3 lines (see Task 11) |
| `runbook.md` | "fuelKeeper local run" section |
| `.github/workflows/docker-publish.yml` | `mandala-fuelkeeper` image in the matrix |

---

### Task 1: Module scaffold, config, Dockerfile

**Files:**
- Create: `fuelkeeper/go.mod`, `fuelkeeper/internal/config/config.go`, `fuelkeeper/internal/config/config_test.go`, `fuelkeeper/cmd/fuelkeeper/main.go` (stub), `fuelkeeper/Dockerfile`, `fuelkeeper/README.md`
- Modify: `.gitignore` (add `/fuelkeeper/fuelkeeper` and `/fuelkeeper/*.sqlite*`)

**Interfaces:**
- Produces: `config.Config` (all fields below), `config.Load(getenv func(string) string) (Config, error)`.

- [ ] **Step 1: go.mod**

```
module github.com/sirdeggen/mandala/fuelkeeper

go 1.27.0

require (
	github.com/bsv-blockchain/go-sdk v1.5.1
	github.com/bsv-blockchain/go-wallet-toolbox v0.186.3
	github.com/jackc/pgx/v5 v5.11.0
	github.com/mattn/go-sqlite3 v1.14.52
	github.com/stretchr/testify v1.11.1
)

replace github.com/libp2p/go-libp2p => github.com/libp2p/go-libp2p v0.48.1-0.20260709142922-ec408fcc60c9

replace github.com/quic-go/webtransport-go => github.com/quic-go/webtransport-go v0.11.1

replace github.com/quic-go/quic-go => github.com/quic-go/quic-go v0.60.0

replace k8s.io/kube-openapi => k8s.io/kube-openapi v0.0.0-20260721132016-d427ff9ee9ad
```

If `go mod tidy` reports a different testify version already in the graph, use that one. Run `cd fuelkeeper && GOTOOLCHAIN=auto go mod tidy` after the first source file exists.

- [ ] **Step 2: Write the failing config test**

`fuelkeeper/internal/config/config_test.go`:

```go
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/config/`
Expected: FAIL (package does not compile: `Load` undefined).

- [ ] **Step 4: Implement config**

`fuelkeeper/internal/config/config.go`:

```go
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
```

If `defs.ParseBSVNetworkStr` does not exist under that name at v0.186.3, use the exported parser in `pkg/defs/network.go` (grep `func Parse.*Network`); the accepted strings are `main`, `test`, `tstn`.

- [ ] **Step 5: main.go stub**

`fuelkeeper/cmd/fuelkeeper/main.go` (replaced in Task 10):

```go
package main

import (
	"fmt"
	"os"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
)

func main() {
	if _, err := config.Load(os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Println("fuelkeeper: wiring lands in Task 10")
}
```

- [ ] **Step 6: Dockerfile and README**

`fuelkeeper/Dockerfile`:

```
# Build context is ./fuelkeeper. CGO is on because the SQLite driver needs it.
FROM golang:1.27-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -o /fuelkeeper ./cmd/fuelkeeper

FROM gcr.io/distroless/base-debian12
COPY --from=builder /fuelkeeper /fuelkeeper
EXPOSE 8090
ENTRYPOINT ["/fuelkeeper"]
```

`fuelkeeper/README.md`: one screen — purpose (link to spec §4), required env (`ISSUER_ROOT_KEY`, `FK_API_KEY`, `FK_NETWORK`, `FK_STORAGE_CONFIG`, `FUEL_ASSET_IDS`), optional env with defaults (copy the list from `config.go`), the infra yaml requirement (`utxo_management.strategy: throughput`, `denomination_satoshis` = `FUEL_D`, `pool_basket: fuel`, `reserve_basket: reserve`, `http.port` = the port in `FK_STORAGE_URL`), and the test command.

- [ ] **Step 7: Tidy, run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go mod tidy && GOTOOLCHAIN=auto go build ./... && GOTOOLCHAIN=auto go test ./internal/config/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add fuelkeeper .gitignore
git commit -m "feat(fuelkeeper): scaffold module, config, Dockerfile"
```

---

### Task 2: Token script encoder and script hash (parity with overlay-go)

**Files:**
- Create: `fuelkeeper/internal/token/token.go`, `fuelkeeper/internal/token/token_test.go`

**Interfaces:**
- Produces: `token.LockToken(assetID string, amount int64, pubKeyHash []byte) (*script.Script, error)`, `token.EncodeAssetID(assetID string) ([]byte, error)`, `token.ValidAssetID(s string) bool`, `token.ScriptHash(lockingScript []byte) string` (sha256 of the script bytes, reversed, hex — the WhatsOnChain script-hash form used by `services.IsUtxo`), `token.FTProtocol` (`sdk.Protocol{SecurityLevel: 2, Protocol: "mandala token"}`), `token.MaxSafeAmount = 9007199254740991`.

- [ ] **Step 1: Write the failing parity test**

```go
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/token/`
Expected: FAIL (undefined symbols).

- [ ] **Step 3: Implement**

Copy `EncodeAssetID`, `encodeScriptNum` and `LockToken` **verbatim** from `overlay-go/internal/mandala/token.go` (lines 21–44, 90–113, 150–184 on 2026-09-23 master) into `fuelkeeper/internal/token/token.go` under `package token`, keeping `maxSafeAmount` but exporting it as `MaxSafeAmount`. Then add:

```go
// FTProtocol is the BRC-42 protocol every Mandala token key is derived under
// (lib/src/constants.ts FT_PROTOCOL = [2, 'mandala token']).
var FTProtocol = sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryAppAndCounterparty, Protocol: "mandala token"}

var assetIDRe = regexp.MustCompile(`^[0-9a-f]{64}\.[0-9]+$`)

// ValidAssetID accepts the canonical lowercase "<txid>.<vout>" form only.
func ValidAssetID(s string) bool { return assetIDRe.MatchString(s) }

// ScriptHash returns the WhatsOnChain script hash of a locking script:
// SHA-256 of the script bytes, byte-reversed, hex (go-wallet-toolbox
// pkg/internal/txutils.HashOutputScript, which is not importable).
func ScriptHash(lockingScript []byte) string {
	sum := sha256.Sum256(lockingScript)
	slices.Reverse(sum[:])
	return hex.EncodeToString(sum[:])
}
```

with imports `crypto/sha256`, `encoding/hex`, `regexp`, `slices`, `sdk "github.com/bsv-blockchain/go-sdk/wallet"`.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/token/`
Expected: PASS (8 vectors).

- [ ] **Step 5: Commit**

```bash
git add fuelkeeper/internal/token
git commit -m "feat(fuelkeeper): token script encoder with overlay-go vector parity"
```

---

### Task 3: Economics (§1.3)

**Files:**
- Create: `fuelkeeper/internal/econ/econ.go`, `fuelkeeper/internal/econ/econ_test.go`

**Interfaces:**
- Produces:
  ```go
  type Params struct { D, BSVRatePerKb uint64; KMax int }
  func CoveredBytes(p Params) uint64                          // floor(D*1000/BSV_RATE)
  func FeePerPair(p Params, feeRatePerKb int64) (int64, error) // ceil(feeRatePerKb*covered/1000), bounded by token.MaxSafeAmount
  func EstSize(n, m, k int) uint64                             // 10 + 150n + 148k + 85(m+k) + 34
  func Need(p Params, n, m, k int) (uint64, error)             // ceil(estSize*rate/1000) + satDeficit + changeDust
  func SizeDraft(p Params, n, m int) (k int, err error)        // min k≥1 with k*D ≥ need(k); ErrTooLarge if k > KMax
  var ErrTooLarge = errors.New("too_large")
  ```

- [ ] **Step 1: Write the failing tests**

```go
package econ

import (
	"testing"

	"github.com/stretchr/testify/require"
)

var defaults = Params{D: 200, BSVRatePerKb: 100, KMax: 4}

func TestWorkedExample(t *testing.T) {
	// Spec §1.3: n=1, m=3 → estSize(1)=682, fee 69, deficit 3, dust 40, need 112 → k=1, F=20 at rate 10.
	require.Equal(t, uint64(2000), CoveredBytes(defaults))
	require.Equal(t, uint64(682), EstSize(1, 3, 1))
	need, err := Need(defaults, 1, 3, 1)
	require.NoError(t, err)
	require.Equal(t, uint64(112), need)
	k, err := SizeDraft(defaults, 1, 3)
	require.NoError(t, err)
	require.Equal(t, 1, k)
	f, err := FeePerPair(defaults, 10)
	require.NoError(t, err)
	require.Equal(t, int64(20), f)
}

func TestSizeDraft_GrowsAndCaps(t *testing.T) {
	k, err := SizeDraft(defaults, 4, 6)
	require.NoError(t, err)
	require.Equal(t, 1, k) // estSize=10+600+148+85*7+34=1387 → fee 139 + deficit 3 + 40 = 182 ≤ 200
	k, err = SizeDraft(defaults, 8, 10)
	require.NoError(t, err)
	require.Equal(t, 2, k)
	_, err = SizeDraft(Params{D: 200, BSVRatePerKb: 100, KMax: 1}, 8, 10)
	require.ErrorIs(t, err, ErrTooLarge)
}

func TestFeePerPair_Rounding(t *testing.T) {
	f, err := FeePerPair(defaults, 1)
	require.NoError(t, err)
	require.Equal(t, int64(2), f) // ceil(1*2000/1000)
	f, err = FeePerPair(Params{D: 30, BSVRatePerKb: 100, KMax: 4}, 7)
	require.NoError(t, err)
	require.Equal(t, int64(3), f) // covered=300, ceil(2100/1000)=3
}

func TestFeePerPair_Bounds(t *testing.T) {
	_, err := FeePerPair(defaults, 0)
	require.Error(t, err)
	_, err = FeePerPair(defaults, 9007199254740992)
	require.Error(t, err)
	_, err = FeePerPair(Params{D: 1 << 60, BSVRatePerKb: 1, KMax: 4}, 9007199254740991)
	require.Error(t, err, "product overflow must be detected, not wrapped")
}

func TestChangeDustTracksRate(t *testing.T) {
	need100, _ := Need(defaults, 1, 1, 1)
	need50, _ := Need(Params{D: 200, BSVRatePerKb: 50, KMax: 4}, 1, 1, 1)
	require.Greater(t, need100, need50)
	// changeDust = 2*ceil(192*rate/1000): 40 at 100, 20 at 50.
	require.Equal(t, uint64(40), changeDust(100))
	require.Equal(t, uint64(20), changeDust(50))
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/econ/`
Expected: FAIL.

- [ ] **Step 3: Implement**

```go
// Package econ implements the fuel-pair sizing rules of spec §1.3. All
// arithmetic is integer; products that could exceed 64 bits are checked.
package econ

import (
	"errors"
	"fmt"
	"math/bits"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

var ErrTooLarge = errors.New("too_large")

type Params struct {
	D            uint64
	BSVRatePerKb uint64
	KMax         int
}

func ceilDiv(a, b uint64) uint64 { return (a + b - 1) / b }

func mul(a, b uint64) (uint64, error) {
	hi, lo := bits.Mul64(a, b)
	if hi != 0 {
		return 0, fmt.Errorf("econ: %d*%d overflows", a, b)
	}
	return lo, nil
}

// CoveredBytes = floor(D*1000/BSV_RATE).
func CoveredBytes(p Params) uint64 {
	v, err := mul(p.D, 1000)
	if err != nil {
		return 0
	}
	return v / p.BSVRatePerKb
}

// FeePerPair = ceil(feeRatePerKb * coveredBytes / 1000), token base units.
func FeePerPair(p Params, feeRatePerKb int64) (int64, error) {
	if feeRatePerKb < 1 || feeRatePerKb > token.MaxSafeAmount {
		return 0, fmt.Errorf("econ: feeRatePerKb %d out of range", feeRatePerKb)
	}
	prod, err := mul(uint64(feeRatePerKb), CoveredBytes(p))
	if err != nil {
		return 0, err
	}
	f := ceilDiv(prod, 1000)
	if f < 1 || f > uint64(token.MaxSafeAmount) {
		return 0, fmt.Errorf("econ: fee per pair %d out of range", f)
	}
	return int64(f), nil
}

// EstSize upper-bounds wallet-toolbox's own size estimate for the inputs the
// lib passes: tx overhead 10, token input 150, fuel input 148, token output 85,
// one BSV change output 34.
func EstSize(n, m, k int) uint64 {
	return 10 + 150*uint64(n) + 148*uint64(k) + 85*uint64(m+k) + 34
}

func changeDust(rate uint64) uint64 { return 2 * ceilDiv(192*rate, 1000) }

// Need = ceil(estSize*rate/1000) + satDeficit + changeDust.
func Need(p Params, n, m, k int) (uint64, error) {
	feeBytes, err := mul(EstSize(n, m, k), p.BSVRatePerKb)
	if err != nil {
		return 0, err
	}
	fee := ceilDiv(feeBytes, 1000)
	deficit := uint64(m + k - n) // may be "negative": token outputs are 1 sat each, token inputs 1 sat each
	if m+k-n < 0 {
		deficit = 0
	}
	return fee + deficit + changeDust(p.BSVRatePerKb), nil
}

// SizeDraft returns the smallest k ≥ 1 with k*D ≥ Need(k); ErrTooLarge past KMax.
func SizeDraft(p Params, n, m int) (int, error) {
	for k := 1; k <= p.KMax; k++ {
		need, err := Need(p, n, m, k)
		if err != nil {
			return 0, err
		}
		have, err := mul(uint64(k), p.D)
		if err != nil {
			return 0, err
		}
		if have >= need {
			return k, nil
		}
	}
	return 0, ErrTooLarge
}
```

Note on `satDeficit`: the spec writes `(m + k) − n`; when `n > m + k` the payer's token inputs already carry more satoshis than the outputs need, so the deficit contributes nothing (floored at zero). Record this reading in the spec §13 line (Task 11).

- [ ] **Step 4: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/econ/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fuelkeeper/internal/econ
git commit -m "feat(fuelkeeper): fuel-pair economics (§1.3) with overflow guards"
```

---

### Task 4: Request verification (§3.1, §3.3)

**Files:**
- Create: `fuelkeeper/internal/auth/auth.go`, `fuelkeeper/internal/auth/auth_test.go`

**Interfaces:**
- Produces:
  ```go
  var FuelProtocol = sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryApp /*1*/, Protocol: "mandala fuel"}
  func DraftMessage(assetID string, n, m int, requester, nonce string, ts int64) []byte
  func ReleaseMessage(requestID, requester string, ts int64) []byte
  type Verifier struct{ pw *sdk.ProtoWallet; now func() time.Time; window time.Duration }
  func NewVerifier(now func() time.Time) (*Verifier, error)  // ProtoWallet over the 'anyone' key, ±300 s window
  var ErrShape = errors.New("shape"); var ErrAuth = errors.New("auth")
  func (v *Verifier) Verify(ctx, requesterHex, nonce, sigHex string, ts int64, msg []byte) error // ErrShape / ErrAuth / nil
  func Sign(ctx, pw *sdk.ProtoWallet, keyID string, msg []byte) (sigHex string, err error)      // test helper: counterparty 'anyone'
  ```
  `SecurityLevelEveryApp` is go-sdk's constant for level 1; grep `SecurityLevel = 1` in `wallet/wallet.go` if the name differs.

- [ ] **Step 1: Write the failing tests**

```go
package auth

import (
	"context"
	"encoding/hex"
	"testing"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"
)

const asset = "abababababababababababababababababababababababababababababababab.0"

func requester(t *testing.T) (*sdk.ProtoWallet, string) {
	t.Helper()
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	pw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypePrivateKey, PrivateKey: priv})
	require.NoError(t, err)
	return pw, priv.PubKey().ToDERHex()
}

func TestDraftMessage_Canonical(t *testing.T) {
	msg := DraftMessage(asset, 1, 3, "02aa", "ff", 1758500000)
	require.Equal(t, "mandala-fuel-draft:"+asset+":1:3:02aa:ff:1758500000", string(msg))
	require.Equal(t, "mandala-fuel-release:req:02aa:5", string(ReleaseMessage("req", "02aa", 5)))
}

func TestVerify_RoundTrip(t *testing.T) {
	now := time.Unix(1758500000, 0)
	v, err := NewVerifier(func() time.Time { return now })
	require.NoError(t, err)
	pw, pub := requester(t)
	nonce := hex.EncodeToString(make([]byte, 32))
	msg := DraftMessage(asset, 1, 3, pub, nonce, now.Unix())
	sig, err := Sign(context.Background(), pw, nonce, msg)
	require.NoError(t, err)
	require.NoError(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix(), msg))
}

func TestVerify_Rejections(t *testing.T) {
	now := time.Unix(1758500000, 0)
	v, _ := NewVerifier(func() time.Time { return now })
	pw, pub := requester(t)
	_, other := requester(t)
	nonce := hex.EncodeToString(make([]byte, 32))
	msg := DraftMessage(asset, 1, 3, pub, nonce, now.Unix())
	sig, _ := Sign(context.Background(), pw, nonce, msg)

	require.ErrorIs(t, v.Verify(context.Background(), other, nonce, sig, now.Unix(), msg), ErrAuth, "wrong requester")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix(), append(msg, 'x')), ErrAuth, "tampered message")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix()+301, msg), ErrShape, "ts outside window")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, sig, now.Unix()-301, msg), ErrShape)
	require.ErrorIs(t, v.Verify(context.Background(), "02zz", nonce, sig, now.Unix(), msg), ErrShape, "requester not hex")
	require.ErrorIs(t, v.Verify(context.Background(), pub[:64], nonce, sig, now.Unix(), msg), ErrShape, "requester wrong length")
	require.ErrorIs(t, v.Verify(context.Background(), pub, "abcd", sig, now.Unix(), msg), ErrShape, "nonce not 64 hex")
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, "3000", now.Unix(), msg), ErrShape, "sig not DER")
	// A structurally valid DER signature over other data is an auth failure, not a shape failure.
	otherSig, _ := Sign(context.Background(), pw, nonce, []byte("other"))
	require.ErrorIs(t, v.Verify(context.Background(), pub, nonce, otherSig, now.Unix(), msg), ErrAuth)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/auth/`
Expected: FAIL.

- [ ] **Step 3: Implement**

```go
// Package auth verifies signed draft/release requests exactly as the overlay
// does (spec §3.1): the requester signs with counterparty 'anyone', so a
// ProtoWallet over the well-known 'anyone' key verifies with counterparty =
// requester. Verification succeeds only on Valid==true with a nil error.
package auth

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
)

var (
	ErrShape = errors.New("shape")
	ErrAuth  = errors.New("auth")

	FuelProtocol = sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryApp, Protocol: "mandala fuel"}
)

func DraftMessage(assetID string, n, m int, requester, nonce string, ts int64) []byte {
	return []byte("mandala-fuel-draft:" + assetID + ":" + strconv.Itoa(n) + ":" + strconv.Itoa(m) + ":" + requester + ":" + nonce + ":" + strconv.FormatInt(ts, 10))
}

func ReleaseMessage(requestID, requester string, ts int64) []byte {
	return []byte("mandala-fuel-release:" + requestID + ":" + requester + ":" + strconv.FormatInt(ts, 10))
}

type Verifier struct {
	pw     *sdk.ProtoWallet
	now    func() time.Time
	window time.Duration
}

func NewVerifier(now func() time.Time) (*Verifier, error) {
	pw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypeAnyone})
	if err != nil {
		return nil, fmt.Errorf("auth: anyone wallet: %w", err)
	}
	return &Verifier{pw: pw, now: now, window: 300 * time.Second}, nil
}

// ParseRequester enforces the parse boundary: 66 hex chars decoding to a valid compressed point.
func ParseRequester(requesterHex string) (*ec.PublicKey, error) {
	if len(requesterHex) != 66 {
		return nil, fmt.Errorf("%w: requester must be 66 hex chars", ErrShape)
	}
	if _, err := hex.DecodeString(requesterHex); err != nil {
		return nil, fmt.Errorf("%w: requester not hex", ErrShape)
	}
	pub, err := ec.PublicKeyFromString(requesterHex)
	if err != nil {
		return nil, fmt.Errorf("%w: requester not a valid point", ErrShape)
	}
	return pub, nil
}

func ValidNonce(nonce string) bool {
	if len(nonce) != 64 {
		return false
	}
	_, err := hex.DecodeString(nonce)
	return err == nil
}

func (v *Verifier) Verify(ctx context.Context, requesterHex, keyID, sigHex string, ts int64, msg []byte) error {
	pub, err := ParseRequester(requesterHex)
	if err != nil {
		return err
	}
	if !ValidNonce(keyID) {
		return fmt.Errorf("%w: nonce must be 64 hex chars", ErrShape)
	}
	sigBytes, err := hex.DecodeString(sigHex)
	if err != nil {
		return fmt.Errorf("%w: sig not hex", ErrShape)
	}
	sig, err := ec.ParseDERSignature(sigBytes)
	if err != nil {
		return fmt.Errorf("%w: sig not DER", ErrShape)
	}
	d := v.now().Unix() - ts
	if d > int64(v.window/time.Second) || -d > int64(v.window/time.Second) {
		return fmt.Errorf("%w: ts outside window", ErrShape)
	}
	res, err := v.pw.VerifySignature(ctx, sdk.VerifySignatureArgs{
		EncryptionArgs: sdk.EncryptionArgs{
			ProtocolID:   FuelProtocol,
			KeyID:        keyID,
			Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeOther, Counterparty: pub},
		},
		Data:      msg,
		Signature: sig,
	}, "fuelkeeper")
	if err != nil || res == nil || !res.Valid {
		return ErrAuth
	}
	return nil
}

// Sign produces the requester-side signature (counterparty 'anyone'); used by
// tests and by the overlay's own test fixtures.
func Sign(ctx context.Context, pw *sdk.ProtoWallet, keyID string, msg []byte) (string, error) {
	res, err := pw.CreateSignature(ctx, sdk.CreateSignatureArgs{
		EncryptionArgs: sdk.EncryptionArgs{
			ProtocolID:   FuelProtocol,
			KeyID:        keyID,
			Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeAnyone},
		},
		Data: msg,
	}, "test")
	if err != nil {
		return "", err
	}
	der, err := res.Signature.ToDER()
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(der), nil
}
```

Check the exact `ProtoWalletArgs` field names for a private-key wallet at go-sdk 1.5.1 (`wallet/proto_wallet.go:25-60`): the type constant for a raw key and the field that carries `*ec.PrivateKey`. Adjust the test helper to match.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/auth/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fuelkeeper/internal/auth
git commit -m "feat(fuelkeeper): request verification with the anyone key (§3.1)"
```

---

### Task 5: Reservation store (§4.4, §4.5)

**Files:**
- Create: `fuelkeeper/internal/store/schema.go`, `fuelkeeper/internal/store/store.go`, `fuelkeeper/internal/store/store_test.go`

**Interfaces:**
- Produces (all methods take `ctx`; `now` is injected as `func() time.Time` at `Open`):
  ```go
  type Store struct{ db *sql.DB; driver string; now func() time.Time }
  func Open(driver, dsn string, now func() time.Time) (*Store, error) // migrates
  func (s *Store) Close() error

  type Status string // "reserving","reserved","consumed","released","dropped","spent_external"
  type Reservation struct {
      Outpoint string; Satoshis uint64; FuelScript string; FuelBeef string
      DerivationPrefix, DerivationSuffix string
      RequestID, Requester, AssetID string; PairIndex int
      FeeScript, KeyID, FeeAmount string
      Status Status; NeedsRecheck bool; Txid string
      ExpiresAt int64; SettledAt *int64; CreatedAt, UpdatedAt int64
  }
  // §4.3 step 2 (one tx, serialized per requester)
  func (s *Store) BeginRequest(ctx, nonce, requester string, ts int64, q Quotas) (QuotaVerdict, error)
  type Quotas struct{ MaxOutstanding, DailyPairs, PairsPerMinute int }
  type QuotaVerdict string // "ok" | "nonce_used" | "quota" | "unavailable"
  // §4.3 step 5
  type Candidate struct{ Outpoint string; Satoshis uint64; FuelScript, FuelBeef, DerivationPrefix, DerivationSuffix string }
  func (s *Store) ReleasedCandidates(ctx, limit int) ([]Candidate, error)        // released, needs_recheck=0, oldest first
  func (s *Store) Claim(ctx, c Candidate, requestID, requester, assetID string, pairIndex int, reservingTTL int64) (bool, error)
  func (s *Store) Drop(ctx, outpoint, requestID string) error                     // reserving → dropped
  func (s *Store) ReleaseReserving(ctx, requestID string, needsRecheck bool) (int64, error) // reserving(request) → released
  func (s *Store) Commit(ctx, requestID string, pairs []CommitPair, ttl int64) (int64, error) // reserving → reserved, all-or-nothing
  type CommitPair struct{ Outpoint, FeeScript, KeyID, FeeAmount string }
  // overlay-facing
  type ConsumeItem struct{ Outpoint, RequestID string }
  type ConsumeRefusal struct{ Outpoint, Reason string }
  func (s *Store) Consume(ctx, txid string, items []ConsumeItem) (*ConsumeRefusal, error) // nil refusal = ok
  func (s *Store) ReleaseRequest(ctx, requestID string) (int64, error)            // reserved(request) → released, needs_recheck=1
  func (s *Store) ReleaseEvicted(ctx, txid string, outpoints []string) (int64, error) // consumed(txid) → released, needs_recheck=1
  func (s *Store) ByTxid(ctx, txid string) ([]Reservation, error)
  func (s *Store) ByRequest(ctx, requestID string) ([]Reservation, error)
  func (s *Store) MarkSettled(ctx, outpoint, txid string) (bool, error)          // consumed|released|spent_external with txid → consumed, settled_at
  // sweeper
  func (s *Store) ExpiredReserving(ctx) ([]Reservation, error)
  func (s *Store) ExpireReserved(ctx) (int64, error)                              // reserved past expires_at → released, needs_recheck=1
  func (s *Store) RecheckPending(ctx, limit int) ([]Reservation, error)          // released, needs_recheck=1
  func (s *Store) SetRechecked(ctx, outpoint string, unspent bool) (bool, error) // → needs_recheck=0 | spent_external; true iff the CAS matched
  func (s *Store) UnsettledConsumed(ctx, olderThan time.Duration) ([]Reservation, error)
  func (s *Store) ReleaseByRule4(ctx, txid string) (int64, error)                 // consumed(txid) → released, needs_recheck=1
  // deny list + health
  func (s *Store) Deny(ctx, requester, reason, outpoint string) error
  func (s *Store) IsDenied(ctx, requester string) (bool, error)
  func (s *Store) Undeny(ctx, requester string) (bool, error)
  func (s *Store) Counts(ctx) (map[Status]int, int /*recheckPending*/, int /*consumedUnsettled*/, int /*denied*/, error)
  ```

- [ ] **Step 1: Schema**

`schema.go`:

```go
package store

// Spec §4.4 plus three columns this implementation needs: fuel_beef (the
// proven source BEEF captured at first claim so a re-drafted released row,
// which is no longer in the toolbox basket, can still be shipped),
// derivation_prefix/suffix (to sign it), and pair_index (the fee output's
// vout inside its draft, needed by /settle).
const schemaSQLite = `
CREATE TABLE IF NOT EXISTS fuel_requests (
  nonce TEXT PRIMARY KEY, requester TEXT NOT NULL, ts INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_requests_requester ON fuel_requests(requester, created_at);
CREATE TABLE IF NOT EXISTS fuel_denylist (
  requester TEXT PRIMARY KEY, reason TEXT, outpoint TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fuel_reservations (
  outpoint TEXT PRIMARY KEY, satoshis INTEGER NOT NULL, fuel_script TEXT NOT NULL, fuel_beef TEXT NOT NULL DEFAULT '',
  derivation_prefix TEXT NOT NULL DEFAULT '', derivation_suffix TEXT NOT NULL DEFAULT '',
  request_id TEXT, requester TEXT, asset_id TEXT, pair_index INTEGER NOT NULL DEFAULT 0,
  fee_script TEXT, key_id TEXT, fee_amount TEXT,
  status TEXT NOT NULL, needs_recheck INTEGER NOT NULL DEFAULT 0, txid TEXT,
  expires_at INTEGER NOT NULL, settled_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_reservations_status ON fuel_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS fuel_reservations_request ON fuel_reservations(request_id);
CREATE INDEX IF NOT EXISTS fuel_reservations_txid ON fuel_reservations(txid);
CREATE INDEX IF NOT EXISTS fuel_reservations_requester ON fuel_reservations(requester, created_at);
`

// Postgres: identical shape; INTEGER → BIGINT, BOOLEAN kept as INTEGER 0/1 for
// one query set across both engines.
const schemaPostgres = `
CREATE TABLE IF NOT EXISTS fuel_requests (
  nonce TEXT PRIMARY KEY, requester TEXT NOT NULL, ts BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_requests_requester ON fuel_requests(requester, created_at);
CREATE TABLE IF NOT EXISTS fuel_denylist (
  requester TEXT PRIMARY KEY, reason TEXT, outpoint TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS fuel_reservations (
  outpoint TEXT PRIMARY KEY, satoshis BIGINT NOT NULL, fuel_script TEXT NOT NULL, fuel_beef TEXT NOT NULL DEFAULT '',
  derivation_prefix TEXT NOT NULL DEFAULT '', derivation_suffix TEXT NOT NULL DEFAULT '',
  request_id TEXT, requester TEXT, asset_id TEXT, pair_index INTEGER NOT NULL DEFAULT 0,
  fee_script TEXT, key_id TEXT, fee_amount TEXT,
  status TEXT NOT NULL, needs_recheck INTEGER NOT NULL DEFAULT 0, txid TEXT,
  expires_at BIGINT NOT NULL, settled_at BIGINT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_reservations_status ON fuel_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS fuel_reservations_request ON fuel_reservations(request_id);
CREATE INDEX IF NOT EXISTS fuel_reservations_txid ON fuel_reservations(txid);
CREATE INDEX IF NOT EXISTS fuel_reservations_requester ON fuel_reservations(requester, created_at);
`
```

- [ ] **Step 2: Write the failing store tests**

`store_test.go` — every test runs against SQLite (temp file) and, when `FK_TEST_PG_URL` is set, Postgres (truncate tables in a helper before each):

```go
package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func openAll(t *testing.T) []struct {
	name string
	s    *Store
	c    *clock
} {
	t.Helper()
	c1 := &clock{t: time.Unix(1_758_500_000, 0)}
	s1, err := Open("sqlite", filepath.Join(t.TempDir(), "fk.sqlite"), c1.now)
	require.NoError(t, err)
	t.Cleanup(func() { _ = s1.Close() })
	all := []struct {
		name string
		s    *Store
		c    *clock
	}{{"sqlite", s1, c1}}
	if url := os.Getenv("FK_TEST_PG_URL"); url != "" {
		c2 := &clock{t: c1.t}
		s2, err := Open("postgres", url, c2.now)
		require.NoError(t, err)
		require.NoError(t, s2.truncateForTests(context.Background()))
		t.Cleanup(func() { _ = s2.Close() })
		all = append(all, struct {
			name string
			s    *Store
			c    *clock
		}{"postgres", s2, c2})
	}
	return all
}

func cand(op string) Candidate {
	return Candidate{Outpoint: op, Satoshis: 200, FuelScript: "76a914", FuelBeef: "0100beef", DerivationPrefix: "p", DerivationSuffix: "s"}
}

func TestClaimCommitConsumeLifecycle(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			ok, err := s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			require.NoError(t, err)
			require.True(t, ok)
			ok, err = s.Claim(ctx, cand("aa.0"), "req2", "02bb", "asset.0", 0, 60)
			require.NoError(t, err)
			require.False(t, ok, "second claim of a reserving row must lose")

			n, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0", FeeScript: "fee", KeyID: "fee-aa.0", FeeAmount: "20"}}, 600)
			require.NoError(t, err)
			require.EqualValues(t, 1, n)
			rows, _ := s.ByRequest(ctx, "req1")
			require.Equal(t, StatusReserved, rows[0].Status)
			require.Equal(t, e.c.t.Unix()+600, rows[0].ExpiresAt)

			ref, err := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req2"}})
			require.NoError(t, err)
			require.Equal(t, &ConsumeRefusal{Outpoint: "aa.0", Reason: "reserved by another request"}, ref)
			ref, err = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.NoError(t, err)
			require.Nil(t, ref)
			ref, _ = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.Nil(t, ref, "same txid is idempotent")
			ref, _ = s.Consume(ctx, "tx2", []ConsumeItem{{"aa.0", "req1"}})
			require.Equal(t, "consumed by another txid", ref.Reason)
			ref, _ = s.Consume(ctx, "tx1", []ConsumeItem{{"zz.9", "req1"}})
			require.Equal(t, "unknown", ref.Reason)

			n, err = s.ReleaseRequest(ctx, "req1")
			require.NoError(t, err)
			require.EqualValues(t, 0, n, "release never touches consumed rows")
			ok, err = s.MarkSettled(ctx, "aa.0", "tx1")
			require.NoError(t, err)
			require.True(t, ok)
			rows, _ = s.ByTxid(ctx, "tx1")
			require.NotNil(t, rows[0].SettledAt)
		})
	}
}

func TestConsumeIsAllOrNothing(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			for i, op := range []string{"aa.0", "aa.1"} {
				ok, _ := s.Claim(ctx, cand(op), "req1", "02aa", "asset.0", i, 60)
				require.True(t, ok)
			}
			_, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}, {Outpoint: "aa.1"}}, 600)
			require.NoError(t, err)
			ref, err := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}, {"aa.1", "other"}})
			require.NoError(t, err)
			require.Equal(t, "aa.1", ref.Outpoint)
			rows, _ := s.ByRequest(ctx, "req1")
			for _, r := range rows {
				require.Equal(t, StatusReserved, r.Status, "refused batch must roll back %s", r.Outpoint)
			}
		})
	}
}

func TestReleaseExpiryRecheckAndDeny(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			ok, _ := s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			require.True(t, ok)
			_, _ = s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}}, 600)
			e.c.t = e.c.t.Add(601 * time.Second)
			n, err := s.ExpireReserved(ctx)
			require.NoError(t, err)
			require.EqualValues(t, 1, n)
			pend, _ := s.RecheckPending(ctx, 10)
			require.Len(t, pend, 1)
			require.NoError(t, s.SetRechecked(ctx, "aa.0", true))
			c, _ := s.ReleasedCandidates(ctx, 10)
			require.Len(t, c, 1)
			require.Equal(t, "0100beef", c[0].FuelBeef)
			require.Equal(t, "p", c[0].DerivationPrefix)

			// Late submit of a released, not re-drafted row is allowed for its last holder.
			ref, _ := s.Consume(ctx, "tx9", []ConsumeItem{{"aa.0", "req1"}})
			require.Nil(t, ref)
			// Eviction release puts it back to recheck; a chain "spent" verdict denies the requester.
			n, _ = s.ReleaseEvicted(ctx, "tx9", []string{"aa.0"})
			require.EqualValues(t, 1, n)
			require.NoError(t, s.SetRechecked(ctx, "aa.0", false))
			rows, _ := s.ByTxid(ctx, "tx9")
			require.Equal(t, StatusSpentExternal, rows[0].Status)
			require.NoError(t, s.Deny(ctx, "02aa", "spent_external", "aa.0"))
			d, _ := s.IsDenied(ctx, "02aa")
			require.True(t, d)
			ok, _ = s.Undeny(ctx, "02aa")
			require.True(t, ok)
			// /settle repairs a wrongful release/spent_external for the matching txid.
			ok, _ = s.MarkSettled(ctx, "aa.0", "tx9")
			require.True(t, ok)
		})
	}
}

func TestReservingExpiryAndDrop(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			_, _ = s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			_, _ = s.Claim(ctx, cand("aa.1"), "req1", "02aa", "asset.0", 1, 60)
			require.NoError(t, s.Drop(ctx, "aa.1", "req1"))
			e.c.t = e.c.t.Add(61 * time.Second)
			exp, _ := s.ExpiredReserving(ctx)
			require.Len(t, exp, 1)
			require.Equal(t, "aa.0", exp[0].Outpoint)
			n, _ := s.ReleaseReserving(ctx, "req1", false)
			require.EqualValues(t, 1, n)
			ok, _ := s.Claim(ctx, cand("aa.1"), "req2", "02bb", "asset.0", 0, 60)
			require.False(t, ok, "dropped is terminal")
		})
	}
}

func TestQuotas(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			q := Quotas{MaxOutstanding: 1, DailyPairs: 3, PairsPerMinute: 100}
			v, err := s.BeginRequest(ctx, "n1", "02aa", e.c.t.Unix(), q)
			require.NoError(t, err)
			require.Equal(t, VerdictOK, v)
			v, _ = s.BeginRequest(ctx, "n1", "02aa", e.c.t.Unix(), q)
			require.Equal(t, VerdictNonceUsed, v)
			_, _ = s.Claim(ctx, cand("aa.0"), "n1", "02aa", "asset.0", 0, 60)
			_, _ = s.Commit(ctx, "n1", []CommitPair{{Outpoint: "aa.0"}}, 600)
			v, _ = s.BeginRequest(ctx, "n2", "02aa", e.c.t.Unix(), q)
			require.Equal(t, VerdictQuota, v, "outstanding reserved drafts ≥ MaxOutstanding")
			v, _ = s.BeginRequest(ctx, "n3", "02bb", e.c.t.Unix(), q)
			require.Equal(t, VerdictOK, v, "quota is per requester")
			v, _ = s.BeginRequest(ctx, "n4", "02cc", e.c.t.Unix(), Quotas{MaxOutstanding: 5, DailyPairs: 5, PairsPerMinute: 1})
			require.Equal(t, VerdictUnavailable, v, "global per-minute cap counts pairs created in the last minute")
		})
	}
}

func TestCounts(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			_, _ = e.s.Claim(ctx, cand("aa.0"), "r", "02aa", "a.0", 0, 60)
			m, recheck, unsettled, denied, err := e.s.Counts(ctx)
			require.NoError(t, err)
			require.Equal(t, 1, m[StatusReserving])
			require.Zero(t, recheck+unsettled+denied)
		})
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/store/`
Expected: FAIL.

- [ ] **Step 4: Implement the store**

Rules for `store.go`:

- `Open`: sqlite DSN is `file:<dsn>?_txlock=immediate&_busy_timeout=5000&_journal_mode=WAL` with driver name `sqlite3` (`_ "github.com/mattn/go-sqlite3"`); `db.SetMaxOpenConns(1)` for sqlite. Postgres uses driver `pgx` (`_ "github.com/jackc/pgx/v5/stdlib"`). Run the matching schema in one `Exec` per statement (split on `;`).
- A `q(sql string) string` method rewrites `?` placeholders to `$1,$2,…` when driver is postgres. Every query is written once with `?`.
- `now()` seconds come from the injected clock; never from SQL `now()`.
- Status constants: `StatusReserving = "reserving"`, `StatusReserved`, `StatusConsumed`, `StatusReleased`, `StatusDropped`, `StatusSpentExternal`.
- `Claim`: `INSERT INTO fuel_reservations(...) VALUES(...) ON CONFLICT(outpoint) DO UPDATE SET status='reserving', request_id=excluded.request_id, requester=excluded.requester, asset_id=excluded.asset_id, pair_index=excluded.pair_index, expires_at=excluded.expires_at, updated_at=excluded.updated_at, txid=NULL, fee_script=NULL, key_id=NULL, fee_amount=NULL, needs_recheck=0 WHERE fuel_reservations.status='released' AND fuel_reservations.needs_recheck=0` — one statement covers both "new row" and "released → reserving"; `RowsAffected()==1` is the claim result (on Postgres `ON CONFLICT … DO UPDATE … WHERE` reports 0 when the WHERE fails; on SQLite likewise). `fuel_beef`/derivation columns are set on insert only (`excluded` values are ignored on the update path because the existing row already holds them).
- `Drop`: `UPDATE … SET status='dropped', updated_at=? WHERE outpoint=? AND request_id=? AND status='reserving'`.
- `ReleaseReserving(requestID, needsRecheck)`: reserving rows of that request → released with the given flag.
- `Commit`: one transaction; for each pair `UPDATE … SET status='reserved', fee_script=?, key_id=?, fee_amount=?, expires_at=?, updated_at=? WHERE outpoint=? AND request_id=? AND status='reserving'`; if any RowsAffected≠1 → rollback and return `(0, ErrCommitConflict)`.
- `Consume`: one transaction (sqlite is already serialized; postgres uses `SELECT … FOR UPDATE`). For each item read `status, request_id, txid`; decide:
  - not found / dropped / spent_external → refuse `unknown`
  - `consumed`: same txid → ok (no write); other → `consumed by another txid`
  - `reserved`: request matches → `UPDATE … SET status='consumed', txid=?, updated_at=? WHERE outpoint=?`; else `reserved by another request`
  - `released` with `needs_recheck=0` and request matches → consumed; `released` otherwise → `unknown`
  - `reserving` → `unknown`
  Any refusal → rollback, return the refusal, nil error.
- `ReleaseRequest`: `UPDATE … SET status='released', needs_recheck=1, updated_at=? WHERE request_id=? AND status='reserved'`.
- `ReleaseEvicted(txid, outpoints)`: for each outpoint `… WHERE outpoint=? AND txid=? AND status='consumed'` → released, needs_recheck=1; sum affected.
- `ReleaseByRule4(txid)`: same predicate without the outpoint list.
- `MarkSettled`: `UPDATE … SET status='consumed', settled_at=?, updated_at=? WHERE outpoint=? AND txid=? AND status IN ('consumed','released','spent_external')`.
- `ExpiredReserving`: `SELECT … WHERE status='reserving' AND expires_at < ?`.
- `ExpireReserved`: `UPDATE … SET status='released', needs_recheck=1, updated_at=? WHERE status='reserved' AND expires_at < ?`.
- `RecheckPending`: `… WHERE status='released' AND needs_recheck=1 ORDER BY updated_at LIMIT ?`.
- `SetRechecked(outpoint, unspent) (bool, error)`: unspent → `needs_recheck=0`; spent → `status='spent_external', needs_recheck=0`; both `WHERE status='released' AND needs_recheck=1`; returns `RowsAffected()==1`.
- `UnsettledConsumed(olderThan)`: `… WHERE status='consumed' AND settled_at IS NULL AND updated_at < ?`.
- `BeginRequest`: one transaction. SQLite: the `_txlock=immediate` DSN makes `BEGIN` an immediate lock, so nothing else is needed; Postgres: first statement `SELECT pg_advisory_xact_lock(hashtext(?))` with the requester. Then: `INSERT INTO fuel_requests … ON CONFLICT(nonce) DO NOTHING` → RowsAffected 0 → `VerdictNonceUsed` (rollback); `SELECT COUNT(DISTINCT request_id) FROM fuel_reservations WHERE requester=? AND status='reserved' AND expires_at>?` ≥ MaxOutstanding → `VerdictQuota`; `SELECT COUNT(*) FROM fuel_reservations WHERE requester=? AND created_at>?` (24 h) ≥ DailyPairs → `VerdictQuota`; `SELECT COUNT(*) FROM fuel_reservations WHERE created_at>?` (60 s) ≥ PairsPerMinute → `VerdictUnavailable`. Any non-ok verdict rolls back (the nonce row is not kept). Commit on ok.
- `Counts`: `SELECT status, COUNT(*) … GROUP BY status`, plus the three scalar counts.
- `truncateForTests`: deletes all rows of the three tables (unexported, used by the Postgres test path).

- [ ] **Step 5: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/store/ -count=1`
Expected: PASS on sqlite; Postgres sub-tests skipped unless `FK_TEST_PG_URL` is set (state this in the report).

- [ ] **Step 6: Commit**

```bash
git add fuelkeeper/internal/store
git commit -m "feat(fuelkeeper): reservation store with CAS state machine, batch consume, quotas"
```

---

### Task 6: Fuel source (wallet + storage adapter) and fake

**Files:**
- Create: `fuelkeeper/internal/fuel/source.go`, `fuelkeeper/internal/fuel/wallet_source.go`, `fuelkeeper/internal/fuel/fake_source.go`, `fuelkeeper/internal/fuel/derivation_test.go`

**Interfaces:**
- Produces:
  ```go
  // Row is one spendable, proven fuel output as the toolbox storage sees it.
  type Row struct {
      Outpoint string; Txid string; Vout uint32; Satoshis uint64; OutputID uint
      LockingScript []byte; DerivationPrefix, DerivationSuffix string
      Beef []byte // BEEF (with BUMPs) of the source tx
  }
  type Source interface {
      IdentityKeyHex() string
      ListProven(ctx context.Context, basket string, max int) ([]Row, error) // completed + spendable, sorted OutputID desc
      Detach(ctx context.Context, outpoint string) error                       // RelinquishOutput with basket ""
      StillSpendable(ctx context.Context, outpoint string) (bool, error)       // FindOutputsAuth: spendable && spent_by IS NULL
      FeePubKeyHash(ctx context.Context, keyID string, requester *ec.PublicKey) ([]byte, error)
      Unlocker(prefix, suffix string) (transaction.UnlockingScriptTemplate, error) // brc29.Unlock(self identity, KeyID, keyDeriver, WithSigHash(SINGLE|ANYONECANPAY|FORKID))
      Internalize(ctx context.Context, args sdk.InternalizeActionArgs) error
      BalanceSats(ctx context.Context) (uint64, error)
  }
  func NewWalletSource(w *wallet.Wallet, storageClient *storage.WalletStorageProviderClient, keyDeriver *sdk.KeyDeriver) *WalletSource
  func NewFake(identityPriv *ec.PrivateKey) *Fake // in-memory rows; AddFuel(...) builds a real self→self BRC-29 output in a synthetic source tx
  ```

- [ ] **Step 1: Write the failing derivation-parity test**

The fee key must be the same point on both sides: issuer `GetPublicKey(forSelf:true, counterparty: requester)` equals requester `GetPublicKey(forSelf:false, counterparty: issuer)`. This is what lets the payer's `revealLinkage` credit the issuer on the overlay (spec §1.2).

```go
package fuel

import (
	"context"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

func TestFeeKeyMatchesRequesterSideDerivation(t *testing.T) {
	issuerPriv, _ := ec.NewPrivateKey()
	requesterPriv, _ := ec.NewPrivateKey()
	f := NewFake(issuerPriv)
	pkh, err := f.FeePubKeyHash(context.Background(), "fee-aa.0", requesterPriv.PubKey())
	require.NoError(t, err)
	require.Len(t, pkh, 20)

	rw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypePrivateKey, PrivateKey: requesterPriv})
	require.NoError(t, err)
	res, err := rw.GetPublicKey(context.Background(), sdk.GetPublicKeyArgs{EncryptionArgs: sdk.EncryptionArgs{
		ProtocolID:   token.FTProtocol,
		KeyID:        "fee-aa.0",
		Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeOther, Counterparty: issuerPriv.PubKey()},
	}}, "test")
	require.NoError(t, err)
	require.Equal(t, res.PublicKey.Hash(), pkh)
}

func TestFakeUnlockerSignsItsOwnFuel(t *testing.T) {
	issuerPriv, _ := ec.NewPrivateKey()
	f := NewFake(issuerPriv)
	row := f.AddFuel(t, 200)
	rows, err := f.ListProven(context.Background(), "fuel", 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, row.Outpoint, rows[0].Outpoint)
	require.NoError(t, f.Detach(context.Background(), row.Outpoint))
	ok, err := f.StillSpendable(context.Background(), row.Outpoint)
	require.NoError(t, err)
	require.True(t, ok)
	f.SpendExternally(row.Outpoint)
	ok, _ = f.StillSpendable(context.Background(), row.Outpoint)
	require.False(t, ok)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/fuel/`
Expected: FAIL.

- [ ] **Step 3: Implement `source.go` (interface + shared helpers)**

```go
package fuel

var FuelSigHash = sighash.SingleForkID | sighash.AnyOneCanPay // 0xC3

// feePubKeyHash derives the issuer-side fee key for a requester (spec §1.2).
func feePubKeyHash(ctx context.Context, pw interface {
	GetPublicKey(context.Context, sdk.GetPublicKeyArgs, string) (*sdk.GetPublicKeyResult, error)
}, keyID string, requester *ec.PublicKey) ([]byte, error) {
	forSelf := true
	res, err := pw.GetPublicKey(ctx, sdk.GetPublicKeyArgs{
		EncryptionArgs: sdk.EncryptionArgs{
			ProtocolID:   token.FTProtocol,
			KeyID:        keyID,
			Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeOther, Counterparty: requester},
		},
		ForSelf: &forSelf,
	}, "fuelkeeper")
	if err != nil {
		return nil, fmt.Errorf("fee key: %w", err)
	}
	return res.PublicKey.Hash(), nil
}

// unlocker builds the toolbox change-input unlocker with the fuel sighash.
func unlocker(identityHex, prefix, suffix string, kd *sdk.KeyDeriver) (transaction.UnlockingScriptTemplate, error) {
	f := FuelSigHash
	tpl, err := brc29.Unlock(brc29.PubHex(identityHex), brc29.KeyID{DerivationPrefix: prefix, DerivationSuffix: suffix}, kd, brc29.WithSigHash(&f))
	if err != nil {
		return nil, fmt.Errorf("fuel unlocker: %w", err)
	}
	return tpl, nil
}
```

`*brc29.UnlockingScriptTemplate` has `Sign(tx, inputIndex uint32)` and `EstimateLength(tx, inputIndex uint32)`; confirm it satisfies go-sdk's `transaction.UnlockingScriptTemplate` interface at 1.5.1 (`transaction/input.go`). If the interface differs, return `*brc29.UnlockingScriptTemplate` from `Unlocker` instead and call `.Sign` directly in the drafter.

- [ ] **Step 4: Implement `wallet_source.go`**

```go
type WalletSource struct {
	w       *wallet.Wallet
	storage *storage.WalletStorageProviderClient
	kd      *sdk.KeyDeriver
	auth    wdk.AuthID
}

func NewWalletSource(w *wallet.Wallet, sc *storage.WalletStorageProviderClient, kd *sdk.KeyDeriver) *WalletSource {
	return &WalletSource{w: w, storage: sc, kd: kd, auth: wdk.AuthID{IdentityKey: kd.IdentityKeyHex()}}
}

func (s *WalletSource) IdentityKeyHex() string { return s.kd.IdentityKeyHex() }

// ListProven intersects the basket listing (which carries BEEF) with the
// storage rows that are spendable and belong to a completed (proven) tx.
func (s *WalletSource) ListProven(ctx context.Context, basket string, max int) ([]Row, error) {
	limit := uint32(10000)
	list, err := s.w.ListOutputs(ctx, sdk.ListOutputsArgs{Basket: basket, Include: sdk.OutputIncludeEntireTransactions, Limit: &limit}, "fuelkeeper")
	if err != nil {
		return nil, fmt.Errorf("list fuel: %w", err)
	}
	inBasket := map[string]sdk.Output{}
	for _, o := range list.Outputs {
		inBasket[o.Outpoint.String()] = o
	}
	spendable := true
	rows, err := s.storage.FindOutputsAuth(ctx, s.auth, wdk.FindOutputsArgs{Spendable: &spendable, TxStatus: []wdk.TxStatus{wdk.TxStatusCompleted}})
	if err != nil {
		return nil, fmt.Errorf("find proven outputs: %w", err)
	}
	var beef *transaction.Beef
	if len(list.BEEF) > 0 {
		beef, err = transaction.NewBeefFromBytes(list.BEEF)
		if err != nil {
			return nil, fmt.Errorf("basket beef: %w", err)
		}
	}
	var out []Row
	for _, r := range rows {
		if r.TxID == nil || r.SpentBy != nil {
			continue
		}
		op := fmt.Sprintf("%s.%d", *r.TxID, r.Vout)
		if _, ok := inBasket[op]; !ok {
			continue
		}
		var srcBeef []byte
		if beef != nil {
			if tx := beef.FindTransaction(*r.TxID); tx != nil {
				srcBeef, err = tx.BEEF()
				if err != nil {
					return nil, fmt.Errorf("beef for %s: %w", op, err)
				}
			}
		}
		if len(srcBeef) == 0 {
			continue // no proof material → not usable as fuel (spec §4.3 step 4)
		}
		out = append(out, Row{
			Outpoint: op, Txid: *r.TxID, Vout: r.Vout, Satoshis: uint64(r.Satoshis), OutputID: r.OutputID,
			LockingScript: []byte(r.LockingScript),
			DerivationPrefix: deref(r.DerivationPrefix), DerivationSuffix: deref(r.DerivationSuffix),
			Beef: srcBeef,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OutputID > out[j].OutputID })
	if len(out) > max {
		out = out[:max]
	}
	return out, nil
}

func (s *WalletSource) Detach(ctx context.Context, outpoint string) error {
	op, err := transaction.OutpointFromString(outpoint)
	if err != nil {
		return err
	}
	_, err = s.w.RelinquishOutput(ctx, sdk.RelinquishOutputArgs{Basket: "", Output: *op}, "fuelkeeper")
	return err
}

func (s *WalletSource) StillSpendable(ctx context.Context, outpoint string) (bool, error) {
	op, err := transaction.OutpointFromString(outpoint)
	if err != nil {
		return false, err
	}
	txid := op.Txid.String()
	rows, err := s.storage.FindOutputsAuth(ctx, s.auth, wdk.FindOutputsArgs{TxID: &txid, Vout: &op.Index})
	if err != nil {
		return false, err
	}
	if len(rows) != 1 {
		return false, nil
	}
	return rows[0].Spendable && rows[0].SpentBy == nil, nil
}

func (s *WalletSource) FeePubKeyHash(ctx context.Context, keyID string, requester *ec.PublicKey) ([]byte, error) {
	return feePubKeyHash(ctx, s.w, keyID, requester)
}
func (s *WalletSource) Unlocker(prefix, suffix string) (transaction.UnlockingScriptTemplate, error) {
	return unlocker(s.IdentityKeyHex(), prefix, suffix, s.kd)
}
func (s *WalletSource) Internalize(ctx context.Context, args sdk.InternalizeActionArgs) error {
	_, err := s.w.InternalizeAction(ctx, args, "fuelkeeper")
	return err
}
func (s *WalletSource) BalanceSats(ctx context.Context) (uint64, error) { return s.w.Balance(ctx) }
```

Notes for the implementer: `transaction.Outpoint.String()` at 1.5.1 must yield `"<txid>.<vout>"` (check `transaction/outpoint.go`; if it does not, format with `fmt.Sprintf("%s.%d", op.Txid.String(), op.Index)` everywhere and never rely on `String()`). The `ListOutputs` include constant is `sdk.OutputIncludeEntireTransactions`. `r.LockingScript` is `primitives.ExplicitByteArray` (a `[]byte` alias).

- [ ] **Step 5: Implement `fake_source.go`**

An in-memory `Fake` with the same interface, for the drafter/sweeper/api tests:

- `NewFake(identityPriv)` keeps `kd = sdk.NewKeyDeriver(identityPriv)` and a `pw` ProtoWallet over the same key for `FeePubKeyHash`.
- `AddFuel(t, sats) Row`: builds a self→self BRC-29 lock with random 16-byte base64 `prefix`/`suffix` via `brc29.LockForCounterparty(kd, brc29.KeyID{prefix, suffix}, kd)`, wraps it in a synthetic source tx (`transaction.NewTransaction()` with one dummy input `SourceTXID` = zero hash, `SourceTxOutIndex` = 0xffffffff, and the fuel output), records `Beef = tx.BEEF()` (unproven BEEF is fine for a fake) and returns the Row with `OutputID` incrementing.
- Flags per row: `inBasket`, `spendable`, `spentBy`. `ListProven` returns rows with `inBasket && spendable && spentBy==""` sorted by OutputID desc. `Detach` sets `inBasket=false` (idempotent). `StillSpendable` returns `spendable && spentBy==""`. `SpendExternally(op)` sets `spendable=false`. `FailNextDetach(err)` and `FailNextList(err)` inject one error each. `Internalize` records the args in `Internalized []sdk.InternalizeActionArgs` and returns `InternalizeErr` if set. `BalanceSats` returns a settable field.

- [ ] **Step 6: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go build ./... && GOTOOLCHAIN=auto go test ./internal/fuel/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add fuelkeeper/internal/fuel
git commit -m "feat(fuelkeeper): fuel source over the toolbox wallet with derivation-parity test and fake"
```

---

### Task 7: Drafter (§4.3) with go-sdk verification test

**Files:**
- Create: `fuelkeeper/internal/draft/draft.go`, `fuelkeeper/internal/draft/draft_test.go`

**Interfaces:**
- Produces:
  ```go
  type Request struct { // verbatim §3.1 body + overlay-supplied fields
      AssetID string; N, M int; Requester, Nonce string; Ts int64; Sig string
      FeeRatePerKb int64; IssuerIdentityKey string
  }
  type Pair struct { Vin, Vout int; FuelOutpoint string; FuelSatoshis uint64; KeyID, Counterparty, FeeScript, FeeAmount string }
  type Response struct { RequestID, AssetID string; K int; FeePerPair string; ExpiresAt int64; DraftTx, FuelBeef string; Pairs []Pair }
  type Refusal struct { Code string; HTTP int; Retryable bool; Description string } // codes: ERR_SHAPE, ERR_FUEL_AUTH, ERR_FUEL_INELIGIBLE, ERR_FUEL_DENIED, ERR_FUEL_QUOTA, ERR_FUEL_TOO_LARGE, ERR_FUEL_UNAVAILABLE
  type Drafter struct { /* cfg, store, source, verifier, econ params, now */ }
  func New(cfg config.Config, st *store.Store, src fuel.Source, v *auth.Verifier, now func() time.Time) *Drafter
  func (d *Drafter) Draft(ctx context.Context, req Request) (*Response, *Refusal, error) // error = infrastructure failure (503)
  ```

- [ ] **Step 1: Write the failing tests**

```go
package draft

import (
	"context"
	"encoding/hex"
	"path/filepath"
	"testing"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/transaction/template/p2pkh"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/auth"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

const asset = "abababababababababababababababababababababababababababababababab.0"

type harness struct {
	d      *Drafter
	src    *fuel.Fake
	st     *store.Store
	now    time.Time
	issuer *ec.PrivateKey
	reqPW  *sdk.ProtoWallet
	reqHex string
}

func newHarness(t *testing.T, fuelRows int) *harness {
	t.Helper()
	cfg, err := config.Load(func(k string) string {
		return map[string]string{
			"ISSUER_ROOT_KEY": "dc745c57de627a6d3a3ca549e0f9fb6b8f779108a1fe6fe290cc4df3461125d6", "FK_API_KEY": "0123456789abcdef0123456789abcdef",
			"FK_STORAGE_CONFIG": "x", "FK_NETWORK": "test", "FUEL_ASSET_IDS": asset,
		}[k]
	})
	require.NoError(t, err)
	now := time.Unix(1_758_500_000, 0)
	h := &harness{now: now}
	h.issuer, _ = ec.PrivateKeyFromHex(cfg.IssuerRootKeyHex)
	h.src = fuel.NewFake(h.issuer)
	for i := 0; i < fuelRows; i++ {
		h.src.AddFuel(t, cfg.Denomination)
	}
	h.st, err = store.Open("sqlite", filepath.Join(t.TempDir(), "fk.sqlite"), func() time.Time { return h.now })
	require.NoError(t, err)
	v, _ := auth.NewVerifier(func() time.Time { return h.now })
	h.d = New(cfg, h.st, h.src, v, func() time.Time { return h.now })
	reqPriv, _ := ec.NewPrivateKey()
	h.reqPW, _ = sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypePrivateKey, PrivateKey: reqPriv})
	h.reqHex = reqPriv.PubKey().ToDERHex()
	return h
}

func (h *harness) request(t *testing.T, n, m int, nonceByte byte) Request {
	nonce := hex.EncodeToString(append(make([]byte, 31), nonceByte))
	msg := auth.DraftMessage(asset, n, m, h.reqHex, nonce, h.now.Unix())
	sig, err := auth.Sign(context.Background(), h.reqPW, nonce, msg)
	require.NoError(t, err)
	return Request{AssetID: asset, N: n, M: m, Requester: h.reqHex, Nonce: nonce, Ts: h.now.Unix(), Sig: sig,
		FeeRatePerKb: 10, IssuerIdentityKey: h.issuer.PubKey().ToDERHex()}
}

func TestDraft_WorkedExample(t *testing.T) {
	h := newHarness(t, 3)
	res, ref, err := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, 1, res.K)
	require.Equal(t, "20", res.FeePerPair)
	require.Equal(t, h.now.Unix()+600, res.ExpiresAt)
	require.Len(t, res.Pairs, 1)
	p := res.Pairs[0]
	require.Equal(t, 0, p.Vin)
	require.Equal(t, 0, p.Vout)
	require.Equal(t, "fee-"+p.FuelOutpoint, p.KeyID)
	require.Equal(t, h.issuer.PubKey().ToDERHex(), p.Counterparty)
	require.Equal(t, "20", p.FeeAmount)

	tx, err := transaction.NewTransactionFromHex(res.DraftTx)
	require.NoError(t, err)
	require.EqualValues(t, 1, tx.Version)
	require.EqualValues(t, 0, tx.LockTime)
	require.Len(t, tx.Inputs, 1)
	require.Len(t, tx.Outputs, 1)
	require.EqualValues(t, 1, tx.Outputs[0].Satoshis)
	require.Equal(t, p.FeeScript, tx.Outputs[0].LockingScript.String())
	require.EqualValues(t, 0xffffffff, tx.Inputs[0].SequenceNumber)
	// unlocking script ends with the fuel sighash byte before the pubkey push
	us := *tx.Inputs[0].UnlockingScript
	sigLen := int(us[0])
	require.Equal(t, byte(sighash.SingleForkID|sighash.AnyOneCanPay), us[sigLen])

	rows, _ := h.st.ByRequest(context.Background(), res.RequestID)
	require.Len(t, rows, 1)
	require.Equal(t, store.StatusReserved, rows[0].Status)
	require.Equal(t, p.FeeScript, rows[0].FeeScript)
	_, err = transaction.NewBeefFromBytes(mustHex(t, res.FuelBeef))
	require.NoError(t, err)
}

// The core guarantee (spec §1.1): a payer may append inputs/outputs after the
// pairs and the fuel signatures still verify; changing output i breaks input i.
func TestDraft_SkeletonSurvivesExtension(t *testing.T) {
	h := newHarness(t, 6)
	res, ref, err := h.d.Draft(context.Background(), h.request(t, 8, 10, 2)) // k=2
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, 2, res.K)
	tx, _ := transaction.NewTransactionFromHex(res.DraftTx)
	prev := make([]*transaction.TransactionOutput, 2)
	for i, p := range res.Pairs {
		row := h.src.Row(p.FuelOutpoint)
		prev[i] = &transaction.TransactionOutput{Satoshis: row.Satoshis, LockingScript: script.NewFromBytes(row.LockingScript)}
	}
	// Append a payer P2PKH input and two outputs, sign the payer input ALL|FORKID.
	payer, _ := ec.NewPrivateKey()
	payerLock, _ := p2pkh.Lock(payer.PubKey().Hash())
	srcTx := transaction.NewTransaction()
	srcTx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: payerLock})
	require.NoError(t, tx.AddInputFromTx(srcTx, 0, mustP2PKHUnlock(t, payer)))
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: payerLock})
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: payerLock})
	require.NoError(t, tx.Sign()) // signs only inputs with a template (the payer input)

	for i := range res.Pairs {
		require.NoError(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, i, prev[i]), interpreter.WithForkID(), interpreter.WithAfterGenesis()), "fuel input %d must verify after extension", i)
	}
	// Tamper with output 0 → input 0 fails, input 1 still passes.
	tx.Outputs[0].Satoshis = 2
	require.Error(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, 0, prev[0]), interpreter.WithForkID(), interpreter.WithAfterGenesis()))
	require.NoError(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, 1, prev[1]), interpreter.WithForkID(), interpreter.WithAfterGenesis()))
	// Dropping the trailing pair keeps pair 0 valid.
	tx.Outputs[0].Satoshis = 1
	tx.Inputs = tx.Inputs[:1]
	tx.Outputs = tx.Outputs[:1]
	require.NoError(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, 0, prev[0]), interpreter.WithForkID(), interpreter.WithAfterGenesis()))
}

func TestDraft_Refusals(t *testing.T) {
	h := newHarness(t, 3)
	ctx := context.Background()
	bad := h.request(t, 1, 3, 3)
	bad.AssetID = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.0"
	_, ref, _ := h.d.Draft(ctx, bad)
	require.Equal(t, "ERR_SHAPE", ref.Code, "signature no longer matches the message → but assetId is checked first as allowlist? No: shape/auth precede eligibility; a changed assetId invalidates the signature")

	r := h.request(t, 1, 3, 4)
	r.Sig = r.Sig[:len(r.Sig)-2] + "00"
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_FUEL_AUTH", ref.Code)

	r = h.request(t, 0, 3, 5)
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_SHAPE", ref.Code)

	r = h.request(t, 1, 3, 6)
	r.FeeRatePerKb = 0
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_FUEL_INELIGIBLE", ref.Code)

	r = h.request(t, 1, 3, 7)
	r.IssuerIdentityKey = h.reqHex
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_FUEL_INELIGIBLE", ref.Code, "issuer key must be this keeper's identity")

	require.NoError(t, h.st.Deny(ctx, h.reqHex, "test", "x.0"))
	_, ref, _ = h.d.Draft(ctx, h.request(t, 1, 3, 8))
	require.Equal(t, "ERR_FUEL_DENIED", ref.Code)
	_, _ = h.st.Undeny(ctx, h.reqHex)

	_, ref, _ = h.d.Draft(ctx, h.request(t, 8, 10, 9))
	require.Nil(t, ref)
	_, ref, _ = h.d.Draft(ctx, h.request(t, 8, 10, 10))
	require.Nil(t, ref)
	_, ref, _ = h.d.Draft(ctx, h.request(t, 1, 3, 11))
	require.Equal(t, "ERR_FUEL_QUOTA", ref.Code, "MaxOutstanding=2 reserved drafts")
}

func TestDraft_TooLargeAndNoFuel(t *testing.T) {
	h := newHarness(t, 0)
	_, ref, _ := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.Equal(t, "ERR_FUEL_UNAVAILABLE", ref.Code)
	h2 := newHarness(t, 1)
	_, ref, _ = h2.d.Draft(context.Background(), h2.request(t, 20, 10, 1))
	require.Equal(t, "ERR_FUEL_TOO_LARGE", ref.Code)
}

func TestDraft_FunderRaceDropsAndReplaces(t *testing.T) {
	h := newHarness(t, 3)
	rows, _ := h.src.ListProven(context.Background(), "fuel", 10)
	h.src.SpendAfterDetach(rows[0].Outpoint) // the storage funder allocates it between detach and verify
	res, ref, err := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.NotEqual(t, rows[0].Outpoint, res.Pairs[0].FuelOutpoint)
	all, _ := h.st.ByRequest(context.Background(), res.RequestID)
	statuses := map[string]store.Status{}
	for _, r := range all {
		statuses[r.Outpoint] = r.Status
	}
	require.Equal(t, store.StatusDropped, statuses[rows[0].Outpoint])
}

func TestDraft_RedraftsReleasedRowWithStoredBeef(t *testing.T) {
	h := newHarness(t, 1)
	res, ref, _ := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.Nil(t, ref)
	_, _ = h.st.ReleaseRequest(context.Background(), res.RequestID)
	require.NoError(t, h.st.SetRechecked(context.Background(), res.Pairs[0].FuelOutpoint, true))
	h.src.FailNextList(nil) // basket listing now returns nothing for the detached row
	res2, ref, err := h.d.Draft(context.Background(), h.request(t, 1, 3, 2))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, res.Pairs[0].FuelOutpoint, res2.Pairs[0].FuelOutpoint)
	require.Equal(t, res.FuelBeef, res2.FuelBeef)
	require.NotEqual(t, res.Pairs[0].FeeScript, res2.Pairs[0].FeeScript, "different requester nonce → same keyID (fee-<outpoint>) but new request; fee script is identical for the same requester and keyID") // see note below
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	require.NoError(t, err)
	return b
}

func mustP2PKHUnlock(t *testing.T, k *ec.PrivateKey) *p2pkh.P2PKH {
	t.Helper()
	f := sighash.AllForkID
	u, err := p2pkh.Unlock(k, &f)
	require.NoError(t, err)
	return u
}
```

Note on the last assertion of `TestDraft_RedraftsReleasedRowWithStoredBeef`: `keyID = "fee-" + outpoint` and the requester is the same, so the fee script is **identical** across re-drafts of the same outpoint. Replace that final `require.NotEqual` with `require.Equal(t, res.Pairs[0].FeeScript, res2.Pairs[0].FeeScript)` and keep the comment explaining why. Also fix the first `Refusals` case: a request whose `AssetID` was changed after signing fails signature verification, so the expected code there is `ERR_FUEL_AUTH`; to test the allowlist itself, sign a request for the non-allowlisted asset properly (build the message with that assetId) and expect `ERR_FUEL_INELIGIBLE`. The Fake needs two extra hooks used above: `Row(outpoint) Row` and `SpendAfterDetach(outpoint)` (marks the row unspendable when `Detach` is called on it).

- [ ] **Step 2: Run to verify failure**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/draft/`
Expected: FAIL.

- [ ] **Step 3: Implement the drafter**

`draft.go` follows §4.3 literally. Skeleton of the flow (fill in with the store/source calls named above):

```go
func (d *Drafter) Draft(ctx context.Context, req Request) (*Response, *Refusal, error) {
	// 1. shape → auth → eligibility → deny list (§3.1 order)
	if req.N < 1 || req.N > d.cfg.NMax || req.M < 1 || req.M > d.cfg.MMax || !token.ValidAssetID(req.AssetID) {
		return nil, shape("n, m or assetId out of range"), nil
	}
	msg := auth.DraftMessage(req.AssetID, req.N, req.M, req.Requester, req.Nonce, req.Ts)
	if err := d.verifier.Verify(ctx, req.Requester, req.Nonce, req.Sig, req.Ts, msg); err != nil {
		if errors.Is(err, auth.ErrShape) { return nil, shape(err.Error()), nil }
		return nil, refuse("ERR_FUEL_AUTH", 401, false, "signature invalid"), nil
	}
	requesterPub, _ := auth.ParseRequester(req.Requester)
	if !d.cfg.AllowsAsset(req.AssetID) || req.FeeRatePerKb < 1 || req.IssuerIdentityKey != d.src.IdentityKeyHex() {
		return nil, refuse("ERR_FUEL_INELIGIBLE", 409, true, "asset not fuel-eligible"), nil
	}
	if denied, err := d.st.IsDenied(ctx, req.Requester); err != nil { return nil, nil, err } else if denied {
		return nil, refuse("ERR_FUEL_DENIED", 403, false, "requester denied"), nil
	}
	// 2. quota + nonce, one serialized tx
	switch v, err := d.st.BeginRequest(ctx, req.Nonce, req.Requester, req.Ts, store.Quotas{...}); {
	case err != nil: return nil, nil, err
	case v == store.VerdictNonceUsed: return nil, refuse("ERR_FUEL_AUTH", 401, false, "nonce already used"), nil
	case v == store.VerdictQuota: return nil, refuse("ERR_FUEL_QUOTA", 429, true, "quota exceeded"), nil
	case v == store.VerdictUnavailable: return nil, refuse("ERR_FUEL_UNAVAILABLE", 503, true, "rate limited"), nil
	}
	// 3. size
	k, err := econ.SizeDraft(d.params, req.N, req.M)
	if errors.Is(err, econ.ErrTooLarge) { return nil, refuse("ERR_FUEL_TOO_LARGE", 400, false, "k > K_MAX"), nil }
	if err != nil { return nil, nil, err }
	fee, err := econ.FeePerPair(d.params, req.FeeRatePerKb)
	if err != nil { return nil, refuse("ERR_FUEL_INELIGIBLE", 409, true, err.Error()), nil }
	// 4–7. candidates → claim → detach → verify, up to K_MAX*2 attempts
	survivors, err := d.reserve(ctx, req, k)          // []store.Candidate in pair order
	if err != nil { return nil, nil, err }
	if len(survivors) < k {
		_, _ = d.st.ReleaseReserving(ctx, req.Nonce, true) // survivors → released, needs_recheck=1
		return nil, refuse("ERR_FUEL_UNAVAILABLE", 503, true, "no proven fuel"), nil
	}
	// 8–9. fee scripts, skeleton, signatures, BEEF
	// 10. commit
}
```

`reserve` iterates: candidates = `st.ReleasedCandidates(ctx, k*2)` first, then `src.ListProven(ctx, cfg.PoolBasket, k*4)` mapped to `store.Candidate{... FuelBeef: hex(row.Beef) ...}` (skip outpoints already tried); for each: `Claim` (false → next); `Detach` (error → `Drop`, next); `StillSpendable` (false/error → `Drop`, next); append. Stop when `len == k` or attempts reach `cfg.KMax*2`.

Skeleton build and sign:

```go
tx := transaction.NewTransaction() // version 1, lockTime 0
for i, c := range survivors {
	op, _ := transaction.OutpointFromString(c.Outpoint)
	in := &transaction.TransactionInput{SourceTXID: &op.Txid, SourceTxOutIndex: op.Index, SequenceNumber: 0xffffffff}
	fuelScript, _ := hex.DecodeString(c.FuelScript)
	in.SetSourceTxOutput(&transaction.TransactionOutput{Satoshis: c.Satoshis, LockingScript: script.NewFromBytes(fuelScript)})
	tx.AddInput(in)
	pkh, err := d.src.FeePubKeyHash(ctx, "fee-"+c.Outpoint, requesterPub)
	feeScript, err := token.LockToken(req.AssetID, fee, pkh)
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: feeScript})
}
for i, c := range survivors {
	tpl, err := d.src.Unlocker(c.DerivationPrefix, c.DerivationSuffix)
	us, err := tpl.Sign(tx, uint32(i))
	tx.Inputs[i].UnlockingScript = us
}
```

`fuelBeef`: `b := transaction.NewBeef()`; for each survivor `b.MergeBeefBytes(beefBytes)`; `bytes, _ := b.Bytes()`; hex. Any storage/signing error after claim → `ReleaseReserving(ctx, nonce, true)` best-effort, then return the error (503). Finally `st.Commit(ctx, req.Nonce, pairs, cfg.TTLSeconds)`; a commit conflict is an error (503) after the same best-effort release.

Response: `RequestID = req.Nonce`, `K`, `FeePerPair = strconv.FormatInt(fee, 10)`, `ExpiresAt = now + TTL`, `DraftTx = tx.Hex()`, `Pairs[i] = {Vin: i, Vout: i, FuelOutpoint, FuelSatoshis, KeyID: "fee-"+outpoint, Counterparty: d.src.IdentityKeyHex(), FeeScript: hex(feeScript), FeeAmount}`.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/draft/ -count=1`
Expected: PASS, including the interpreter verification after extension and the tamper/drop-trailing cases.

- [ ] **Step 5: Commit**

```bash
git add fuelkeeper/internal/draft fuelkeeper/internal/fuel
git commit -m "feat(fuelkeeper): draft signer with claim/detach/verify/commit and go-sdk verification test"
```

---

### Task 8: Chain checker, settle, sweeper (§4.6, §4.7)

**Files:**
- Create: `fuelkeeper/internal/chain/chain.go`, `fuelkeeper/internal/settle/settle.go`, `fuelkeeper/internal/settle/settle_test.go`, `fuelkeeper/internal/sweeper/sweeper.go`, `fuelkeeper/internal/sweeper/sweeper_test.go`

**Interfaces:**
- Produces:
  ```go
  // chain
  type Checker interface { IsUnspent(ctx context.Context, fuelScriptHex, outpoint string) (bool, error) }
  func NewServicesChecker(s *services.WalletServices) Checker   // token.ScriptHash + services.IsUtxo
  type Disabled struct{}                                       // always returns an error ("chain check disabled")
  // settle
  type Settler struct{ st *store.Store; src fuel.Source; now func() time.Time }
  func (s *Settler) Settle(ctx context.Context, txid string, atomicBeef []byte) (settled int, err error)
  // sweeper
  type OverlayClient interface { AdmissionStatus(ctx context.Context, txid string) (code int, finalReject bool, err error); Resettle(ctx context.Context, txid string) error }
  type Sweeper struct{ st; src; checker; overlay; now; logger; reservingTTL }
  func (s *Sweeper) Tick(ctx context.Context) error   // rules 0–4 in order; each rule logs and continues on error
  func (s *Sweeper) Run(ctx context.Context, every time.Duration)
  func NewHTTPOverlayClient(baseURL, adminToken string, hc *http.Client) OverlayClient
  ```

- [ ] **Step 1: Write the failing settle test**

```go
func TestSettle_InternalizesEveryRowAndMarksSettled(t *testing.T) {
	// two consumed rows for txid "t1" (pair_index 0 and 1) + one released row for t1 (wrongful release) → all three internalized, all consumed+settled
	// asserts InternalizeActionArgs: Outputs[0].OutputIndex == pair_index, Protocol == "basket insertion",
	// InsertionRemittance.Basket == "mandala-tokens", CustomInstructions JSON has protocolID [2,"mandala token"], keyID, counterparty == requester, Tags == ["mandala","fee",assetId]
	// Description == "Fee for t1"
}
func TestSettle_NormalizesToAtomicBeef(t *testing.T) {
	// pass a plain BEEF (version 0x0100beef… from tx.BEEF()); the args handed to Internalize must start with the ATOMIC_BEEF prefix (0x01010101)
}
func TestSettle_IdempotentAndUnknownTxid(t *testing.T) {
	// second call: Internalize called again (harmless known-tx merge) and rows unchanged; unknown txid → 0, nil
}
```

Write these three fully (fake source, sqlite store, rows inserted via `Claim`+`Commit`+`Consume`, and one row via `Claim`+`Commit`+`ReleaseRequest`+`SetRechecked(true)`+`Consume`+`ReleaseEvicted` to reach `released` with `txid`). Build the test tx as any go-sdk transaction with one input (dummy source) and two outputs; `beef, _ := tx.BEEF()`; atomic prefix check: `bytes.HasPrefix(args.Tx, []byte{0x01,0x01,0x01,0x01})`.

- [ ] **Step 2: Implement settle**

```go
func (s *Settler) Settle(ctx context.Context, txid string, beefBytes []byte) (int, error) {
	atomic := beefBytes
	if !bytes.HasPrefix(beefBytes, []byte{0x01, 0x01, 0x01, 0x01}) {
		b, err := transaction.NewBeefFromBytes(beefBytes)
		if err != nil { return 0, fmt.Errorf("settle: beef: %w", err) }
		h, err := chainhash.NewHashFromHex(txid)
		if err != nil { return 0, fmt.Errorf("settle: txid: %w", err) }
		atomic, err = b.AtomicBytes(h)
		if err != nil { return 0, fmt.Errorf("settle: atomic: %w", err) }
	}
	rows, err := s.st.ByTxid(ctx, txid)
	if err != nil { return 0, err }
	n := 0
	for _, r := range rows {
		switch r.Status {
		case store.StatusConsumed, store.StatusReleased, store.StatusSpentExternal:
		default:
			continue
		}
		ci, _ := json.Marshal(map[string]any{"protocolID": []any{2, "mandala token"}, "keyID": r.KeyID, "counterparty": r.Requester})
		args := sdk.InternalizeActionArgs{
			Tx: atomic,
			Outputs: []sdk.InternalizeOutput{{OutputIndex: uint32(r.PairIndex), Protocol: sdk.InternalizeProtocolBasketInsertion,
				InsertionRemittance: &sdk.BasketInsertion{Basket: "mandala-tokens", CustomInstructions: string(ci), Tags: []string{"mandala", "fee", r.AssetID}}}},
			Description: "Fee for " + txid,
		}
		if err := s.src.Internalize(ctx, args); err != nil { return n, fmt.Errorf("settle %s: %w", r.Outpoint, err) }
		if _, err := s.st.MarkSettled(ctx, r.Outpoint, txid); err != nil { return n, err }
		n++
	}
	return n, nil
}
```

Use the go-sdk constant whose value is `"basket insertion"` (grep `InternalizeProtocol` in `wallet/interfaces.go`; the name above is the expected one). The ATOMIC_BEEF version prefix is `0x01010101` little-endian (`transaction.ATOMIC_BEEF` if exported — prefer the constant).

- [ ] **Step 3: Write the failing sweeper tests**

Cover, with a fake `Checker` (map outpoint→(unspent bool, err)) and a fake `OverlayClient` (map txid→(code, finalReject, err), records `Resettle` calls):

- rule 0: `reserving` past TTL, detach+verify ok → `released, needs_recheck=0`; verify fails → `dropped`.
- rule 1: `reserved` past `expires_at` → `released, needs_recheck=1`.
- rule 2: recheck rows: unspent → `needs_recheck=0`; spent → `spent_external` and the requester denied **only when `SetRechecked` reports `true`** (the CAS can miss when `/settle` concurrently repaired the row to `consumed` — then no denial, no alert); checker error → unchanged and not denied.
- rule 3: `consumed` unsettled older than 5 min → only a log line (assert nothing changed).
- rule 4: `consumed` unsettled older than 30 min: overlay 200 → unchanged + `Resettle` called once; 410 → released needs_recheck=1; 400 with `finalReject` → released; 404 with checker unspent on two ticks ≥ 10 min apart → released on the second tick, not the first; 5xx → unchanged, no `Resettle`.

For the 404 rule keep an in-memory `map[txid]firstUnspentAt time.Time` on the Sweeper (lost on restart, which only delays the release — acceptable; say so in a comment).

- [ ] **Step 4: Implement sweeper + chain + overlay client**

`Tick` runs the rules in order 0→4 using the store methods from Task 5 and the source's `Detach`/`StillSpendable` for rule 0. `NewHTTPOverlayClient.AdmissionStatus` does `GET {base}/admin/admission/{txid}` with `Authorization: Bearer <token>`, 10 s timeout; returns the status code and, for 400, whether the JSON body's `code` is one of the final verdict codes (any `4xx` body with `"retryable": false` counts as final — parse `retryable`). `Resettle` does `POST {base}/fuel/resettle` with JSON `{"txid": …}` and the same bearer; non-2xx is an error.

`chain.NewServicesChecker(s)` → `s.IsUtxo(ctx, token.ScriptHash(scriptBytes), outpoint)`. `Disabled.IsUnspent` returns `errors.New("chain check disabled: set FK_WOC_API_KEY")` so rule 2 leaves rows unchanged (never treat an error as unspent).

- [ ] **Step 5: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/settle/ ./internal/sweeper/ ./internal/chain/ -count=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fuelkeeper/internal/chain fuelkeeper/internal/settle fuelkeeper/internal/sweeper
git commit -m "feat(fuelkeeper): settle via InternalizeAction, sweeper rules 0-4, chain checker"
```

---

### Task 9: HTTP API (§3.1 codes, §4.5 bodies, §4.8 health)

**Files:**
- Create: `fuelkeeper/internal/httpapi/api.go`, `fuelkeeper/internal/httpapi/api_test.go`

**Interfaces:**
- Produces: `func New(deps Deps) http.Handler` where
  ```go
  type Deps struct {
      APIKey string
      Drafter interface{ Draft(ctx, draft.Request) (*draft.Response, *draft.Refusal, error) }
      Store *store.Store
      Settler interface{ Settle(ctx, txid string, beef []byte) (int, error) }
      Source fuel.Source; Cfg config.Config; Logger *slog.Logger
  }
  ```
  Routes (all JSON; every route except `GET /health` requires `X-Fuel-Key` equal to `APIKey` via `crypto/subtle.ConstantTimeCompare`, else `401 {status:"error", code:"ERR_UNAUTHORIZED", retryable:false}`):
  - `POST /draft` → body = `draft.Request` JSON (`feeRatePerKb` and `n`/`m` as numbers, `ts` number); 200 = `draft.Response` JSON with field names exactly as spec §3.1 (`requestId, assetId, k, feePerPair, expiresAt, draftTx, fuelBeef, pairs[{vin, vout, fuelOutpoint, fuelSatoshis, keyID, counterparty, feeScript, feeAmount}]`); refusal → its HTTP status with `{status:"error", code, retryable, description}`; infra error → `503 ERR_FUEL_UNAVAILABLE`.
  - `POST /consume` `{txid, pairs:[{outpoint, requestId}]}` → `200 {ok:true}` or `200 {ok:false, outpoint, reason}`; malformed → 400 `ERR_SHAPE`; store error → 503.
  - `POST /release` — `{requestId}` → `200 {ok:true, affected}`; `{txid, outpoints:[…]}` → same, using `ReleaseEvicted`; both present or neither → 400.
  - `POST /settle` `{txid, atomicBeef}` (hex) → `200 {settled}`; keeper error → 503.
  - `GET /health` (no key) → §4.8 JSON: `pool{available, reserving, reserved, consumedUnsettled, released, recheckPending, dropped, spentExternal}, issuerBsvSats, lowWater, denomination, provenFuel, denied`; `available` and `provenFuel` = `len(Source.ListProven(ctx, PoolBasket, 10000))`, `lowWater = PoolTarget*LowWaterPercent/100`. If the wallet call fails, still return 200 with `issuerBsvSats: null` and an `errors: [...]` array.
  - `DELETE /deny/{requester}` → `200 {removed: bool}`.
  - 1 MiB body limit (`http.MaxBytesReader`), 15 s per-request timeout, `Content-Type: application/json`.

- [ ] **Step 1: Write the failing tests** (httptest against `New` with a stub Drafter/Settler and a real sqlite store + Fake source):

  - key missing/wrong → 401 on every route; `/health` works without a key.
  - `/draft` maps a `Refusal{Code:"ERR_FUEL_QUOTA", HTTP:429, Retryable:true}` to status 429 and the exact body; a returned error → 503 `ERR_FUEL_UNAVAILABLE`; response JSON has the exact key names (assert with a `map[string]any` decode).
  - `/consume` ok, refused, malformed.
  - `/release` both forms + ambiguity 400.
  - `/settle` passes decoded hex to the settler and returns `{settled}`.
  - `/health` shape and `lowWater` arithmetic.
  - `DELETE /deny/{r}` after `Store.Deny`.

- [ ] **Step 2: Implement** with `http.NewServeMux()` and Go 1.22 patterns (`mux.HandleFunc("POST /draft", …)`); a `guard(next)` middleware; a `writeErr(w, status, code, retryable, desc)` helper; JSON decode with `DisallowUnknownFields()` off (the overlay may add fields) but `Decode` errors → 400 `ERR_SHAPE`.

- [ ] **Step 3: Run tests, verify pass**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go test ./internal/httpapi/ -count=1`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add fuelkeeper/internal/httpapi
git commit -m "feat(fuelkeeper): overlay-facing HTTP API with X-Fuel-Key guard and /health"
```

---

### Task 10: Process wiring (§4.2)

**Files:**
- Modify: `fuelkeeper/cmd/fuelkeeper/main.go`
- Create: `fuelkeeper/cmd/fuelkeeper/wiring.go`, `fuelkeeper/cmd/fuelkeeper/wiring_test.go`

- [ ] **Step 1: Write the failing test for the pure helpers**

```go
func TestKeeperConfigFromEnv(t *testing.T) {
	cfg := config.Config{Denomination: 200, PoolTarget: 100, LowWaterPercent: 60, HighWaterPercent: 100, FanoutOutputsPerTx: 20, FanoutMaxTxsPerRound: 5, PoolBasket: "fuel", ReserveBasket: "reserve", KeeperIntervalSeconds: 30}
	k := keeperConfig(cfg)
	require.Equal(t, uint64(200), k.Denomination)
	require.Equal(t, uint64(100), k.TargetPoolSize)
	require.Equal(t, "fuel", k.PoolBasket)
	require.Equal(t, 30*time.Second, k.Interval)
	require.Equal(t, uint64(1600), k.ChunkFeeHeadroom, "max(1000, 8*D)")
	require.Equal(t, "fuelkeeper", k.Originator)
}

func TestConnectRetry_GivesUpAfterWindow(t *testing.T) {
	calls := 0
	err := retryWithBackoff(context.Background(), 50*time.Millisecond, time.Millisecond, 10*time.Millisecond, func() error { calls++; return errors.New("down") }, nil)
	require.Error(t, err)
	require.Greater(t, calls, 2)
}
```

- [ ] **Step 2: Implement wiring**

`wiring.go`:

```go
func keeperConfig(c config.Config) fuelkeeper.Config {
	headroom := uint64(1000)
	if s := 8 * c.Denomination; s > headroom { headroom = s }
	return fuelkeeper.Config{
		Denomination: c.Denomination, TargetPoolSize: c.PoolTarget,
		LowWaterPercent: c.LowWaterPercent, HighWaterPercent: c.HighWaterPercent,
		FanoutOutputsPerTx: c.FanoutOutputsPerTx, FanoutMaxTxsPerRound: c.FanoutMaxTxsPerRound,
		PoolBasket: c.PoolBasket, ReserveBasket: c.ReserveBasket,
		Interval: time.Duration(c.KeeperIntervalSeconds) * time.Second,
		ChunkFeeHeadroom: headroom, Originator: "fuelkeeper",
	}
}

// retryWithBackoff mirrors go-wallet-toolbox's internal connect helper.
func retryWithBackoff(ctx context.Context, window, initial, max time.Duration, fn func() error, onRetry func(n int, err error, sleep time.Duration)) error { /* exponential backoff, capped, until window elapses or ctx done */ }

func connectWallet(ctx context.Context, cfg config.Config, priv *ec.PrivateKey, logger *slog.Logger) (*wallet.Wallet, *storage.WalletStorageProviderClient, error) {
	var sc *storage.WalletStorageProviderClient
	var w *wallet.Wallet
	err := retryWithBackoff(ctx, 2*time.Minute, 500*time.Millisecond, 10*time.Second, func() error {
		if w != nil { w.Close(); w = nil }
		nw, err := wallet.NewWithStorageFactory(cfg.Network, priv, func(uw sdk.Interface) (wdk.WalletStorageProvider, func(), error) {
			c, cleanup, err := storage.NewClient(cfg.StorageURL, uw)
			if err != nil { return nil, nil, err }
			sc = c
			return c, cleanup, nil
		})
		if err != nil { return err }
		if _, err = nw.Balance(ctx); err != nil { nw.Close(); return err }
		w = nw
		return nil
	}, func(n int, err error, sleep time.Duration) { logger.Warn("storage not ready", "attempt", n, "err", err, "retry_in", sleep) })
	if err != nil { return nil, nil, err }
	return w, sc, nil
}
```

`main.go` `run()`:

1. `cfg := config.Load(os.Getenv)`; `logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))`.
2. `srv, err := infra.NewServer(ctx, infra.WithConfigFile(cfg.StorageConf), infra.WithEnvPrefix("FK_STORAGE"), infra.WithLogger(logger))`; `go func(){ if err := srv.ListenAndServe(ctx); err != nil { logger.Error(...); cancel() } }()`; `defer srv.Cleanup()`.
3. `priv, _ := ec.PrivateKeyFromHex(cfg.IssuerRootKeyHex)`; `w, _, err := connectWallet(...)`; `defer w.Close()`; `kd := sdk.NewKeyDeriver(priv)`.
   **Read-only storage provider (ruling 2026-09-23, Task 6 review):** the toolbox HTTP client's `FindOutputsAuth` is a stub at v0.186.3, so reads come from an in-process provider on the same DB: `scfg := srv.Config` (exported field of `*infra.Server`); `svc := services.New(logger, scfg.Services)`; `reader, err := storage.NewGORMProvider(scfg.BSVNetwork, svc, append(infra.GORMProviderOptionsFromConfig(&scfg), storage.WithLogger(logger))...)`; `u, err := reader.FindOrInsertUser(ctx, kd.IdentityKeyHex())` → `userID := u.User.UserID` (check the response field names in `pkg/wdk`); `src := fuel.NewWalletSource(w, reader, kd, userID, logger)`. Do NOT call `Migrate` on the reader (infra already did). Startup self-check: `ListOutputs(basket=PoolBasket, limit 1)` non-empty but `src.ListProven(ctx, PoolBasket, 1)` empty AND the basket's single output belongs to a completed tx → log Error and exit 1 ("storage reader sees no fuel rows: check DB config/user"). If the wallet option `wallet.WithAutoKnownTxids(false)` exists at v0.186.3 (grep `pkg/wallet/wallet_opts` or `wallet.With` functions), pass it to `NewWithStorageFactory` so basket listings keep full BEEF instead of txid-only entries.
4. `keeper, err := fuelkeeper.New(w, keeperConfig(cfg), logger)`; `go keeper.Run(ctx)`.
5. `st, err := store.Open(cfg.DBDriver, cfg.DBDSN, time.Now)`.
6. `checker`: if `cfg.WoCAPIKey != ""` → `svcCfg := infra.Defaults().Services; svcCfg.Chain = cfg.Network;` set the WhatsOnChain API key field on `svcCfg.WhatsOnChain` (grep `type WhatsOnChain struct` in `pkg/defs/services.go` for the field name and an `Enabled` flag; set both) → `chain.NewServicesChecker(services.New(logger, svcCfg))`; else `chain.Disabled{}` with a startup warning naming `FK_WOC_API_KEY`.
7. `verifier := auth.NewVerifier(time.Now)`; `drafter := draft.New(cfg, st, src, verifier, time.Now)`; `settler := &settle.Settler{...}`; `sw := sweeper.New(...)` with `sweeper.NewHTTPOverlayClient(cfg.OverlayURL, cfg.OverlayAdminToken, &http.Client{Timeout: 10 * time.Second})` (a `nil` overlay client when `FK_OVERLAY_URL` is empty makes rule 4 a no-op with a warning); `go sw.Run(ctx, time.Duration(cfg.SweeperIntervalSeconds)*time.Second)`.
8. `api := &http.Server{Addr: fmt.Sprintf(":%d", cfg.APIPort), Handler: httpapi.New(...), ReadHeaderTimeout: 5 * time.Second}`; serve; on SIGINT/SIGTERM `api.Shutdown` with a 10 s context, then cancel the root ctx.
9. Startup log line: `fuelkeeper: network=… api=:PORT storage=URL db=DRIVER assets=N pool_target=… chain_check=on|off`.

- [ ] **Step 3: Build and run tests**

Run: `cd fuelkeeper && GOTOOLCHAIN=auto go build ./... && GOTOOLCHAIN=auto go vet ./... && GOTOOLCHAIN=auto go test ./... -count=1`
Expected: build OK, vet clean, all PASS.

- [ ] **Step 4: Manual smoke (no network needed for the failure path)**

Run: `cd fuelkeeper && ISSUER_ROOT_KEY=dc745c57de627a6d3a3ca549e0f9fb6b8f779108a1fe6fe290cc4df3461125d6 FK_API_KEY=0123456789abcdef0123456789abcdef FK_NETWORK=test FK_STORAGE_CONFIG=/nonexistent.yaml FUEL_ASSET_IDS= GOTOOLCHAIN=auto go run ./cmd/fuelkeeper; echo exit=$?`
Expected: a clear "failed to load config" error from `infra.NewServer` and a non-zero exit (proves the wiring reaches the storage server construction). Record the output in the report.

- [ ] **Step 5: Commit**

```bash
git add fuelkeeper/cmd
git commit -m "feat(fuelkeeper): process wiring — infra storage, issuer wallet, pool keeper, sweeper, API"
```

---

### Task 11: Docs, spec revision, CI image

**Files:**
- Modify: `docs/design/2026-09-22-mandala-token-fee-design.md` (§13), `runbook.md`, `.github/workflows/docker-publish.yml`

- [ ] **Step 1: Spec §13 — append a "Revision 3 (2026-09-23, P2 implementation)" block** with these lines:
  - Toolchain: fuelKeeper builds against `go-wallet-toolbox v0.186.3` (go 1.27.0, go-sdk v1.5.1) — the published tag, not the local branch the spec's line numbers came from; four `replace` directives (adds `k8s.io/kube-openapi`).
  - §4.4: `fuel_reservations` gains `fuel_beef`, `derivation_prefix`, `derivation_suffix`, `pair_index` (why: re-drafted `released` rows are no longer in the basket; `/settle` needs the fee vout).
  - §4.5: `POST /consume` body is `{ txid, pairs: [{ outpoint, requestId }] }` — the keeper needs the request the overlay matched to enforce "reserved by another request"; a `released, needs_recheck=0` row is consumable only by its last holder's `requestId`.
  - §1.3: `satDeficit(k)` is floored at 0 when `n > m + k`.
  - §4.3 step 1: the keeper also checks the overlay-supplied `issuerIdentityKey` equals its own identity (else `ERR_FUEL_INELIGIBLE`).
  - §4.7 rule 2: `IsUtxo` is provided only by WhatsOnChain in go-wallet-toolbox; without `FK_WOC_API_KEY` the check is disabled and `needs_recheck` rows stay pending (never released) — P5 must provision a key or an alternative checker for tstn.
  - §4.7 rule 4: the "two unspent observations ≥ 10 min apart" memory is in-process; a restart only delays that release.
  - §4.1/§4.2: the toolbox HTTP storage client's `FindOutputsAuth` is a stub at v0.186.3 (no server route), so the keeper reads fuel rows through a read-only in-process `*storage.Provider` built from `infra.Server.Config` on the same DB; wallet operations stay on the HTTP wallet.
  - §4.4: `created_at` is the time of the current claim (re-claims count toward `DailyPairs`/`PairsPerMinute`); `settled_at` is cleared on claim and consume.
  - §4.3 step 2 / §10: quotas are soft under concurrent drafts from one requester (rows are created after the check) — spec-owner follow-up: count recent `fuel_requests` as outstanding.
  - §4.7 rule 2: a requester is denied only when the `released → spent_external` CAS actually matched (a concurrent `/settle` repair wins).
  - §12: P2 marked done with the commit range.
- [ ] **Step 2: runbook.md — add "fuelKeeper local run (P2)"**: env block, minimal infra yaml (sqlite engine, `http.port: 8100`, `fee_model 100`, `utxo_management` throughput with `denomination_satoshis: 200`, `pool_basket: fuel`, `reserve_basket: reserve`, `bsv_network: test`), the `go run` command with `GOTOOLCHAIN=auto`, the curl for `/health`, and the note that the wallet must be funded before the keeper mints.
- [ ] **Step 3: docker-publish.yml** — add `- image: mandala-fuelkeeper, context: fuelkeeper, dockerfile: fuelkeeper/Dockerfile` to the matrix, mirroring the `mandala-overlay-go` entry, and update the header comment.
- [ ] **Step 4: Commit**

```bash
git add docs/design/2026-09-22-mandala-token-fee-design.md runbook.md .github/workflows/docker-publish.yml
git commit -m "docs(fuelkeeper): spec revision 3, runbook local-run section, publish image"
```

---

## Self-review notes

- Spec coverage: §1.1 (Task 7), §1.2 (Tasks 6–7), §1.3 (Task 3), §3.1 codes/verification (Tasks 4, 7, 9), §3.3 release semantics (Tasks 5, 9), §4.1 reuse map (Tasks 6, 10), §4.2 process (Task 10), §4.3 (Task 7), §4.4/§4.5 (Task 5), §4.6 (Task 8), §4.7 (Task 8), §4.8 (Task 9), §12 P2 Dockerfile (Task 1), parity vectors (Task 2), go-sdk verification test (Task 7). Not in P2 by design: the overlay-side recognizer and routes (P3).
- Type consistency: `store.Candidate` fields are what `draft.reserve` fills from `fuel.Row`; `store.CommitPair` matches the drafter's commit; `draft.Refusal` is what `httpapi` maps; `fuel.Source` is shared by draft, settle, sweeper, api.
- Known deviation from the spec text, all recorded in Task 11: extra columns, consume body shape, deficit floor, issuer-key check, IsUtxo availability.
