package httpapi

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v2"
)

// Pinger proves Mongo connectivity for /health/ready.
type Pinger func(ctx context.Context) error

// Readiness reports the owner-index check: "ok", or "degraded" with a public message (counts and error classes only).
type Readiness func() (status, message string)

// ownerIndexCheckName keeps the TS overlay-express check name.
const ownerIndexCheckName = "mandala-owner-index"

type readyCheck struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

type readyBody struct {
	Status string       `json:"status"`
	Checks []readyCheck `json:"checks,omitempty"`
}

// WithReadiness adds the mandala-owner-index check to /health/ready (V-9).
func WithReadiness(r Readiness) ServerOption {
	return func(o *serverOptions) { o.readiness = r }
}

// registerHealthRoutes wires /health, /health/live (the process is up) and /health/ready (Mongo ping, then the
// owner-index check, which degrades but never fails readiness).
func registerHealthRoutes(f *fiber.App, ping Pinger, readiness Readiness) {
	f.Get("/health", healthOKHandler)
	f.Get("/health/live", healthOKHandler)
	f.Get("/health/ready", healthReadyHandler(ping, readiness))
}

func healthOKHandler(c *fiber.Ctx) error {
	return c.Status(fiber.StatusOK).JSON(fiber.Map{"status": "ok"})
}

func healthReadyHandler(ping Pinger, readiness Readiness) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if ping != nil {
			ctx, cancel := context.WithTimeout(c.UserContext(), 2*time.Second)
			defer cancel()
			if err := ping(ctx); err != nil {
				return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"status": "error"})
			}
		}
		if readiness != nil {
			if status, message := readiness(); status == "degraded" {
				return c.Status(fiber.StatusOK).JSON(readyBody{
					Status: "degraded",
					Checks: []readyCheck{{Name: ownerIndexCheckName, Status: "degraded", Message: message}},
				})
			}
		}
		return c.Status(fiber.StatusOK).JSON(readyBody{Status: "ok"})
	}
}
