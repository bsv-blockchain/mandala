package mandala

import "github.com/bsv-blockchain/go-sdk/transaction"

// orderingUnminedHeight is JS Number.MAX_SAFE_INTEGER: an unmined action folds after every mined one.
const orderingUnminedHeight = int64(maxSafeInteger)

// TxOrdering ports TS txOrdering (Q2/mandala/ordering.ts): no merkle path → (MAX_SAFE_INTEGER, 0);
// else the block height and the offset of the level-0 leaf whose hash is txid and that carries the
// txid flag, or 0 when there is no such leaf.
func TxOrdering(tx *transaction.Transaction, txid string) (height, offset int64) {
	mp := tx.MerklePath
	if mp == nil {
		return orderingUnminedHeight, 0
	}
	height = int64(mp.BlockHeight)
	if len(mp.Path) == 0 {
		return height, 0
	}
	for _, leaf := range mp.Path[0] {
		if leaf == nil || leaf.Hash == nil || leaf.Txid == nil || !*leaf.Txid {
			continue
		}
		if leaf.Hash.String() == txid {
			return height, int64(leaf.Offset)
		}
	}
	return height, 0
}
