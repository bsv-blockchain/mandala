package mandalav2

import (
	"context"
	"testing"
)

func TestPayloadContextRoundTrip(t *testing.T) {
	p := &LinkagePayload{Admin: []IndexedAdmin{{Index: 3}}}
	ctx := WithPayload(context.Background(), p)
	got := PayloadFromContext(ctx)
	if len(got.Admin) != 1 || got.Admin[0].Index != 3 {
		t.Fatalf("%+v", got)
	}
}

func TestPayloadFromBareContextIsEmptyNotNil(t *testing.T) {
	got := PayloadFromContext(context.Background())
	if got == nil || len(got.Inputs)+len(got.Outputs)+len(got.Admin) != 0 {
		t.Fatalf("%+v", got)
	}
}
