package store

import (
	"testing"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func TestCreateInvoiceComputesAmountFromItems(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	items := []domain.InvoiceItem{
		{Description: "Backend engineering", Quantity: 3, UnitPrice: 500000},
		{Description: "Code review", Quantity: 2, UnitPrice: 250000},
	}
	iv, err := s.CreateInvoice(ws.ID, "INV-1", "Umbrella LLC", "Jakarta", items,
		"2026-08-01", "2026-07-02", "draft", "BCA", "Andi Syahruddin", "6281892573")
	if err != nil {
		t.Fatal(err)
	}
	wantAmount := 3*500000.0 + 2*250000.0
	if iv.Amount != wantAmount {
		t.Errorf("CreateInvoice amount = %v, want %v (sum of qty * unitPrice)", iv.Amount, wantAmount)
	}
	if len(iv.Items) != 2 {
		t.Fatalf("CreateInvoice Items = %+v, want 2 entries", iv.Items)
	}
	if iv.Items[0].Description != "Backend engineering" {
		t.Errorf("CreateInvoice Items[0].Description = %q, want %q", iv.Items[0].Description, "Backend engineering")
	}
	if iv.CompanyName != "Umbrella LLC" || iv.CompanyAddress != "Jakarta" {
		t.Errorf("CreateInvoice company snapshot = %q/%q, want Umbrella LLC/Jakarta", iv.CompanyName, iv.CompanyAddress)
	}
}

func TestInvoiceItemsRoundTripThroughReload(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	items := []domain.InvoiceItem{{Description: "Consulting", Quantity: 1, UnitPrice: 1000000}}
	created, err := s.CreateInvoice(ws.ID, "INV-2", "Northwind", "SF", items,
		"2026-08-01", "2026-07-02", "draft", "BCA", "Andi Syahruddin", "6281892573")
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := s.invoiceByID(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Items) != 1 || reloaded.Items[0].Quantity != 1 || reloaded.Items[0].UnitPrice != 1000000 {
		t.Errorf("reloaded Items = %+v, want a single 1x1000000 item", reloaded.Items)
	}
}

func TestUpdateInvoiceItemsRecomputesAmount(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	iv, err := s.CreateInvoice(ws.ID, "INV-3", "Initech", "NY",
		[]domain.InvoiceItem{{Description: "A", Quantity: 1, UnitPrice: 100}},
		"2026-08-01", "2026-07-02", "draft", "BCA", "Andi Syahruddin", "6281892573")
	if err != nil {
		t.Fatal(err)
	}
	newItems := []domain.InvoiceItem{{Description: "B", Quantity: 4, UnitPrice: 250}}
	updated, err := s.UpdateInvoice(iv.ID, port.InvoicePatch{Items: &newItems})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Amount != 1000 {
		t.Errorf("UpdateInvoice amount after items patch = %v, want 1000", updated.Amount)
	}
}
