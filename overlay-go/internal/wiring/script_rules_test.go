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
//     _Spend_checkSignatureEncoding, which a non-relaxed v1 tx enforces). The
//     SDK layer accepts it at every version (v1.2.24 refused it at every
//     version, so the bump moved this gap from v2 to v1). The overlay closes
//     the v1 cell with CheckChronicleSighashRule, called by POST /submit
//     before the engine: a v1 tx carrying the bit answers 503
//     ERR_UNAVAILABLE, as the TS throw does. The SDK-layer tests below stay
//     as pins of go-sdk itself so a future SDK change is noticed.
//   - The v1 malleability rules (LOW_S, MINIMALDATA, NULLDUMMY, CLEANSTACK) and
//     the pre-Genesis limits are enforced by TS for v1 only; the Go verify path
//     has never set those flags. Pre-existing and unrelated to the bump; not
//     pinned here.
//
// The check refuses only a version-0/1 tx whose executed input carries the
// SIGHASH_CHRONICLE bit; a tx without that bit, or of version >= 2, is never
// refused by it.
//
// The cross-stack cells (v1/v2 x plain/Chronicle signature, ancestry, and the
// one open corner) are asserted against overlay-go/testdata/
// chronicle_sighash_vectors.json, which the TS overlay's
// chronicleSighashParity.test.ts reads too: each vector carries the verdict
// measured on @bsv/sdk, and the Go overlay must give the same one.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
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

// p2pkhKeyAndLock is the fixed test key and its P2PKH lock; every vector is
// signed with it (RFC6979, so the bytes are deterministic).
func p2pkhKeyAndLock(t *testing.T) (*ec.PrivateKey, *script.Script) {
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
	return key, lock
}

// withMerklePath marks tx proven, with a trivial single-leaf path.
func withMerklePath(tx *transaction.Transaction) *transaction.Transaction {
	id := tx.TxID()
	tx.MerklePath = transaction.NewMerklePath(1, [][]*transaction.PathElement{{{Offset: 0, Hash: id, Txid: boolPtr(true)}}})
	return tx
}

// provenSource is a one-output tx (locked by lock) whose merkle path stops
// spv.Verify's walk.
func provenSource(t *testing.T, version uint32, lock *script.Script) *transaction.Transaction {
	t.Helper()
	src := transaction.NewTransaction()
	src.Version = version
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1000, LockingScript: lock})
	return withMerklePath(src)
}

// signedSpend spends src:0 with a P2PKH-style unlocking script signed with
// flag; its single output is locked by outLock.
func signedSpend(t *testing.T, key *ec.PrivateKey, src *transaction.Transaction, version uint32, flag sighash.Flag, outLock *script.Script) *transaction.Transaction {
	t.Helper()
	tmpl, err := p2pkh.Unlock(key, &flag)
	if err != nil {
		t.Fatal(err)
	}
	child := transaction.NewTransaction()
	child.Version = version
	child.AddInput(&transaction.TransactionInput{
		SourceTXID: src.TxID(), SourceTxOutIndex: 0, SourceTransaction: src,
		UnlockingScriptTemplate: tmpl, SequenceNumber: 0xffffffff,
	})
	child.AddOutput(&transaction.TransactionOutput{Satoshis: 900, LockingScript: outLock})
	if err := child.Sign(); err != nil {
		t.Fatal(err)
	}
	return child
}

