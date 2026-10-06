package mandala

// Documentation served by GetDocumentation for every Mandala topic manager and lookup service.
// Short on purpose: the BRC-162 design (D) and the token-topics design (TT) are the reference.
const (
	docTokenTopic = `Mandala token topic tm_<deploy txid>: admits the BRC-162 outputs of one Mandala token
(authority and value) after layers A-D of the BRC-162 design: codec and ledger, ownership and
linkage, issuer authority, issuer controls. The first refusal wins and every refusal is a typed
Mandala code. Off-chain values carry the envelope {inputs, outputs, admin[, deploySig]}.`

	docTokenRegistryTopic = `Mandala token registry tm_mandala: admits output 0 of a deploy transaction and
nothing else. It runs the deploy token's own topic check as a dry run first, so tm_mandala and
tm_<deploy txid> always agree on a refusal.`

	docTokenLookup = `Mandala token lookup ls_<deploy txid>: indexes what tm_<deploy txid> admits (owner
rows, balances, linkage records, deploy metadata, committed admin actions folded into the asset
state). Lookup answers outpoints only: metadataTokenId, authoritiesTokenId, tokenId, or txid with
outputIndex; limit 1-100, skip 0-100000. It answers for its own token <deploy txid>_0 only: a token id
naming another token is an invalid query, and an outpoint whose row belongs to another token answers
nothing. Asset state and admin history are served over HTTP.`

	docTokenRegistryLookup = `Mandala token registry lookup ls_mandala: one permanent record per deploy
tm_mandala admitted. {tokenId} answers the deploy outpoint; {list: true, limit, skip} answers a page
of deploy outpoints. The record list itself is served by GET /admin/tokens. At boot, before
submissions, the host runs RestoreMissingRecords: it rebuilds a lost record from the token's deploy
metadata and its deploy's owner-journal row at output 0 on tm_<deploy txid> (first write wins).`

	docKYCTopic = `Mandala identity registry tm_mandala_kyc: one BRC-162 authority chain whose committed
admitIdentity and revokeIdentity actions maintain the membership set. No value outputs; the first
trusted deploy is the registry.`

	docKYCLookup = `Mandala identity registry lookup ls_mandala_kyc: folds the admit and revoke actions of
the claimed registry chain into mandalaRegistry and tracks the registry authority. Lookup answers
nothing; the registry is served by GET /admin/registry.`
)
