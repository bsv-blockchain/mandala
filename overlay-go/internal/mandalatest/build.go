package mandalatest

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/transaction/chaintracker"
	"github.com/bsv-blockchain/go-sdk/transaction/template/p2pkh"
	"github.com/bsv-blockchain/go-sdk/util"
	"github.com/bsv-blockchain/go-sdk/wallet"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// Out is one token output to build.
type Out struct {
	Owner      Party  // the identity the output locks to (linkage counterparty)
	Prover     Party  // who derives the lock and reveals the linkage (the issuer for deploy/authority outputs)
	TokenID    string // "" = deploy (OP_0 id)
	Amount     uint64
	Payload    []byte
	HasPayload bool
	Details    []byte // strict-CBOR admin details placed in env.admin at this index; nil = none
	NoLinkage  bool   // omit this output's env.outputs entry
	Satoshis   uint64 // 0 means 1
}

// In is one token input: Src's output Vout.
type In struct {
	Src         *Built
	Vout        uint32
	WithLinkage bool // add an env.inputs entry revealed by Src.Outs[Vout].Owner
}

// Built is one signed transaction and everything a test submits with it.
type Built struct {
	Tx       *transaction.Transaction
	Txid     string
	Beef     []byte // tx.AtomicBEEF(false): full ancestry, proven funding
	OffChain []byte // envelope JSON, keys in order inputs, outputs, admin[, deploySig]
	Outs     []Out  // per-output spec; keyID of output n is "out-<n>"
}

// numBytes marshals as a JSON number array, the TS shape of SpecificLinkage byte fields.
type numBytes []byte

func (n numBytes) MarshalJSON() ([]byte, error) {
	ints := make([]int, len(n))
	for i, b := range n {
		ints[i] = int(b)
	}
	return json.Marshal(ints)
}

type linkageJSON struct {
	Prover                string   `json:"prover"`
	Verifier              string   `json:"verifier"`
	Counterparty          string   `json:"counterparty"`
	ProtocolID            [2]any   `json:"protocolID"`
	KeyID                 string   `json:"keyID"`
	EncryptedLinkage      numBytes `json:"encryptedLinkage"`
	EncryptedLinkageProof numBytes `json:"encryptedLinkageProof"`
	ProofType             int      `json:"proofType"`
}

type linkedEntry struct {
	Index   uint32      `json:"index"`
	Linkage linkageJSON `json:"linkage"`
}

type adminEntry struct {
	Index   uint32 `json:"index"`
	Details string `json:"details"`
}

// envelopeJSON fixes the key order inputs, outputs, admin, deploySig (struct field order). The
// three lists are always non-nil: a JSON null list is a refusal (TS decodeEnvelope).
type envelopeJSON struct {
	Inputs    []linkedEntry `json:"inputs"`
	Outputs   []linkedEntry `json:"outputs"`
	Admin     []adminEntry  `json:"admin"`
	DeploySig string        `json:"deploySig,omitempty"`
}

func keyIDOf(vout uint32) string { return "out-" + strconv.FormatUint(uint64(vout), 10) }

// lockPubKey is the BRC-42 child of owner that prover derives for keyID: the key the output locks to.
func lockPubKey(t testing.TB, prover, owner Party, keyID string) []byte {
	t.Helper()
	pub, err := wallet.NewKeyDeriver(prover.Priv).DerivePublicKey(FTProtocol, keyID, owner.other(), false)
	if err != nil {
		t.Fatalf("mandalatest: derive %s's lock for %s (%s): %v", prover.Name, owner.Name, keyID, err)
	}
	return pub.Compressed()
}

// spendKey is the owner's private child for the same derivation: it signs the spend.
func spendKey(t testing.TB, owner, prover Party, keyID string) *p2pkh.P2PKH {
	t.Helper()
	priv, err := wallet.NewKeyDeriver(owner.Priv).DerivePrivateKey(FTProtocol, keyID, prover.other())
	if err != nil {
		t.Fatalf("mandalatest: derive %s's spend key (%s): %v", owner.Name, keyID, err)
	}
	unlock, err := p2pkh.Unlock(priv, nil)
	if err != nil {
		t.Fatal(err)
	}
	return unlock
}

// reveal is revealer's BRC-72 specific linkage for (FTProtocol, keyID) with counterparty, sealed for Overlay.
func reveal(t testing.TB, revealer, counterparty Party, keyID string) linkageJSON {
	t.Helper()
	res, err := revealer.protoWallet().RevealSpecificKeyLinkage(context.Background(), wallet.RevealSpecificKeyLinkageArgs{
		Counterparty: counterparty.other(),
		Verifier:     Overlay.Priv.PubKey(),
		ProtocolID:   FTProtocol,
		KeyID:        keyID,
	}, "")
	if err != nil {
		t.Fatalf("mandalatest: %s reveals %s: %v", revealer.Name, keyID, err)
	}
	return linkageJSON{
		Prover:                revealer.Identity,
		Verifier:              Overlay.Identity,
		Counterparty:          counterparty.Identity,
		ProtocolID:            [2]any{int(FTProtocol.SecurityLevel), FTProtocol.Protocol},
		KeyID:                 keyID,
		EncryptedLinkage:      res.EncryptedLinkage,
		EncryptedLinkageProof: res.EncryptedLinkageProof,
		ProofType:             int(res.ProofType),
	}
}

var fundingSeq atomic.Uint32

