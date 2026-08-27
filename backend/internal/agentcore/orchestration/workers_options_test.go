package orchestration

import (
	"encoding/json"
	"testing"

	"devdeck/backend/internal/agentcore/provider"
)

// The composer's Reasoning / Context Window picker rides the turn as
// ModelSelection.Options, and every provider that honours those values does
// so through start-time CLI flags (claude --effort/--autocompact, pi
// --thinking). Before ensureSession took the whole selection, the options
// reached the reactor and were dropped right there — no StartSession ever
// saw them, so the picker was decorative. These tests pin the three rules
// that make it real: options reach StartSession, a live session is restarted
// when they change, and the restart is refused under a running turn.

func countCalls(h *reactorHarness, name string) int {
	n := 0
	for _, c := range h.rec.snapshot() {
		if c == name {
			n++
		}
	}
	return n
}

// A thread's session is started at creation, before any turn — and therefore
// before any options exist. The first turn that carries options must restart
// it so they actually apply, and must NOT resume: the process was launched
// moments ago and never received a message, and claude's --resume on such an
// id exits with "No conversation found" (verified against the binary).
func TestReactorRestartsForOptionsOnTheFirstTurnWithoutResuming(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")
	// system/init hands out a session id at spawn — the cursor exists even
	// though no conversation does.
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{
		"status": string(ThreadIdle), "resumeCursor": json.RawMessage(`"fresh-sid"`),
	}))

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:  "think hard about this",
		Model: provider.ModelSelection{Options: map[string]any{"effort": "max", "contextWindow": "1M"}},
	}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })

	if got := countCalls(h, "StopSession"); got != 1 {
		t.Fatalf("StopSession called %d times, want 1 — the option-less session must be replaced", got)
	}
	inputs := h.adapter.startInputs()
	if len(inputs) != 2 {
		t.Fatalf("StartSession called %d times, want 2 (creation + restart for options)", len(inputs))
	}
	restart := inputs[1]
	if restart.Model.Options["effort"] != "max" || restart.Model.Options["contextWindow"] != "1M" {
		t.Fatalf("restart options = %v, want the turn's effort/contextWindow", restart.Model.Options)
	}
	if len(restart.ResumeCursor) != 0 {
		t.Fatalf("restart ResumeCursor = %s, want none — nothing has been said yet, and resuming an unused id kills the process", restart.ResumeCursor)
	}
	if n := countErrorEntries(h.store.All()); n != 0 {
		t.Fatalf("turn reported %d errors, want none", n)
	}
}

// Once a session runs under the options a turn asks for, further turns with
// the same options must not touch it — restarting on every turn would drop
// the agent's context each time.
func TestReactorKeepsTheSessionWhenOptionsAreUnchanged(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	opts := map[string]any{"effort": "low"}
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "one", Model: provider.ModelSelection{Options: opts}}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{"status": string(ThreadIdle)}))
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "two", Model: provider.ModelSelection{Options: opts}}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 2 })

	if got := countCalls(h, "StartSession"); got != 2 {
		t.Fatalf("StartSession called %d times, want 2 (creation + one restart for the first options) — identical options must be a no-op", got)
	}
}

// Changing effort on a thread that is already a conversation restarts the
// session AND resumes it: the provider's own transcript must survive, or the
// next reply forgets everything said so far.
func TestReactorRestartsForChangedOptionsAndResumesTheConversation(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{
		"status": string(ThreadIdle), "resumeCursor": json.RawMessage(`"sid-1"`),
	}))

	// Turn one under the defaults (no options) — same as the creation-time
	// session, so no restart.
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "hello"}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{"status": string(ThreadIdle)}))
	if got := countCalls(h, "StartSession"); got != 1 {
		t.Fatalf("StartSession called %d times after a default-options turn, want 1", got)
	}

	// Turn two picks Low.
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:  "quicker please",
		Model: provider.ModelSelection{Options: map[string]any{"effort": "low"}},
	}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 2 })

	inputs := h.adapter.startInputs()
	if len(inputs) != 2 {
		t.Fatalf("StartSession called %d times, want 2 (creation + restart for the changed options)", len(inputs))
	}
	if got := inputs[1].Model.Options["effort"]; got != "low" {
		t.Fatalf("restart effort = %v, want low", got)
	}
	if got := string(inputs[1].ResumeCursor); got != `"sid-1"` {
		t.Fatalf("restart ResumeCursor = %q, want the stored cursor so the conversation survives", got)
	}
	// The order matters: the old process must be gone before the new one
	// starts, or two CLIs share one thread.
	calls := h.rec.snapshot()
	stopAt, startAt := -1, -1
	for i, c := range calls {
		if c == "StopSession" && stopAt == -1 {
			stopAt = i
		}
		if c == "StartSession" {
			startAt = i
		}
	}
	if stopAt == -1 || stopAt > startAt {
		t.Fatalf("StopSession must precede the restart's StartSession, got %v", calls)
	}
}

// A message sent while a turn is in flight is steering — the running process
// is doing the work. Killing it to apply a setting would abort that work, so
// the options wait for the next session start instead.
func TestReactorDoesNotRestartForOptionsUnderARunningTurn(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "go"}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	// No session-set idle: the turn is still running when the next message
	// lands.
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:  "and be brief",
		Model: provider.ModelSelection{Options: map[string]any{"effort": "low"}},
	}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 2 })

	if got := countCalls(h, "StopSession"); got != 0 {
		t.Fatalf("StopSession called %d times under a running turn, want 0", got)
	}
	if got := countCalls(h, "StartSession"); got != 1 {
		t.Fatalf("StartSession called %d times, want 1 — a steered turn must not restart the session", got)
	}
	if n := countErrorEntries(h.store.All()); n != 0 {
		t.Fatalf("turn reported %d errors, want none", n)
	}
}

// The turn's model and instance ride the session start alongside the options,
// so a restarted session comes up on the model the thread is actually using
// rather than the worktree's configured default.
func TestReactorStartsTheRestartedSessionOnTheTurnsModel(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:  "hi",
		Model: provider.ModelSelection{Model: "fake-mini", Options: map[string]any{"effort": "xhigh"}},
	}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })

	inputs := h.adapter.startInputs()
	if len(inputs) != 2 {
		t.Fatalf("StartSession called %d times, want 2", len(inputs))
	}
	if got := inputs[1].Model.Model; got != "fake-mini" {
		t.Fatalf("restart model = %q, want fake-mini", got)
	}
}

// A user-initiated Stop settles the thread from the reactor itself. The
// per-process adapters no longer report a deliberate stop as SessionExited
// (that is what keeps an in-place restart from flipping the thread to
// "stopped" under its next turn), and the server-backed ones never did — so
// without this dispatch a stopped thread kept whatever status it had.
func TestReactorSettlesThreadAsStoppedOnSessionStop(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "go"}))
	waitFor(t, func() bool { return threadStatus(t, h, "w-abc") == ThreadRunning })

	h.dispatch(t, "w-abc", CmdThreadSessionStop, nil)
	h.waitForCall(t, "StopSession")
	waitFor(t, func() bool { return threadStatus(t, h, "w-abc") == ThreadStopped })

	// And the next turn, on the now-dead session, starts a fresh one that
	// carries its options — the stop forgot the old session's, so the new
	// process is not mistaken for one already running under them.
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:  "again",
		Model: provider.ModelSelection{Options: map[string]any{"effort": "low"}},
	}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 2 })
	inputs := h.adapter.startInputs()
	if got := inputs[len(inputs)-1].Model.Options["effort"]; got != "low" {
		t.Fatalf("post-stop session effort = %v, want low", got)
	}
}
