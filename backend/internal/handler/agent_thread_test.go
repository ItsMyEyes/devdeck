package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
)

// Plan `2026-08-15-composer-plan-surface.md` T6: PlanReady is overlaid from
// the engine's live state (Thread.ProposedPlan), the same pattern
// withLiveStatus already applies to Status — never persisted as a SQL
// column (design.md §8).

func getThreadsForTest(t *testing.T, h *AgentThreadHandler, worktreeID string) []domain.AgentThread {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/agent/threads?worktree="+worktreeID, nil)
	rec := httptest.NewRecorder()
	h.GetThreads(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GetThreads status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out []domain.AgentThread
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return out
}

func TestGetThreadsPlanReadyReflectsLiveProposedPlan(t *testing.T) {
	engine, st, threadID, cleanup := newAgentWSTestEnv(t, "claude")
	defer cleanup()
	ctx := context.Background()

	if _, err := engine.Dispatch(ctx, orchestration.Command{
		CommandID: "cmd-create",
		Type:      orchestration.CmdThreadCreate,
		ThreadID:  threadID,
	}); err != nil {
		t.Fatalf("create thread: %v", err)
	}

	h := NewAgentThreadHandler(st, engine)

	// No plan proposed yet: PlanReady is false.
	threads := getThreadsForTest(t, h, threadID)
	if len(threads) != 1 {
		t.Fatalf("expected 1 thread, got %d", len(threads))
	}
	if threads[0].PlanReady {
		t.Fatalf("PlanReady = true before any plan was proposed, want false")
	}

	// A plan lands on the table: PlanReady flips to true.
	payload, _ := json.Marshal(orchestration.PlanProposePayload{PlanMarkdown: "# Do the thing"})
	if _, err := engine.Dispatch(ctx, orchestration.Command{
		CommandID: "cmd-propose",
		Type:      orchestration.CmdThreadPlanPropose,
		ThreadID:  threadID,
		Payload:   payload,
	}); err != nil {
		t.Fatalf("propose plan: %v", err)
	}

	threads = getThreadsForTest(t, h, threadID)
	if len(threads) != 1 {
		t.Fatalf("expected 1 thread, got %d", len(threads))
	}
	if !threads[0].PlanReady {
		t.Fatalf("PlanReady = false after a plan was proposed, want true")
	}

	// A following turn supersedes the plan: PlanReady drops back to false.
	turnPayload, _ := json.Marshal(orchestration.TurnStartPayload{Text: "go ahead"})
	if _, err := engine.Dispatch(ctx, orchestration.Command{
		CommandID: "cmd-turn-start",
		Type:      orchestration.CmdThreadTurnStart,
		ThreadID:  threadID,
		Payload:   turnPayload,
	}); err != nil {
		t.Fatalf("start turn: %v", err)
	}

	threads = getThreadsForTest(t, h, threadID)
	if threads[0].PlanReady {
		t.Fatalf("PlanReady = true after a following turn started, want false")
	}
}

// A thread the engine has never heard of (its row exists in the store, but a
// fresh in-memory engine has not replayed the log that would carry its
// ProposedPlan) must not be treated as plan-ready — it keeps the field's
// zero value, the same "fall back to stored state" rule withLiveStatus
// already applies to Status.
func TestGetThreadsPlanReadyFalseWhenEngineHasNoLiveState(t *testing.T) {
	engineA, st, threadID, cleanup := newAgentWSTestEnv(t, "claude")
	defer cleanup()
	ctx := context.Background()

	if _, err := engineA.Dispatch(ctx, orchestration.Command{
		CommandID: "cmd-create",
		Type:      orchestration.CmdThreadCreate,
		ThreadID:  threadID,
	}); err != nil {
		t.Fatalf("create thread: %v", err)
	}
	payload, _ := json.Marshal(orchestration.PlanProposePayload{PlanMarkdown: "# Do the thing"})
	if _, err := engineA.Dispatch(ctx, orchestration.Command{
		CommandID: "cmd-propose",
		Type:      orchestration.CmdThreadPlanPropose,
		ThreadID:  threadID,
		Payload:   payload,
	}); err != nil {
		t.Fatalf("propose plan: %v", err)
	}

	// engineB shares the store but boots with fresh, empty state — it has
	// never replayed the log, so it has never "heard of" this thread.
	n := 0
	engineB := orchestration.NewEngine(orchestration.EngineOptions{
		Store: orchestration.NewPortStore(st),
		NewID: func() string { n++; return "ae-b-" + strconv.Itoa(n) },
	})
	h := NewAgentThreadHandler(st, engineB)

	threads := getThreadsForTest(t, h, threadID)
	if len(threads) != 1 {
		t.Fatalf("expected 1 thread (row is durable in the store), got %d", len(threads))
	}
	if threads[0].PlanReady {
		t.Fatalf("PlanReady = true for a thread engineB never heard of, want false (fall back to stored value)")
	}
}
