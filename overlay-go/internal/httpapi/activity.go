package httpapi

// GET /admin/activity (Appendix B §3e) on BRC-162: the overlay-wide activity feed. The grouping, paging and
// classification live in internal/activity; this file is the route glue. Gated by ADMIN_API_TOKEN (adminGatedPath).

import (
	"context"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/activity"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// ActivityLinkage is the slice of *mandala.Store the route reads.
type ActivityLinkage interface {
	ListLinkage(ctx context.Context, limit int64, before *time.Time) ([]mandala.LinkageRecord, error)
	FindLinkageByOutpoints(ctx context.Context, ops []mandala.Outpoint) ([]mandala.LinkageRecord, error)
}

var _ ActivityLinkage = (*mandala.Store)(nil)

// FindRawTxsFunc is activity.Deps.FindRawTxs; wiring.App.FindRawTxs satisfies it.
type FindRawTxsFunc func(ctx context.Context, txids []string) (map[string]string, error)

// WithActivity mounts GET /admin/activity. New(app) always supplies it.
func WithActivity(linkage ActivityLinkage, findRawTxs FindRawTxsFunc) ServerOption {
	return func(o *serverOptions) {
		o.activityLinkage = linkage
		o.activityFindRawTxs = findRawTxs
	}
}

func registerActivityRoute(f *fiber.App, linkage ActivityLinkage, findRawTxs FindRawTxsFunc, adminToken string) {
	f.Get("/admin/activity", AdminAuthMiddleware(adminToken), activityHandler(linkage, findRawTxs))
}

func activityHandler(linkage ActivityLinkage, findRawTxs FindRawTxsFunc) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if linkage == nil || findRawTxs == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		// TS: a present ?tokenId= (even empty) must be a canonical token id.
		tokenID := ""
		if c.Context().QueryArgs().Has("tokenId") {
			tokenID = c.Query("tokenId")
			if !mandala.IsTokenID(tokenID) {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid tokenId"})
			}
		}
		var before *time.Time
		if raw := c.Query("before"); raw != "" {
			t, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid before: must be an RFC3339 timestamp"})
			}
			before = &t
		}
		page, err := activity.Build(c.UserContext(), activity.Deps{
			ListLinkage:            linkage.ListLinkage,
			FindLinkageByOutpoints: linkage.FindLinkageByOutpoints,
			FindRawTxs:             findRawTxs,
		}, activity.Opts{TokenID: tokenID, Limit: activityLimitParam(c), Before: before})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusOK).JSON(page)
	}
}

// activityLimitParam: absent or junk -> 0, which activity.Build maps to its 100 default.
func activityLimitParam(c *fiber.Ctx) int64 {
	n, err := strconv.ParseInt(c.Query("limit"), 10, 64)
	if err != nil {
		return 0
	}
	return n
}
