package mandala

// Layer B (D §4.2, §4.2a; TS ownership.ts, F/ts-layers §2): who owns each token output and each
// spent token input. An output's owner is proven by its envelope linkage. An input's owner is its
// stored owner row; a missing or disagreeing row is repaired inline from the append-only owner
// journal when the engine still holds the exact source output, and anything unrepairable is the
// retryable ERR_UNAVAILABLE, never a final refusal.

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// VerifiedOwner is the owner of one token output, proven by its linkage.
type VerifiedOwner struct {
	Index       uint32
	TokenID     string
	Role        brc162.Role
	Amount      uint64
	IdentityKey string // canonical compressed lowercase
	Prover      string // canonical compressed lowercase
}

// InputOwnerDeps are layer B's dependencies for the inputs of one topic.
type InputOwnerDeps struct {
	Store    StateStore
	Engine   EngineOutputReader
	Verifier LinkageVerifier
	Topic    string                               // the journal/engine topic of the coins (tm_<id> or tm_mandala_kyc)
	OnRepair func(outpoint string, inserted bool) // never nil here; managers default it to LogOwnerRepair(<topic>); nil falls back to that too
}

// sameAmount: a stored amount equals amount only when it is a safe non-negative integer (TS
// Number.isSafeInteger(stored) && BigInt(stored) === amount).
func sameAmount(stored Amount, amount uint64) bool {
	return stored >= 0 && uint64(stored) <= MaxSafeAmount && uint64(stored) == amount
}

// ownFirstFailing returns the index of the first output (index order) that fails.
func ownFirstFailing(outputs []brc162.Output, fails func(brc162.Output) bool) (uint32, bool) {
	for _, o := range outputs {
		if fails(o) {
			return o.Index, true
		}
	}
	return 0, false
}

// RequireValidTokenOutputs is the shape policy, rule-major (each rule scans every output before
// the next rule runs): codec refusals, deploy at vout 0, P2PKH remainder, 1 satoshi, amount cap.
func RequireValidTokenOutputs(invalid []brc162.InvalidOutput, outputs []brc162.Output) error {
	if len(invalid) > 0 {
		return rInvalidTokenOutput(invalid[0].Index, invalid[0].Detail)
	}
	if i, bad := ownFirstFailing(outputs, func(o brc162.Output) bool { return o.Role == brc162.RoleDeploy && o.Index != 0 }); bad {
		return rDeployNotAtZero(i)
	}
	if i, bad := ownFirstFailing(outputs, func(o brc162.Output) bool { return len(o.RestPubKeyHash) != brc162.PubKeyHashBytes }); bad {
		return rNonP2pkhRemainder(i)
	}
	if i, bad := ownFirstFailing(outputs, func(o brc162.Output) bool { return o.Satoshis != 1 }); bad {
		return rOneSat(i)
	}
	if i, bad := ownFirstFailing(outputs, func(o brc162.Output) bool { return o.Amount > MaxSafeAmount }); bad {
		return rAmountCap(i)
	}
	return nil
}

// ownLinkedIdentity is TS linkedIdentity: ok=false for no entry, no remainder pkh, a linkage of any
// malformed shape (D-13), one this overlay cannot decrypt, or one whose derived key is not the
// output's key.
func ownLinkedIdentity(ctx context.Context, raw json.RawMessage, present bool, v LinkageVerifier, pkh []byte) (identityKey, prover string, ok bool) {
	if !present || len(pkh) != brc162.PubKeyHashBytes {
		return "", "", false
	}
	l, err := ParseLinkage(raw)
	if err != nil {
		return "", "", false
	}
	id, derived, err := v.VerifyKeyLinkage(ctx, l)
	if err != nil || !bytes.Equal(derived, pkh) {
		return "", "", false
	}
	if identityKey, err = CanonicalKey(id); err != nil {
		return "", "", false
	}
	if prover, err = CanonicalKey(l.Prover); err != nil {
		return "", "", false
	}
	return identityKey, prover, true
}

