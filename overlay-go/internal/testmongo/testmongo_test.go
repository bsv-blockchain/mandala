package testmongo

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// TestDBDropsBeforeAndAfter seeds the database with a raw client, then checks that DB hands it
// back empty and that the database is gone once the subtest's cleanup ran.
func TestDBDropsBeforeAndAfter(t *testing.T) {
	const name = "mandala3_test_testmongo"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	raw, err := mongo.Connect(options.Client().ApplyURI(URI))
	if err != nil {
		t.Skipf("mongo unavailable: %v", err)
	}
	defer func() { _ = raw.Disconnect(context.Background()) }()
	if err := raw.Ping(ctx, nil); err != nil {
		t.Skipf("mongo unavailable: %v", err)
	}
	if _, err := raw.Database(name).Collection("seed").InsertOne(ctx, bson.D{{Key: "k", Value: 1}}); err != nil {
		t.Fatal(err)
	}

	t.Run("handed back empty", func(t *testing.T) {
		db := DB(t, name)
		n, err := db.Collection("seed").CountDocuments(ctx, bson.D{})
		if err != nil || n != 0 {
			t.Fatalf("seed docs = %d (%v), want 0: DB must drop the database before returning it", n, err)
		}
		if _, err := db.Collection("seed").InsertOne(ctx, bson.D{{Key: "k", Value: 2}}); err != nil {
			t.Fatal(err)
		}
	})

	names, err := raw.ListDatabaseNames(ctx, bson.D{{Key: "name", Value: name}})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("database %s still exists after the subtest: DB must drop it in t.Cleanup", name)
	}
}