// fundingSource is a fresh one-output P2PKH coin of fundingParty, proven by a single-leaf merkle
// path. Each one sits at its own block height: AtomicBEEF combines same-height bumps and fails on
// two different roots at one height.
func fundingSource() *transaction.Transaction {
	n := fundingSeq.Add(1)
	src := transaction.NewTransaction()
	src.LockTime = n
	lock := script.Script(append(append([]byte{0x76, 0xa9, 0x14}, hash.Hash160(fundingParty.Priv.PubKey().Compressed())...), 0x88, 0xac))
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1000, LockingScript: &lock})
	isTxid := true
	src.MerklePath = transaction.NewMerklePath(1000+n, [][]*transaction.PathElement{{{Offset: 0, Hash: src.TxID(), Txid: &isTxid}}})
	return src
}

// deploySig is D §5.3's signature: signer's ProtoWallet over "mandala-deploy:"+txid, counterparty anyone.
func deploySig(t testing.TB, signer Party, txid string) string {
	t.Helper()
	res, err := signer.protoWallet().CreateSignature(context.Background(), wallet.CreateSignatureArgs{
		EncryptionArgs: wallet.EncryptionArgs{
			ProtocolID:   deployProtocol,
			KeyID:        "1",
			Counterparty: wallet.Counterparty{Type: wallet.CounterpartyTypeAnyone},
		},
		Data: wallet.BytesList("mandala-deploy:" + txid),
	}, "")
	if err != nil {
		t.Fatalf("mandalatest: deploySig: %v", err)
	}
	der, err := res.Signature.ToDER()
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(der)
}

// Build signs one transaction: token inputs first (in ins order), then one fresh proven funding
// input; one output per outs entry, locked to the Owner's BRC-42 child derived by the Prover for
// (FTProtocol, "out-<n>") and revealed to Overlay. deploySigBy != nil adds a deploySig over the txid.
func Build(t testing.TB, ins []In, outs []Out, deploySigBy *Party) *Built {
	t.Helper()
	tx := transaction.NewTransaction()
	env := envelopeJSON{Inputs: []linkedEntry{}, Outputs: []linkedEntry{}, Admin: []adminEntry{}}
	for i, in := range ins {
		if in.Src == nil || int(in.Vout) >= len(in.Src.Outs) {
			t.Fatalf("mandalatest: input %d names no built output", i)
		}
		spec := in.Src.Outs[in.Vout]
		keyID := keyIDOf(in.Vout)
		tx.AddInput(&transaction.TransactionInput{
			SourceTXID:              in.Src.Tx.TxID(),
			SourceTxOutIndex:        in.Vout,
			SourceTransaction:       in.Src.Tx,
			UnlockingScriptTemplate: spendKey(t, spec.Owner, spec.Prover, keyID),
			SequenceNumber:          0xffffffff,
		})
		if in.WithLinkage {
			env.Inputs = append(env.Inputs, linkedEntry{Index: uint32(i), Linkage: reveal(t, spec.Owner, spec.Prover, keyID)})
		}
	}
	funding := fundingSource()
	fundingUnlock, err := p2pkh.Unlock(fundingParty.Priv, nil)
	if err != nil {
		t.Fatal(err)
	}
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID:              funding.TxID(),
		SourceTxOutIndex:        0,
		SourceTransaction:       funding,
		UnlockingScriptTemplate: fundingUnlock,
		SequenceNumber:          0xffffffff,
	})
	for n, o := range outs {
		keyID := keyIDOf(uint32(n))
		lock, err := brc162.Lock(brc162.LockParams{
			TokenID:    o.TokenID,
			Amount:     o.Amount,
			PubKeyHash: hash.Hash160(lockPubKey(t, o.Prover, o.Owner, keyID)),
			Payload:    o.Payload,
			HasPayload: o.HasPayload,
		})
		if err != nil {
			t.Fatalf("mandalatest: output %d: %v", n, err)
		}
		sats := o.Satoshis
		if sats == 0 {
			sats = 1
		}
		s := script.Script(lock)
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: sats, LockingScript: &s})
		if !o.NoLinkage {
			env.Outputs = append(env.Outputs, linkedEntry{Index: uint32(n), Linkage: reveal(t, o.Prover, o.Owner, keyID)})
		}
		if o.Details != nil {
			env.Admin = append(env.Admin, adminEntry{Index: uint32(n), Details: hex.EncodeToString(o.Details)})
		}
	}
	if err := tx.Sign(); err != nil {
		t.Fatalf("mandalatest: sign: %v", err)
	}
	txid := tx.TxID().String()
	if deploySigBy != nil {
		env.DeploySig = deploySig(t, *deploySigBy, txid)
	}
	beef, err := tx.AtomicBEEF(false)
	if err != nil {
		t.Fatalf("mandalatest: atomic BEEF: %v", err)
	}
	offChain, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return &Built{Tx: tx, Txid: txid, Beef: beef, OffChain: offChain, Outs: append([]Out(nil), outs...)}
}

// SubmitBody is the /submit body with x-includes-off-chain-values: CompactSize(len(Beef)) || Beef || OffChain.
func SubmitBody(b *Built) []byte {
	body := append([]byte{}, util.VarInt(uint64(len(b.Beef))).Bytes()...)
	body = append(body, b.Beef...)
	return append(body, b.OffChain...)
}

// TokenIDOf is the token id of b's output vout: "<b.Txid>_0" for a deploy, else the output's TokenID.
func TokenIDOf(b *Built, vout uint32) string {
	if b.Outs[vout].TokenID == "" {
		return b.Txid + "_0"
	}
	return b.Outs[vout].TokenID
}

type scriptsOnlyTracker struct{}

func (scriptsOnlyTracker) IsValidRootForHeight(context.Context, *chainhash.Hash, uint32) (bool, error) {
	return true, nil
}

func (scriptsOnlyTracker) CurrentHeight(context.Context) (uint32, error) { return 0, nil }

// ScriptsOnlyTracker accepts every merkle root (CurrentHeight 0), so SPV reduces to script checks.
func ScriptsOnlyTracker() chaintracker.ChainTracker { return scriptsOnlyTracker{} }
