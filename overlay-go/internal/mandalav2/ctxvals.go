package mandalav2

import "context"

type payloadKey struct{}

func WithPayload(ctx context.Context, p *LinkagePayload) context.Context {
	return context.WithValue(ctx, payloadKey{}, p)
}

func PayloadFromContext(ctx context.Context) *LinkagePayload {
	if p, ok := ctx.Value(payloadKey{}).(*LinkagePayload); ok && p != nil {
		return p
	}
	return &LinkagePayload{}
}
