package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"devdeck/backend/internal/store"
)

func TestBindingStatusCacheGetMissReturnsFalse(t *testing.T) {
	c := NewBindingStatusCache()
	if _, ok := c.Get("m-none"); ok {
		t.Error("Get on an empty cache should return ok=false")
	}
}

func TestBindingStatusCacheSetThenGet(t *testing.T) {
	c := NewBindingStatusCache()
	c.Set("m-1", BindingStatus{HubReachable: true, Adopted: true})
	status, ok := c.Get("m-1")
	if !ok || !status.Adopted {
		t.Errorf("Get = %+v, %v, want Adopted=true", status, ok)
	}
}

func newTestStoreForBindingPush(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return store.New(db)
}

func TestPushBindingsOnceSkipsLocalMachines(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		json.NewEncoder(w).Encode(map[string]bool{"adopted": true})
	}))
	t.Cleanup(srv.Close)

	st := newTestStoreForBindingPush(t)
	if _, err := st.CreateMachine("local-machine", srv.URL, "k", true); err != nil {
		t.Fatal(err)
	}

	c := NewBindingStatusCache()
	pushBindingsOnce(context.Background(), st, c, func() (string, bool, string) {
		return "https://hub.example.ts.net", true, ""
	})

	if called {
		t.Error("a local machine (same process as the hub) must never receive a binding push")
	}
}

func TestPushBindingsOnceRecordsUnreachableHubWithoutCallingMachine(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	t.Cleanup(srv.Close)

	st := newTestStoreForBindingPush(t)
	if _, err := st.CreateMachine("remote-machine", srv.URL, "k", false); err != nil {
		t.Fatal(err)
	}

	c := NewBindingStatusCache()
	pushBindingsOnce(context.Background(), st, c, func() (string, bool, string) {
		return "", false, "hub is bound to loopback and Tailscale serve is not running"
	})

	if called {
		t.Error("a push must never be attempted when this hub has no resolvable URL")
	}
	machines, _ := st.Machines()
	status, ok := c.Get(machines[0].ID)
	if !ok {
		t.Fatal("expected a cached status even when the hub is unreachable")
	}
	if status.HubReachable {
		t.Error("HubReachable = true, want false")
	}
	if status.Reason == "" {
		t.Error("Reason is empty, want an explanation")
	}
}

// A runtime that already adopted a binding keeps working on its own sync
// schedule regardless of what this hub's NEXT push attempt finds — so a tick
// where the hub can't resolve its own URL must not reset Adopted to false
// and raise a false "not synced" alarm for a runtime that is actually fine.
func TestPushBindingsOnceKeepsAdoptedTrueWhenHubGoesUnreachable(t *testing.T) {
	adoptedCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adoptedCalls++
		json.NewEncoder(w).Encode(map[string]bool{"adopted": true})
	}))
	t.Cleanup(srv.Close)

	st := newTestStoreForBindingPush(t)
	if _, err := st.CreateMachine("remote-machine", srv.URL, "k", false); err != nil {
		t.Fatal(err)
	}
	machines, _ := st.Machines()
	c := NewBindingStatusCache()

	// First tick: hub reachable, runtime adopts.
	pushBindingsOnce(context.Background(), st, c, func() (string, bool, string) {
		return "https://hub.example.ts.net", true, ""
	})
	if status, _ := c.Get(machines[0].ID); !status.Adopted {
		t.Fatal("setup: expected Adopted=true after the first successful push")
	}

	// Second tick: the hub itself has no URL this time — the runtime is
	// never even contacted.
	pushBindingsOnce(context.Background(), st, c, func() (string, bool, string) {
		return "", false, "serve_disabled"
	})

	status, ok := c.Get(machines[0].ID)
	if !ok {
		t.Fatal("expected a cached status")
	}
	if !status.Adopted {
		t.Error("Adopted = false after a hub-unreachable tick, want true (sticky — the runtime was never asked again)")
	}
	if status.HubReachable {
		t.Error("HubReachable = true, want false for this tick")
	}
	if adoptedCalls != 1 {
		t.Errorf("the runtime was contacted %d times, want 1 (never during the hub-unreachable tick)", adoptedCalls)
	}
}

// Same principle as above, for the other no-fresh-answer case: the hub HAD a
// URL but the push attempt itself failed to reach the machine (a one-tick
// network blip on that machine, not evidence it un-adopted).
func TestPushBindingsOnceKeepsAdoptedTrueWhenPushFailsToReachMachine(t *testing.T) {
	up := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up {
			panic(http.ErrAbortHandler)
		}
		json.NewEncoder(w).Encode(map[string]bool{"adopted": true})
	}))
	t.Cleanup(srv.Close)

	st := newTestStoreForBindingPush(t)
	if _, err := st.CreateMachine("remote-machine", srv.URL, "k", false); err != nil {
		t.Fatal(err)
	}
	machines, _ := st.Machines()
	c := NewBindingStatusCache()
	resolve := func() (string, bool, string) { return "https://hub.example.ts.net", true, "" }

	pushBindingsOnce(context.Background(), st, c, resolve)
	if status, _ := c.Get(machines[0].ID); !status.Adopted {
		t.Fatal("setup: expected Adopted=true after the first successful push")
	}

	up = false
	pushBindingsOnce(context.Background(), st, c, resolve)

	status, ok := c.Get(machines[0].ID)
	if !ok {
		t.Fatal("expected a cached status")
	}
	if !status.Adopted {
		t.Error("Adopted = false after a push that failed to reach the machine, want true (sticky)")
	}
	if status.Reason == "" {
		t.Error("Reason is empty, want the push failure explanation")
	}
}

func TestPushBindingsOncePushesToEveryRemoteMachine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]bool{"adopted": true})
	}))
	t.Cleanup(srv.Close)

	st := newTestStoreForBindingPush(t)
	if _, err := st.CreateMachine("remote-machine", srv.URL, "k", false); err != nil {
		t.Fatal(err)
	}

	c := NewBindingStatusCache()
	pushBindingsOnce(context.Background(), st, c, func() (string, bool, string) {
		return "https://hub.example.ts.net", true, ""
	})

	machines, _ := st.Machines()
	status, ok := c.Get(machines[0].ID)
	if !ok {
		t.Fatal("expected a cached status")
	}
	if !status.HubReachable || !status.Adopted {
		t.Errorf("status = %+v, want HubReachable=true Adopted=true", status)
	}
}

func TestRunBindingPushLoopStopsOnContextCancel(t *testing.T) {
	st := newTestStoreForBindingPush(t)
	c := NewBindingStatusCache()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		RunBindingPushLoop(ctx, st, c, func() (string, bool, string) { return "", false, "no url" }, 5*time.Millisecond)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunBindingPushLoop did not return after ctx cancellation")
	}
}
