package brc162

import (
	"bytes"
	"math"
	"math/big"
	"reflect"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

var (
	tokenA = strings.Repeat("aa", 32) + "_0"
	tokenB = strings.Repeat("bb", 32) + "_0"
	tokenC = strings.Repeat("cc", 32) + "_0"
)

func mustLock(t *testing.T, tokenID string, amount uint64) []byte {
	t.Helper()
	b, err := Lock(LockParams{TokenID: tokenID, Amount: amount, PubKeyHash: mustHex(t, pkhHex)})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func txWithOutputs(scripts ...[]byte) *transaction.Transaction {
	tx := transaction.NewTransaction()
	for _, s := range scripts {
		ls := script.Script(s)
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: &ls})
	}
	return tx
}

func spend(tx, src *transaction.Transaction, vout uint32) {
	in := &transaction.TransactionInput{SourceTxOutIndex: vout, SourceTransaction: src, SequenceNumber: 0xffffffff}
	if src != nil {
		in.SourceTXID = src.TxID()
	} else {
		in.SourceTXID = transaction.NewTransaction().TxID()
	}
	tx.AddInput(in)
}

func TestClassifyOutputs(t *testing.T) {
	invalid := mustHex(t, "20"+strings.Repeat("11", 32)+"01056d"+p2pkhHex)
	tx := txWithOutputs(mustLock(t, "", 0), mustLock(t, tokenA, 5), mustHex(t, p2pkhHex), invalid, mustLock(t, tokenA, 0))
	tx.Outputs[1].Satoshis = 2
	txid := tx.TxID().String()
	c := ClassifyOutputs(tx)
	if len(c.Outputs) != 3 {
		t.Fatalf("outputs = %+v", c.Outputs)
	}
	want := []struct {
		index    uint32
		role     Role
		tokenID  string
		amount   uint64
		satoshis uint64
	}{{0, RoleDeploy, txid + "_0", 0, 1}, {1, RoleValue, tokenA, 5, 2}, {4, RoleAuthority, tokenA, 0, 1}}
	for i, w := range want {
		o := c.Outputs[i]
		if o.Index != w.index || o.Role != w.role || o.TokenID != w.tokenID || o.Amount != w.amount || o.Satoshis != w.satoshis {
			t.Errorf("output %d = %+v, want %+v", i, o, w)
		}
		if !bytes.Equal(o.Script, []byte(*tx.Outputs[w.index].LockingScript)) || !bytes.Equal(o.RestPubKeyHash, mustHex(t, pkhHex)) {
			t.Errorf("output %d script/pkh = %x / %x", i, o.Script, o.RestPubKeyHash)
		}
	}
	if !reflect.DeepEqual(c.Invalid, []InvalidOutput{{Index: 3, Detail: "amounts 0..16 must use OP_0/OP_1..OP_16"}}) {
		t.Errorf("invalid = %+v", c.Invalid)
	}
}

func TestDeployNotAtZeroIsKeyedByItsOutpoint(t *testing.T) {
	tx := txWithOutputs(mustLock(t, tokenA, 5), mustLock(t, "", 0))
	txid := tx.TxID().String()
	c := ClassifyOutputs(tx)
	if c.Outputs[1].TokenID != txid+"_1" || c.Outputs[1].Role != RoleDeploy {
		t.Fatalf("deploy at vout 1 = %+v", c.Outputs[1])
	}
	l := BuildLedger(txid, c.Outputs, nil)
	tokens := l.Tokens()
	if len(tokens) != 2 || tokens[0].TokenID != tokenA || tokens[1].TokenID != txid+"_1" {
		t.Fatalf("ledger order = %v", ids(tokens))
	}
	d, _ := l.Get(txid + "_1")
	if !d.HasDeploy || d.DeployIndex != 1 || !reflect.DeepEqual(d.AuthorityOut, []uint32{1}) {
		t.Fatalf("deploy ledger = %+v", d)
	}
	if v := SpecVerdicts(d); v.DeployValid || v.AuthorityOutputsValid {
		t.Fatalf("verdict = %+v", v)
	}
}

func ids(ts []*TokenLedger) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.TokenID
	}
	return out
}

func TestClassifyAdmittedInputs(t *testing.T) {
	invalid := mustHex(t, "20"+strings.Repeat("11", 32)+"01056d"+p2pkhHex)
	src := txWithOutputs(mustLock(t, "", 0), mustLock(t, tokenA, 7), mustLock(t, "", 0), invalid, mustHex(t, p2pkhHex))
	srcTxid := src.TxID().String()
	tx := transaction.NewTransaction()
	for vout := uint32(0); vout < 5; vout++ {
		spend(tx, src, vout) // inputs 0..4
	}
	spend(tx, nil, 0) // input 5: no SourceTransaction
	spend(tx, src, 9) // input 6: source output missing
	got := ClassifyAdmittedInputs(tx, []uint32{6, 5, 4, 3, 2, 1, 0, 1, 9})
	if len(got) != 2 {
		t.Fatalf("inputs = %+v", got)
	}
	deploy, value := got[0], got[1]
	if deploy.Index != 0 || deploy.Role != RoleAuthority || deploy.TokenID != srcTxid+"_0" || deploy.Amount != 0 ||
		deploy.SourceRole != RoleDeploy || deploy.Outpoint != srcTxid+".0" || deploy.SourceTxid != srcTxid || deploy.SourceVout != 0 {
		t.Errorf("spent deploy = %+v", deploy)
	}
	if !bytes.Equal(deploy.Source, []byte(*src.Outputs[0].LockingScript)) || !bytes.Equal(deploy.SourcePubKeyHash, mustHex(t, pkhHex)) {
		t.Errorf("spent deploy source = %x pkh %x", deploy.Source, deploy.SourcePubKeyHash)
	}
	if value.Index != 1 || value.Role != RoleValue || value.TokenID != tokenA || value.Amount != 7 ||
		value.SourceRole != RoleValue || value.Outpoint != srcTxid+".1" {
		t.Errorf("value input = %+v", value)
	}
	if len(ClassifyAdmittedInputs(tx, nil)) != 0 {
		t.Error("no previous coins must classify nothing")
	}
}

