package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
)

type fakeRunCounter struct{ n int }

func (f fakeRunCounter) BusyThreadCount() int { return f.n }

// stubTerminalCount swaps the PTY counter for the duration of one test. The
// real registry is package-private to internal/terminal, so a handler test
// cannot spawn a session to count — same reason self.go keeps
// spawnReplacement/exitProcess swappable.
func stubTerminalCount(t *testing.T, n int) {
	t.Helper()
	orig := activeTerminalCount
	t.Cleanup(func() { activeTerminalCount = orig })
	activeTerminalCount = func() int { return n }
}

func getBusy(t *testing.T, h *BusyHandler) (int, map[string]int) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.GetBusy(rec, httptest.NewRequest(http.MethodGet, "/api/self/busy", nil))
	var body map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return rec.Code, body
}

func TestGetBusyReportsTerminalAndAgentRunCounts(t *testing.T) {
	stubTerminalCount(t, 3)
	h := NewBusyHandler(fakeRunCounter{n: 2})

	code, body := getBusy(t, h)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if body["terminals"] != 3 {
		t.Errorf("terminals = %d, want 3 (terminal.ActiveSessionCount)", body["terminals"])
	}
	if body["agentRuns"] != 2 {
		t.Errorf("agentRuns = %d, want 2 (the engine's busy thread count)", body["agentRuns"])
	}
	if len(body) != 2 {
		t.Errorf("body = %+v, want exactly terminals + agentRuns", body)
	}
}

// main.go builds selfH long before the orchestration engine exists, which is
// why this is a separate handler at all — and why "no engine" has to be a
// normal answer rather than a 500 or a panic. See decision D3 of
// docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md.
func TestGetBusyReportsZeroAgentRunsWithoutAnEngine(t *testing.T) {
	stubTerminalCount(t, 1)
	h := NewBusyHandler(nil)

	code, body := getBusy(t, h)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with no engine wired", code)
	}
	if body["agentRuns"] != 0 {
		t.Errorf("agentRuns = %d, want 0 with no engine wired", body["agentRuns"])
	}
	if body["terminals"] != 1 {
		t.Errorf("terminals = %d, want 1 — a missing engine must not blank the PTY count", body["terminals"])
	}
}

// The trap a plain `h.engine == nil` check misses: a typed nil *Engine stored
// in an interface is not a nil interface.
func TestGetBusySurvivesATypedNilEngine(t *testing.T) {
	stubTerminalCount(t, 0)
	var engine *orchestration.Engine
	h := NewBusyHandler(engine)

	code, body := getBusy(t, h)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a typed-nil engine", code)
	}
	if body["agentRuns"] != 0 {
		t.Errorf("agentRuns = %d, want 0 for a typed-nil engine", body["agentRuns"])
	}
}

// The default path: no stub, so this asserts the handler really is reading
// terminal.ActiveSessionCount() (0 in a process with no terminal registry)
// rather than reporting a hardcoded number.
func TestGetBusyReadsTheRealTerminalCountByDefault(t *testing.T) {
	h := NewBusyHandler(fakeRunCounter{n: 1})
	code, body := getBusy(t, h)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if body["terminals"] != 0 {
		t.Errorf("terminals = %d, want 0 in a process with no terminal registry", body["terminals"])
	}
}