// chronicleSighashSpend builds a one-input P2PKH spend (v<version>, source tx
// proven by a merkle path so verification stops there) whose signature carries
// the given sighash flag.
func chronicleSighashSpend(t *testing.T, version uint32, flag sighash.Flag) (*transaction.Transaction, *transaction.TransactionOutput) {
	t.Helper()
	key, lock := p2pkhKeyAndLock(t)
	src := provenSource(t, version, lock)
	return signedSpend(t, key, src, version, flag, lock), src.Outputs[0]
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

// Pinned at the SDK layer: go-sdk v1.7.1 spv.Verify verifies a v1 spend whose
// signature carries SIGHASH_CHRONICLE, while TS refuses it ("The signature
// format is invalid." from Spend.js _Spend_enforceSignatureHashType, because a
// non-relaxed v1 tx is not after-Chronicle). The engine runs spv.Verify
// internally with fixed flags, so the overlay refuses the cell BEFORE the
// engine, in CheckChronicleSighashRule (POST /submit calls it); the tests
// further down assert that refusal against the shared TS vectors. This test
// only pins go-sdk, so a change in the SDK's own behaviour is noticed.
func TestSPVVerifyAcceptsChronicleSighashOnV1(t *testing.T) {
	child, _ := chronicleSighashSpend(t, 1, chronicleSighash)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("go-sdk v1.7.1 verifies a v1 SIGHASH_CHRONICLE spend at the SDK layer (the overlay refuses it in CheckChronicleSighashRule): ok=%v err=%v", ok, err)
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

// ---- the overlay's pre-check, against vectors measured on TS ----------------

func atomicBEEF(t *testing.T, tx *transaction.Transaction) []byte {
	t.Helper()
	b, err := tx.AtomicBEEF(false)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// chronicleOpcodeFirstLock is OP_1 OP_2MUL OP_2 OP_EQUALVERIFY followed by a
// P2PKH lock: a Chronicle-only opcode that executes BEFORE the CHECKSIG.
func chronicleOpcodeFirstLock(t *testing.T, p2pkhLock *script.Script) *script.Script {
	t.Helper()
	pre := &script.Script{}
	if err := pre.AppendOpcodes(script.Op1, script.Op2MUL, script.Op2, script.OpEQUALVERIFY); err != nil {
		t.Fatal(err)
	}
	out := append(script.Script{}, *pre...)
	out = append(out, *p2pkhLock...)
	return &out
}

// chronicleChain builds child (v2, plain signature) -> parent (v1, SIGHASH_CHRONICLE
// signature) -> proven grandparent. With parentProven the parent carries a
// merkle path, which ends the walk before its own inputs are verified.
func chronicleChain(t *testing.T, parentProven bool) []byte {
	t.Helper()
	key, lock := p2pkhKeyAndLock(t)
	gp := provenSource(t, 1, lock)
	parent := signedSpend(t, key, gp, 1, chronicleSighash, lock)
	if parentProven {
		withMerklePath(parent)
	}
	return atomicBEEF(t, signedSpend(t, key, parent, 2, sighash.AllForkID, lock))
}

// chronicleProvenParentWithAncestor is the same child -> proven v1 parent
// chain, but sent as a (non-atomic) BEEF V2 that ALSO carries the parent's own
// ancestor, so the parsed graph links parent.Inputs[0] to a source tx whose
// signature carries SIGHASH_CHRONICLE. The parent has a merkle path, so
// spv.Verify and TS stop at it and never execute that input.
func chronicleProvenParentWithAncestor(t *testing.T) []byte {
	t.Helper()
	key, lock := p2pkhKeyAndLock(t)
	gp := provenSource(t, 1, lock)
	parent := withMerklePath(signedSpend(t, key, gp, 1, chronicleSighash, lock))
	child := signedSpend(t, key, parent, 2, sighash.AllForkID, lock)
	beef := transaction.NewBeefV2()
	for _, tx := range []*transaction.Transaction{gp, parent, child} {
		if _, err := beef.MergeTransaction(tx); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := beef.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// chronicleOpcodeFirstSpend is a v1 spend of chronicleOpcodeFirstLock whose
// signature carries SIGHASH_CHRONICLE: the one corner the pre-check misses.
func chronicleOpcodeFirstSpend(t *testing.T) []byte {
	t.Helper()
	key, lock := p2pkhKeyAndLock(t)
	src := provenSource(t, 1, chronicleOpcodeFirstLock(t, lock))
	return atomicBEEF(t, signedSpend(t, key, src, 1, chronicleSighash, lock))
}

// epochDivergentLockSpend is a version-1 spend of `OP_SUBSTR <pub> OP_CHECKSIG`
// unlocked by `<sig||0x00> OP_0 <len(sig)>`, signed with a plain
// SIGHASH_ALL|FORKID. Under Chronicle rules (the engine's spv.Verify, and TS at
// every version, since Transaction.verify passes no verifyFlags) OP_SUBSTR trims
// the junk byte and the signature verifies. Pre-Chronicle, go-sdk runs OP_SUBSTR
// as a NOP, so CHECKSIG takes the one-byte length operand as its "signature"
// and fails on its hash type: the pre-check's own epoch would refuse a tx both
// engines accept, unless it skips scripts that behave differently by epoch.
func epochDivergentLockSpend(t *testing.T) []byte {
	t.Helper()
	key, outLock := p2pkhKeyAndLock(t)
	lock := &script.Script{}
	if err := lock.AppendOpcodes(script.OpSUBSTR); err != nil {
		t.Fatal(err)
	}
	if err := lock.AppendPushData(key.PubKey().Compressed()); err != nil {
		t.Fatal(err)
	}
	if err := lock.AppendOpcodes(script.OpCHECKSIG); err != nil {
		t.Fatal(err)
	}
	src := transaction.NewTransaction()
	src.Version = 1
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1000, LockingScript: lock})
	withMerklePath(src)

	child := transaction.NewTransaction()
	child.Version = 1
	child.AddInput(&transaction.TransactionInput{
		SourceTXID: src.TxID(), SourceTxOutIndex: 0, SourceTransaction: src, SequenceNumber: 0xffffffff,
	})
	child.AddOutput(&transaction.TransactionOutput{Satoshis: 900, LockingScript: outLock})
	digest, err := child.CalcInputSignatureHash(0, sighash.AllForkID)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := key.Sign(digest)
	if err != nil {
		t.Fatal(err)
	}
	full := append(sig.Serialize(), byte(sighash.AllForkID))
	padded := append(append([]byte{}, full...), 0x00) // the junk byte OP_SUBSTR trims
	raw := append([]byte{byte(len(padded))}, padded...)
	raw = append(raw, 0x00, 0x01, byte(len(full))) // OP_0, then push len(full)
	child.Inputs[0].UnlockingScript = script.NewFromBytes(raw)
	return atomicBEEF(t, child)
}

func spendBEEF(version uint32, flag sighash.Flag) func(*testing.T) []byte {
	return func(t *testing.T) []byte {
		child, _ := chronicleSighashSpend(t, version, flag)
		return atomicBEEF(t, child)
	}
}

// chronicleVectorBuilders rebuilds every vector in testdata/
// chronicle_sighash_vectors.json (RFC6979 signing makes the bytes
// deterministic).
var chronicleVectorBuilders = map[string]func(*testing.T) []byte{
	"v1_plain":                            spendBEEF(1, sighash.AllForkID),
	"v1_chronicle":                        spendBEEF(1, chronicleSighash),
	"v2_plain":                            spendBEEF(2, sighash.AllForkID),
	"v2_chronicle":                        spendBEEF(2, chronicleSighash),
	"v2_child_of_unproven_v1_chronicle":   func(t *testing.T) []byte { return chronicleChain(t, false) },
	"v2_child_of_proven_v1_chronicle":     func(t *testing.T) []byte { return chronicleChain(t, true) },
	"v1_chronicle_after_chronicle_opcode": chronicleOpcodeFirstSpend,
	"v2_child_of_proven_v1_chronicle_ancestor_present": chronicleProvenParentWithAncestor,
	"v1_plain_epoch_divergent_lock":                    epochDivergentLockSpend,
}

type chronicleVector struct {
	Name       string `json:"name"`
	TSVerifies bool   `json:"tsVerifies"`
	// KnownGap, when set, names a corner where Go deliberately admits what TS
	// refuses (tsVerifies is false there).
	KnownGap string `json:"knownGap"`
	BeefHex  string `json:"beefHex"`
}

func loadChronicleVectors(t *testing.T) []chronicleVector {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/chronicle_sighash_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Vectors []chronicleVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f.Vectors
}

// overlayAdmitsScripts is what the overlay does about scripts for one /submit
// body, in order: the repo-local pre-check (called by the submit handler), then
// the engine's own SPV step (spv.Verify on the tx Engine.Submit verifies).
func overlayAdmitsScripts(t *testing.T, beefBytes []byte) bool {
	t.Helper()
	if err := CheckChronicleSighashRule(beefBytes); err != nil {
		return false
	}
	beef, _, txid, err := transaction.ParseBeef(beefBytes)
	if err != nil {
		t.Fatal(err)
	}
	tx := beef.FindTransactionForSigningByHash(txid)
	if tx == nil {
		t.Fatal("beef has no subject tx")
	}
	ok, verr := spv.Verify(context.Background(), tx, scriptsOnlyTracker{}, nil)
	return verr == nil && ok
}

// The vectors are the cross-stack contract: the file records what @bsv/sdk
// does with each BEEF; rebuilding them here keeps the bytes honest.
func TestChronicleVectorsAreReproducible(t *testing.T) {
	vectors := loadChronicleVectors(t)
	if len(vectors) != len(chronicleVectorBuilders) {
		t.Fatalf("%d vectors in the file, %d builders", len(vectors), len(chronicleVectorBuilders))
	}
	for _, v := range vectors {
		build, ok := chronicleVectorBuilders[v.Name]
		if !ok {
			t.Fatalf("vector %q has no builder", v.Name)
		}
		if got := hex.EncodeToString(build(t)); got != v.BeefHex {
			t.Errorf("vector %q drifted from its builder (re-measure it on TS before replacing the hex):\n got  %s\n file %s", v.Name, got, v.BeefHex)
		}
	}
}

// The overlay gives the verdict TS gives on every shared vector, except the
// one named open corner, where it admits what TS refuses.
func TestOverlayScriptVerdictMatchesTSOnSharedVectors(t *testing.T) {
	for _, v := range loadChronicleVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(v.BeefHex)
			if err != nil {
				t.Fatal(err)
			}
			want := v.TSVerifies
			if v.KnownGap != "" {
				want = true
			}
			if got := overlayAdmitsScripts(t, raw); got != want {
				t.Fatalf("overlay admits scripts = %v, want %v (TS verifies = %v, knownGap = %q)", got, want, v.TSVerifies, v.KnownGap)
			}
		})
	}
}

