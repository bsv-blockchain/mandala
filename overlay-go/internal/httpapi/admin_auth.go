package httpapi

// A13 — bearer auth + narrowed CORS for the identity-bearing admin routes:
// GET /admin/registry, GET /admin/activity, and A12's
// GET /admin/admission/:txid (not yet ported to this backend — see
// adminGatedPath). Every other /admin/* route (asset-state*, admin-history*,
// admin-summary*, asset-auth*, registry/beef/*) is the public audit surface
// R29 wants and keeps the wildcard CORS in server.go's corsMiddleware with
// no auth — recovery must keep working without a console token.
//
// Wire shapes (401 body, header names) mirror overlay/src/adminAuth.ts
// exactly, so both backends behave identically to the console.

import (
	"net/url"
	"strings"

	"github.com/gofiber/fiber/v2"
)

const bearerPrefix = "Bearer "

// ParseBearerToken extracts the token from an `Authorization: Bearer
// <token>` header value. ok is false for any other shape (missing scheme,
// empty token).
func ParseBearerToken(header string) (token string, ok bool) {
	if !strings.HasPrefix(header, bearerPrefix) {
		return "", false
	}
	token = header[len(bearerPrefix):]
	return token, token != ""
}

// IsAdminAuthorized mirrors overlay/src/adminAuth.ts's isAdminAuthorized: an
// unset token is the open dev default (main.go logs the one startup warning
// for that case — never per-request here); a set token requires an exact
// bearer match, compared via arcingest.go's constantTimeEqual (same
// package) — the fast, non-secret length pre-check it does before
// subtle.ConstantTimeCompare's constant-time byte comparison is the same
// trade-off already accepted there for the Arcade callback token.
func IsAdminAuthorized(authorizationHeader, token string) bool {
	if token == "" {
		return true
	}
	provided, ok := ParseBearerToken(authorizationHeader)
	if !ok {
		return false
	}
	return constantTimeEqual(provided, token)
}

// AdminAuthMiddleware gates a route behind ADMIN_API_TOKEN: 401
// {"error":"unauthorized"} (same shape as overlay/src/adminAuth.ts) on a
// missing/wrong bearer token, otherwise c.Next(). An empty token leaves the
// route open.
func AdminAuthMiddleware(token string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if IsAdminAuthorized(c.Get(fiber.HeaderAuthorization), token) {
			return c.Next()
		}
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
	}
}

// adminGatedPath reports whether path is one of the identity-bearing admin
// routes narrowed-CORS applies to. /admin/admission/ is matched by prefix
// even though this backend does not register that route yet (A12), so
// narrowing takes effect automatically the day it lands — matching it now is
// harmless since no route currently answers under that prefix.
func adminGatedPath(path string) bool {
	return path == "/admin/registry" || path == "/admin/activity" || strings.HasPrefix(path, "/admin/admission/")
}

func originOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return rawURL
	}
	return u.Scheme + "://" + u.Host
}

// ParseAdminCORSOrigins mirrors overlay/src/adminAuth.ts's
// parseAdminCorsOrigins: ADMIN_CORS_ORIGINS as a trimmed, comma-separated
// list when non-blank, else hostingURL's origin plus the two local dev
// origins the console runs on.
func ParseAdminCORSOrigins(raw, hostingURL string) []string {
	if trimmed := strings.TrimSpace(raw); trimmed != "" {
		parts := strings.Split(trimmed, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return []string{originOf(hostingURL), "http://127.0.0.1:5173", "http://localhost:5173"}
}

func containsOrigin(origins []string, origin string) bool {
	for _, o := range origins {
		if o == origin {
			return true
		}
	}
	return false
}
