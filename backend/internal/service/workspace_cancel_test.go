package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"devdeck/backend/internal/store"
)

// List fans out one goroutine per machine-assigned project to fetch worktrees.
// Those calls used context.Background(), so a client that gave up — a browser
// navigating away, or React Query retrying a request that is taking too long
// on a slow link — left every fetch running to machineclient's full 3s
// timeout. On a slow runtime that turns each abandoned page load into another
// pile of in-flight goroutines and sockets that nothing can cancel.
func TestWorkspaceListFanoutStopsWhenCallerCancels(t *testing.T) {
	st := store.NewTestStore(t)

	// A machine that never answers, so the only thing that can end the fetch
	// is cancellation or machineclient's own timeout.
	released := make(chan struct{})
	defer close(released)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-released:
		}
	}))
	defer fake.Close()

	ws, _ := st.CreateWorkspace("clients")
	m, err := st.CreateMachine("builder", fake.URL, "mkey", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"api", "web", "worker"} {
		if _, err := st.CreateProject(ws.ID, name, "/srv/"+name, "", m.ID); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	svc := NewWorkspaceService(st)

	done := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		if _, err := svc.List(ctx); err != nil {
			t.Errorf("List: %v", err)
		}
		done <- time.Since(start)
	}()

	// Caller gives up well before machineclient's 3s request timeout.
	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case elapsed := <-done:
		// Allow slack for scheduling, but it must be nowhere near the 3s
		// timeout that an uncancellable fetch would run to.
		if elapsed > 1500*time.Millisecond {
			t.Errorf("List returned %s after the caller cancelled; the per-project fetches "+
				"ignored cancellation and ran to machineclient's own timeout instead", elapsed)
		}
		t.Logf("fan-out unwound %s after cancellation", elapsed.Round(10*time.Millisecond))
	case <-time.After(5 * time.Second):
		t.Fatal("List never returned after the caller cancelled")
	}
}
