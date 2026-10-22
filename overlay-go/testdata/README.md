# overlay-go test vectors

Vector files are copied from their source repository with `git show <commit>:<path>`, never from a
working tree and never edited by hand. A changed byte is a cross-engine change: recopy, then update
the pinned hash here and in the test that checks it.

| File | Source | Pin |
|---|---|---|
| `brc162.json` | bsv-blockchain/ts-stack `packages/helpers/ts-templates/test/vectors/brc162.json` at `cbdccfe5b` (full strict DAG-CBOR rows: 124 `strictCbor`; other sections unchanged from `37468f290`) | sha256 `dec7003a7cf61a933574737228bc56d7fc902fedab0b21eddc28ab1042ef47f0`, 76 656 bytes; checked by `internal/brc162/vectors_test.go` |
| `chronicle_sighash_vectors.json` | pre-Q3 Chronicle sighash vectors | not touched by Q3 |
| `linkage_vector.json` | `jq '.linkage' testdata/vectors.json` (mandala `db638af`): the BRC-72 golden specific-linkage revelation, format-independent, kept when `vectors.json` is deleted | sha256 `23be941dca50941ef3f8b2dc4955ae8cf16f4a7031cec06104a99c50a0a51475` (jq 1.8.1); read by `internal/mandala/linkage_test.go` |

## mandala-rejects.json

- Source: ts-stack `packages/overlays/topics/test/vectors/mandala-rejects.json` at commit `ee9f56c92` on branch `feat/mandala-token-topics` (read with `git -C /Users/personal/git/ts-stack show`). Q2 Task 5, "KYC rename; 2.1.0 exports, vectors, docs", is `37468f290`; `ee9f56c92` appended ten cases (coinsToRetain narrowing, registry/token agreement, two-token admin entries).
- sha256 `c13fb98532ea86fbddbb6a8023528ab8339b3aed308dd69f767cb3942727d8a1`, 615526 bytes, format version 2 (real topic names, explicit coinsToRetain).
- Read by `internal/mandala/vectors_test.go`, which replays every case through the three managers directly (no host rules).
- 1Color: replayed with a topic remap (`tm_<deploy txid>` → `tm_color_<deploy txid>_0`; the registry and KYC topics are not remapped) and a reviewed override table in `internal/mandala/vectors_test.go`, each override naming its case and its reason. The file is unchanged: same bytes, same sha256.
