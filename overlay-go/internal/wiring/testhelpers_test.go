package wiring

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Arbitrary valid secp256k1 private key (test-only).
const testPrivHex = "1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"

// requireMongo pre-flight-pings mongodb://localhost:27017 (the same
// connect-then-ping shape as httpapi/admin_test.go's testAdminDB) so a test
// skips ONLY when Mongo itself is unreachable in this environment. Any
// Build error that occurs after this succeeds is a real failure, not an
// environment gap, and must fail the test via t.Fatal instead of skipping.
func requireMongo(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://localhost:27017"))
	if err != nil {
		t.Skip("mongo unavailable:", err)
	}
	defer func() { _ = client.Disconnect(context.Background()) }()
	if err := client.Ping(ctx, nil); err != nil {
		t.Skip("mongo unavailable:", err)
	}
}
