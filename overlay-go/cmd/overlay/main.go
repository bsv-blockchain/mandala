// Command overlay is the mandala overlay-go server entrypoint. It mirrors
// overlay/src/index.ts's env surface (Global Constraints,
// docs/superpowers/plans/2026-07-07-go-overlay-port.md): read config from
// the environment, fail fast naming any missing required var, wire the
// engine via wiring.Build, build the Fiber app via httpapi.New, and serve
// it on :8080 with graceful shutdown on SIGINT/SIGTERM.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/httpapi"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

// shutdownTimeout bounds how long graceful shutdown waits for in-flight
// requests to finish before forcing the listener closed.
const shutdownTimeout = 10 * time.Second

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

	// A13: an unset ADMIN_API_TOKEN is a supported dev default — the
	// identity-bearing admin routes stay open — but it must be loud, hence
	// this one startup warning rather than a silent fallback. Logged here
	// (once, regardless of how many requests follow), not in httpapi's
	// per-request middleware.
	if cfg.AdminAPIToken == "" {
		log.Print("mandala overlay-go: ADMIN_API_TOKEN is not set — /admin/registry, /admin/activity and /admin/admission/:txid are UNAUTHENTICATED. Set ADMIN_API_TOKEN before any public demo.")
	}

	// FIX E: with Arcade on but no callback token, httpapi.New refuses to
	// mount /arc-ingest (eviction restores inputs and voids σ_I, so the route
	// must never be open). Say so once at boot, where an operator will see it,
	// rather than leaving them to discover a 404 from Arcade's callbacks.
	if cfg.ArcadeURL != "" && cfg.ArcadeCallbackToken == "" {
		log.Print("mandala overlay-go: ARCADE_CALLBACK_TOKEN is not set — /arc-ingest will NOT be mounted, so merkle proofs and terminal transaction statuses from Arcade are ignored. Set ARCADE_CALLBACK_TOKEN.")
	}

	app, err := wiring.Build(context.Background(), cfg)
	if err != nil {
		return fmt.Errorf("wiring.Build: %w", err)
	}

	arcadeState := "off"
	if app.ArcadeEnabled {
		arcadeState = "on"
	}
	log.Printf(
		"mandala overlay-go: node=%s network=%s arcade=%s mongo_db=%s",
		cfg.NodeName, cfg.Network, arcadeState, app.Mongo.Name(),
	)

	fiberApp := httpapi.New(app)

	serverErr := make(chan error, 1)
	go func() {
		if err := fiberApp.Listen(":8080"); err != nil {
			serverErr <- err
		}
		close(serverErr)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err, ok := <-serverErr:
		if ok && err != nil {
			return fmt.Errorf("listen: %w", err)
		}
		return nil
	case sig := <-sigCh:
		log.Printf("mandala overlay-go: received %s, shutting down", sig)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := fiberApp.ShutdownWithContext(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := app.Mongo.Client().Disconnect(shutdownCtx); err != nil {
		return fmt.Errorf("mongo disconnect: %w", err)
	}
	return nil
}

// envLookup is os.Getenv's shape — a seam so loadConfig's required/optional
// var handling can be exercised without mutating process env (not currently
// tested; kept narrow in case Task-adjacent work adds coverage later).
type envLookup func(string) string

// requireEnv reads a required environment variable, mirroring
// overlay/src/index.ts's requireEnv: fail fast, naming the missing var.
func requireEnv(getenv envLookup, name string) (string, error) {
	v := getenv(name)
	if v == "" {
		return "", fmt.Errorf("missing required environment variable: %s", name)
	}
	return v, nil
}

// loadConfig builds a wiring.Config from the environment. Required:
// NODE_NAME, SERVER_PRIVATE_KEY, HOSTING_URL, MONGO_URL, NETWORK (must be
// "main" or "test", matching overlay/src/index.ts's check). Optional:
// ARCADE_URL, ARCADE_API_KEY, ARCADE_CALLBACK_TOKEN, CHAINTRACKS_URL,
// CHAINTRACKS_API_PREFIX — wiring.Build applies their TS-parity defaults
// itself when unset.
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

	cfg.ArcadeURL = getenv("ARCADE_URL")
	cfg.ArcadeAPIKey = getenv("ARCADE_API_KEY")
	cfg.ArcadeCallbackToken = getenv("ARCADE_CALLBACK_TOKEN")
	cfg.ChaintracksURL = getenv("CHAINTRACKS_URL")
	cfg.ChaintracksPrefix = getenv("CHAINTRACKS_API_PREFIX")

	// A13: ADMIN_API_TOKEN gates the identity-bearing admin routes;
	// ADMIN_CORS_ORIGINS narrows their CORS. Resolution (the TS-parity
	// default of HOSTING_URL's origin + the two local dev origins) lives in
	// httpapi.ParseAdminCORSOrigins so it's tested once, in httpapi, rather
	// than duplicated here.
	cfg.AdminAPIToken = getenv("ADMIN_API_TOKEN")
	cfg.AdminCORSOrigins = httpapi.ParseAdminCORSOrigins(getenv("ADMIN_CORS_ORIGINS"), cfg.HostingURL)

	return cfg, nil
}
