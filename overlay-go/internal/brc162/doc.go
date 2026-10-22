// Package brc162 is layer A of the Mandala BRC-162 port: the generic BRC-162
// (BSV-21 binary) token-output codec, full strict DAG-CBOR and the token
// ledger. It holds no Mandala policy (identity, trust, admin kinds, payload
// size and depth limits), so any BRC-162 topic can reuse it.
//
// Parity source: @bsv/templates strictCbor.ts at ts-stack cbdccfe5b (full
// strict DAG-CBOR, depth bound 1024, no size cap); Bsv21Binary.ts and
// @bsv/overlay-topics brc162/ledger.ts at ts-stack commit 37468f290. The
// vectors in testdata/brc162.json (cbdccfe5b) are the cross-engine contract
// (docs/superpowers/specs/2026-10-01-mandala-brc162-design.md §3.1-§3.5).
//
// The chunker is this package's own port of the TS SDK Script.#parseChunks:
// go-sdk's script decoder differs on OP_RETURN after an unbalanced OP_ENDIF and
// on truncated pushes (fact base ts-codec §1.1-§1.2), so chunks.go and codec.go
// must never import github.com/bsv-blockchain/go-sdk/script.
package brc162
