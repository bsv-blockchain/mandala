package wiring

import (
	"fmt"

	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/script/interpreter/errs"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

// ChronicleSighashError is the refusal CheckChronicleSighashRule returns: a
// version-0/1 transaction carries a signature with SIGHASH_CHRONICLE (0x20).
type ChronicleSighashError struct {
	Txid string
	Vin  int
}

func (e *ChronicleSighashError) Error() string {
	return fmt.Sprintf("script verification failed: input %d of version-1 transaction %s carries a SIGHASH_CHRONICLE signature", e.Vin, e.Txid)
}

// CheckChronicleSighashRule closes the one Go/TS script-rule cell the
// go-sdk v1.7.1 bump moved: go-sdk's spv.Verify (run inside Engine.Submit)
// verifies EVERY tx version under after-Chronicle rules, which accept a
// SIGHASH_CHRONICLE (0x20) signature. TS's Transaction.verify builds Spend
// without verifyFlags, so Spend treats a version <= 1 tx as NOT after-Chronicle
// and refuses the same signature (Spend.js _Spend_enforceSignatureHashType
// "invalid before Chronicle"; a TS throw answers 503 ERR_UNAVAILABLE). This is
// the repo-local pre-check that makes Go refuse it too, on the same bytes and
// the same traversal.
//
// It walks the graph exactly as spv.Verify does (the BEEF subject, then every
// SourceTransaction of a tx with no MerklePath; a proven tx ends the walk),
// and for every input of a version < 2 tx runs the interpreter once more under
// the PRE-Chronicle flags go-sdk v1.2.24 used for every version. The only
// error it acts on is errs.ErrInvalidSigHashType. That filter is exact for the
// cell: the SDK's strict hash-type check strips the Chronicle bit only under
// after-Chronicle + ForkID, so "refused pre-Chronicle" for a ForkID signature
// is precisely "carries SIGHASH_CHRONICLE", and any other invalid hash type
// is refused by the engine's own after-Chronicle run as well (same 503). For
// a script with no Chronicle-only construct the pre- and after-Chronicle runs
// execute the same path, so the check never refuses anything TS accepts and
// opens no divergence of its own.
//
// Why not the pre-Chronicle run as the verdict, or the interpreter Debugger:
// pre-Chronicle also rejects Chronicle-only opcodes, which TS accepts at every
// version (Spend.js gates them on explicit verifyFlags only), and the Debugger
// deep-copies every stack and script on every hook, which is quadratic in
// script length (measured 11 s against 4.5 ms at 16k opcodes: a /submit DoS).
// This check costs one extra plain interpreter run per version-1 input.
//
// Known open corner (documented, pinned by
// TestChronicleSighashCheckMissesWhenAChronicleOpcodeRunsFirst): if a
// Chronicle-only construct (OP_2MUL, OP_SUBSTR, ...) executes before the
// CHECKSIG in the same input, the pre-Chronicle run fails on it first and the
// signature is never reached, so the engine's after-Chronicle run admits what
// TS refuses. It needs a version-1 tx that uses a Chronicle-only opcode AND a
// SIGHASH_CHRONICLE signature in one input.
//
// Fail-closed (wire contract §9.5): a nil result means "not refused"; an
// unparseable BEEF is left to Submit's own parse, which rejects it. A panic
// in the interpreter on hostile bytes is returned as an error, which /submit
// answers 503 ERR_UNAVAILABLE and never persists.
func CheckChronicleSighashRule(beefBytes []byte) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("script rules check panicked: %v", r)
		}
	}()

	beef, _, txid, perr := transaction.ParseBeef(beefBytes)
	if perr != nil || beef == nil || txid == nil {
		return nil
	}
	root := beef.FindTransactionForSigningByHash(txid)
	if root == nil {
		return nil
	}

	seen := make(map[string]struct{})
	queue := []*transaction.Transaction{root}
	for len(queue) > 0 {
		tx := queue[0]
		queue = queue[1:]
		id := tx.TxID().String()
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		if tx.MerklePath != nil {
			continue
		}
		for vin, input := range tx.Inputs {
			prevOut := input.SourceTxOutput()
			if prevOut == nil {
				// spv.Verify refuses a missing source; the engine reports it.
				continue
			}
			if input.SourceTransaction != nil {
				queue = append(queue, input.SourceTransaction)
			}
			// TS: Spend relaxed iff transactionVersion > 1.
			if tx.Version >= 2 {
				continue
			}
			xerr := interpreter.NewEngine().Execute(
				interpreter.WithTx(tx, vin, prevOut),
				interpreter.WithForkID(),
				interpreter.WithAfterGenesis(),
			)
			if xerr != nil && errs.IsErrorCode(xerr, errs.ErrInvalidSigHashType) {
				return &ChronicleSighashError{Txid: id, Vin: vin}
			}
		}
	}
	return nil
}
