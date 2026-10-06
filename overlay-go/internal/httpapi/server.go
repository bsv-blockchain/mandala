// Package httpapi is the HTTP entry point: POST /submit, POST /lookup, the admin read routes, /health* and the Arcade
// callback, all on one Fiber app so the global middleware (CORS, body limit, 404 fallback) applies uniformly.
package httpapi

import (
	"context"
	"log"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

// bodyLimit mirrors the TS overlay's express.raw({limit: '1gb'}).
const bodyLimit = 1 << 30

// Lookuper is the slice of *engine.Engine POST /lookup needs.
type Lookuper interface {
	Lookup(ctx context.Context, question *lookup.LookupQuestion) (*lookup.LookupAnswer, error)
}

var _ Lookuper = (*engine.Engine)(nil)

// New builds the production Fiber app from a wired App. The compensation seam is always applied (its snapshot is what
// the admission record keeps); /arc-ingest is mounted only with Arcade and a callback token.
func New(app *wiring.App) *fiber.App {
	opts := []ServerOption{
		WithOutputBeefWhere(app.OutputBeefWhere),
		WithAdminAPIToken(app.AdminAPIToken),
		WithAdminCORSOrigins(app.AdminCORSOrigins),
		WithAdmissionStore(app.Store, app.AppliedAdmissionProof),
		WithBroadcastCompensation(app.PrepareSubmitCompensation),
	}
	if app.ServerPrivKeyHex != "" {
		if s, err := mandala.NewECAdmissionSigner(app.ServerPrivKeyHex); err == nil {
			opts = append(opts, WithAdmissionSigner(s))
		} else {
			log.Printf("httpapi: admission signer unavailable, admitted submits will carry no σI: %v", err)
		}
	}
	if app.OwnerIndex != nil {
		opts = append(opts, WithReadiness(app.OwnerIndex.Readiness))
	}
	if app.ArcadeEnabled {
		var evict EvictTx
		if app.EvictTx != nil {
			evict = app.EvictTx
		}
		opts = append(opts, WithArcade(app.Engine, app.ArcadeCallbackToken, evict))
	}
	return newServer(app.Engine, app.Engine, app.Store, func(ctx context.Context) error {
		return app.Mongo.Client().Ping(ctx, nil)
	}, opts...)
}

// serverOptions carries newServer's optional seams.
type serverOptions struct {
	arcadeEnabled       bool
	merkleHandler       MerkleProofHandler
	arcCallbackToken    string
	evictTx             EvictTx
	prepareCompensation PrepareSubmitCompensation
	admissionSigner     mandala.AdmissionSigner
	admissionRecorder   AdmissionRecorder
	appliedProof        AppliedAdmissionProof
	outputBeefWhere     OutputBeefWhereFunc
	adminAPIToken       string
	adminCORSOrigins    []string
	readiness           Readiness
}

// ServerOption customizes newServer without changing its required parameters.
type ServerOption func(*serverOptions)

// WithOutputBeefWhere backs the BEEF recovery routes with the engine store's per-output BEEF, filtered by topic.
func WithOutputBeefWhere(f OutputBeefWhereFunc) ServerOption {
	return func(o *serverOptions) { o.outputBeefWhere = f }
}

// WithArcade mounts POST /arc-ingest (only with a non-empty callback token).
func WithArcade(handler MerkleProofHandler, callbackToken string, evict EvictTx) ServerOption {
	return func(o *serverOptions) {
		o.arcadeEnabled = true
		o.merkleHandler = handler
		o.arcCallbackToken = callbackToken
		o.evictTx = evict
	}
}

// WithBroadcastCompensation threads the pre-Submit snapshot / broadcast-failure compensation into POST /submit.
func WithBroadcastCompensation(prepare PrepareSubmitCompensation) ServerOption {
	return func(o *serverOptions) { o.prepareCompensation = prepare }
}

// WithAdmissionSigner signs σI (digest v3, per topic) on admitted submits and the admission route.
func WithAdmissionSigner(s mandala.AdmissionSigner) ServerOption {
	return func(o *serverOptions) { o.admissionSigner = s }
}

// WithAdmissionStore wires the admission record and the engine's applied proof into /submit and the admission route.
func WithAdmissionStore(rec AdmissionRecorder, proof AppliedAdmissionProof) ServerOption {
	return func(o *serverOptions) {
		o.admissionRecorder = rec
		o.appliedProof = proof
	}
}

// WithAdminAPIToken gates the identity-bearing admin routes behind a bearer token (empty = open).
func WithAdminAPIToken(token string) ServerOption {
	return func(o *serverOptions) { o.adminAPIToken = token }
}

// WithAdminCORSOrigins sets the allowed console origins for the gated admin routes.
func WithAdminCORSOrigins(origins []string) ServerOption {
	return func(o *serverOptions) { o.adminCORSOrigins = origins }
}

// newServer assembles the Fiber app from narrow interfaces so tests can stub every dependency.
func newServer(submitter Submitter, lookuper Lookuper, store AdminStore, ping Pinger, opts ...ServerOption) *fiber.App {
	var o serverOptions
	for _, opt := range opts {
		opt(&o)
	}

	f := fiber.New(fiber.Config{BodyLimit: bodyLimit})
	f.Use(corsMiddleware(o.adminCORSOrigins))

	registerSubmitRoutes(f, submitDeps{
		submitter: submitter,
		prepare:   o.prepareCompensation,
		signer:    o.admissionSigner,
		recorder:  o.admissionRecorder,
		proof:     o.appliedProof,
	})
	registerLookupRoutes(f, lookuper)
	registerAdminRoutes(f, store, o.outputBeefWhere, o.adminAPIToken)
	registerAdmissionRoute(f, o.admissionRecorder, o.appliedProof, o.admissionSigner, o.adminAPIToken)
	registerHealthRoutes(f, ping, o.readiness)
	if o.arcadeEnabled {
		// An unauthenticated /arc-ingest would let anyone trigger an eviction: refuse to mount it without a token.
		if o.arcCallbackToken == "" {
			log.Printf("arc-ingest: NOT mounted — ARCADE_CALLBACK_TOKEN is empty; merkle-proof ingestion and terminal-status eviction are disabled until it is set")
		} else {
			registerArcIngestRoutes(f, o.merkleHandler, o.arcCallbackToken, o.evictTx)
		}
	}
	f.Use(notFoundMiddleware)
	return f
}

// corsMiddleware sets wildcard CORS on every response and answers OPTIONS with 200, except on the identity-bearing
// admin routes (adminGatedPath), which get narrowed CORS: only an allowed Origin is echoed (with Vary: Origin),
// Authorization is listed, and Access-Control-Allow-Private-Network is omitted.
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

// notFoundMiddleware answers any unmatched request with the TS overlay's exact 404 shape.
func notFoundMiddleware(c *fiber.Ctx) error {
	return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
		"status":      "error",
		"code":        "ERR_ROUTE_NOT_FOUND",
		"description": "Route not found.",
	})
}