func TestChronicleSighashRuleNamesTheUnprovenAncestor(t *testing.T) {
	err := CheckChronicleSighashRule(chronicleChain(t, false))
	var ce *ChronicleSighashError
	if !errors.As(err, &ce) {
		t.Fatalf("want *ChronicleSighashError for the unproven v1 parent, got %v", err)
	}
	// The refused tx is the v1 PARENT (input 0), not the v2 child that was submitted.
	key, lock := p2pkhKeyAndLock(t)
	gp := provenSource(t, 1, lock)
	parent := signedSpend(t, key, gp, 1, chronicleSighash, lock)
	if ce.Txid != parent.TxID().String() || ce.Vin != 0 {
		t.Fatalf("refused %s input %d, want the parent %s input 0", ce.Txid, ce.Vin, parent.TxID())
	}
}

// An unparseable body is not this check's to judge: Engine.Submit's own parse
// rejects it. Nothing here may panic or refuse it.
func TestChronicleSighashRuleIgnoresUnparseableBeef(t *testing.T) {
	for _, b := range [][]byte{nil, {}, {0x01}, {0xde, 0xad, 0xbe, 0xef, 0x00, 0x01}, make([]byte, 64)} {
		if err := CheckChronicleSighashRule(b); err != nil {
			t.Errorf("CheckChronicleSighashRule(%x) = %v, want nil", b, err)
		}
	}
}

