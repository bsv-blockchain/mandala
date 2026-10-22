package mandala

// Documentation served by GetDocumentation for every Mandala topic manager and lookup service.
// Short on purpose: the 1Color/BRC-207 conformance design and the interface contract are the reference.
// None of these strings claims 1Color color-service conformance: Mandala reads and writes BRC-162 outputs
// under its own issuer policy and advertises no color service (design §3).
const (
	docTokenTopic = `Mandala token topic tm_color_<assetId> (<assetId> = <deploy txid>_0): admits the BRC-162
(1Color) outputs of one Mandala token (authority and value) after the codec and ledger check and the
Mandala issuer policy: 1-sat token outputs, holder inputs equal outputs, 32-byte token ids only, trusted
issuer and deploySig, deploy req = the attested profile and issuer-v1 naming this overlay's identity
key (ext refused, payload at most 65536 bytes and 64 deep), membership, sanctions, freeze, pause and
the admin chain. Amounts are uint64 per output; sums and supply are exact. The first refusal wins and
every refusal is a typed Mandala code. Off-chain values carry the envelope {inputs, outputs, admin[,
deploySig]}. Each admitted STEAK entry carries the BRC-207 attested admission signature (statement
1color-admit:v1, child key [2, "color admission attestation"], keyID 1, counterparty anyone).`

	docTokenRegistryTopic = `Mandala token registry tm_mandala: admits output 0 of a deploy transaction and
nothing else; a deploy submit names exactly ["tm_mandala", "tm_color_<txid>_0"]. It runs the deploy
token's own tm_color_<assetId> check as a dry run first, so tm_mandala and tm_color_<assetId> always
agree on a refusal. Its STEAK entries keep the Mandala sigma-I v3 admission signature (bare overlay key).`

	docTokenLookup = `Mandala token lookup ls_color_<assetId>: indexes what tm_color_<assetId> admits (owner
rows, balances, linkage records, deploy metadata, committed admin actions folded into the asset
state). Lookup answers outpoints only. Mandala keys: metadataTokenId, authoritiesTokenId, tokenId, or
txid with outputIndex; limit 1-100, skip 0-100000. Color keys (interface compatibility only, nothing is
advertised): {type: "color-spendability" | "color-admission", version: 1, assetId, topic, outpoints:
1-1000 unique "<txid>.<vout>"}; color-spendability answers the admitted, unspent, unfrozen, unreissued
outpoints, color-admission every admitted outpoint, spent or not. It answers for its own token only: a
token id naming another token is an invalid query, and an outpoint whose row belongs to another token
answers nothing. A store fault is retryable (503 ERR_UNAVAILABLE). Asset state and admin history are
served over HTTP.`

	docTokenRegistryLookup = `Mandala token registry lookup ls_mandala: one permanent record per deploy
tm_mandala admitted. {tokenId} answers the deploy outpoint; {list: true, limit, skip} answers a page
of deploy outpoints. The record list itself is served by GET /admin/tokens. At boot, before
submissions, the host runs RestoreMissingRecords: it rebuilds a lost record from the token's deploy
metadata and its deploy's owner-journal row at output 0 on tm_color_<assetId> (first write wins).`

	docKYCTopic = `Mandala identity registry tm_mandala_kyc: one BRC-162 authority chain whose committed
admitIdentity and revokeIdentity actions maintain the membership set. No value outputs; the first
trusted deploy is the registry. Its STEAK entries carry no admission signature.`

	docKYCLookup = `Mandala identity registry lookup ls_mandala_kyc: folds the admit and revoke actions of
the claimed registry chain into mandalaRegistry and tracks the registry authority. Lookup answers
nothing; the registry is served by GET /admin/registry.`
)
