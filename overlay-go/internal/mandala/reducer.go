package mandala

type FrozenRef struct {
	Outpoint string `json:"outpoint" bson:"outpoint"`
	Amount   int64  `json:"amount" bson:"amount"`
	Owner    string `json:"owner" bson:"owner"`
	Reason   string `json:"reason" bson:"reason"`
	// HasFrozenRow is computed per request by AnnotateFrozenRows (A16), never
	// persisted: whether the frozen coin still has a token row, i.e. whether a
	// reissue of it can succeed.
	HasFrozenRow bool `json:"hasFrozenRow" bson:"-"`
}

type AssetAdminState struct {
	AssetID             string      `json:"assetId" bson:"assetId"`
	IssuerIdentityKey   string      `json:"issuerIdentityKey" bson:"issuerIdentityKey"`
	IsPaused            bool        `json:"isPaused" bson:"isPaused"`
	AccessMode          string      `json:"accessMode" bson:"accessMode"`
	BlockedIdentities   []string    `json:"blockedIdentities" bson:"blockedIdentities"`
	AllowedIdentities   []string    `json:"allowedIdentities" bson:"allowedIdentities"`
	FrozenOutpoints     []FrozenRef `json:"frozenOutpoints" bson:"frozenOutpoints"`
	EvictedOutpoints    []string    `json:"evictedOutpoints" bson:"evictedOutpoints"`
	LastProcessedHeight int64       `json:"lastProcessedHeight" bson:"lastProcessedHeight"`
	LastProcessedOffset int64       `json:"lastProcessedOffset" bson:"lastProcessedOffset"`
	LastAdmitSeq        int64       `json:"lastAdmitSeq" bson:"lastAdmitSeq"`
}

type FoldContext struct {
	Issuer       string
	FrozenAmount int64
	FrozenOwner  string
	HasFrozenRow bool
}

func DefaultAssetState(assetID string) AssetAdminState {
	return AssetAdminState{
		AssetID: assetID, AccessMode: "denylist",
		BlockedIdentities: []string{}, AllowedIdentities: []string{},
		FrozenOutpoints: []FrozenRef{}, EvictedOutpoints: []string{},
	}
}

func uniqueAppend(xs []string, x string) []string {
	for _, e := range xs {
		if e == x {
			return append([]string(nil), xs...)
		}
	}
	out := make([]string, 0, len(xs)+1)
	return append(append(out, xs...), x)
}

func remove(xs []string, x string) []string {
	out := make([]string, 0, len(xs))
	for _, e := range xs {
		if e != x {
			out = append(out, e)
		}
	}
	return out
}

func removeFrozen(xs []FrozenRef, outpoint string) []FrozenRef {
	out := make([]FrozenRef, 0, len(xs))
	for _, e := range xs {
		if e.Outpoint != outpoint {
			out = append(out, e)
		}
	}
	return out
}

func FoldAction(prev AssetAdminState, details ActionDetails, ctx FoldContext) AssetAdminState {
	s := prev // value copy; slice fields replaced below before any change
	switch details.Kind() {
	case "register":
		if ctx.Issuer != "" {
			s.IssuerIdentityKey = ctx.Issuer
		}
	case "pause":
		s.IsPaused = true
	case "unpause":
		s.IsPaused = false
	case "blockIdentity":
		if k, ok := details.Str("identityKey"); ok {
			s.BlockedIdentities = uniqueAppend(prev.BlockedIdentities, k)
		}
	case "unblockIdentity":
		if k, ok := details.Str("identityKey"); ok {
			s.BlockedIdentities = remove(prev.BlockedIdentities, k)
		}
	case "allowIdentity":
		if k, ok := details.Str("identityKey"); ok {
			s.AllowedIdentities = uniqueAppend(prev.AllowedIdentities, k)
		}
	case "unallowIdentity":
		if k, ok := details.Str("identityKey"); ok {
			s.AllowedIdentities = remove(prev.AllowedIdentities, k)
		}
	case "setAccessMode":
		if m, ok := details.Str("mode"); ok && (m == "denylist" || m == "allowlist") {
			s.AccessMode = m
		}
	case "freezeOutput":
		if op, ok := details.Str("outpoint"); ok {
			reason, _ := details.Str("reason")
			s.FrozenOutpoints = append(removeFrozen(prev.FrozenOutpoints, op),
				FrozenRef{Outpoint: op, Amount: ctx.FrozenAmount, Owner: ctx.FrozenOwner, Reason: reason})
		}
	case "unfreezeOutput":
		if op, ok := details.Str("outpoint"); ok {
			s.FrozenOutpoints = removeFrozen(prev.FrozenOutpoints, op)
		}
	case "reissue":
		if op, ok := details.Str("outpoint"); ok {
			s.FrozenOutpoints = removeFrozen(prev.FrozenOutpoints, op)
			s.EvictedOutpoints = uniqueAppend(prev.EvictedOutpoints, op)
		}
	}
	return s
}