// The one open corner, pinned so closing it is a deliberate decision: the
// locking script holds an epoch-divergent opcode (OP_2MUL), so the pre-check
// skips the input — a pre-Chronicle run would stop on it anyway
// (ErrDisabledOpcode) — and the engine's after-Chronicle run admits the
// signature TS refuses. The shared vector records the TS side of the same bytes.
func TestChronicleSighashCheckMissesWhenAChronicleOpcodeRunsFirst(t *testing.T) {
	raw := chronicleOpcodeFirstSpend(t)
	if err := CheckChronicleSighashRule(raw); err != nil {
		t.Fatalf("the pre-check is not expected to see this corner: %v", err)
	}
	beef, _, txid, err := transaction.ParseBeef(raw)
	if err != nil {
		t.Fatal(err)
	}
	tx := beef.FindTransactionForSigningByHash(txid)
	pre := interpreter.NewEngine().Execute(
		interpreter.WithTx(tx, 0, tx.Inputs[0].SourceTxOutput()), interpreter.WithForkID(), interpreter.WithAfterGenesis())
	if pre == nil || !errs.IsErrorCode(pre, errs.ErrDisabledOpcode) {
		t.Fatalf("pre-Chronicle run must stop on the disabled OP_2MUL, got %v", pre)
	}
	if ok, verr := spv.Verify(context.Background(), tx, scriptsOnlyTracker{}, nil); verr != nil || !ok {
		t.Fatalf("go-sdk spv.Verify admits the corner: ok=%v err=%v", ok, verr)
	}
}

