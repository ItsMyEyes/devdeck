package service

import (
	"testing"

	"devdeck/backend/internal/store"
)

func TestRuntimeWorkspaceListNestsLocalProjectsWithoutFanout(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")
	// machineID is set, which on a hub would trigger a machineclient fetch.
	st.CreateProject(ws.ID, "api", "/srv/api", "", "m-1")

	svc := NewWorkspaceServiceForRuntime(st)
	got, err := svc.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].Projects) != 1 || got[0].Projects[0].Name != "api" {
		t.Fatalf("List() = %+v, want one workspace holding one project", got)
	}
}
