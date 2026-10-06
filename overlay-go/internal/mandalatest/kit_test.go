package mandalatest

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/spv"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/util"
	"github.com/bsv-blockchain/go-sdk/wallet"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

func TestPartiesAreTheTSVectorCast(t *testing.T) {
	// trustedIssuers[0] of mandala-rejects.json (F/ts-layers §13) is the issuer's identity.
	if Issuer.Identity != "035ab4689e400a4a160cf01cd44730845a54768df8547dcdf073d964f109f18c30" {
		t.Fatalf("Issuer.Identity = %s", Issuer.Identity)
	}
	if Overlay.PrivHex() != strings.Repeat("0a", 32) {
		t.Fatalf("Overlay.PrivHex() = %s", Overlay.PrivHex())
	}
	seen := map[string]string{}
	for _, p := range []Party{Overlay, Issuer, Holder, Receiver, Rogue} {
		if prev, dup := seen[p.Identity]; dup {
			t.Fatalf("%s and %s share an identity", prev, p.Name)
		}
		seen[p.Identity] = p.Name
		if len(p.Identity) != 66 || p.Identity != strings.ToLower(p.Identity) {
			t.Fatalf("%s identity %q is not compressed lowercase hex", p.Name, p.Identity)
		}
	}
}

type wantOut struct {
	role    brc162.Role
	tokenID string // "" for a deploy
	amount  uint64
}

func requireOutputs(t *testing.T, b *Built, want []wantOut) {
	t.Helper()
	if len(b.Tx.Outputs) != len(want) {
		t.Fatalf("%d outputs, want %d", len(b.Tx.Outputs), len(want))
	}
	for n, w := range want {
		o := b.Tx.Outputs[n]
		d, err := brc162.Decode(o.LockingScript.Bytes())
		if err != nil {
			t.Fatalf("output %d: %v", n, err)
		}
		if d.Role != w.role || d.Amount != w.amount || o.Satoshis != 1 {
			t.Fatalf("output %d: role %s amount %d sats %d, want %s %d 1", n, d.Role, d.Amount, o.Satoshis, w.role, w.amount)
		}
		gotID := ""
		if d.TokenID != nil {
			gotID = brc162.TokenIDToString(*d.TokenID)
		}
		if gotID != w.tokenID {
			t.Fatalf("output %d: token %q, want %q", n, gotID, w.tokenID)
		}
		spec := b.Outs[n]
		wantPKH := hash.Hash160(lockPubKey(t, spec.Prover, spec.Owner, keyIDOf(uint32(n))))
		if !bytes.Equal(d.RestPubKeyHash, wantPKH) {
			t.Fatalf("output %d: pkh %x, want the BRC-42 child %x", n, d.RestPubKeyHash, wantPKH)
		}
	}
}

func TestFlowsDecodeToTheirSpec(t *testing.T) {
	d := Deploy(t, Issuer, "USD")
	tok := d.Txid + "_0"
	requireOutputs(t, d, []wantOut{{brc162.RoleDeploy, "", 0}})
	is := Issue(t, d, 0, Issuer, Holder, 100)
	requireOutputs(t, is, []wantOut{{brc162.RoleAuthority, tok, 0}, {brc162.RoleValue, tok, 100}})
	tr := Transfer(t, is, 1, Receiver, 40)
	requireOutputs(t, tr, []wantOut{{brc162.RoleValue, tok, 40}, {brc162.RoleValue, tok, 60}})
	if tr.Outs[0].Owner.Name != "receiver" || tr.Outs[1].Owner.Name != "holder" || tr.Outs[0].Prover.Name != "holder" {
		t.Fatalf("transfer parties: %+v", tr.Outs)
	}
	whole := Transfer(t, tr, 0, Holder, 40)
	requireOutputs(t, whole, []wantOut{{brc162.RoleValue, tok, 40}})
	if TokenIDOf(d, 0) != tok || TokenIDOf(is, 1) != tok {
		t.Fatal("TokenIDOf")
	}
}

