// Package testmongo is the one Mongo helper for Q3 test suites.
//
// Every Go test talks to mongodb://localhost:27017 (container local-mongo-1) and
// SKIPS when it is unreachable, so a green `go test` proves nothing without
// `-v` and a zero `--- SKIP` count. DB refuses any database name outside the
// mandala3_test_ namespace, so a typo can never drop a live node's
// <NODE_NAME>_lookup_services database.
package testmongo

import (
	"context"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// URI is the only Mongo the tests use.
const URI = "mongodb://localhost:27017"

// Prefix is the namespace every Q3 test database lives in.
const Prefix = "mandala3_test_"

// DB connects to mongodb://localhost:27017 (2 s ping) and t.Skip("mongo unavailable: …") when that fails,
// drops the named database before returning it, and drops it again then disconnects in t.Cleanup.
// A name without the "mandala3_test_" prefix fails the test before anything is dropped.
func DB(t testing.TB, name string) *mongo.Database {
	t.Helper()
	if !strings.HasPrefix(name, Prefix) || len(name) == len(Prefix) {
		t.Fatalf("testmongo: refusing database %q: test databases are named %s<suite>", name, Prefix)
	}
	client, err := mongo.Connect(options.Client().ApplyURI(URI))
	if err != nil {
		t.Skipf("mongo unavailable: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		t.Skipf("mongo unavailable: %v", err)
	}
	db := client.Database(name)
	if err := db.Drop(context.Background()); err != nil {
		_ = client.Disconnect(context.Background())
		t.Fatalf("testmongo: drop %s before the test: %v", name, err)
	}
	t.Cleanup(func() {
		// One bounded context for both calls: a Mongo that stalls after the ping must not hang
		// the test binary until the go test timeout. Faults are logged, not failed, so a flaky
		// teardown never turns a green test red; the next DB call drops the database anyway.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := db.Drop(ctx); err != nil {
			t.Logf("testmongo: drop %s after the test: %v", name, err)
		}
		if err := client.Disconnect(ctx); err != nil {
			t.Logf("testmongo: disconnect after %s: %v", name, err)
		}
	})
	return db
}
