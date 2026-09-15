// Package httpapi is the HTTP entry point the unchanged TS frontend talks
// to: a Fiber app exposing POST /submit, POST /lookup, the five bespoke
// /admin/* read endpoints (including /admin/activity, Task 17), and
// /health* — all mounted on the same constructor so the global middleware
// (CORS, body limit, 404 fallback) applies uniformly.
package httpapi

import (
	"context"
	"log"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

// bodyLimit mirrors the TS overlay's express.raw({limit: '1gb'}) body cap
// (Appendix B §4).
const bodyLimit = 1 << 30

// Lookuper is the narrow slice of *engine.Engine that POST /lookup depends
// on (signature per overlay-go/README.md "Pinned API notes" —
// engine.Lookup). *engine.Engine satisfies it; tests substitute a stub so
// they never need Mongo or real lookup services.
type Lookuper interface {
	Lookup(ctx context.Context, question *lookup.LookupQuestion) (*lookup.LookupAnswer, error)
}

var _ Lookuper = (*engine.Engine)(nil)

// New builds the production Fiber app from a fully wired App (Mongo, the
// engine, topic/lookup services already constructed by wiring.Build).
// /arc-ingest is mounted only when Task 16's Arcade wiring set
// app.ArcadeEnabled (WithArcade below) AND a non-empty Arcade callback token
// is configured. /admin/activity (Task 17) is always mounted — app.Store and
// app.FindRawTxs are unconditionally wired regardless of Arcade.
func New(app *wiring.App) *fiber.App {
	opts := []ServerOption{
		WithActivity(app.Store, app.FindRawTxs),
		WithOutputBeef(app.OutputBeef),
		WithAdminAPIToken(app.AdminAPIToken),
		WithAdminCORSOrigins(app.AdminCORSOrigins),
		WithAdmissionStore(app.Store, app.AppliedAdmissionProof),
	}
	if app.ServerPrivKeyHex != "" {
		if s, err := NewECAdmissionSigner(app.ServerPrivKeyHex); err == nil {
			opts = append(opts, WithAdmissionSigner(s))
		}
	}
	if app.ArcadeEnabled {
		opts = append(opts,
			WithArcade(app.Engine, app.ArcadeCallbackToken, app.EvictTx),
			WithBroadcastCompensation(app.PrepareSubmitCompensation))
	}
	return newServer(app.Engine, app.Engine, app.Store, func(ctx context.Context) error {
		return app.Mongo.Client().Ping(ctx, nil)
	}, opts...)
}

// serverOptions carries newServer's optional seams — Arcade's /arc-ingest
// route with its terminal-status eviction hook (Tasks 16/18) and the
// submit broadcast-failure compensation seam (Task 18). A struct (rather
// than more positional params) keeps every pre-Task-16 newServer call site
// source-compatible.
type serverOptions struct {
	arcadeEnabled       bool
	merkleHandler       MerkleProofHandler
	arcCallbackToken    string
	evictTx             EvictTx
	prepareCompensation PrepareSubmitCompensation
	activityLinkage     ActivityLinkage
	activityFindRawTxs  FindRawTxsFunc
	admissionSigner     AdmissionSigner
	admissionRecorder   AdmissionRecorder
	appliedProof        AppliedAdmissionProof
	outputBeef          OutputBeefFunc
	adminAPIToken       string
	adminCORSOrigins    []string
}

// WithOutputBeef backs the /admin/registry/beef and /admin/asset-auth/beef
// recovery routes (A10/A17) with the engine store's per-output BEEF. Without
// it those routes answer 500 {error: "engine store unavailable"}; New(app)
// always supplies it in production.
func WithOutputBeef(beef OutputBeefFunc) ServerOption {
	return func(o *serverOptions) { o.outputBeef = beef }
}

// ServerOption customizes newServer without changing its required
// parameters (mirrors wiring.Option's shape/rationale).
type ServerOption func(*serverOptions)

// WithArcade mounts POST /arc-ingest, delegating merkle-proof ingestion to
// handler and gating every request behind callbackToken. An EMPTY token does
// not mean "no token check" any more (FIX E): the route is not mounted at
// all, newServer logs an error, and the rest of the node starts normally.
// evict handles terminal txStatus callbacks (nil degrades to log-only).
func WithArcade(handler MerkleProofHandler, callbackToken string, evict EvictTx) ServerOption {
	return func(o *serverOptions) {
		o.arcadeEnabled = true
		o.merkleHandler = handler
		o.arcCallbackToken = callbackToken
		o.evictTx = evict
	}
}

// WithBroadcastCompensation threads the pre-Submit snapshot / post-failure
// compensation closure into POST /submit (see PrepareSubmitCompensation).
func WithBroadcastCompensation(prepare PrepareSubmitCompensation) ServerOption {
	return func(o *serverOptions) {
		o.prepareCompensation = prepare
	}
}

// WithActivity mounts GET /admin/activity (Task 17), reading linkage rows
// through linkage and raw tx hex through findRawTxs. Kept as an option
// rather than a required newServer parameter so the package's many existing
// stub-based tests don't all need updating; New(app) always supplies it in
// production.
func WithAdmissionSigner(s AdmissionSigner) ServerOption {
	return func(o *serverOptions) { o.admissionSigner = s }
}

// WithAdmissionStore wires the σ_I / verdict persistence (wire contract §4)
// and FIX C's applied-transaction proof into POST /submit and
// GET /admin/admission/:txid. Without it /submit still admits and signs, but
// nothing is persisted and the admission endpoint answers 404 for every
// txid; New(app) always supplies both in production.
func WithAdmissionStore(rec AdmissionRecorder, proof AppliedAdmissionProof) ServerOption {
	return func(o *serverOptions) {
		o.admissionRecorder = rec
		o.appliedProof = proof
	}
}

func WithActivity(linkage ActivityLinkage, findRawTxs FindRawTxsFunc) ServerOption {
	return func(o *serverOptions) {
		o.activityLinkage = linkage
		o.activityFindRawTxs = findRawTxs
	}
}

// WithAdminAPIToken gates the identity-bearing admin routes (/admin/registry,
// /admin/activity, /admin/admission/:txid — A13) behind a bearer token via
// AdminAuthMiddleware (admin_auth.go). An empty token — the zero value, and
// what New(app) passes when ADMIN_API_TOKEN is unset — leaves those routes
// open; logging the one startup warning for that case is cmd/overlay/main.go's
// job, not this package's, since it must happen once regardless of how many
// requests follow.
func WithAdminAPIToken(token string) ServerOption {
	return func(o *serverOptions) { o.adminAPIToken = token }
}

// WithAdminCORSOrigins sets the allowed console origins for the gated admin
// routes (admin_auth.go's adminGatedPath), replacing the public routes'
// wildcard CORS for those paths only (see corsMiddleware below). A nil/empty
// slice means no origin is ever allowed for those routes; New(app) always
// resolves a non-empty list via ParseAdminCORSOrigins before this is called.
func WithAdminCORSOrigins(origins []string) ServerOption {
	return func(o *serverOptions) { o.adminCORSOrigins = origins }
}

// newServer assembles the Fiber app from narrow per-route interfaces
// (Submitter, Lookuper, AdminStore, Pinger) so tests can stub dependencies
// without a wiring.App or a live Mongo connection. The global middleware
// wraps whatever routes are registered.
func newServer(submitter Submitter, lookuper Lookuper, store AdminStore, ping Pinger, opts ...ServerOption) *fiber.App {
	var o serverOptions
	for _, opt := range opts {
		opt(&o)
	}

	f := fiber.New(fiber.Config{
		BodyLimit: bodyLimit,
	})

	f.Use(corsMiddleware(o.adminCORSOrigins))

	registerSubmitRoutes(f, submitter, o.prepareCompensation, o.admissionSigner, o.admissionRecorder, o.appliedProof)
	registerLookupRoutes(f, lookuper)
	registerAdminRoutes(f, store, o.outputBeef, o.adminAPIToken)
	registerAdmissionRoute(f, o.admissionRecorder, o.appliedProof, o.admissionSigner, o.adminAPIToken)
	registerHealthRoutes(f, ping)
	if o.activityLinkage != nil {
		registerActivityRoute(f, o.activityLinkage, o.activityFindRawTxs, o.adminAPIToken)
	}
	if o.arcadeEnabled {
		// FIX E, second half: an unauthenticated /arc-ingest lets anyone POST a
		// terminal txStatus and trigger an eviction — which now restores the
		// transaction's inputs and voids its σ_I permanently. Refuse to mount
		// the route at all without a callback token; the node keeps serving
		// everything else, so a misconfiguration degrades to "no proof
		// ingestion" instead of "anyone can evict".
		if o.arcCallbackToken == "" {
			log.Printf("arc-ingest: NOT mounted — ARCADE_CALLBACK_TOKEN is empty; merkle-proof ingestion and terminal-status eviction are disabled until it is set")
		} else {
			registerArcIngestRoutes(f, o.merkleHandler, o.arcCallbackToken, o.evictTx)
		}
	}

	// Registered last: Fiber falls through to this catch-all only when no
	// earlier route matched the method+path, giving the TS-shaped 404 body
	// instead of Fiber's default plain-text response (Appendix B §4).
	f.Use(notFoundMiddleware)

	return f
}

// corsMiddleware sets wildcard CORS headers on every response and
// short-circuits OPTIONS preflight requests with 200 (Appendix B §4) — the
// browser's custom-header preflight (X-Topics, x-includes-off-chain-values,
// X-Aggregation) fails without this — EXCEPT on the identity-bearing admin
// routes (adminGatedPath, A13), which get narrowed CORS instead: only an
// Origin in adminOrigins is echoed back (with Vary: Origin), Authorization is
// explicitly listed so the browser will send it on the real request, and
// Access-Control-Allow-Private-Network is omitted — that header stays a
// public-routes-only signal.
func corsMiddleware(adminOrigins []string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if adminGatedPath(c.Path()) {
			if origin := c.Get(fiber.HeaderOrigin); origin != "" && containsOrigin(adminOrigins, origin) {
				c.Set("Access-Control-Allow-Origin", origin)
				c.Set("Vary", "Origin")
			}
			c.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			c.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			if c.Method() == fiber.MethodOptions {
				return c.SendStatus(fiber.StatusOK)
			}
			return c.Next()
		}

		c.Set("Access-Control-Allow-Origin", "*")
		c.Set("Access-Control-Allow-Headers", "*")
		c.Set("Access-Control-Allow-Methods", "*")
		c.Set("Access-Control-Expose-Headers", "*")
		c.Set("Access-Control-Allow-Private-Network", "true")

		if c.Method() == fiber.MethodOptions {
			return c.SendStatus(fiber.StatusOK)
		}
		return c.Next()
	}
}

// notFoundMiddleware answers any request no earlier route matched with the
// TS overlay's exact 404 shape (Appendix B §4).
func notFoundMiddleware(c *fiber.Ctx) error {
	return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
		"status":      "error",
		"code":        "ERR_ROUTE_NOT_FOUND",
		"description": "Route not found.",
	})
}