func TestLedgerOrderInputOnlyTokensLast(t *testing.T) {
	src := txWithOutputs(mustLock(t, tokenB, 3), mustLock(t, tokenA, 4))
	tx := txWithOutputs(mustLock(t, tokenA, 4), mustLock(t, tokenC, 0))
	spend(tx, src, 0)
	spend(tx, src, 1)
	txid := tx.TxID().String()
	l := BuildLedger(txid, ClassifyOutputs(tx).Outputs, ClassifyAdmittedInputs(tx, []uint32{0, 1}))
	if got := ids(l.Tokens()); !reflect.DeepEqual(got, []string{tokenA, tokenC, tokenB}) {
		t.Fatalf("order = %v", got)
	}
	a, _ := l.Get(tokenA)
	if a.ValueIn.Int64() != 4 || a.ValueOut.Int64() != 4 || !reflect.DeepEqual(a.ValueInIndices, []uint32{1}) || !reflect.DeepEqual(a.ValueOutIndices, []uint32{0}) {
		t.Errorf("A = %+v", a)
	}
	c, _ := l.Get(tokenC)
	if !reflect.DeepEqual(c.AuthorityOut, []uint32{1}) || len(c.AuthorityIn) != 0 {
		t.Errorf("C = %+v", c)
	}
	b, _ := l.Get(tokenB)
	if b.ValueIn.Int64() != 3 || b.ValueOut.Sign() != 0 {
		t.Errorf("B = %+v", b)
	}
	if _, ok := l.Get(strings.Repeat("dd", 32) + "_0"); ok {
		t.Error("Get of an unknown token = true")
	}
}

func TestLedgerSumsDoNotWrap(t *testing.T) {
	outs := []Output{
		{Index: 0, Role: RoleValue, TokenID: tokenA, Amount: math.MaxUint64},
		{Index: 1, Role: RoleValue, TokenID: tokenA, Amount: math.MaxUint64},
	}
	ins := []Input{{Index: 0, Role: RoleValue, TokenID: tokenA, Amount: math.MaxUint64}, {Index: 1, Role: RoleValue, TokenID: tokenA, Amount: 1}}
	a, _ := BuildLedger(strings.Repeat("ee", 32), outs, ins).Get(tokenA)
	if a.ValueOut.String() != "36893488147419103230" || a.ValueIn.String() != "18446744073709551616" {
		t.Fatalf("sums = %s / %s", a.ValueOut, a.ValueIn)
	}
}

func TestSpecVerdictsTruthTable(t *testing.T) {
	led := func(f func(*TokenLedger)) *TokenLedger {
		l := &TokenLedger{TokenID: tokenA, AuthorityIn: []uint32{}, AuthorityOut: []uint32{}, ValueIn: new(big.Int),
			ValueOut: new(big.Int), ValueInIndices: []uint32{}, ValueOutIndices: []uint32{}}
		f(l)
		return l
	}
	for _, c := range []struct {
		name string
		l    *TokenLedger
		want SpecVerdict
	}{
		{"empty", led(func(*TokenLedger) {}), SpecVerdict{true, true, true}},
		{"authority out without input", led(func(l *TokenLedger) { l.AuthorityOut = []uint32{0} }), SpecVerdict{true, false, true}},
		{"genesis deploy at 0", led(func(l *TokenLedger) { l.HasDeploy, l.AuthorityOut = true, []uint32{0} }), SpecVerdict{true, true, true}},
		{"deploy at 1", led(func(l *TokenLedger) { l.HasDeploy, l.DeployIndex, l.AuthorityOut = true, 1, []uint32{1} }), SpecVerdict{false, false, true}},
		{"authority in and out", led(func(l *TokenLedger) { l.AuthorityIn, l.AuthorityOut = []uint32{0}, []uint32{1} }), SpecVerdict{true, true, true}},
		{"value conserved", led(func(l *TokenLedger) {
			l.ValueIn, l.ValueOut, l.ValueOutIndices = big.NewInt(5), big.NewInt(5), []uint32{0}
		}), SpecVerdict{true, true, true}},
		{"value created", led(func(l *TokenLedger) {
			l.ValueIn, l.ValueOut, l.ValueOutIndices = big.NewInt(4), big.NewInt(5), []uint32{0}
		}), SpecVerdict{true, true, false}},
		{"value minted with authority", led(func(l *TokenLedger) {
			l.AuthorityIn, l.ValueOut, l.ValueOutIndices = []uint32{0}, big.NewInt(5), []uint32{1}
		}), SpecVerdict{true, true, true}},
		{"fixed-supply genesis", led(func(l *TokenLedger) {
			l.HasDeploy, l.ValueOut, l.ValueOutIndices = true, big.NewInt(5), []uint32{0}
		}), SpecVerdict{true, true, true}},
	} {
		if got := SpecVerdicts(c.l); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}
