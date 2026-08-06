package store

import (
	"testing"

	"devdeck/backend/internal/port"
)

func newForwardTestConnection(t *testing.T, s *Store) string {
	t.Helper()
	conn, err := s.CreateSSHConnection("web", "", "example.com", 22, "root", "password", nil, nil)
	if err != nil {
		t.Fatalf("CreateSSHConnection: %v", err)
	}
	return conn.ID
}

func forwardPatch(bindPort int, label string) port.SSHForwardPatch {
	return port.SSHForwardPatch{BindPort: &bindPort, Label: &label}
}

func TestCreateAndListSSHForwards(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)

	fwd, err := s.CreateSSHForward(connID, "local", "127.0.0.1", 5432, "db.internal", 5432, "prod db")
	if err != nil {
		t.Fatalf("CreateSSHForward: %v", err)
	}
	if fwd.ID == "" {
		t.Fatal("CreateSSHForward returned an empty id")
	}
	if fwd.Mode != "local" || fwd.BindPort != 5432 || fwd.TargetHost != "db.internal" {
		t.Fatalf("unexpected round-trip: %+v", fwd)
	}

	list, err := s.SSHForwards(connID)
	if err != nil {
		t.Fatalf("SSHForwards: %v", err)
	}
	if len(list) != 1 || list[0].ID != fwd.ID {
		t.Fatalf("SSHForwards = %+v, want the one created rule", list)
	}
}

func TestSSHForwardsAreScopedToTheirConnection(t *testing.T) {
	s := newTestStore(t)
	a := newForwardTestConnection(t, s)
	b := newForwardTestConnection(t, s)

	if _, err := s.CreateSSHForward(a, "local", "127.0.0.1", 5432, "db", 5432, ""); err != nil {
		t.Fatal(err)
	}

	list, err := s.SSHForwards(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("connection b sees %d rules from connection a", len(list))
	}
}

func TestUpdateSSHForward(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)
	fwd, err := s.CreateSSHForward(connID, "local", "127.0.0.1", 5432, "db", 5432, "")
	if err != nil {
		t.Fatal(err)
	}

	got, err := s.UpdateSSHForward(fwd.ID, forwardPatch(6543, "renamed"))
	if err != nil {
		t.Fatalf("UpdateSSHForward: %v", err)
	}
	if got.BindPort != 6543 || got.Label != "renamed" {
		t.Fatalf("patch not applied: %+v", got)
	}
	if got.TargetHost != "db" {
		t.Errorf("unpatched field changed: TargetHost = %q, want \"db\"", got.TargetHost)
	}
}

func TestDeleteSSHForward(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)
	fwd, err := s.CreateSSHForward(connID, "dynamic", "127.0.0.1", 1081, "", 0, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteSSHForward(fwd.ID); err != nil {
		t.Fatalf("DeleteSSHForward: %v", err)
	}
	if _, err := s.SSHForwardByID(fwd.ID); err == nil {
		t.Fatal("SSHForwardByID succeeded after delete")
	}
}

func TestDeletingConnectionCascadesToForwards(t *testing.T) {
	s := newTestStore(t)
	connID := newForwardTestConnection(t, s)
	fwd, err := s.CreateSSHForward(connID, "local", "127.0.0.1", 5432, "db", 5432, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteSSHConnection(connID); err != nil {
		t.Fatalf("DeleteSSHConnection: %v", err)
	}
	if _, err := s.SSHForwardByID(fwd.ID); err == nil {
		t.Fatal("forward survived its connection being deleted; the FK cascade is not working")
	}
}
