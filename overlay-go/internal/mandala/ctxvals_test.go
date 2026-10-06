package mandala

import (
	"context"
	"testing"
)

func TestOffChainValuesRoundTrip(t *testing.T) {
	if got := OffChainValuesFrom(context.Background()); got != nil {
		t.Fatalf("bare context = %q, want nil", got)
	}
	body := []byte(`{"outputs":[]}`)
	ctx := WithOffChainValues(context.Background(), body)
	body[0] = 'X' // the HTTP layer may reuse its buffer
	if got := string(OffChainValuesFrom(ctx)); got != `{"outputs":[]}` {
		t.Fatalf("carried = %q", got)
	}
	if got := OffChainValuesFrom(WithOffChainValues(context.Background(), nil)); got != nil {
		t.Fatalf("nil carried = %q", got)
	}
}
