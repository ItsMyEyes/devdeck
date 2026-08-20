package memorybackfill

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/store"
)

func mustRaw(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	return store.NewTestStore(t)
}

func TestGroupByThreadSortsBySeq(t *testing.T) {
	events := []orchestration.Event{
		{Seq: 3, ThreadID: "w-1", Type: orchestration.EvtThreadTurnStartRequested},
		{Seq: 1, ThreadID: "w-1", Type: orchestration.EvtThreadCreated},
		{Seq: 2, ThreadID: "w-2", Type: orchestration.EvtThreadCreated},
	}
	got := groupByThread(events)
	if len(got) != 2 {
		t.Fatalf("threads = %d, want 2", len(got))
	}
	w1 := got["w-1"]
	if len(w1) != 2 || w1[0].Seq != 1 || w1[1].Seq != 3 {
		t.Fatalf("w-1 events = %+v, want seq order [1,3]", w1)
	}
}

func TestProviderFromCreateExtractsKind(t *testing.T) {
	events := []orchestration.Event{
		{Type: orchestration.EvtThreadCreated, Payload: mustRaw(t, map[string]string{"instanceId": "codex:default"})},
	}
	if got := providerFromCreate(events); got != "codex" {
		t.Fatalf("provider = %q, want codex", got)
	}
}

func TestProviderFromCreateEmptyWhenMissing(t *testing.T) {
	if got := providerFromCreate(nil); got != "" {
		t.Fatalf("provider = %q, want empty", got)
	}
}

func TestUserItemsExtractsTurnTextAndSkipsEmpty(t *testing.T) {
	st := newTestStore(t)
	events := []orchestration.Event{
		{Type: orchestration.EvtThreadCreated, ThreadID: "w-abc", CreatedAt: 1000,
			Payload: mustRaw(t, map[string]string{"instanceId": "claude:default"})},
		{Type: orchestration.EvtThreadTurnStartRequested, ThreadID: "w-abc", CreatedAt: 2000,
			Payload: mustRaw(t, orchestration.TurnStartPayload{Text: "fix the auth redirect"})},
		{Type: orchestration.EvtThreadTurnStartRequested, ThreadID: "w-abc", CreatedAt: 3000,
			Payload: mustRaw(t, orchestration.TurnStartPayload{Text: "  "})}, // blank, must be skipped
		{Type: orchestration.EvtThreadActivityAppended, ThreadID: "w-abc", CreatedAt: 4000}, // not a turn-start, ignored
	}

	items := userItems("w-abc", events, st, "mac-mini")
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	item := items[0]
	if !strings.Contains(item.Content, "fix the auth redirect") {
		t.Fatalf("content = %q", item.Content)
	}
	if item.DocumentID != "w-abc" || item.UpdateMode != "replace" {
		t.Fatalf("item = %+v", item)
	}
	foundProvider, foundMachine, foundSurface := false, false, false
	for _, tag := range item.Tags {
		switch tag {
		case "provider:claude":
			foundProvider = true
		case "machine:mac-mini":
			foundMachine = true
		case "surface:worktree":
			foundSurface = true
		}
	}
	if !foundProvider || !foundMachine || !foundSurface {
		t.Fatalf("tags = %v, missing expected scope tags", item.Tags)
	}
}

func TestUserItemsEmptyForThreadWithNoTurns(t *testing.T) {
	st := newTestStore(t)
	events := []orchestration.Event{
		{Type: orchestration.EvtThreadCreated, ThreadID: "w-abc", CreatedAt: 1000},
	}
	if items := userItems("w-abc", events, st, "mac-mini"); len(items) != 0 {
		t.Fatalf("items = %d, want 0", len(items))
	}
}

func TestRunFailsWithoutDryRunWhenMemoryNotConfigured(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	// Opening once via the real store package to create the schema, exactly
	// like `run` will when it opens the same path.
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()

	var stdout, stderr bytes.Buffer
	err = run([]string{"--db", dbPath}, &stdout, &stderr)
	if err == nil {
		t.Fatal("expected error when memory is not configured and --dry-run is not set")
	}
}

func TestRunDryRunSucceedsWithoutMemoryConfigured(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	st := store.New(db)
	if _, err := st.CommitAgentEvents("cmd-1", []orchestration.Event{
		{EventID: "e1", ThreadID: "w-abc", Type: orchestration.EvtThreadCreated, CreatedAt: 1000,
			Payload: mustRaw(t, map[string]string{"instanceId": "claude:default"})},
		{EventID: "e2", ThreadID: "w-abc", Type: orchestration.EvtThreadTurnStartRequested, CreatedAt: 2000,
			Payload: mustRaw(t, orchestration.TurnStartPayload{Text: "hello there"})},
	}); err != nil {
		t.Fatalf("seed events: %v", err)
	}
	db.Close()

	var stdout, stderr bytes.Buffer
	if err := run([]string{"--db", dbPath, "--dry-run"}, &stdout, &stderr); err != nil {
		t.Fatalf("run: %v (stderr: %s)", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "would retain 1 message") {
		t.Fatalf("stdout = %q, missing dry-run summary", stdout.String())
	}
}
