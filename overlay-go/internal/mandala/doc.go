// Package mandala is the v3 Mandala token domain on BRC-162, laid out as token
// topics on one overlay: tm_mandala (the token registry), tm_mandala_kyc (the
// identity registry) and one tm_<deploy txid> per token.
//
// Design: docs/superpowers/specs/2026-10-01-mandala-brc162-design.md (layers
// A-D, the §4.2a owner journal, typed verdicts, §6.6 storage) and
// docs/superpowers/specs/2026-10-05-mandala-token-topics-design.md including
// §14 Amendment A1 (single overlay, σI v3 per topic). The generic BRC-162
// codec and ledger live in internal/brc162. The old MandalaToken format was
// removed in Q3 Task 25.
package mandala
