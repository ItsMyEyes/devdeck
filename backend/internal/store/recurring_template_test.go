package store

import (
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

func TestCreateRecurringTemplatePersistsAndNestsInWorkspace(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	items := []domain.InvoiceItem{{Description: "Retainer", Quantity: 1, UnitPrice: 5000000}}
	tpl, err := s.CreateRecurringTemplate(ws.ID, "Umbrella LLC", "Jakarta", items, "BCA", "Andi Syahruddin", "6281892573", 5, 14, "2026-07-02")
	if err != nil {
		t.Fatal(err)
	}
	if tpl.ID == "" || !tpl.Active || tpl.DayOfMonth != 5 || tpl.PaymentTermDays != 14 {
		t.Errorf("CreateRecurringTemplate = %+v, want Active=true DayOfMonth=5 PaymentTermDays=14", tpl)
	}
	if len(tpl.Items) != 1 || tpl.Items[0].Description != "Retainer" {
		t.Errorf("CreateRecurringTemplate Items = %+v, want one Retainer line", tpl.Items)
	}

	got, err := s.workspaceByID(ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RecurringTemplates) != 1 || got.RecurringTemplates[0].ID != tpl.ID {
		t.Errorf("workspaceByID().RecurringTemplates = %+v, want one entry with ID %q", got.RecurringTemplates, tpl.ID)
	}
}

func TestUpdateRecurringTemplateAppliesPartialPatch(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	tpl, err := s.CreateRecurringTemplate(ws.ID, "Umbrella LLC", "Jakarta", nil, "BCA", "Andi Syahruddin", "6281892573", 5, 14, "2026-07-02")
	if err != nil {
		t.Fatal(err)
	}
	inactive := false
	newDay := 20
	updated, err := s.UpdateRecurringTemplate(tpl.ID, port.RecurringTemplatePatch{Active: &inactive, DayOfMonth: &newDay})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Active {
		t.Error("UpdateRecurringTemplate Active = true, want false")
	}
	if updated.DayOfMonth != 20 {
		t.Errorf("UpdateRecurringTemplate DayOfMonth = %d, want 20", updated.DayOfMonth)
	}
	if updated.CompanyName != "Umbrella LLC" {
		t.Errorf("UpdateRecurringTemplate changed CompanyName to %q, want unchanged", updated.CompanyName)
	}
}

func TestDeleteRecurringTemplateRemovesIt(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	tpl, err := s.CreateRecurringTemplate(ws.ID, "Umbrella LLC", "Jakarta", nil, "BCA", "Andi Syahruddin", "6281892573", 5, 14, "2026-07-02")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteRecurringTemplate(tpl.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.workspaceByID(ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RecurringTemplates) != 0 {
		t.Errorf("RecurringTemplates after delete = %+v, want empty", got.RecurringTemplates)
	}
	if err := s.DeleteRecurringTemplate(tpl.ID); err != ErrNotFound {
		t.Errorf("DeleteRecurringTemplate on already-deleted id = %v, want ErrNotFound", err)
	}
}