func verifies(t *testing.T, b *Built) {
	t.Helper()
	ctx := context.Background()
	if ok, err := spv.Verify(ctx, b.Tx, ScriptsOnlyTracker(), nil); err != nil || !ok {
		t.Fatalf("spv.Verify(built tx) = %v, %v", ok, err)
	}
	// The engine verifies the transaction it parses from the submitted BEEF, not the builder's object.
	parsed, err := transaction.NewTransactionFromBEEF(b.Beef)
	if err != nil {
		t.Fatalf("parse BEEF: %v", err)
	}
	if parsed.TxID().String() != b.Txid {
		t.Fatalf("BEEF subject %s, want %s", parsed.TxID(), b.Txid)
	}
	if ok, err := spv.Verify(ctx, parsed, ScriptsOnlyTracker(), nil); err != nil || !ok {
		t.Fatalf("spv.Verify(parsed BEEF) = %v, %v", ok, err)
	}
}

// F/ts-codec §3.14 is UNVERIFIED for Go: a P2PKH signature over the whole token script must verify.
func TestFlowsVerifyUnderSPV(t *testing.T) {
	a := Deploy(t, Issuer, "AAA")
	verifies(t, a)
	ia := Issue(t, a, 0, Issuer, Holder, 100)
	verifies(t, ia)
	ta := Transfer(t, ia, 1, Receiver, 30)
	verifies(t, ta)
	reissue := Issue(t, ia, 0, Issuer, Holder, 5) // spends the authority, not the deploy
	verifies(t, reissue)
	b := Deploy(t, Issuer, "BBB")
	ib := Issue(t, b, 0, Issuer, Holder, 7)
	two := TwoTokenTransfer(t, ta, 1, ib, 1, Receiver)
	verifies(t, two)
	withLinkage := Build(t, []In{{Src: ta, Vout: 0, WithLinkage: true}},
		[]Out{{Owner: Holder, Prover: Receiver, TokenID: TokenIDOf(ta, 0), Amount: 30}}, nil)
	verifies(t, withLinkage)
}

type envelopeProbe struct {
	Inputs []struct {
		Index   uint32          `json:"index"`
		Linkage json.RawMessage `json:"linkage"`
	} `json:"inputs"`
	Outputs []struct {
		Index   uint32          `json:"index"`
		Linkage json.RawMessage `json:"linkage"`
	} `json:"outputs"`
	Admin []struct {
		Index   uint32 `json:"index"`
		Details string `json:"details"`
	} `json:"admin"`
	DeploySig *string `json:"deploySig"`
}

type linkageProbe struct {
	Prover           string `json:"prover"`
	Verifier         string `json:"verifier"`
	Counterparty     string `json:"counterparty"`
	ProtocolID       []any  `json:"protocolID"`
	KeyID            string `json:"keyID"`
	EncryptedLinkage []int  `json:"encryptedLinkage"`
}

