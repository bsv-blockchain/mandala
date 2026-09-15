package httpapi

// Task 17: GET /admin/activity (Appendix B §3e), the overlay-wide
// transaction activity feed. The heavy lifting (grouping, pagination,
// classification) lives in internal/activity — this file is purely the
// Fiber route glue: query-param parsing and the wire response.

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/activity"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// ActivityLinkage is the narrow slice of *mandala.Store the /admin/activity
// route depends on. *mandala.Store satisfies it (it already exposes both
// methods for the mandala lookup service); tests substitute an in-memory
// fake so they never need Mongo.
type ActivityLinkage interface {
	ListLinkage(ctx context.Context, limit int64, before *time.Time) ([]mandala.LinkageRow, error)
	FindLinkageByOutpoints(ctx context.Context, outpoints []mandala.Outpoint) ([]mandala.LinkageRow, error)
}

var _ ActivityLinkage = (*mandala.Store)(nil)

// FindRawTxsFunc is activity.Deps.FindRawTxs's function type, named here so
// WithActivity's signature doesn't need to import internal/activity's Deps
// struct just to reference one field. wiring.App.FindRawTxs satisfies it.
type FindRawTxsFunc func(ctx context.Context, txids []string) (map[string]string, error)

// registerActivityRoute mounts GET /admin/activity behind adminToken (A13).
// Unlike the four routes in admin.go, this one is wired through a
// ServerOption (WithActivity) — see server.go — rather than being an
// unconditional registerAdminRoutes call, purely so the ~40 existing
// newServer(...) call sites elsewhere in this package's tests don't all need
// a new required parameter; New(app) always supplies WithActivity in
// production, so the route is unconditional there too.
func registerActivityRoute(f *fiber.App, linkage ActivityLinkage, findRawTxs FindRawTxsFunc, adminToken string) {
	f.Get("/admin/activity", AdminAuthMiddleware(adminToken), activityHandler(linkage, findRawTxs))
}

func activityHandler(linkage ActivityLinkage, findRawTxs FindRawTxsFunc) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if linkage == nil || findRawTxs == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}

		var before *time.Time
		if raw := c.Query("before"); raw != "" {
			t, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
					"error": "invalid before: must be an RFC3339 timestamp",
				})
			}
			before = &t
		}

		page, err := activity.Build(c.UserContext(), activity.Deps{
			ListLinkage:            linkage.ListLinkage,
			FindLinkageByOutpoints: linkage.FindLinkageByOutpoints,
			FindRawTxs:             findRawTxs,
		}, activity.Opts{
			AssetID: c.Query("assetId"),
			Limit:   queryInt64(c, "limit"),
			Before:  before,
		})
		if err != nil {
			return adminErrorResponse(c, err)
		}
		return c.Status(fiber.StatusOK).JSON(page)
	}
}
