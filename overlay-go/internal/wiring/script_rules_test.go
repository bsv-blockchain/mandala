package wiring

// go-sdk v1.6.0+ spv.Verify runs scripts under after-Chronicle rules for EVERY
// tx version. The TS SDK gates Chronicle on transactionVersion > 1. These
// tests pin Go's behaviour on the exact verify path the engine uses so a
// future go-sdk change is noticed, and document the v1 divergence.

import (
	"context"
	"testing"

	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/spv"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

// OP_1 OP_2MUL OP_2 OP_EQUAL — valid only once OP_2MUL is re-enabled (Chronicle).
func chronicleOnlyLock(t *testing.T) *script.Script {
	t.Helper()
	s := &script.Script{}
	if err := s.AppendOpcodes(script.Op1, script.Op2MUL, script.Op2, script.OpEQUAL); err != nil {
		t.Fatal(err)
	}
	return s
}

func chronicleSpend(t *testing.T, version uint32) (*transaction.Transaction, *transaction.TransactionOutput) {
	t.Helper()
	src := transaction.NewTransaction()
	src.Version = version
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1000, LockingScript: chronicleOnlyLock(t)})
	srcID := src.TxID()
	src.MerklePath = transaction.NewMerklePath(1, [][]*transaction.PathElement{{{Offset: 0, Hash: srcID, Txid: boolPtr(true)}}})

	child := transaction.NewTransaction()
	child.Version = version
	child.AddInput(&transaction.TransactionInput{
		SourceTXID: srcID, SourceTxOutIndex: 0, SourceTransaction: src,
		UnlockingScript: &script.Script{}, SequenceNumber: 0xffffffff,
	})
	child.AddOutput(&transaction.TransactionOutput{Satoshis: 900, LockingScript: chronicleOnlyLock(t)})
	return child, src.Outputs[0]
}

func boolPtr(b bool) *bool { return &b }

func TestSPVVerifyAppliesAfterChronicleToV2(t *testing.T) {
	child, _ := chronicleSpend(t, 2)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("v2 OP_2MUL spend must verify under after-Chronicle rules: ok=%v err=%v", ok, err)
	}
}

// Documented divergence: Go also accepts it for a v1 tx; TS (@bsv/sdk Spend) rejects it.
func TestSPVVerifyAppliesAfterChronicleToV1(t *testing.T) {
	child, _ := chronicleSpend(t, 1)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("go-sdk v1.7.1 verifies v1 txs under after-Chronicle rules too: ok=%v err=%v", ok, err)
	}
}

func TestPreChronicleInterpreterRejectsSameSpend(t *testing.T) {
	child, prevOut := chronicleSpend(t, 2)
	err := interpreter.NewEngine().Execute(
		interpreter.WithTx(child, 0, prevOut), interpreter.WithForkID(), interpreter.WithAfterGenesis())
	if err == nil {
		t.Fatal("pre-Chronicle (after-Genesis only) flags must reject OP_2MUL")
	}
}