func probe(t *testing.T, b *Built) envelopeProbe {
	t.Helper()
	var p envelopeProbe
	if err := json.Unmarshal(b.OffChain, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestEnvelopeShapeAndKeyOrder(t *testing.T) {
	d := Deploy(t, Issuer, "USD")
	if !bytes.HasPrefix(d.OffChain, []byte(`{"inputs":[],"outputs":[{"index":0,"linkage":{"prover":"`+Issuer.Identity+`","verifier":"`+Overlay.Identity+`","counterparty":"`+Issuer.Identity+`","protocolID":[2,"mandala token"],"keyID":"out-0","encryptedLinkage":[`)) {
		t.Fatalf("deploy envelope prefix: %s", d.OffChain)
	}
	if !bytes.Contains(d.OffChain, []byte(`],"admin":[],"deploySig":"`)) {
		t.Fatalf("deploy envelope tail: %s", d.OffChain)
	}
	is := Issue(t, d, 0, Issuer, Holder, 100)
	p := probe(t, is)
	if p.DeploySig != nil || len(p.Inputs) != 0 || len(p.Outputs) != 2 {
		t.Fatalf("issue envelope: %s", is.OffChain)
	}
	// {kind:"issue"} = a1 64'kind' 65'issue'
	if len(p.Admin) != 1 || p.Admin[0].Index != 0 || p.Admin[0].Details != "a1646b696e64656973737565" {
		t.Fatalf("issue admin entry: %+v", p.Admin)
	}
	var out1 linkageProbe
	if err := json.Unmarshal(p.Outputs[1].Linkage, &out1); err != nil {
		t.Fatal(err)
	}
	if out1.Prover != Issuer.Identity || out1.Counterparty != Holder.Identity || out1.KeyID != "out-1" || len(out1.EncryptedLinkage) == 0 {
		t.Fatalf("issue output 1 linkage: %+v", out1)
	}
	tr := Build(t, []In{{Src: is, Vout: 1, WithLinkage: true}}, []Out{{Owner: Receiver, Prover: Holder, TokenID: TokenIDOf(is, 1), Amount: 100}}, nil)
	p = probe(t, tr)
	var in0 linkageProbe
	if len(p.Inputs) != 1 || p.Inputs[0].Index != 0 {
		t.Fatalf("input linkage entries: %s", tr.OffChain)
	}
	if err := json.Unmarshal(p.Inputs[0].Linkage, &in0); err != nil {
		t.Fatal(err)
	}
	// Revealed by the coin's owner, against the coin's prover, for the coin's keyID.
	if in0.Prover != Holder.Identity || in0.Counterparty != Issuer.Identity || in0.KeyID != "out-1" {
		t.Fatalf("input linkage: %+v", in0)
	}
	noLink := Build(t, nil, []Out{{Owner: Issuer, Prover: Issuer, TokenID: TokenIDOf(d, 0), NoLinkage: true}}, nil)
	if p := probe(t, noLink); len(p.Outputs) != 0 {
		t.Fatalf("NoLinkage still wrote an outputs entry: %s", noLink.OffChain)
	}
}

func TestDeploySigVerifiesForTheIssuerOnly(t *testing.T) {
	d := Deploy(t, Issuer, "USD")
	sigHex := *probe(t, d).DeploySig
	der, err := hex.DecodeString(sigHex)
	if err != nil || sigHex != strings.ToLower(sigHex) {
		t.Fatalf("deploySig %q is not lowercase hex", sigHex)
	}
	sig, err := ec.FromDER(der)
	if err != nil {
		t.Fatal(err)
	}
	anyone, err := wallet.NewProtoWallet(wallet.ProtoWalletArgs{Type: wallet.ProtoWalletArgsTypeAnyone})
	if err != nil {
		t.Fatal(err)
	}
	check := func(txid string, owner Party) bool {
		res, err := anyone.VerifySignature(context.Background(), wallet.VerifySignatureArgs{
			EncryptionArgs: wallet.EncryptionArgs{ProtocolID: deployProtocol, KeyID: "1", Counterparty: owner.other()},
			Data:           []byte("mandala-deploy:" + txid),
			Signature:      sig,
		}, "")
		return err == nil && res.Valid
	}
	if !check(d.Txid, Issuer) {
		t.Fatal("deploySig does not verify against the issuer over its own txid")
	}
	if check(strings.Repeat("ab", 32), Issuer) {
		t.Fatal("deploySig verifies over another txid")
	}
	if check(d.Txid, Rogue) {
		t.Fatal("deploySig verifies against another owner")
	}
}

func TestSubmitBodyFraming(t *testing.T) {
	d := Deploy(t, Issuer, "USD")
	body := SubmitBody(d)
	n, size := util.NewVarIntFromBytes(body)
	if uint64(n) != uint64(len(d.Beef)) {
		t.Fatalf("CompactSize %d, want %d", n, len(d.Beef))
	}
	if !bytes.Equal(body[size:size+len(d.Beef)], d.Beef) || !bytes.Equal(body[size+len(d.Beef):], d.OffChain) {
		t.Fatal("body is not CompactSize || BEEF || off-chain")
	}
}

func TestEveryBuildHasItsOwnFunding(t *testing.T) {
	a, b := Deploy(t, Issuer, "USD"), Deploy(t, Issuer, "USD")
	if a.Txid == b.Txid {
		t.Fatal("two identical deploy specs produced one txid")
	}
}
