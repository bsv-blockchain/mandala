package wiring

// Mongo-backed wiring tests get their database from testmongo.DB (directly, or through buildV3App), the one skip path:
// it skips only when Mongo is unreachable and refuses any name outside mandala3_test_.

// Arbitrary valid secp256k1 private key (test-only).
const testPrivHex = "1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"
