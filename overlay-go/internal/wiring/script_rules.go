package wiring

import (
	"fmt"

	"github.com/bsv-blockchain/go-sdk/script"
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
// is refused by the engine's own after-Chronicle run as well (same 503).
//
// That holds only for scripts that execute the same path in both epochs, so an
// input whose LOCKING script contains an epoch-divergent opcode is skipped
// (epochDivergentOpcodes): OP_SUBSTR/LEFT/RIGHT/LSHIFTNUM/RSHIFTNUM are NOPs
// before Chronicle, OP_VERIF/VERNOTIF are NOPs in a non-executing branch
// before it and conditionals after, OP_VER and OP_2MUL/2DIV error before it.
// Run pre-Chronicle, such a script can follow a different stack and raise
// ErrInvalidSigHashType on an operand that is not the real signature — a
// false refusal of a tx TS and the engine both accept (shared vector
// v1_plain_epoch_divergent_lock). A locking script that fails to parse is
// skipped too; the engine judges it. For every other script the pre- and
// after-Chronicle runs execute the same path, so the check refuses nothing
// TS accepts.
//
// The UNLOCKING script is not scanned. Every epoch-divergent opcode is a
// non-push opcode, and TS refuses any version-1 tx whose unlocking script is
// not push-only (Spend.js: SIGPUSHONLY is enforced for a non-relaxed tx,
// "Unlocking scripts can only contain push operations"), so skipping on the
// unlock could only turn "both refuse" into "Go admits, TS refuses". The one
// other epoch difference, the post-Chronicle sighash subscript of a CHECKSIG
// executing in the unlocking script, needs a non-push unlock as well.
//
// Why not the pre-Chronicle run as the verdict, or the interpreter Debugger:
// pre-Chronicle also rejects Chronicle-only opcodes, which TS accepts at every
// version (Spend.js gates them on explicit verifyFlags only), and the Debugger
// deep-copies every stack and script on every hook, which is quadratic in
// script length (measured 11 s against 4.5 ms at 16k opcodes: a /submit DoS).
// This check costs one extra plain interpreter run per version-1 input.
//
// Known open corner (documented, pinned by
// TestChronicleSighashCheckMissesWhenAChronicleOpcodeRunsFirst): an input
// whose locking script holds an epoch-divergent opcode (OP_2MUL, OP_SUBSTR,
// ...) is not pre-checked at all, so if it also carries a SIGHASH_CHRONICLE
// signature the engine's after-Chronicle run admits what TS refuses. It needs
// a version-1 tx that uses such an opcode AND a SIGHASH_CHRONICLE signature in
// one input; no Mandala template does either.
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
			if epochDivergent(prevOut.LockingScript) {
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

// epochDivergentOpcodes behave differently before and after Chronicle in
// go-sdk v1.7.1's interpreter (script/interpreter/operations.go, thread.go).
var epochDivergentOpcodes = map[byte]bool{
	script.OpSUBSTR:    true,
	script.OpLEFT:      true,
	script.OpRIGHT:     true,
	script.OpLSHIFTNUM: true,
	script.OpRSHIFTNUM: true,
	script.OpVER:       true,
	script.OpVERIF:     true,
	script.OpVERNOTIF:  true,
	script.Op2MUL:      true,
	script.Op2DIV:      true,
}

// epochDivergent reports whether a pre-Chronicle run of a script could take a
// different path from the engine's after-Chronicle run: it contains an
// epoch-divergent opcode, or it does not parse. A nil script is not divergent.
func epochDivergent(sc *script.Script) bool {
	if sc == nil {
		return false
	}
	chunks, err := sc.Chunks()
	if err != nil {
		return true
	}
	for _, c := range chunks {
		if epochDivergentOpcodes[c.Op] {
			return true
		}
	}
	return false
}
