package brc162

import (
	"fmt"
	"math/big"
	"slices"

	"github.com/bsv-blockchain/go-sdk/transaction"
)

// Layer A (design §3, §4.1): the generic BRC-162 rules, ported from
// @bsv/overlay-topics src/brc162/ledger.ts (ts-stack 37468f290). It never
// refuses: a token-shaped output the codec refuses is listed in Invalid, and
// the Mandala layers decide what to reject.

// Output is TS Brc162Output plus the raw locking script.
type Output struct {
	Index            uint32
	Satoshis         uint64
	Role             Role
	TokenID          string // deploy: DeployTokenID(txid, Index); else TokenIDToString(*Decoded.TokenID)
	Amount           uint64
	Payload          []byte
	HasPayload       bool
	PayloadCanonical bool
	RestPubKeyHash   []byte
	Script           []byte // raw locking script bytes
}

// InvalidOutput is TS InvalidTokenOutput.
type InvalidOutput struct {
	Index  uint32
	Detail string // CodecError.Message
}

// Input is TS Brc162Input plus what the §4.2a repair and layer B read from the source output.
type Input struct {
	Index            uint32 // input index in the spending tx
	Role             Role   // RoleAuthority (amount 0, includes a spent vout-0 deploy) or RoleValue
	TokenID          string
	Amount           uint64
	SourceTxid       string // source tx display hex, lowercase
	SourceVout       uint32
	Outpoint         string // SourceTxid + "." + SourceVout
	Source           []byte // the source output's raw locking script bytes (the §4.2a repair compares these)
	SourceRole       Role   // the source script's own role (RoleDeploy for a spent deploy)
	SourcePubKeyHash []byte // the source script's RestPubKeyHash; nil when none
}

// Classification is TS Brc162Classification.
type Classification struct {
	Outputs []Output
	Invalid []InvalidOutput
}

// TokenLedger is TS TokenLedger; HasDeploy stands for `deployIndex !== undefined`.
type TokenLedger struct {
	TokenID         string
	HasDeploy       bool
	DeployIndex     uint32
	AuthorityIn     []uint32 // input indices
	AuthorityOut    []uint32 // output indices; a deploy counts here
	ValueIn         *big.Int
	ValueOut        *big.Int
	ValueInIndices  []uint32
	ValueOutIndices []uint32
}

// Ledger is TS buildLedger's Map: insertion order is semantic (fact base
// ts-layers §14.1), so it is a slice plus an index, never a bare map.
type Ledger struct {
	order []string
	byID  map[string]*TokenLedger
}

// Tokens returns output tokens in output order, then input-only tokens in ascending input order.
func (l *Ledger) Tokens() []*TokenLedger {
	out := make([]*TokenLedger, len(l.order))
	for i, id := range l.order {
		out[i] = l.byID[id]
	}
	return out
}

func (l *Ledger) Get(tokenID string) (*TokenLedger, bool) {
	t, ok := l.byID[tokenID]
	return t, ok
}

func (l *Ledger) ledgerFor(tokenID string) *TokenLedger {
	if t, ok := l.byID[tokenID]; ok {
		return t
	}
	t := &TokenLedger{
		TokenID:         tokenID,
		AuthorityIn:     []uint32{},
		AuthorityOut:    []uint32{},
		ValueIn:         new(big.Int),
		ValueOut:        new(big.Int),
		ValueInIndices:  []uint32{},
		ValueOutIndices: []uint32{},
	}
	l.order = append(l.order, tokenID)
	l.byID[tokenID] = t
	return t
}

// SpecVerdict is TS SpecVerdict.
type SpecVerdict struct{ DeployValid, AuthorityOutputsValid, ValueOutputsValid bool }

// DeployTokenID names a deploy by its own outpoint (ledger.ts:65).
func DeployTokenID(txid string, index uint32) string { return fmt.Sprintf("%s_%d", txid, index) }

func scriptBytes(o *transaction.TransactionOutput) []byte {
	if o == nil || o.LockingScript == nil {
		return nil
	}
	return []byte(*o.LockingScript)
}

// ClassifyOutputs ports classifyOutputs (ledger.ts:100-111): not token-shaped
// -> skipped; codec refusal -> Invalid (index order); else Outputs.
func ClassifyOutputs(tx *transaction.Transaction) Classification {
	txid := tx.TxID().String()
	c := Classification{Outputs: []Output{}, Invalid: []InvalidOutput{}}
	for i, o := range tx.Outputs {
		script := scriptBytes(o)
		if !IsTokenShaped(script) {
			continue
		}
		index := uint32(i)
		d, err := Decode(script)
		if err != nil {
			c.Invalid = append(c.Invalid, InvalidOutput{Index: index, Detail: err.Error()})
			continue
		}
		tokenID := DeployTokenID(txid, index)
		if d.TokenID != nil {
			tokenID = TokenIDToString(*d.TokenID)
		}
		c.Outputs = append(c.Outputs, Output{
			Index:            index,
			Satoshis:         o.Satoshis,
			Role:             d.Role,
			TokenID:          tokenID,
			Amount:           d.Amount,
			Payload:          d.Payload,
			HasPayload:       d.HasPayload,
			PayloadCanonical: d.PayloadCanonical,
			RestPubKeyHash:   d.RestPubKeyHash,
			Script:           append([]byte{}, script...),
		})
	}
	return c
}

