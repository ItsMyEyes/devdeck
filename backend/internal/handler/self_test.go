package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// stubSpawnReplacement replaces the package-level spawnReplacement for the
// duration of a test, returning a pointer the test can check afterward to
// see whether it was called.
func stubSpawnReplacement(t *testing.T, err error) *bool {
	t.Helper()
	called := false
	orig := spawnReplacement
	spawnReplacement = func() error {
		called = true
		return err
	}
	t.Cleanup(func() { spawnReplacement = orig })
	return &called
}

// stubExitProcess replaces the package-level exitProcess so tests never
// actually call os.Exit; the returned channel receives a value each time
// the stub runs.
func stubExitProcess(t *testing.T) <-chan struct{} {
	t.Helper()
	done := make(chan struct{}, 1)
	orig := exitProcess
	exitProcess = func() { done <- struct{}{} }
	t.Cleanup(func() { exitProcess = orig })
	return done
}

func waitForExit(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("exitProcess was not called within 1s")
	}
}

func assertExitNotCalled(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Error("exitProcess must not be called")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPostRestartUnmanagedSpawnsReplacementThenExits(t *testing.T) {
	called := stubSpawnReplacement(t, nil)
	done := stubExitProcess(t)

	h := NewSelfHandler(false)
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !*called {
		t.Error("PostRestart on an unmanaged process must spawn a replacement")
	}
	waitForExit(t, done)
}

func TestPostRestartManagedDoesNotSpawnReplacement(t *testing.T) {
	called := stubSpawnReplacement(t, nil)
	done := stubExitProcess(t)

	h := NewSelfHandler(true)
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if *called {
		t.Error("PostRestart on a managed process must not spawn its own replacement")
	}
	waitForExit(t, done)
}

func TestPostRestartUnmanagedSpawnFailureReturns500AndDoesNotExit(t *testing.T) {
	stubSpawnReplacement(t, errors.New("boom"))
	done := stubExitProcess(t)

	h := NewSelfHandler(false)
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500, body = %s", rec.Code, rec.Body.String())
	}
	assertExitNotCalled(t, done)
}

func TestPostStopUnmanagedExits(t *testing.T) {
	done := stubExitProcess(t)

	h := NewSelfHandler(false)
	rec := httptest.NewRecorder()
	h.PostStop(rec, httptest.NewRequest(http.MethodPost, "/api/self/stop", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	waitForExit(t, done)
}

func TestPostStopManagedRefuses(t *testing.T) {
	done := stubExitProcess(t)

	h := NewSelfHandler(true)
	rec := httptest.NewRecorder()
	h.PostStop(rec, httptest.NewRequest(http.MethodPost, "/api/self/stop", nil))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body = %s", rec.Code, rec.Body.String())
	}
	assertExitNotCalled(t, done)
}
