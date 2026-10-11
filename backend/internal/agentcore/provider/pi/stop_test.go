package pi

import (
	"context"
	"testing"
	"time"
)

func TestStopSessionWaitsForProviderExit(t *testing.T) {
	canceled := make(chan struct{})
	done := make(chan struct{})
	sess := &session{threadID: "w-1", cancel: func() { close(canceled) }, done: done}
	a := &adapter{sessions: map[string]*session{"w-1": sess}}
	result := make(chan error, 1)
	go func() { result <- a.StopSession(context.Background(), "w-1") }()
	<-canceled
	select {
	case err := <-result:
		t.Fatalf("stop acknowledged before provider exit: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(done)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("stop never acknowledged provider exit")
	}
	if a.HasSession("w-1") {
		t.Fatal("stopped binding retained")
	}
}

func TestStopSessionCancellationDoesNotAcknowledgeOrLoseRetry(t *testing.T) {
	done := make(chan struct{})
	sess := &session{threadID: "w-1", cancel: func() {}, done: done}
	a := &adapter{sessions: map[string]*session{"w-1": sess}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := a.StopSession(ctx, "w-1"); err != context.Canceled {
		t.Fatalf("unconfirmed stop: %v", err)
	}
	if !a.HasSession("w-1") {
		t.Fatal("unconfirmed stop lost retry binding")
	}
	close(done)
	if err := a.StopSession(context.Background(), "w-1"); err != nil {
		t.Fatal(err)
	}
}