// ClassifyAdmittedInputs ports classifyAdmittedInputs (ledger.ts:151-161):
// previousCoins deduplicated and ascending; silently skips an index out of
// range, an input without SourceTransaction, a missing source output, a source
// that is not token-shaped or that the codec refuses, and a deploy source at
// vout != 0. The role comes from the amount alone, so a spent vout-0 deploy is
// an authority input named <sourceTxid>_0.
func ClassifyAdmittedInputs(tx *transaction.Transaction, previousCoins []uint32) []Input {
	indices := slices.Clone(previousCoins)
	slices.Sort(indices)
	indices = slices.Compact(indices)
	inputs := []Input{}
	for _, index := range indices {
		if int(index) >= len(tx.Inputs) || tx.Inputs[index] == nil {
			continue
		}
		spend := tx.Inputs[index]
		source := spend.SourceTransaction
		if source == nil {
			continue
		}
		vout := spend.SourceTxOutIndex
		if int(vout) >= len(source.Outputs) {
			continue
		}
		script := scriptBytes(source.Outputs[vout])
		if !IsTokenShaped(script) {
			continue
		}
		d, err := Decode(script)
		if err != nil {
			continue
		}
		sourceTxid := source.TxID().String()
		var tokenID string
		switch {
		case d.TokenID != nil:
			tokenID = TokenIDToString(*d.TokenID)
		case vout == 0:
			tokenID = DeployTokenID(sourceTxid, 0)
		default:
			continue
		}
		role := RoleValue
		if d.Amount == 0 {
			role = RoleAuthority
		}
		inputs = append(inputs, Input{
			Index:            index,
			Role:             role,
			TokenID:          tokenID,
			Amount:           d.Amount,
			SourceTxid:       sourceTxid,
			SourceVout:       vout,
			Outpoint:         fmt.Sprintf("%s.%d", sourceTxid, vout),
			Source:           append([]byte{}, script...),
			SourceRole:       d.Role,
			SourcePubKeyHash: d.RestPubKeyHash,
		})
	}
	return inputs
}

// BuildLedger ports buildLedger (ledger.ts:201-220): outputs first, then
// inputs, each in the given order; a deploy output is keyed <txid>_<index>.
func BuildLedger(txid string, outputs []Output, inputs []Input) *Ledger {
	l := &Ledger{byID: map[string]*TokenLedger{}}
	for _, o := range outputs {
		tokenID := o.TokenID
		if o.Role == RoleDeploy {
			tokenID = DeployTokenID(txid, o.Index)
		}
		t := l.ledgerFor(tokenID)
		if o.Role == RoleDeploy {
			t.HasDeploy, t.DeployIndex = true, o.Index
		}
		if o.Amount == 0 {
			t.AuthorityOut = append(t.AuthorityOut, o.Index)
		} else {
			t.ValueOut.Add(t.ValueOut, new(big.Int).SetUint64(o.Amount))
			t.ValueOutIndices = append(t.ValueOutIndices, o.Index)
		}
	}
	for _, in := range inputs {
		t := l.ledgerFor(in.TokenID)
		if in.Amount == 0 {
			t.AuthorityIn = append(t.AuthorityIn, in.Index)
		} else {
			t.ValueIn.Add(t.ValueIn, new(big.Int).SetUint64(in.Amount))
			t.ValueInIndices = append(t.ValueInIndices, in.Index)
		}
	}
	return l
}

// SpecVerdicts ports specVerdicts (ledger.ts:230-240).
func SpecVerdicts(t *TokenLedger) SpecVerdict {
	deployValid := !t.HasDeploy || t.DeployIndex == 0
	authorized := len(t.AuthorityIn) > 0
	isGenesis := func(i uint32) bool { return deployValid && t.HasDeploy && i == t.DeployIndex }
	every := func(xs []uint32) bool {
		for _, x := range xs {
			if !isGenesis(x) {
				return false
			}
		}
		return true
	}
	return SpecVerdict{
		DeployValid:           deployValid,
		AuthorityOutputsValid: authorized || every(t.AuthorityOut),
		ValueOutputsValid:     authorized || t.ValueIn.Cmp(t.ValueOut) >= 0 || every(t.ValueOutIndices),
	}
}
