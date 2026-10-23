// Package colorprofile names the BRC-207 required profile a Mandala deploy declares in its `req`
// (contract §4 Revision 3, design §9 B7): only the Mandala issuer-v1 profile, pinned to this
// overlay's identity key K (no attested companion). It imports only internal/brc162, so
// package mandala and the internal/mandalatest kit can both use it.
package colorprofile

import "github.com/sirdeggen/mandala/overlay-go/internal/brc162"

// MandalaProfileID is the Mandala issuer-v1 profile (contract §4; 80 bytes).
const MandalaProfileID = "https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md"

// MandalaReq is the exact req map a Mandala deploy carries for the overlay whose identity key is
// identityKey (compressed lowercase hex, written as DAG-CBOR text):
//
//	{MandalaProfileID: {"params": {"identityKey": K}, "version": 1}}
//
// Every call returns a fresh map, so a caller may edit it.
func MandalaReq(identityKey string) brc162.CborMap {
	return brc162.CborMap{
		MandalaProfileID: brc162.CborMap{
			"params":  brc162.CborMap{"identityKey": identityKey},
			"version": uint64(1),
		},
	}
}

// MandalaReqBytes is the strict DAG-CBOR encoding of MandalaReq(identityKey): the bytes a deploy's
// re-encoded req value must equal (contract §4 step 2; F-REQ reqHex for the C.0 signer, 181 bytes).
func MandalaReqBytes(identityKey string) ([]byte, error) {
	return brc162.EncodeStrictCborValue(MandalaReq(identityKey))
}
