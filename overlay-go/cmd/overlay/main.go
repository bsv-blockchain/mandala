// Command overlay is the mandala overlay-go server entrypoint: BRC-162 Mandala tokens laid out as token topics on
// one overlay. It reads config from the environment and fails fast on any bad variable, assembles the engine with
// wiring.Build, runs the boot (App.Start: the token-topic boot union, then the owner-index boot run) before it
// listens, builds the Fiber app with httpapi.New and serves it on $PORT (default 8080), shutting down gracefully on
// SIGINT/SIGTERM.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"

	"github.com/sirdeggen/mandala/overlay-go/internal/httpapi"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

// shutdownTimeout bounds how long graceful shutdown waits for in-flight requests.
const shutdownTimeout = 10 * time.Second

// defaultPort keeps the historical :8080 when PORT is unset (V-8).
const defaultPort = "8080"

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	port, err := parsePort(os.Getenv("PORT"))
	if err != nil {
		return err
	}

	// A13: an unset ADMIN_API_TOKEN is a supported dev default (the identity-bearing admin routes stay open), but it
	// must be loud: one startup warning, not a per-request log.
	if cfg.AdminAPIToken == "" {
		log.Print("mandala overlay-go: ADMIN_API_TOKEN is not set — /admin/registry, /admin/activity and /admin/admission/:txid are UNAUTHENTICATED. Set ADMIN_API_TOKEN before any public demo.")
	}
	// FIX E: with Arcade on but no callback token, httpapi.New refuses to mount /arc-ingest. Say so once at boot.
	if cfg.ArcadeURL != "" && cfg.ArcadeCallbackToken == "" {
		log.Print("mandala overlay-go: ARCADE_CALLBACK_TOKEN is not set — /arc-ingest will NOT be mounted, so merkle proofs and terminal transaction statuses from Arcade are ignored. Set ARCADE_CALLBACK_TOKEN.")
	}

	app, err := wiring.Build(context.Background(), cfg)
	if err != nil {
		return fmt.Errorf("wiring.Build: %w", err)
	}
	// stop releases what Build and Start acquired (the owner-index timer, the Mongo client). Every exit path after
	// Build calls it exactly once.
	stop := func(ctx context.Context) error {
		app.Close()
		return app.Mongo.Client().Disconnect(ctx)
	}

	// The boot, before the listener exists: a Mongo read fault in the boot union fails here instead of answering
	// unknown-topic for every token (Review Focus 4), and the first submit meets a reconciled owner index.
	if err := app.Start(context.Background()); err != nil {
		_ = stop(context.Background())
		return fmt.Errorf("boot: %w", err)
	}

	arcadeState := "off"
	if app.ArcadeEnabled {
		arcadeState = "on"
	}
	// wiring.Build already parsed SERVER_PRIVATE_KEY, so this cannot fail. The identity key is what the app's
	// VITE_OVERLAY_IDENTITY_KEY must hold.
	priv, err := ec.PrivateKeyFromHex(cfg.ServerPrivKeyHex)
	if err != nil {
		_ = stop(context.Background())
		return fmt.Errorf("SERVER_PRIVATE_KEY: %w", err)
	}
	log.Printf(
		"mandala overlay-go: node=%s network=%s arcade=%s mongo_db=%s identity=%s tokens=%d port=%s",
		cfg.NodeName, cfg.Network, arcadeState, app.Mongo.Name(), priv.PubKey().ToDERHex(), len(app.Tokens.Registered()), port,
	)

	fiberApp := httpapi.New(app)

	serverErr := make(chan error, 1)
	go func() {
		if err := fiberApp.Listen(":" + port); err != nil {
			serverErr <- err
		}
		close(serverErr)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err, ok := <-serverErr:
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		_ = stop(ctx)
		if ok && err != nil {
			return fmt.Errorf("listen: %w", err)
		}
		return nil
	case sig := <-sigCh:
		log.Printf("mandala overlay-go: received %s, shutting down", sig)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	shutdownErr := fiberApp.ShutdownWithContext(shutdownCtx)
	if err := stop(shutdownCtx); err != nil && shutdownErr == nil {
		return fmt.Errorf("mongo disconnect: %w", err)
	}
	if shutdownErr != nil {
		return fmt.Errorf("shutdown: %w", shutdownErr)
	}
	return nil
}

