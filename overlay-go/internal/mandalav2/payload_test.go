package mandalav2

import "testing"

func TestDecodeLinkagePayload(t *testing.T) {
	raw := []byte(`{
	  "inputs":[{"index":0,"linkage":{"prover":"02aa","verifier":"02bb","counterparty":"02cc",
	    "protocolID":[2,"mandala token"],"keyID":"k1",
	    "encryptedLinkage":[1,2,3],"encryptedLinkageProof":[0],"proofType":0}}],
	  "outputs":[],
	  "admin":[{"index":1,"actionDetails":{"kind":"issue","assetId":"a.0","amount":100}}]
	}`)
	p, err := DecodeLinkagePayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Inputs) != 1 || p.Inputs[0].Index != 0 {
		t.Fatalf("inputs: %+v", p.Inputs)
	}
	l := p.Inputs[0].Linkage
	if l.ProtocolID.SecurityLevel != 2 || l.ProtocolID.Name != "mandala token" {
		t.Fatalf("protocolID: %+v", l.ProtocolID)
	}
	if string(l.EncryptedLinkage) != "\x01\x02\x03" {
		t.Fatalf("encryptedLinkage: %v", l.EncryptedLinkage)
	}
	if p.Admin[0].ActionDetails.Kind() != "issue" {
		t.Fatalf("admin kind: %+v", p.Admin[0].ActionDetails)
	}
	if n, ok := p.Admin[0].ActionDetails.Num("amount"); !ok || n != 100 {
		t.Fatalf("amount: %d %v", n, ok)
	}
}

func TestDecodeLinkagePayloadEmpty(t *testing.T) {
	for _, in := range [][]byte{nil, {}} {
		p, err := DecodeLinkagePayload(in)
		if err != nil || len(p.Inputs) != 0 || len(p.Outputs) != 0 || len(p.Admin) != 0 {
			t.Fatalf("empty payload: %+v %v", p, err)
		}
	}
}

func TestProtocolIDRejectsWrongArity(t *testing.T) {
	var p ProtocolID
	if err := p.UnmarshalJSON([]byte(`[2,"mandala token","extra"]`)); err == nil {
		t.Fatal("3-element protocolID must error")
	}
	if err := p.UnmarshalJSON([]byte(`[2]`)); err == nil {
		t.Fatal("1-element protocolID must error")
	}
}

func TestNumRejectsBeyondMaxSafe(t *testing.T) {
	d := ActionDetails{"amount": float64(9007199254740993)} // 2^53+1, unrepresentable
	if _, ok := d.Num("amount"); ok {
		t.Fatal("beyond-max-safe amount must be rejected")
	}
	d2 := ActionDetails{"amount": float64(9007199254740991)}
	if n, ok := d2.Num("amount"); !ok || n != 9007199254740991 {
		t.Fatal("max-safe amount must pass")
	}
}
