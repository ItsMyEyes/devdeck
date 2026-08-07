package store

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
)

// The whole event-sourcing contract, exercised against real SQLite. This is
// the same guarantee TestReplayDeterministic makes against MemStore; if the
// two ever disagree, the database is lying about ordering or payloads.
func TestEngineReplayDeterministicOnSQLite(t *testing.T) {
	st := newTestStore(t)

	n := 0
	e := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { n++; return "ae-" + string(rune('a'+n)) },
		Now:       func() int64 { return 1000 },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	mustRaw := func(v any) json.RawMessage {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return b
	}

	if _, err := e.Dispatch(ctx, orchestration.Command{
		CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
		Payload: mustRaw(map[string]any{"instanceId": "claude:default"}),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := e.Dispatch(ctx, orchestration.Command{
		CommandID: "ac-turn", Type: orchestration.CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(orchestration.TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn: %v", err)
	}

	logged, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if len(logged) != 3 {
		t.Fatalf("log has %d events, want 3", len(logged))
	}

	replayed := orchestration.Apply(orchestration.NewState(), logged)
	live := e.State()
	if !reflect.DeepEqual(live.Threads, replayed.Threads) {
		t.Fatalf("replay from SQLite diverged:\n live=%+v\nreplay=%+v",
			live.Threads["w-abc"], replayed.Threads["w-abc"])
	}
}

// Idempotency must hold across the real receipt table, not just in memory.
func TestEngineIdempotencyOnSQLite(t *testing.T) {
	st := newTestStore(t)
	n := 0
	e := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { n++; return "ae-" + string(rune('a'+n)) },
		Now:       func() int64 { return 1000 },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	cmd := orchestration.Command{
		CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"claude:default"}`),
	}
	first, err := e.Dispatch(ctx, cmd)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := e.Dispatch(ctx, cmd)
	if err != nil {
		t.Fatalf("resend: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("resend differed:\n first=%+v\nsecond=%+v", first, second)
	}

	logged, _ := st.AgentEventsSince("w-abc", 0)
	if len(logged) != 1 {
		t.Fatalf("log has %d events, want 1 — resend must not append", len(logged))
	}
}
