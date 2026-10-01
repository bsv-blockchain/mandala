package wiring

// go-sdk v1.6.0+ spv.Verify runs scripts under after-Chronicle rules for EVERY
// tx version (v1.2.24 ran after-Genesis, pre-Chronicle, for every version).
// These tests pin Go's behaviour on the exact verify path the engine uses
// (engine.verifyTransaction -> spv.Verify) so a future go-sdk change is
// noticed, and record how that compares with the TS overlay.
//
// What the TS overlay does (@bsv/sdk 2.8.11; Engine.submit calls
// Transaction.verify, which builds Spend WITHOUT verifyFlags, so Spend runs its
// "no explicit flags" rule set and gates on transactionVersion > 1):
//
//   - Chronicle-only OPCODES (OP_2MUL, OP_2DIV, OP_SUBSTR, ...): accepted at
//     every tx version. The opcode gates (Spend.js _Spend_enforceChronicleOnlyOpcode
//     and _Spend_skipUnavailablePreChronicleOpcode) both require explicit
//     verifyFlags, which Transaction.verify never passes. Go v1.7.1 also
//     accepts them at every version: AGREEMENT (v1.2.24 rejected them at every
//     version, so the bump closed that gap).
//   - SIGHASH_CHRONICLE (0x20) in a signature: accepted for v2, REFUSED for v1
//     (Spend.js _Spend_enforceSignatureHashType, reached through
//     _Spend_checkSignatureEncoding, which a non-relaxed v1 tx enforces). Go
//     v1.7.1 accepts it at every version: DIVERGENCE on v1, Go laxer (v1.2.24
//     refused it at every version, so the bump moved this gap from v2 to v1).
//   - The v1 malleability rules (LOW_S, MINIMALDATA, NULLDUMMY, CLEANSTACK) are
//     enforced by TS for v1 only; the Go verify path has never set those flags.
//     Pre-existing and unrelated to the bump; not pinned here.
//
// The first-party wallet emits v2 transactions, so the v1 gap is dormant for
// first-party traffic; it is reachable only by a third party POSTing a v1 tx
// to /submit.

import (
	"context"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/script/interpreter/errs"
	"github.com/bsv-blockchain/go-sdk/spv"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	"github.com/bsv-blockchain/go-sdk/transaction/template/p2pkh"
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

// Agreement, not divergence: Go accepts a Chronicle-only opcode in a v1 tx and
// so does TS (see the file header: Transaction.verify passes no verifyFlags,
// so Spend never gates opcodes on version). Pinned so a go-sdk change that
// starts gating opcodes by version is noticed and compared with TS again.
func TestSPVVerifyAppliesAfterChronicleToV1(t *testing.T) {
	child, _ := chronicleSpend(t, 1)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("go-sdk v1.7.1 verifies v1 txs under after-Chronicle rules too (TS accepts the opcode on v1 as well): ok=%v err=%v", ok, err)
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

// chronicleSighashSpend builds a one-input P2PKH spend (v<version>, source tx
// proven by a merkle path so verification stops there) whose signature carries
// the given sighash flag.
func chronicleSighashSpend(t *testing.T, version uint32, flag sighash.Flag) (*transaction.Transaction, *transaction.TransactionOutput) {
	t.Helper()
	key, err := ec.PrivateKeyFromHex(testPrivHex)
	if err != nil {
		t.Fatal(err)
	}
	addr, err := script.NewAddressFromPublicKey(key.PubKey(), true)
	if err != nil {
		t.Fatal(err)
	}
	lock, err := p2pkh.Lock(addr)
	if err != nil {
		t.Fatal(err)
	}
	src := transaction.NewTransaction()
	src.Version = version
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1000, LockingScript: lock})
	srcID := src.TxID()
	src.MerklePath = transaction.NewMerklePath(1, [][]*transaction.PathElement{{{Offset: 0, Hash: srcID, Txid: boolPtr(true)}}})

	tmpl, err := p2pkh.Unlock(key, &flag)
	if err != nil {
		t.Fatal(err)
	}
	child := transaction.NewTransaction()
	child.Version = version
	child.AddInput(&transaction.TransactionInput{
		SourceTXID: srcID, SourceTxOutIndex: 0, SourceTransaction: src,
		UnlockingScriptTemplate: tmpl, SequenceNumber: 0xffffffff,
	})
	child.AddOutput(&transaction.TransactionOutput{Satoshis: 900, LockingScript: lock})
	if err := child.Sign(); err != nil {
		t.Fatal(err)
	}
	return child, src.Outputs[0]
}

const chronicleSighash = sighash.AllForkID | sighash.Chronicle

// Agreement: a v2 spend whose signature carries SIGHASH_CHRONICLE verifies in
// Go and in TS (the same bytes were checked against @bsv/sdk 2.8.11).
func TestSPVVerifyAcceptsChronicleSighashOnV2(t *testing.T) {
	child, _ := chronicleSighashSpend(t, 2, chronicleSighash)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("v2 spend with a SIGHASH_CHRONICLE signature must verify: ok=%v err=%v", ok, err)
	}
}

// Documented DIVERGENCE (Go laxer): a v1 spend whose signature carries
// SIGHASH_CHRONICLE verifies in Go, while TS refuses it ("The signature
// format is invalid." from Spend.js _Spend_enforceSignatureHashType, because a
// non-relaxed v1 tx is not after-Chronicle). The engine runs spv.Verify
// internally with fixed flags, so Go cannot be made to refuse it without a
// repo-local pre-check; this test records the gap so closing (or accepting)
// it is a deliberate decision, and so a go-sdk change is noticed.
func TestSPVVerifyAcceptsChronicleSighashOnV1(t *testing.T) {
	child, _ := chronicleSighashSpend(t, 1, chronicleSighash)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("go-sdk v1.7.1 verifies a v1 SIGHASH_CHRONICLE spend (TS refuses it): ok=%v err=%v", ok, err)
	}
}

// The pre-Chronicle flags go-sdk v1.2.24 used for every tx version refuse the
// same signature with an invalid-hash-type error, while the identical spend
// signed without the Chronicle bit passes under them: the bit alone is the
// difference, and the Go verify epoch alone decides whether it is refused.
func TestPreChronicleInterpreterRejectsChronicleSighash(t *testing.T) {
	exec := func(child *transaction.Transaction, prevOut *transaction.TransactionOutput) error {
		return interpreter.NewEngine().Execute(
			interpreter.WithTx(child, 0, prevOut), interpreter.WithForkID(), interpreter.WithAfterGenesis())
	}
	plain, plainOut := chronicleSighashSpend(t, 1, sighash.AllForkID)
	if err := exec(plain, plainOut); err != nil {
		t.Fatalf("control: a plain FORKID signature must pass pre-Chronicle flags: %v", err)
	}
	child, prevOut := chronicleSighashSpend(t, 1, chronicleSighash)
	err := exec(child, prevOut)
	if err == nil || !errs.IsErrorCode(err, errs.ErrInvalidSigHashType) {
		t.Fatalf("pre-Chronicle flags must refuse SIGHASH_CHRONICLE with ErrInvalidSigHashType, got: %v", err)
	}
}