// VerifyOutputOwners proves the owner of every token output (all roles) in index order; the first
// output without a verified linkage is rNoLinkage. Envelope entries for other indices are ignored.
func VerifyOutputOwners(ctx context.Context, outputs []brc162.Output, env *Envelope, v LinkageVerifier) ([]VerifiedOwner, error) {
	owners := make([]VerifiedOwner, 0, len(outputs))
	for _, o := range outputs {
		raw, present := env.OutputLinkage(o.Index)
		id, prover, ok := ownLinkedIdentity(ctx, raw, present, v, o.RestPubKeyHash)
		if !ok {
			return nil, rNoLinkage(o.Index)
		}
		owners = append(owners, VerifiedOwner{Index: o.Index, TokenID: o.TokenID, Role: o.Role, Amount: o.Amount, IdentityKey: id, Prover: prover})
	}
	return owners, nil
}

// journalAgrees: the journal row names this token, the source script's own role (a spent genesis
// deploy journals as "deploy"), this amount as a safe integer, and a compressed identity key.
func journalAgrees(j *OwnerRecord, tokenID string, role brc162.Role, amount uint64) bool {
	return j != nil && j.TokenID == tokenID && j.Role == role && sameAmount(j.Amount, amount) && IsIdentity(j.IdentityKey)
}

// ownStoredOwner reads the input's owner row (value -> mandalaTokens, else mandalaAuthorities) and
// accepts it only when it agrees with the source. The authority row's topic is not compared
// (F/ts-layers §14.7).
func ownStoredOwner(ctx context.Context, in brc162.Input, s StateStore) (string, bool, error) {
	if in.Role == brc162.RoleValue {
		row, err := s.GetTokenRow(ctx, in.SourceTxid, in.SourceVout)
		if err != nil {
			return "", false, rStoreUnavailable("the owner index", err)
		}
		if row != nil && row.TokenID == in.TokenID && IsIdentity(row.IdentityKey) && sameAmount(row.Amount, in.Amount) {
			return row.IdentityKey, true, nil
		}
		return "", false, nil
	}
	row, err := s.GetAuthorityRow(ctx, in.SourceTxid, in.SourceVout)
	if err != nil {
		return "", false, rStoreUnavailable("the owner index", err)
	}
	if row != nil && row.TokenID == in.TokenID && IsIdentity(row.IdentityKey) {
		return row.IdentityKey, true, nil
	}
	return "", false, nil
}

// ownRepairedOwner is D §4.2a rule 3: rebuild the row from the journal when the engine admitted this
// exact output (raw script bytes, R9) on this topic; take an inserted row back if the engine spent
// the coin meanwhile.
func ownRepairedOwner(ctx context.Context, in brc162.Input, d InputOwnerDeps) (string, error) {
	journal, err := d.Store.GetOwnerJournal(ctx, in.SourceTxid, in.SourceVout, d.Topic)
	if err != nil {
		return "", rStoreUnavailable("the owner index", err)
	}
	script, _, found, err := d.Engine.FindAdmittedOutput(ctx, in.SourceTxid, in.SourceVout, d.Topic)
	if err != nil {
		return "", rStoreUnavailable("the owner index", err)
	}
	if journal == nil || !found || !journalAgrees(journal, in.TokenID, in.SourceRole, in.Amount) || !bytes.Equal(script, in.Source) {
		return "", rOwnerIndexUnavailable(in.Outpoint)
	}
	inserted, err := d.Store.RepairOwnerRow(ctx, *journal)
	if err != nil {
		return "", rStoreWriteUnavailable("the owner index", err)
	}
	if inserted {
		_, _, still, err := d.Engine.FindAdmittedOutput(ctx, in.SourceTxid, in.SourceVout, d.Topic)
		if err != nil {
			return "", rStoreUnavailable("the owner index", err)
		}
		if !still {
			if err := TakeBackRepair(ctx, d.Store, in.SourceTxid, in.SourceVout, journal.Role); err != nil {
				return "", rStoreWriteUnavailable("the owner index", err)
			}
			return "", rOwnerIndexUnavailable(in.Outpoint)
		}
	}
	onRepair := d.OnRepair
	if onRepair == nil {
		onRepair = LogOwnerRepair(d.Topic)
	}
	onRepair(in.Outpoint, inserted)
	return journal.IdentityKey, nil
}

