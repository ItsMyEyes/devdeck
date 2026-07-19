package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/store"
)

func TestMachineHealthCacheGetMissReturnsFalse(t *testing.T) {
	c := NewMachineHealthCache()
	if _, ok := c.Get("m-none"); ok {
		t.Error("Get on an empty cache should return ok=false")
	}
}

func TestMachineHealthCacheSetThenGet(t *testing.T) {
	c := NewMachineHealthCache()
	c.Set("m-1", machineclient.HealthStatus{Status: "online", LatencyMs: 42})
	status, ok := c.Get("m-1")
	if !ok || status.Status != "online" || status.LatencyMs != 42 {
		t.Errorf("Get = %+v, %v, want online/42/true", status, ok)
	}
}

func TestRunPollerCachesEveryRegisteredMachine(t *testing.T) {
	online := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(online.Close)

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	if _, err := st.CreateMachine("online-machine", online.URL, "k", false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateMachine("dead-machine", "http://127.0.0.1:1", "k", false); err != nil {
		t.Fatal(err)
	}

	c := NewMachineHealthCache()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.RunPoller(ctx, st, 5*time.Millisecond)
		close(done)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		machines, _ := st.Machines()
		allCached := true
		for _, m := range machines {
			if _, ok := c.Get(m.ID); !ok {
				allCached = false
			}
		}
		if allCached && len(machines) == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	machines, _ := st.Machines()
	for _, m := range machines {
		status, ok := c.Get(m.ID)
		if !ok {
			t.Fatalf("machine %s never got a cached status", m.ID)
		}
		wantStatus := "offline"
		if m.Name == "online-machine" {
			wantStatus = "online"
		}
		if status.Status != wantStatus {
			t.Errorf("machine %s status = %q, want %q", m.Name, status.Status, wantStatus)
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunPoller did not return after ctx cancellation")
	}
}
