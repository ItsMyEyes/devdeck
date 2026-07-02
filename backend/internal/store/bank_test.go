package store

import (
	"testing"

	"loom/backend/internal/port"
)

func TestCreateBankPersistsAndLists(t *testing.T) {
	s := newTestStore(t)
	b, err := s.CreateBank("BCA", "Andi Syahruddin", "6281892573")
	if err != nil {
		t.Fatal(err)
	}
	if b.ID == "" {
		t.Fatal("CreateBank returned empty ID")
	}
	if b.BankName != "BCA" || b.AccountName != "Andi Syahruddin" || b.AccountNumber != "6281892573" {
		t.Errorf("CreateBank = %+v, want BankName=BCA AccountName=Andi Syahruddin AccountNumber=6281892573", b)
	}

	list, err := s.Banks()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != b.ID {
		t.Errorf("Banks() = %+v, want a single entry with ID %q", list, b.ID)
	}
}

func TestUpdateBankAppliesPartialPatch(t *testing.T) {
	s := newTestStore(t)
	b, err := s.CreateBank("BCA", "Andi Syahruddin", "6281892573")
	if err != nil {
		t.Fatal(err)
	}
	newNumber := "0000000000"
	updated, err := s.UpdateBank(b.ID, port.BankPatch{AccountNumber: &newNumber})
	if err != nil {
		t.Fatal(err)
	}
	if updated.BankName != "BCA" {
		t.Errorf("UpdateBank changed BankName to %q, want it unchanged", updated.BankName)
	}
	if updated.AccountNumber != "0000000000" {
		t.Errorf("UpdateBank AccountNumber = %q, want %q", updated.AccountNumber, "0000000000")
	}
}

func TestDeleteBankRemovesIt(t *testing.T) {
	s := newTestStore(t)
	b, err := s.CreateBank("BCA", "Andi Syahruddin", "6281892573")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteBank(b.ID); err != nil {
		t.Fatal(err)
	}
	list, err := s.Banks()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Errorf("Banks() after delete = %+v, want empty", list)
	}
	if err := s.DeleteBank(b.ID); err != ErrNotFound {
		t.Errorf("DeleteBank on already-deleted id = %v, want ErrNotFound", err)
	}
}
