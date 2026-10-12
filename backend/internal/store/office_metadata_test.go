package store

import (
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/port"
	"encoding/json"
	"testing"
)

func TestOfficeCharacterNamePersistsAndArchivePreservesTranscript(t *testing.T) {
	st := NewTestStore(t)
	if _, err := st.CommitAgentEvents("create", []orchestration.Event{evt("create", "w-1", "create", orchestration.EvtThreadCreated)}); err != nil {
		t.Fatal(err)
	}
	rows, _ := st.AgentThreads("w-1")
	raw, _ := json.Marshal(rows[0])
	var fields map[string]any
	json.Unmarshal(raw, &fields)
	name, ok := fields["characterName"].(string)
	if !ok || name == "" {
		t.Fatal("no persistent character name")
	}
	if _, err := st.CommitAgentEvents("end", []orchestration.Event{evt("end", "w-1", "end", orchestration.EventType("thread.archived"))}); err != nil {
		t.Fatal(err)
	}
	rows, _ = st.AgentThreads("w-1")
	raw, _ = json.Marshal(rows[0])
	json.Unmarshal(raw, &fields)
	if fields["characterName"] != name || fields["archivedAt"] != float64(1000) {
		t.Fatalf("metadata lost: %s", raw)
	}
	events, _ := st.AgentEventsSince("w-1", 0)
	if len(events) != 2 {
		t.Fatal("history erased")
	}
	if _, err := st.CommitAgentEvents("resume", []orchestration.Event{evt("resume", "w-1", "resume", orchestration.EventType("thread.resumed"))}); err != nil {
		t.Fatal(err)
	}
	rows, _ = st.AgentThreads("w-1")
	raw, _ = json.Marshal(rows[0])
	json.Unmarshal(raw, &fields)
	if fields["characterName"] != name || fields["archivedAt"] != float64(0) {
		t.Fatal("resume changed identity")
	}
}
func TestSSHParentProjectPersistsSeparateFromGroup(t *testing.T) {
	st := NewTestStore(t)
	c, err := st.CreateSSHConnection("vm", "production", "example.test", 22, "user", "password", nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	var patch port.SSHConnectionPatch
	json.Unmarshal([]byte(`{"parentProject":"AIGN"}`), &patch)
	got, err := st.UpdateSSHConnection(c.ID, patch)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(got)
	var fields map[string]any
	json.Unmarshal(raw, &fields)
	if fields["parentProject"] != "AIGN" || got.Group != "production" {
		t.Fatalf("parent lost: %s", raw)
	}
}

func TestCharacterBackfillOnlyFillsMissingNames(t *testing.T) {
	st := NewTestStore(t)
	if _, err := st.CommitAgentEvents("create", []orchestration.Event{evt("create", "w-1", "create", orchestration.EvtThreadCreated)}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`UPDATE agent_thread SET character_name='',title='Keep title'`); err != nil {
		t.Fatal(err)
	}
	if err := migrateAgentThreadColumns(st.db); err != nil {
		t.Fatal(err)
	}
	rows, _ := st.AgentThreads("w-1")
	name := rows[0].CharacterName
	if name == "" || rows[0].Title != "Keep title" {
		t.Fatal("backfill failed")
	}
	if err := migrateAgentThreadColumns(st.db); err != nil {
		t.Fatal(err)
	}
	rows, _ = st.AgentThreads("w-1")
	if rows[0].CharacterName != name {
		t.Fatal("restart renamed character")
	}
}

func TestNoopLifecycleReceiptPersists(t *testing.T) {
	st := NewTestStore(t)
	if _, err := st.CommitAgentEvents("noop-resume", []orchestration.Event{evt("noop", "w-1", "noop-resume", orchestration.EventType("thread.lifecycle-unchanged"))}); err != nil {
		t.Fatal(err)
	}
	_, seen, err := st.SeenAgentCommand("noop-resume")
	if err != nil || !seen {
		t.Fatalf("no-op receipt lost: %v %v", seen, err)
	}
}
