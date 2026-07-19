package store

import (
	"testing"
	"time"

	"devdeck/backend/internal/port"
)

func TestRunDueRecurringInvoicesGeneratesOnceThenSkipsSameMonth(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	tpl, err := s.CreateRecurringTemplate(ws.ID, "Umbrella LLC", "Jakarta", nil, "BCA", "Andi Syahruddin", "6281892573", 5, 14, "2026-07-01")
	if err != nil {
		t.Fatal(err)
	}
	today := time.Date(2026, time.July, 5, 0, 0, 0, 0, time.UTC)

	generated, err := s.RunDueRecurringInvoicesAt(today)
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) != 1 {
		t.Fatalf("first run generated %d invoices, want 1", len(generated))
	}
	if generated[0].Status != "draft" || generated[0].CompanyName != "Umbrella LLC" {
		t.Errorf("generated invoice = %+v, want Status=draft CompanyName=Umbrella LLC", generated[0])
	}
	wantDue := "2026-07-19" // 2026-07-05 + 14 days
	if generated[0].DueDate != wantDue {
		t.Errorf("generated invoice DueDate = %q, want %q", generated[0].DueDate, wantDue)
	}

	got, err := s.recurringTemplateByID(tpl.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.LastGeneratedYm != "2026-07" {
		t.Errorf("LastGeneratedYm = %q, want 2026-07", got.LastGeneratedYm)
	}

	generated2, err := s.RunDueRecurringInvoicesAt(time.Date(2026, time.July, 20, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(generated2) != 0 {
		t.Errorf("second run in same month generated %d invoices, want 0", len(generated2))
	}
}

func TestRunDueRecurringInvoicesSkipsInactiveAndNotYetDue(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	if _, err := s.CreateRecurringTemplate(ws.ID, "Northwind", "SF", nil, "BCA", "Andi Syahruddin", "6281892573", 20, 14, "2026-07-01"); err != nil {
		t.Fatal(err)
	}
	tpl2, err := s.CreateRecurringTemplate(ws.ID, "Initech", "", nil, "BCA", "Andi Syahruddin", "6281892573", 1, 14, "2026-07-01")
	if err != nil {
		t.Fatal(err)
	}
	inactive := false
	if _, err := s.UpdateRecurringTemplate(tpl2.ID, port.RecurringTemplatePatch{Active: &inactive}); err != nil {
		t.Fatal(err)
	}

	generated, err := s.RunDueRecurringInvoicesAt(time.Date(2026, time.July, 5, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) != 0 {
		t.Errorf("RunDueRecurringInvoicesAt = %d invoices, want 0 (one not due, one inactive)", len(generated))
	}
}

func TestRunDueRecurringInvoicesClampsDayOfMonthToShortMonths(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	if _, err := s.CreateRecurringTemplate(ws.ID, "Umbrella LLC", "Jakarta", nil, "BCA", "Andi Syahruddin", "6281892573", 28, 14, "2026-01-01"); err != nil {
		t.Fatal(err)
	}
	generated, err := s.RunDueRecurringInvoicesAt(time.Date(2026, time.February, 28, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) != 1 {
		t.Fatalf("RunDueRecurringInvoicesAt on Feb 28 = %d invoices, want 1", len(generated))
	}
}
