// Package brc162 is layer A of the Mandala BRC-162 port: the generic BRC-162
// (BSV-21 binary) token-output codec, the strict DAG-CBOR subset and the token
// ledger. It holds no Mandala policy (identity, trust, admin kinds), so any
// BRC-162 topic can reuse it.
//
// Parity source: @bsv/templates 2.0.0 (Bsv21Binary.ts, strictCbor.ts) and
// @bsv/overlay-topics brc162/ledger.ts, ts-stack commit 37468f290. The vectors
// in testdata/brc162.json are the cross-engine contract
// (docs/superpowers/specs/2026-10-01-mandala-brc162-design.md §3.1-§3.5).
//
// The chunker is this package's own port of the TS SDK Script.#parseChunks:
// go-sdk's script decoder differs on OP_RETURN after an unbalanced OP_ENDIF and
// on truncated pushes (fact base ts-codec §1.1-§1.2), so chunks.go and codec.go
// must never import github.com/bsv-blockchain/go-sdk/script.
package brc162
