package store

import (
	"errors"
	"testing"

	"loom/backend/internal/port"
)

func TestCreateMachinePersistsAndLists(t *testing.T) {
	s := newTestStore(t)
	m, err := s.CreateMachine("builder", "https://builder.tail-x.ts.net", "rt-key-1")
	if err != nil {
		t.Fatal(err)
	}
	if m.ID == "" || m.ID[:2] != "m-" {
		t.Errorf("ID = %q, want m- prefix", m.ID)
	}
	list, err := s.Machines()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Key != "rt-key-1" || list[0].URL != "https://builder.tail-x.ts.net" {
		t.Errorf("Machines() = %+v", list)
	}
}

func TestUpdateMachineAppliesPartialPatch(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.CreateMachine("builder", "https://old.ts.net", "k1")
	newURL := "https://new.ts.net"
	got, err := s.UpdateMachine(m.ID, port.MachinePatch{URL: &newURL})
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != newURL || got.Name != "builder" || got.Key != "k1" {
		t.Errorf("UpdateMachine = %+v, want only URL changed", got)
	}
}

func TestDeleteMachineRemovesIt(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.CreateMachine("builder", "https://b.ts.net", "k")
	if err := s.DeleteMachine(m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MachineByID(m.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("MachineByID after delete = %v, want ErrNotFound", err)
	}
}

func TestMachineByIDMissingReturnsNotFound(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.MachineByID("m-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}
