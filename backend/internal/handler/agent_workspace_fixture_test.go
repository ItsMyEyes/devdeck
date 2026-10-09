package handler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/store"
)

// Explicit opt-in fixture for the isolated desktop/renderer smoke harness; never production data.
func TestWriteOfficeSmokeFixture(t *testing.T) {
	dir := os.Getenv("DEVDECK_OFFICE_SMOKE_DIR")
	if dir == "" {
		t.Skip("smoke fixture not requested")
	}
	dbPath := filepath.Join(dir, "office-smoke.db")
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatal("fixture database must not already exist")
	}
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	st := store.New(db)
	ws, err := st.CreateWorkspace("DevDeck Studio")
	if err != nil {
		t.Fatal(err)
	}
	titles := []string{"Build authentication flow", "Review workspace events", "Test SSH connection handling", "Improve query performance", "Write release notes", "Audit approval boundaries"}
	threadIDs := []string{}
	now := time.Now().UnixMilli()
	for p := 0; p < 2; p++ {
		project, err := st.CreateProject(ws.ID, []string{"DevDeck", "Platform"}[p], dir, "", "")
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 10; i++ {
			wt, err := st.CreateWorktree(project.ID, "root", "", "", "sonnet", "claude", "", dir)
			if err != nil {
				t.Fatal(err)
			}
			threadIDs = append(threadIDs, wt.ID)
			payloads := []struct {
				typ orchestration.EventType
				v   any
			}{
				{orchestration.EvtThreadCreated, map[string]any{"instanceId": "claude:default"}},
				{orchestration.EvtThreadTurnStartRequested, map[string]any{"text": titles[(p*10+i)%len(titles)]}},
				{orchestration.EvtThreadActivityAppended, map[string]any{"type": "turn.started", "provider": "claude", "payload": map[string]any{"model": "sonnet"}}},
				{orchestration.EvtThreadActivityAppended, map[string]any{"type": "item.started", "itemId": "read", "payload": map[string]any{"itemType": "tool_call", "title": "Read"}}},
			}
			if i == 0 {
				payloads = append(payloads, struct {
					typ orchestration.EventType
					v   any
				}{orchestration.EvtThreadActivityAppended, map[string]any{"type": "task.started", "agentId": "reviewer", "payload": map[string]any{"taskId": "reviewer", "title": "Review changes", "role": "Reviewer"}}})
			}
			events := []orchestration.Event{}
			for j, entry := range payloads {
				raw, _ := json.Marshal(entry.v)
				events = append(events, orchestration.Event{EventID: fmt.Sprintf("office-%d-%d-%d", p, i, j), ThreadID: wt.ID, Type: entry.typ, CreatedAt: now + int64(j), Payload: raw})
			}
			if _, err := st.CommitAgentEvents(fmt.Sprintf("fixture-%d-%d", p, i), events); err != nil {
				t.Fatal(err)
			}
		}
	}
	b, _ := json.Marshal(map[string]any{"workspaceId": ws.ID, "threadIds": threadIDs})
	if err := os.WriteFile(filepath.Join(dir, "fixture.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}
