package handler

import (
	"context"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkspaceOverviewIsolationAndNoSessionCreation(t *testing.T) {
	engine, st, thread, cleanup := newAgentWSTestEnv(t, "claude")
	defer cleanup()
	spaces, _ := st.Workspaces()
	ws := spaces[0].ID
	other, err := st.CreateWorkspace("Other")
	if err != nil {
		t.Fatal(err)
	}
	h := NewAgentThreadHandler(st, engine)
	read := func(id string) domain.OfficeOverview {
		t.Helper()
		rec := httptest.NewRecorder()
		h.GetWorkspaceOverview(rec, httptest.NewRequest("GET", "/api/agent/workspace-overview?workspaceId="+id, nil))
		if rec.Code != 200 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
		var result domain.OfficeOverview
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if len(read(ws).Sessions) != 0 {
		t.Fatal("reading created a session")
	}
	_, err = engine.Dispatch(context.Background(), orchestration.Command{CommandID: "create", Type: orchestration.CmdThreadCreate, ThreadID: thread})
	if err != nil {
		t.Fatal(err)
	}
	if len(read(other.ID).Sessions) != 0 {
		t.Fatal("cross-workspace session leak")
	}
	out := read(ws)
	if len(out.Sessions) != 1 || out.Sessions[0].Status != "idle" {
		t.Fatalf("%+v", out)
	}
	if err := st.DeleteAgentThread(thread); err != nil {
		t.Fatal(err)
	}
	engine.ForgetThread(thread)
	if len(read(ws).Sessions) != 0 {
		t.Fatal("deleted session remains")
	}
	for _, q := range []struct {
		id     string
		status int
	}{{"", 400}, {"missing", 404}} {
		rec := httptest.NewRecorder()
		h.GetWorkspaceOverview(rec, httptest.NewRequest("GET", "/api/agent/workspace-overview?workspaceId="+q.id, nil))
		if rec.Code != q.status {
			t.Fatalf("got %d want %d", rec.Code, q.status)
		}
	}
}

func TestWorkspaceOverviewIncludesSharedSSHAndNoSecrets(t *testing.T) {
	engine, st, _, cleanup := newAgentWSTestEnv(t, "claude")
	defer cleanup()
	spaces, _ := st.Workspaces()
	conn, err := st.CreateSSHConnection("Shared ops", "", "example.test", 22, "operator", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := "ssh:" + conn.ID
	_, err = engine.Dispatch(context.Background(), orchestration.Command{CommandID: "ssh-create", Type: orchestration.CmdThreadCreate, ThreadID: id})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	NewAgentThreadHandler(st, engine).GetWorkspaceOverview(rec, httptest.NewRequest("GET", "/api/agent/workspace-overview?workspaceId="+spaces[0].ID, nil))
	var out domain.OfficeOverview
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Sessions) != 1 || out.Sessions[0].ConnectionID != conn.ID || out.Sessions[0].ProjectID != "" {
		t.Fatalf("wrong SSH scope: %+v", out)
	}
	for _, forbidden := range []string{"password", "example.test", "operator"} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Fatalf("overview leaked %s", forbidden)
		}
	}
}
