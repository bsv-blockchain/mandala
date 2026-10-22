// Package colorprofile names the BRC-207 required profiles a Mandala deploy declares in its `req`
// (contract §4, design C3): the attested profile in identity trust mode and the Mandala issuer-v1
// profile, both pinned to this overlay's identity key K. It imports only internal/brc162, so
// package mandala and the internal/mandalatest kit can both use it.
package colorprofile

import "github.com/sirdeggen/mandala/overlay-go/internal/brc162"

// AttestedProfileID is the BRC-207 built-in attested profile (contract §4).
const AttestedProfileID = "https://brc.dev/207/attested"

// MandalaProfileID is the Mandala issuer-v1 profile (contract §4; 80 bytes).
const MandalaProfileID = "https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md"

// MandalaReq is the exact req map a Mandala deploy carries for the overlay whose identity key is
// identityKey (compressed lowercase hex, written as DAG-CBOR text):
//
//	{AttestedProfileID: {"params": {"identityKey": K, "trustMode": "identity"}, "version": 1},
//	 MandalaProfileID:  {"params": {"identityKey": K}, "version": 1}}
//
// Every call returns a fresh map, so a caller may edit it.
func MandalaReq(identityKey string) brc162.CborMap {
	return brc162.CborMap{
		AttestedProfileID: brc162.CborMap{
			"params":  brc162.CborMap{"identityKey": identityKey, "trustMode": "identity"},
			"version": uint64(1),
		},
		MandalaProfileID: brc162.CborMap{
			"params":  brc162.CborMap{"identityKey": identityKey},
			"version": uint64(1),
		},
	}
}

// MandalaReqBytes is the strict DAG-CBOR encoding of MandalaReq(identityKey): the bytes a deploy's
// re-encoded req value must equal (contract §4 step 2; F-REQ reqHex for the C.0 signer, 328 bytes).
func MandalaReqBytes(identityKey string) ([]byte, error) {
	return brc162.EncodeStrictCborValue(MandalaReq(identityKey))
}
