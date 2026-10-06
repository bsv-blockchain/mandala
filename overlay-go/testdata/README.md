# overlay-go test vectors

Vector files are copied from their source repository with `git show <commit>:<path>`, never from a
working tree and never edited by hand. A changed byte is a cross-engine change: recopy, then update
the pinned hash here and in the test that checks it.

| File | Source | Pin |
|---|---|---|
| `brc162.json` | bsv-blockchain/ts-stack `packages/helpers/ts-templates/test/vectors/brc162.json` at `37468f290` (identical at `87a14c9b5`) | sha256 `de5b898bee1a0f848f92e7082a9ca6b9026f9d2801ed7fcdda8ff6eb47e0afb1`, 68 364 bytes; checked by `internal/brc162/vectors_test.go` |
| `chronicle_sighash_vectors.json` | pre-Q3 Chronicle sighash vectors | not touched by Q3 |
| `vectors.json`, `gen/` | pre-Q3 old-format (MandalaToken v2) vectors and their generator | deleted in Q3 Task 25 |
| `linkage_vector.json` | `jq '.linkage' testdata/vectors.json` (mandala `db638af`): the BRC-72 golden specific-linkage revelation, format-independent, kept when `vectors.json` is deleted | sha256 `23be941dca50941ef3f8b2dc4955ae8cf16f4a7031cec06104a99c50a0a51475` (jq 1.8.1); read by `internal/mandala/linkage_test.go` |
