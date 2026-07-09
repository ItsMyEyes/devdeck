package store

import (
	"testing"
)

func TestProjectMachineIDRoundtrip(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	p, err := s.CreateProject(ws.ID, "api", "/srv/api", "git@x:api.git", "m-1234")
	if err != nil {
		t.Fatal(err)
	}
	if p.MachineID != "m-1234" {
		t.Errorf("MachineID = %q, want m-1234", p.MachineID)
	}
	other := "m-5678"
	p2, err := s.UpdateProject(p.ID, nil, nil, nil, &other, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p2.MachineID != "m-5678" {
		t.Errorf("after update MachineID = %q, want m-5678", p2.MachineID)
	}
}
