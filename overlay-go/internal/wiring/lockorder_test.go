package wiring

// Review Focus 3 (Q3 plan): a double-clicked deploy beside maintenance. Two
// identical deploy submits each hold the submit gate's shared slot, call
// TokenTopics.Ensure for the same token and run the real engine Submit on its
// topic, while an owner-index refold asks for the gate's exclusive section.
// Lock order under test: gate shared slot -> registrar mutex; the exclusive
// section waits for both slots and never calls Ensure.

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"

	"github.com/sirdeggen/mandala/overlay-go/internal/maintenance"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

func TestLockOrderConcurrentDeploysWithMaintenance(t *testing.T) {
	db := testmongo.DB(t, "mandala3_test_lockorder")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	eng, es := newProbeEngine(t, db, map[string]engine.TopicManager{}, nil)
	deploy := probeSource(t, 3001)
	txid := deploy.TxID().String()
	tokenID, topic := txid+"_0", "tm_"+txid
	beef := atomicBEEF(t, deploy)

	factory := &countingFactory{}
	tokens := NewTokenTopics(eng, nil, false, factory.build)
	gate := maintenance.NewGate(5 * time.Second) // a deadlock surfaces as *BusyError inside the 10 s deadline

	var released atomic.Int32
	entered := make(chan struct{}, 2)
	proceed := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			release, err := gate.Enter(ctx)
			if err != nil {
				results <- err
				return
			}
			entered <- struct{}{}
			<-proceed
			results <- func() error {
				defer func() { released.Add(1); release() }()
				ok, err := tokens.Ensure(tokenID)
				if err != nil {
					return err
				}
				if !ok {
					return errors.New("Ensure returned false")
				}
				_, err = eng.Submit(ctx, overlay.TaggedBEEF{Beef: beef, Topics: []string{topic}}, engine.SubmitModeCurrent, nil)
				return err
			}()
		}()
	}
	// Barrier: both shared slots are held before maintenance asks for the gate,
	// so writer preference cannot keep either submit out.
	for range 2 {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("the submits never entered the gate")
		}
	}

	var releasesSeen atomic.Int32
	releasesSeen.Store(-1)
	exclusiveErr := make(chan error, 1)
	go func() {
		exclusiveErr <- gate.Exclusive(ctx, func(context.Context) error {
			releasesSeen.Store(released.Load())
			return nil
		})
	}()
	for !gate.Busy() {
		select {
		case <-ctx.Done():
			t.Fatal("the exclusive section never started waiting")
		case <-time.After(time.Millisecond):
		}
	}
	close(proceed)

	for range 2 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("deploy submit: %v", err)
			}
		case <-ctx.Done():
			t.Fatal("deadlock: a deploy submit did not finish within 10 s")
		}
	}
	select {
	case err := <-exclusiveErr:
		if err != nil {
			t.Fatalf("Exclusive: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("deadlock: the exclusive section did not finish within 10 s")
	}
	if n := releasesSeen.Load(); n != 2 {
		t.Fatalf("the exclusive section started after %d releases, want 2", n)
	}
	if n := factory.calls.Load(); n != 1 {
		t.Fatalf("factory builds = %d, want exactly 1", n)
	}
	if !tokens.Hosted(tokenID) || !eng.HasTopicManager(topic) || !eng.HasLookupService("ls_"+txid) {
		t.Fatal("the token topic is not registered")
	}
	if ok, err := es.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: deploy.TxID(), Topic: topic}); err != nil || !ok {
		t.Fatalf("applied record on %s = %v (%v), want present", topic, ok, err)
	}
}
