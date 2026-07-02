package store

import (
	"testing"

	"loom/backend/internal/port"
)

func TestCreateCompanyPersistsAndLists(t *testing.T) {
	s := newTestStore(t)
	c, err := s.CreateCompany("Umbrella LLC", "Jl. Sudirman No. 1, Jakarta")
	if err != nil {
		t.Fatal(err)
	}
	if c.ID == "" {
		t.Fatal("CreateCompany returned empty ID")
	}
	if c.Name != "Umbrella LLC" || c.ShortAddress != "Jl. Sudirman No. 1, Jakarta" {
		t.Errorf("CreateCompany = %+v, want Name=Umbrella LLC ShortAddress=Jl. Sudirman No. 1, Jakarta", c)
	}

	list, err := s.Companies()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != c.ID {
		t.Errorf("Companies() = %+v, want a single entry with ID %q", list, c.ID)
	}
}

func TestUpdateCompanyAppliesPartialPatch(t *testing.T) {
	s := newTestStore(t)
	c, err := s.CreateCompany("Umbrella LLC", "Old address")
	if err != nil {
		t.Fatal(err)
	}
	newAddress := "New address"
	updated, err := s.UpdateCompany(c.ID, port.CompanyPatch{ShortAddress: &newAddress})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Umbrella LLC" {
		t.Errorf("UpdateCompany changed Name to %q, want it unchanged (patch didn't set Name)", updated.Name)
	}
	if updated.ShortAddress != "New address" {
		t.Errorf("UpdateCompany ShortAddress = %q, want %q", updated.ShortAddress, "New address")
	}
}

func TestDeleteCompanyRemovesIt(t *testing.T) {
	s := newTestStore(t)
	c, err := s.CreateCompany("Umbrella LLC", "Jakarta")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteCompany(c.ID); err != nil {
		t.Fatal(err)
	}
	list, err := s.Companies()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Errorf("Companies() after delete = %+v, want empty", list)
	}
	if err := s.DeleteCompany(c.ID); err != ErrNotFound {
		t.Errorf("DeleteCompany on already-deleted id = %v, want ErrNotFound", err)
	}
}