// envLookup is os.Getenv's shape: the seam that lets tests exercise loadConfig without the process environment.
type envLookup func(string) string

// requireEnv reads a required variable, failing fast by name.
func requireEnv(getenv envLookup, name string) (string, error) {
	v := getenv(name)
	if v == "" {
		return "", fmt.Errorf("missing required environment variable: %s", name)
	}
	return v, nil
}

// loadConfig builds a wiring.Config from the environment. Order: the required NODE_NAME, SERVER_PRIVATE_KEY,
// HOSTING_URL, MONGO_URL, NETWORK (first missing wins), the NETWORK value, MANDALA_ISSUER_KEYS (required; TS
// parseIssuerKeys errors byte for byte), MANDALA_TOKEN_ALLOWLIST (optional; unset or blank follows every token,
// [] hosts none), then the optional Arcade, Chaintracks and admin variables (wiring.Build applies their defaults).
func loadConfig(getenv envLookup) (wiring.Config, error) {
	var cfg wiring.Config

	required := []struct {
		name string
		dst  *string
	}{
		{"NODE_NAME", &cfg.NodeName},
		{"SERVER_PRIVATE_KEY", &cfg.ServerPrivKeyHex},
		{"HOSTING_URL", &cfg.HostingURL},
		{"MONGO_URL", &cfg.MongoURL},
		{"NETWORK", &cfg.Network},
	}
	for _, r := range required {
		v, err := requireEnv(getenv, r.name)
		if err != nil {
			return wiring.Config{}, err
		}
		*r.dst = v
	}
	if cfg.Network != "main" && cfg.Network != "test" {
		return wiring.Config{}, fmt.Errorf(`NETWORK must be "main" or "test", got %q`, cfg.Network)
	}

	keys, err := wiring.ParseIssuerKeys(getenv("MANDALA_ISSUER_KEYS"))
	if err != nil {
		return wiring.Config{}, err
	}
	cfg.IssuerKeys = keys
	allow, allowSet, err := wiring.ParseTokenAllowlist(getenv("MANDALA_TOKEN_ALLOWLIST"))
	if err != nil {
		return wiring.Config{}, err
	}
	cfg.TokenAllowlist, cfg.TokenAllowlistSet = allow, allowSet

	cfg.ArcadeURL = getenv("ARCADE_URL")
	cfg.ArcadeAPIKey = getenv("ARCADE_API_KEY")
	cfg.ArcadeCallbackToken = getenv("ARCADE_CALLBACK_TOKEN")
	cfg.ChaintracksURL = getenv("CHAINTRACKS_URL")
	cfg.ChaintracksPrefix = getenv("CHAINTRACKS_API_PREFIX")

	// A13: ADMIN_API_TOKEN gates the identity-bearing admin routes; ADMIN_CORS_ORIGINS narrows their CORS
	// (resolution lives in httpapi.ParseAdminCORSOrigins).
	cfg.AdminAPIToken = getenv("ADMIN_API_TOKEN")
	cfg.AdminCORSOrigins = httpapi.ParseAdminCORSOrigins(getenv("ADMIN_CORS_ORIGINS"), cfg.HostingURL)

	return cfg, nil
}

// portPattern admits a decimal port with no sign, spaces or leading zeros, so the accepted string is canonical.
var portPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)

// parsePort reads PORT (V-8): blank -> 8080; a canonical integer 1..65535 is returned unchanged; anything else is a
// boot error. The live Q3 boot runs beside the TS P2 overlay on 8080, on another port (8081 when free).
func parsePort(raw string) (string, error) {
	if raw == "" {
		return defaultPort, nil
	}
	if portPattern.MatchString(raw) {
		if n, err := strconv.Atoi(raw); err == nil && n <= 65535 {
			return raw, nil
		}
	}
	return "", fmt.Errorf("PORT must be an integer from 1 to 65535, got %q", raw)
}