// ownLinkedProver is TS linkedProver: ok=false for a malformed linkage, one this overlay cannot
// decrypt, or one whose key (prover + L·G) does not lock the coin.
func ownLinkedProver(ctx context.Context, raw json.RawMessage, v LinkageVerifier, pkh []byte) (string, bool) {
	l, err := ParseLinkage(raw)
	if err != nil {
		return "", false
	}
	p, derived, err := v.VerifyInputLinkage(ctx, l)
	if err != nil || len(pkh) != brc162.PubKeyHashBytes || !bytes.Equal(derived, pkh) {
		return "", false
	}
	prover, err := CanonicalKey(p)
	if err != nil {
		return "", false
	}
	return prover, true
}

// ownRequireInputLinkage: an input linkage is optional; when present it must control the coin and
// name its owner (both final ERR_LINKAGE).
func ownRequireInputLinkage(ctx context.Context, in brc162.Input, owner string, env *Envelope, v LinkageVerifier) error {
	raw, present := env.InputLinkage(in.Index)
	if !present {
		return nil
	}
	prover, ok := ownLinkedProver(ctx, raw, v, in.SourcePubKeyHash)
	if !ok {
		return rInputLinkageControl(in.Index)
	}
	if prover != owner {
		return rInputLinkageOwner(in.Index, prover, owner)
	}
	return nil
}

// ResolveInputOwners maps input index -> owner for every classified input, in input order; each
// input is judged fully (stored owner or repair, then its linkage) before the next, so an index
// fault is always ERR_UNAVAILABLE and never ERR_LINKAGE.
func ResolveInputOwners(ctx context.Context, inputs []brc162.Input, env *Envelope, d InputOwnerDeps) (map[uint32]string, error) {
	owners := make(map[uint32]string, len(inputs))
	for _, in := range inputs {
		owner, ok, err := ownStoredOwner(ctx, in, d.Store)
		if err != nil {
			return nil, err
		}
		if !ok {
			if owner, err = ownRepairedOwner(ctx, in, d); err != nil {
				return nil, err
			}
		}
		if err := ownRequireInputLinkage(ctx, in, owner, env, d.Verifier); err != nil {
			return nil, err
		}
		owners[in.Index] = owner
	}
	return owners, nil
}

// TakeBackRepair undoes a repaired row exactly as the lookup's spend does: a value row debits its
// owner only when this call removed it; any other role takes the authority row.
func TakeBackRepair(ctx context.Context, s RepairUndoStore, txid string, vout uint32, role brc162.Role) error {
	if role != brc162.RoleValue {
		_, err := s.TakeAuthority(ctx, txid, vout)
		return err
	}
	row, err := s.TakeToken(ctx, txid, vout)
	if err != nil || row == nil {
		return err
	}
	return s.AdjustBalance(ctx, row.IdentityKey, -int64(row.Amount))
}

// JournalOwners writes one journal row per verified owner (D §4.2a rule 1) with one shared
// createdAt; a store fault is rStoreWriteUnavailable("the owner journal", err).
func JournalOwners(ctx context.Context, s StateStore, topic, txid string, owners []VerifiedOwner) error {
	at := time.Now().UTC()
	rows := make([]OwnerRecord, 0, len(owners))
	for _, o := range owners {
		rows = append(rows, OwnerRecord{
			Txid: txid, OutputIndex: o.Index, Topic: topic, TokenID: o.TokenID, Role: o.Role,
			Amount:      Amount(o.Amount), // layer B caps every amount at 2^53-1, so this is exact
			IdentityKey: o.IdentityKey, CreatedAt: at,
		})
	}
	if err := s.RecordOwners(ctx, rows); err != nil {
		return rStoreWriteUnavailable("the owner journal", err)
	}
	return nil
}

// LogOwnerRepair is the default repair log, labelled with the repairing manager or topic.
func LogOwnerRepair(label string) func(outpoint string, inserted bool) {
	return func(outpoint string, inserted bool) {
		what := "row corrected"
		if inserted {
			what = "row inserted"
		}
		log.Printf("[%s] owner index repaired for %s from the owner journal (%s)", label, outpoint, what)
	}
}
