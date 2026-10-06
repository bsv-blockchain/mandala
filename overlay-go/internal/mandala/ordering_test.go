package mandala

import (
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

func TestTxOrdering(t *testing.T) {
	tx := transaction.NewTransaction()
	txid := tx.TxID()
	other := chainhash.Hash{0x07}
	yes := true
	cases := []struct {
		name           string
		mp             *transaction.MerklePath
		height, offset int64
	}{
		{"unmined", nil, 9007199254740991, 0},
		{"the flagged txid leaf", &transaction.MerklePath{BlockHeight: 812345, Path: [][]*transaction.PathElement{{
			{Offset: 4, Hash: &other}, {Offset: 5, Hash: txid, Txid: &yes}}}}, 812345, 5},
		{"a txid leaf without the flag", &transaction.MerklePath{BlockHeight: 812345, Path: [][]*transaction.PathElement{{
			{Offset: 5, Hash: txid}}}}, 812345, 0},
		{"no level 0", &transaction.MerklePath{BlockHeight: 812345}, 812345, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tx.MerklePath = c.mp
			if h, o := TxOrdering(tx, txid.String()); h != c.height || o != c.offset {
				t.Fatalf("TxOrdering = (%d, %d), want (%d, %d)", h, o, c.height, c.offset)
			}
		})
	}
}
