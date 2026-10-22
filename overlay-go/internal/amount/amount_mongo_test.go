package amount

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type amountDoc struct {
	K string `bson:"k"`
	V Amount `bson:"v"`
}

func TestAmountMongoIncAndSortExact(t *testing.T) {
	db := testmongo.DB(t, "mandala3_test_amount")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c := db.Collection("amounts")
	max := FromUint64(math.MaxUint64)

	if _, err := c.InsertOne(ctx, amountDoc{K: "x", V: max}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.UpdateOne(ctx, bson.M{"k": "x"}, bson.M{"$inc": bson.M{"v": max}}); err != nil {
		t.Fatal(err)
	}
	var got amountDoc
	if err := c.FindOne(ctx, bson.M{"k": "x"}).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.V.String() != "36893488147419103230" {
		t.Fatal(got.V)
	}
	// A negative $inc (a debit) stays exact.
	if _, err := c.UpdateOne(ctx, bson.M{"k": "x"}, bson.M{"$inc": bson.M{"v": FromUint64(1).Neg()}}); err != nil {
		t.Fatal(err)
	}
	if err := c.FindOne(ctx, bson.M{"k": "x"}).Decode(&got); err != nil || got.V.String() != "36893488147419103229" {
		t.Fatal(got.V, err)
	}

	for _, s := range []string{"18446744073709551615", "5", "9007199254740993"} {
		a, err := Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.InsertOne(ctx, amountDoc{K: "s", V: a}); err != nil {
			t.Fatal(err)
		}
	}
	cur, err := c.Find(ctx, bson.M{"k": "s"}, options.Find().SetSort(bson.D{{Key: "v", Value: 1}}))
	if err != nil {
		t.Fatal(err)
	}
	var rows []amountDoc
	if err := cur.All(ctx, &rows); err != nil {
		t.Fatal(err)
	}
	want := []string{"5", "9007199254740993", "18446744073709551615"}
	if len(rows) != len(want) {
		t.Fatal(rows)
	}
	for i, r := range rows {
		if r.V.String() != want[i] {
			t.Fatalf("row %d: %s want %s", i, r.V, want[i])
		}
	}

	// An old-format (double) amount read through the driver is an error, never a silent value.
	if _, err := c.InsertOne(ctx, bson.D{{Key: "k", Value: "old"}, {Key: "v", Value: 5.0}}); err != nil {
		t.Fatal(err)
	}
	var old amountDoc
	if err := c.FindOne(ctx, bson.M{"k": "old"}).Decode(&old); err == nil {
		t.Fatalf("old double decoded as %s", old.V)
	}
}
