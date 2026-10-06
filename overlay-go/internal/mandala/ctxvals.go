package mandala

import "context"

type offChainKey struct{}

// WithOffChainValues carries the raw submit off-chain values to the Mandala
// managers, which decode the envelope themselves (DecodeEnvelope). The bytes
// are copied: the HTTP layer may reuse its request buffer.
func WithOffChainValues(ctx context.Context, offChain []byte) context.Context {
	if offChain != nil {
		offChain = append([]byte{}, offChain...)
	}
	return context.WithValue(ctx, offChainKey{}, offChain)
}

// OffChainValuesFrom returns the carried off-chain values; nil when absent.
func OffChainValuesFrom(ctx context.Context) []byte {
	b, _ := ctx.Value(offChainKey{}).([]byte)
	return b
}