// Every opcode that behaves differently before and after Chronicle marks a
// locking script as one the pre-check must not run; a plain P2PKH lock (and a
// nil script) does not; an unparseable script does (the engine judges it).
func TestEpochDivergentScripts(t *testing.T) {
	_, p2pkhLock := p2pkhKeyAndLock(t)
	if epochDivergent(p2pkhLock) || epochDivergent(nil) {
		t.Fatal("a P2PKH lock and a nil script are not epoch-divergent")
	}
	for _, op := range []byte{
		script.OpSUBSTR, script.OpLEFT, script.OpRIGHT, script.OpLSHIFTNUM, script.OpRSHIFTNUM,
		script.OpVER, script.OpVERIF, script.OpVERNOTIF, script.Op2MUL, script.Op2DIV,
	} {
		s := &script.Script{}
		if err := s.AppendOpcodes(script.Op1, op); err != nil {
			t.Fatal(err)
		}
		*s = append(*s, *p2pkhLock...)
		if !epochDivergent(s) {
			t.Errorf("opcode 0x%02x must mark the script epoch-divergent", op)
		}
	}
	// A push whose length runs past the end of the script does not parse.
	if !epochDivergent(script.NewFromBytes([]byte{0x4c, 0xff, 0x01})) {
		t.Error("an unparseable script must be treated as epoch-divergent")
	}
	// The byte value of OP_SUBSTR inside pushed DATA is not an opcode.
	pushed := &script.Script{}
	if err := pushed.AppendPushData([]byte{script.OpSUBSTR, script.Op2MUL}); err != nil {
		t.Fatal(err)
	}
	if epochDivergent(pushed) {
		t.Error("opcode bytes inside a push are data, not opcodes")
	}
}

// The false refusal the scan exists to stop, asserted directly: the pre-check
// passes the v1 OP_SUBSTR spend, and so does the engine's verify.
func TestChronicleSighashRuleDoesNotRefuseAnEpochDivergentLock(t *testing.T) {
	raw := epochDivergentLockSpend(t)
	if err := CheckChronicleSighashRule(raw); err != nil {
		t.Fatalf("false refusal: %v", err)
	}
	if !overlayAdmitsScripts(t, raw) {
		t.Fatal("the engine's verify must admit it too")
	}
}
