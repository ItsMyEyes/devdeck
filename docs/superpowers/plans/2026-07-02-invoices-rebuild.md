# Invoices Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Invoices module around reusable Company/Bank presets, a job-details line-item table, a fixed personal-details (issuer) block, and a generated payment-method paragraph — replacing today's single free-text company/client/amount fields.

**Architecture:** Two new global (not workspace-scoped) CRUD resources, `Company` and `Bank`, act as pickable presets whose values are copied (snapshotted) onto an `Invoice` at create/edit time — no foreign keys, so issued invoices stay immutable if a preset changes later. `Invoice` gains an `items[]` line-item array (stored as a JSON column, mirroring how `Worktree.lines` already works) and drops its free-text `client`/`company` fields in favor of `companyName`/`companyAddress`. The frontend gets two small "load preset" dropdowns, a dynamic line-items table in the invoice draft form, and a rebuilt printable HTML export.

**Tech Stack:** Go 1.25 stdlib `net/http` + `modernc.org/sqlite` (backend), React 19 + TanStack Router + `@tanstack/react-query` + zustand + Tailwind v4 (frontend). No new dependencies.

## Global Constraints

- API error responses are exactly `{"error":"<message>"}`; success responses return the domain object(s) directly, no wrapper envelope. (CONTRACTS.md)
- Go handlers use `handleStoreErr(w, err)` to map store errors to HTTP responses; never leak a raw SQL error to the client. (CONTRACTS.md)
- All persistence goes through `port.Store`; never call `db.Query()`/`db.Exec()` outside `backend/internal/store/`. (CLAUDE.md)
- Patch structs use `*T` pointer fields for optional updates; `nil` means "not provided." (CONTRACTS.md)
- `frontend/src/store/types.ts` and `backend/internal/domain/models.go` must mirror each other exactly: same JSON key names, `float64 ↔ number`, `*string ↔ string | null`, `bool ↔ boolean`. (CONTRACTS.md)
- Frontend imports from `src/` always use the `@/*` alias, never relative paths. (CONTRACTS.md)
- `verbatimModuleSyntax` is on — use `import type` for type-only imports. (CONTRACTS.md)
- Never hand-edit `frontend/src/routeTree.gen.ts`. (CLAUDE.md)
- IDs are type-prefixed hex generated via `idGen(prefix)`; this plan introduces `co-` (company) and `bk-` (bank). (.claude/rules/go.md)
- Run `go vet ./...` and `npm run typecheck` before committing. (COMMANDS.md)
- No test framework exists on the frontend (no Vitest/Jest configured) — frontend verification is `npm run typecheck` plus manual dev-server exercise, not unit tests. Backend verification uses Go's stdlib `testing` package, matching the existing `backend/internal/store/*_test.go` convention.

---

### Task 1: Backend — Company resource (reusable "bill to" preset)

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `backend/internal/store/db.go`
- Create: `backend/internal/store/company.go`
- Create: `backend/internal/store/company_test.go`
- Modify: `backend/internal/port/store.go`
- Create: `backend/internal/handler/company.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces: `domain.Company{ID, Name, ShortAddress string}`; `port.CompanyPatch{Name, ShortAddress *string}`; `Store.Companies() ([]domain.Company, error)`; `Store.CreateCompany(name, shortAddress string) (domain.Company, error)`; `Store.UpdateCompany(id string, p port.CompanyPatch) (domain.Company, error)`; `Store.DeleteCompany(id string) error`; routes `GET/POST /api/companies`, `PATCH/DELETE /api/companies/{id}`.

- [ ] **Step 1: Write the failing store test**

Create `backend/internal/store/company_test.go`:

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/... -run TestCreateCompanyPersistsAndLists -v`
Expected: FAIL — compile error, `s.CreateCompany` undefined (`domain.Company` doesn't exist yet).

- [ ] **Step 3: Add the `Company` domain type**

In `backend/internal/domain/models.go`, add after the `BankDetail` struct (before `Invoice`):

```go
// Company mirrors the frontend Company type — a reusable billing preset
// for the client being invoiced.
type Company struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ShortAddress string `json:"shortAddress"`
}
```

- [ ] **Step 4: Add the `companies` table to the schema**

In `backend/internal/store/db.go`, insert into the `schema` constant, after the `todos` table block and before the `invoices` table block:

```sql
CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  short_address TEXT NOT NULL DEFAULT ''
);
```

`CREATE TABLE IF NOT EXISTS` is enough here (no `ALTER TABLE` migration needed) — this is a brand-new table, so it gets created on every `Open()` for both fresh and pre-existing databases.

- [ ] **Step 5: Implement the store layer**

Create `backend/internal/store/company.go`:

```go
package store

import (
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func scanCompany(sc scanner) (domain.Company, error) {
	var c domain.Company
	err := sc.Scan(&c.ID, &c.Name, &c.ShortAddress)
	return c, err
}

// Companies returns all saved company presets, most recently created first.
func (s *Store) Companies() ([]domain.Company, error) {
	rows, err := s.db.Query(`SELECT id, name, short_address FROM companies ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Company{}
	for rows.Next() {
		c, err := scanCompany(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) companyByID(id string) (domain.Company, error) {
	c, err := scanCompany(s.db.QueryRow(`SELECT id, name, short_address FROM companies WHERE id = ?`, id))
	if err != nil {
		return domain.Company{}, mapNotFound(err)
	}
	return c, nil
}

// CreateCompany creates a new company preset.
func (s *Store) CreateCompany(name, shortAddress string) (domain.Company, error) {
	id := idGen("co-")
	if _, err := s.db.Exec(`INSERT INTO companies (id, name, short_address) VALUES (?, ?, ?)`, id, name, shortAddress); err != nil {
		return domain.Company{}, err
	}
	return s.companyByID(id)
}

// UpdateCompany applies a partial update to a company preset.
func (s *Store) UpdateCompany(id string, p port.CompanyPatch) (domain.Company, error) {
	if _, err := s.companyByID(id); err != nil {
		return domain.Company{}, err
	}
	if err := firstErr(
		setStr(s.db, "companies", "name", id, p.Name),
		setStr(s.db, "companies", "short_address", id, p.ShortAddress),
	); err != nil {
		return domain.Company{}, err
	}
	return s.companyByID(id)
}

// DeleteCompany deletes a company preset.
func (s *Store) DeleteCompany(id string) error {
	res, err := s.db.Exec(`DELETE FROM companies WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
```

- [ ] **Step 6: Add the port interface method and patch type**

In `backend/internal/port/store.go`, add to the `Store` interface (after the `Invoices` block):

```go
	// Companies (global billing presets, not scoped to a workspace)
	Companies() ([]domain.Company, error)
	CreateCompany(name, shortAddress string) (domain.Company, error)
	UpdateCompany(id string, p CompanyPatch) (domain.Company, error)
	DeleteCompany(id string) error
```

And add the patch type after `InvoicePatch`:

```go
// CompanyPatch carries optional fields for a partial company update.
type CompanyPatch struct {
	Name         *string
	ShortAddress *string
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && go test ./internal/store/... -run 'TestCreateCompanyPersistsAndLists|TestUpdateCompanyAppliesPartialPatch|TestDeleteCompanyRemovesIt' -v`
Expected: PASS (all three tests).

- [ ] **Step 8: Add the HTTP handler**

Create `backend/internal/handler/company.go`:

```go
package handler

import (
	"net/http"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// CompanyHandler handles company-preset CRUD endpoints.
type CompanyHandler struct {
	st *store.Store
}

// NewCompanyHandler creates a company handler.
func NewCompanyHandler(st *store.Store) *CompanyHandler {
	return &CompanyHandler{st: st}
}

// GetCompanies returns all saved company presets.
func (h *CompanyHandler) GetCompanies(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Companies()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// PostCompany creates a company preset.
func (h *CompanyHandler) PostCompany(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         *string `json:"name"`
		ShortAddress *string `json:"shortAddress"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, err := h.st.CreateCompany(str(body.Name), str(body.ShortAddress))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// PatchCompany updates a company preset.
func (h *CompanyHandler) PatchCompany(w http.ResponseWriter, r *http.Request) {
	var p port.CompanyPatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, err := h.st.UpdateCompany(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// DeleteCompany deletes a company preset.
func (h *CompanyHandler) DeleteCompany(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteCompany(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 9: Wire the handler and routes into `main.go`**

In `backend/cmd/server/main.go`, add after `invH := handler.NewInvoiceHandler(st)`:

```go
	companyH := handler.NewCompanyHandler(st)
```

And add after the invoice routes block (`mux.HandleFunc("DELETE /api/invoices/{id}", invH.DeleteInvoice)`):

```go
	mux.HandleFunc("GET /api/companies", companyH.GetCompanies)
	mux.HandleFunc("POST /api/companies", companyH.PostCompany)
	mux.HandleFunc("PATCH /api/companies/{id}", companyH.PatchCompany)
	mux.HandleFunc("DELETE /api/companies/{id}", companyH.DeleteCompany)
```

- [ ] **Step 10: Verify the whole backend still builds**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no output, exit code 0.

- [ ] **Step 11: Commit**

```bash
git add backend/internal/domain/models.go backend/internal/store/db.go \
  backend/internal/store/company.go backend/internal/store/company_test.go \
  backend/internal/port/store.go backend/internal/handler/company.go \
  backend/cmd/server/main.go
git commit -m "feat: add Company preset resource (backend)"
```

(Skip this step if the working directory is not a git repository.)

---

### Task 2: Backend — Bank resource (reusable payout-account preset)

Mirrors Task 1 exactly, for `Bank` instead of `Company`.

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `backend/internal/store/db.go`
- Create: `backend/internal/store/bank.go`
- Create: `backend/internal/store/bank_test.go`
- Modify: `backend/internal/port/store.go`
- Create: `backend/internal/handler/bank.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces: `domain.Bank{ID, BankName, AccountName, AccountNumber string}`; `port.BankPatch{BankName, AccountName, AccountNumber *string}`; `Store.Banks() ([]domain.Bank, error)`; `Store.CreateBank(bankName, accountName, accountNumber string) (domain.Bank, error)`; `Store.UpdateBank(id string, p port.BankPatch) (domain.Bank, error)`; `Store.DeleteBank(id string) error`; routes `GET/POST /api/banks`, `PATCH/DELETE /api/banks/{id}`.

- [ ] **Step 1: Write the failing store test**

Create `backend/internal/store/bank_test.go`:

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/... -run TestCreateBankPersistsAndLists -v`
Expected: FAIL — compile error, `domain.Bank` doesn't exist yet.

- [ ] **Step 3: Add the `Bank` domain type**

In `backend/internal/domain/models.go`, add directly after the `Company` struct added in Task 1:

```go
// Bank mirrors the frontend Bank type — a reusable payout-account preset
// used to prefill an invoice's payment-method section.
type Bank struct {
	ID            string `json:"id"`
	BankName      string `json:"bankName"`
	AccountName   string `json:"accountName"`
	AccountNumber string `json:"accountNumber"`
}
```

- [ ] **Step 4: Add the `banks` table to the schema**

In `backend/internal/store/db.go`, insert into the `schema` constant, directly after the `companies` table block added in Task 1:

```sql
CREATE TABLE IF NOT EXISTS banks (
  id             TEXT PRIMARY KEY,
  bank_name      TEXT NOT NULL DEFAULT '',
  account_name   TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT ''
);
```

- [ ] **Step 5: Implement the store layer**

Create `backend/internal/store/bank.go`:

```go
package store

import (
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func scanBank(sc scanner) (domain.Bank, error) {
	var b domain.Bank
	err := sc.Scan(&b.ID, &b.BankName, &b.AccountName, &b.AccountNumber)
	return b, err
}

// Banks returns all saved bank presets, most recently created first.
func (s *Store) Banks() ([]domain.Bank, error) {
	rows, err := s.db.Query(`SELECT id, bank_name, account_name, account_number FROM banks ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Bank{}
	for rows.Next() {
		b, err := scanBank(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) bankByID(id string) (domain.Bank, error) {
	b, err := scanBank(s.db.QueryRow(`SELECT id, bank_name, account_name, account_number FROM banks WHERE id = ?`, id))
	if err != nil {
		return domain.Bank{}, mapNotFound(err)
	}
	return b, nil
}

// CreateBank creates a new bank preset.
func (s *Store) CreateBank(bankName, accountName, accountNumber string) (domain.Bank, error) {
	id := idGen("bk-")
	if _, err := s.db.Exec(`INSERT INTO banks (id, bank_name, account_name, account_number) VALUES (?, ?, ?, ?)`,
		id, bankName, accountName, accountNumber); err != nil {
		return domain.Bank{}, err
	}
	return s.bankByID(id)
}

// UpdateBank applies a partial update to a bank preset.
func (s *Store) UpdateBank(id string, p port.BankPatch) (domain.Bank, error) {
	if _, err := s.bankByID(id); err != nil {
		return domain.Bank{}, err
	}
	if err := firstErr(
		setStr(s.db, "banks", "bank_name", id, p.BankName),
		setStr(s.db, "banks", "account_name", id, p.AccountName),
		setStr(s.db, "banks", "account_number", id, p.AccountNumber),
	); err != nil {
		return domain.Bank{}, err
	}
	return s.bankByID(id)
}

// DeleteBank deletes a bank preset.
func (s *Store) DeleteBank(id string) error {
	res, err := s.db.Exec(`DELETE FROM banks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
```

- [ ] **Step 6: Add the port interface method and patch type**

In `backend/internal/port/store.go`, add to the `Store` interface (after the `Companies` block added in Task 1):

```go
	// Banks (global payout-account presets, not scoped to a workspace)
	Banks() ([]domain.Bank, error)
	CreateBank(bankName, accountName, accountNumber string) (domain.Bank, error)
	UpdateBank(id string, p BankPatch) (domain.Bank, error)
	DeleteBank(id string) error
```

And add the patch type after `CompanyPatch`:

```go
// BankPatch carries optional fields for a partial bank update.
type BankPatch struct {
	BankName      *string
	AccountName   *string
	AccountNumber *string
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && go test ./internal/store/... -run 'TestCreateBankPersistsAndLists|TestUpdateBankAppliesPartialPatch|TestDeleteBankRemovesIt' -v`
Expected: PASS (all three tests).

- [ ] **Step 8: Add the HTTP handler**

Create `backend/internal/handler/bank.go`:

```go
package handler

import (
	"net/http"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// BankHandler handles bank-preset CRUD endpoints.
type BankHandler struct {
	st *store.Store
}

// NewBankHandler creates a bank handler.
func NewBankHandler(st *store.Store) *BankHandler {
	return &BankHandler{st: st}
}

// GetBanks returns all saved bank presets.
func (h *BankHandler) GetBanks(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Banks()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// PostBank creates a bank preset.
func (h *BankHandler) PostBank(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BankName      *string `json:"bankName"`
		AccountName   *string `json:"accountName"`
		AccountNumber *string `json:"accountNumber"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	b, err := h.st.CreateBank(str(body.BankName), str(body.AccountName), str(body.AccountNumber))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// PatchBank updates a bank preset.
func (h *BankHandler) PatchBank(w http.ResponseWriter, r *http.Request) {
	var p port.BankPatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	b, err := h.st.UpdateBank(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// DeleteBank deletes a bank preset.
func (h *BankHandler) DeleteBank(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteBank(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 9: Wire the handler and routes into `main.go`**

In `backend/cmd/server/main.go`, add after `companyH := handler.NewCompanyHandler(st)`:

```go
	bankH := handler.NewBankHandler(st)
```

And add after the company routes block:

```go
	mux.HandleFunc("GET /api/banks", bankH.GetBanks)
	mux.HandleFunc("POST /api/banks", bankH.PostBank)
	mux.HandleFunc("PATCH /api/banks/{id}", bankH.PatchBank)
	mux.HandleFunc("DELETE /api/banks/{id}", bankH.DeleteBank)
```

- [ ] **Step 10: Verify the whole backend still builds**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no output, exit code 0.

- [ ] **Step 11: Commit**

```bash
git add backend/internal/domain/models.go backend/internal/store/db.go \
  backend/internal/store/bank.go backend/internal/store/bank_test.go \
  backend/internal/port/store.go backend/internal/handler/bank.go \
  backend/cmd/server/main.go
git commit -m "feat: add Bank preset resource (backend)"
```

(Skip this step if the working directory is not a git repository.)

---

### Task 3: Backend — Invoice restructure (items table, company snapshot)

This is one atomic change: Go requires the whole module to compile together, so the domain type, schema, store, port interface, seed data, and handler for `Invoice` all change in this single task.

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `backend/internal/store/db.go`
- Modify: `backend/internal/store/invoice.go`
- Create: `backend/internal/store/invoice_test.go`
- Modify: `backend/internal/store/seed.go`
- Modify: `backend/internal/port/store.go`
- Modify: `backend/internal/handler/invoice.go`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (Company/Bank are independent resources; Invoice does not reference them by ID, only by copied field values).
- Produces: `domain.InvoiceItem{Description string, Quantity, UnitPrice float64}`; updated `domain.Invoice{ID, Number, CompanyName, CompanyAddress string, Items []InvoiceItem, Amount float64, Status, CreatedAt, DueDate string, BankDetail BankDetail}`; `Store.CreateInvoice(wsID, number, companyName, companyAddress string, items []domain.InvoiceItem, dueDate, createdAt, status, bankName, bankAccountName, bankAccountNumber string) (domain.Invoice, error)`; updated `port.InvoicePatch` with `CompanyName`, `CompanyAddress`, `Items *[]domain.InvoiceItem` replacing `Client`, `Company`, `Amount`.

- [ ] **Step 1: Write the failing store test**

Create `backend/internal/store/invoice_test.go`:

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/... -run TestCreateInvoiceComputesAmountFromItems -v`
Expected: FAIL — compile error (`domain.InvoiceItem` doesn't exist, `CreateInvoice` signature mismatch).

- [ ] **Step 3: Update the `Invoice` domain type and add `InvoiceItem`**

In `backend/internal/domain/models.go`, replace the existing `Invoice` struct with:

```go
// InvoiceItem is a single line item on an invoice's job-details table.
type InvoiceItem struct {
	Description string  `json:"description"`
	Quantity    float64 `json:"quantity"`
	UnitPrice   float64 `json:"unitPrice"`
}

// Invoice mirrors the frontend Invoice type.
type Invoice struct {
	ID             string        `json:"id"`
	Number         string        `json:"number"`
	CompanyName    string        `json:"companyName"`
	CompanyAddress string        `json:"companyAddress"`
	Items          []InvoiceItem `json:"items"`
	Amount         float64       `json:"amount"`
	Status         string        `json:"status"`
	CreatedAt      string        `json:"createdAt"`
	DueDate        string        `json:"dueDate"`
	BankDetail     BankDetail    `json:"bankDetail"`
}
```

- [ ] **Step 4: Update the `invoices` table schema and add a migration for existing databases**

In `backend/internal/store/db.go`, update the base `CREATE TABLE IF NOT EXISTS invoices (...)` block (for brand-new databases) to add the three new columns — keep `client` and `company` as-is (unused going forward, but not worth an unsupported SQLite column-drop):

```sql
CREATE TABLE IF NOT EXISTS invoices (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number              TEXT NOT NULL DEFAULT '',
  client              TEXT NOT NULL DEFAULT '',
  company             TEXT NOT NULL DEFAULT '',
  company_name        TEXT NOT NULL DEFAULT '',
  company_address     TEXT NOT NULL DEFAULT '',
  items_json          TEXT NOT NULL DEFAULT '[]',
  amount              REAL NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft',
  due_date            TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT '',
  bank_name           TEXT NOT NULL DEFAULT '',
  bank_account_name   TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT ''
);
```

Add a new migration function, following the `migrateInvoiceColumns` pattern directly above it:

```go
// migrateInvoiceItemsColumns adds columns introduced when invoices moved from
// a flat client/company/amount shape to a company snapshot + items table
// (company_name, company_address, items_json) to any pre-existing local
// database. Errors from a column that's already present are expected and
// ignored.
func migrateInvoiceItemsColumns(db *sql.DB) error {
	cols := []string{
		"company_name TEXT NOT NULL DEFAULT ''",
		"company_address TEXT NOT NULL DEFAULT ''",
		"items_json TEXT NOT NULL DEFAULT '[]'",
	}
	for _, col := range cols {
		if _, err := db.Exec("ALTER TABLE invoices ADD COLUMN " + col); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	return nil
}
```

Call it from `Open()`, alongside the existing migration calls:

```go
	if err := migrateInvoiceItemsColumns(db); err != nil {
		db.Close()
		return nil, err
	}
```

- [ ] **Step 5: Rewrite `backend/internal/store/invoice.go`**

Replace the whole file with:

```go
package store

import (
	"encoding/json"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

const invoiceColumns = `id, number, company_name, company_address, items_json, amount, status, due_date, created_at, bank_name, bank_account_name, bank_account_number`

func scanInvoice(sc scanner) (domain.Invoice, error) {
	var iv domain.Invoice
	var itemsJSON string
	err := sc.Scan(&iv.ID, &iv.Number, &iv.CompanyName, &iv.CompanyAddress, &itemsJSON, &iv.Amount, &iv.Status, &iv.DueDate, &iv.CreatedAt,
		&iv.BankDetail.BankName, &iv.BankDetail.AccountName, &iv.BankDetail.AccountNumber)
	if err != nil {
		return iv, err
	}
	if itemsJSON == "" {
		iv.Items = []domain.InvoiceItem{}
	} else if err := json.Unmarshal([]byte(itemsJSON), &iv.Items); err != nil {
		return iv, err
	}
	if iv.Items == nil {
		iv.Items = []domain.InvoiceItem{}
	}
	return iv, nil
}

func (s *Store) invoicesOf(wsID string) ([]domain.Invoice, error) {
	rows, err := s.db.Query(`SELECT `+invoiceColumns+` FROM invoices WHERE workspace_id = ? ORDER BY rowid DESC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Invoice{}
	for rows.Next() {
		iv, err := scanInvoice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, iv)
	}
	return out, rows.Err()
}

func (s *Store) invoiceByID(id string) (domain.Invoice, error) {
	iv, err := scanInvoice(s.db.QueryRow(`SELECT `+invoiceColumns+` FROM invoices WHERE id = ?`, id))
	if err != nil {
		return domain.Invoice{}, mapNotFound(err)
	}
	return iv, nil
}

// itemsTotal sums quantity * unitPrice across all items.
func itemsTotal(items []domain.InvoiceItem) float64 {
	var total float64
	for _, it := range items {
		total += it.Quantity * it.UnitPrice
	}
	return total
}

// CreateInvoice creates an invoice. companyName/companyAddress and the bank
// fields are caller-supplied snapshots (typically copied from a Company/Bank
// preset) — Invoice does not hold a foreign key to either.
func (s *Store) CreateInvoice(wsID, number, companyName, companyAddress string, items []domain.InvoiceItem, dueDate, createdAt, status, bankName, bankAccountName, bankAccountNumber string) (domain.Invoice, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.Invoice{}, err
	}
	if !ok {
		return domain.Invoice{}, ErrNotFound
	}
	if companyName == "" {
		companyName = "Untitled client"
	}
	if dueDate == "" {
		dueDate = "—"
	}
	if status == "" {
		status = "draft"
	}
	if items == nil {
		items = []domain.InvoiceItem{}
	}
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return domain.Invoice{}, err
	}
	id := idGen("iv-")
	if _, err := s.db.Exec(`INSERT INTO invoices (id, workspace_id, number, company_name, company_address, items_json, amount, status, due_date, created_at, bank_name, bank_account_name, bank_account_number)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, wsID, number, companyName, companyAddress, string(itemsJSON), itemsTotal(items), status, dueDate, createdAt,
		bankName, bankAccountName, bankAccountNumber); err != nil {
		return domain.Invoice{}, err
	}
	return s.invoiceByID(id)
}

func (s *Store) UpdateInvoice(id string, p port.InvoicePatch) (domain.Invoice, error) {
	if _, err := s.invoiceByID(id); err != nil {
		return domain.Invoice{}, err
	}
	if err := firstErr(
		setStr(s.db, "invoices", "number", id, p.Number),
		setStr(s.db, "invoices", "company_name", id, p.CompanyName),
		setStr(s.db, "invoices", "company_address", id, p.CompanyAddress),
		setStr(s.db, "invoices", "due_date", id, p.DueDate),
		setStr(s.db, "invoices", "status", id, p.Status),
		setStr(s.db, "invoices", "bank_name", id, p.BankName),
		setStr(s.db, "invoices", "bank_account_name", id, p.BankAccountName),
		setStr(s.db, "invoices", "bank_account_number", id, p.BankAccountNumber),
	); err != nil {
		return domain.Invoice{}, err
	}
	if p.Items != nil {
		itemsJSON, err := json.Marshal(*p.Items)
		if err != nil {
			return domain.Invoice{}, err
		}
		if _, err := s.db.Exec(`UPDATE invoices SET items_json = ?, amount = ? WHERE id = ?`,
			string(itemsJSON), itemsTotal(*p.Items), id); err != nil {
			return domain.Invoice{}, err
		}
	}
	return s.invoiceByID(id)
}

func (s *Store) DeleteInvoice(id string) error {
	res, err := s.db.Exec(`DELETE FROM invoices WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
```

- [ ] **Step 6: Update the port interface**

In `backend/internal/port/store.go`, replace the `CreateInvoice` line in the `Store` interface with:

```go
	CreateInvoice(wsID, number, companyName, companyAddress string, items []domain.InvoiceItem, dueDate, createdAt, status, bankName, bankAccountName, bankAccountNumber string) (domain.Invoice, error)
```

And replace the `InvoicePatch` struct with:

```go
// InvoicePatch carries optional fields for a partial invoice update.
type InvoicePatch struct {
	Number            *string
	CompanyName       *string
	CompanyAddress    *string
	Items             *[]domain.InvoiceItem
	DueDate           *string
	Status            *string
	BankName          *string
	BankAccountName   *string
	BankAccountNumber *string
}
```

- [ ] **Step 7: Update seed data (`backend/internal/store/seed.go`)**

This file references the old `Invoice.Client`/`.Company`/`.Amount` fields and won't compile until updated. Add `"encoding/json"` to the imports, then:

Replace the table-wipe loop and add seed company/bank inserts. Change:

```go
	for _, t := range []string{"worktrees", "projects", "news", "todos", "invoices", "workspaces"} {
		if _, err := s.db.Exec("DELETE FROM " + t); err != nil {
			return nil, err
		}
	}
```

to:

```go
	for _, t := range []string{"worktrees", "projects", "news", "todos", "invoices", "companies", "banks", "workspaces"} {
		if _, err := s.db.Exec("DELETE FROM " + t); err != nil {
			return nil, err
		}
	}

	for _, c := range seedCompanies() {
		if _, err := s.db.Exec(`INSERT INTO companies (id, name, short_address) VALUES (?, ?, ?)`,
			idGen("co-"), c.Name, c.ShortAddress); err != nil {
			return nil, err
		}
	}
	for _, b := range seedBanks() {
		if _, err := s.db.Exec(`INSERT INTO banks (id, bank_name, account_name, account_number) VALUES (?, ?, ?, ?)`,
			idGen("bk-"), b.BankName, b.AccountName, b.AccountNumber); err != nil {
			return nil, err
		}
	}
```

Replace the invoice-insert loop:

```go
		for j := len(ws.Invoices) - 1; j >= 0; j-- {
			iv := ws.Invoices[j]
			if _, err := s.db.Exec(`INSERT INTO invoices (id, workspace_id, number, client, company, amount, status, due_date, created_at, bank_name, bank_account_name, bank_account_number)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				idGen("iv-"), wsID, iv.Number, iv.Client, iv.Company, iv.Amount, iv.Status, iv.DueDate, iv.CreatedAt,
				iv.BankDetail.BankName, iv.BankDetail.AccountName, iv.BankDetail.AccountNumber); err != nil {
				return nil, err
			}
		}
```

with:

```go
		for j := len(ws.Invoices) - 1; j >= 0; j-- {
			iv := ws.Invoices[j]
			itemsJSON, err := json.Marshal(iv.Items)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(`INSERT INTO invoices (id, workspace_id, number, company_name, company_address, items_json, amount, status, due_date, created_at, bank_name, bank_account_name, bank_account_number)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				idGen("iv-"), wsID, iv.Number, iv.CompanyName, iv.CompanyAddress, string(itemsJSON), itemsTotal(iv.Items),
				iv.Status, iv.DueDate, iv.CreatedAt,
				iv.BankDetail.BankName, iv.BankDetail.AccountName, iv.BankDetail.AccountNumber); err != nil {
				return nil, err
			}
		}
```

Add two new factory functions (near `seedWorkspaces`):

```go
func seedCompanies() []domain.Company {
	return []domain.Company{
		{Name: "Umbrella LLC", ShortAddress: "Jl. Sudirman No. 25, Jakarta Selatan"},
		{Name: "Northwind Traders", ShortAddress: "500 Market St, San Francisco, CA"},
	}
}

func seedBanks() []domain.Bank {
	return []domain.Bank{
		{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"},
	}
}
```

Finally, replace every `Invoices: []domain.Invoice{...}` block inside `seedWorkspaces()` — there are two, one under `"Acme"` and one under `"Side projects"`. Replace the `"Acme"` one:

```go
			Invoices: []domain.Invoice{
				{Number: "INV-1043", CompanyName: "Umbrella LLC", CompanyAddress: "Jl. Sudirman No. 25, Jakarta Selatan", Items: []domain.InvoiceItem{{Description: "Backend API development", Quantity: 1, UnitPrice: 5600000}}, Status: "draft", CreatedAt: "2026-07-06", DueDate: "2026-07-20", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1042", CompanyName: "Northwind Traders", CompanyAddress: "500 Market St, San Francisco, CA", Items: []domain.InvoiceItem{{Description: "Sprint retainer — July", Quantity: 1, UnitPrice: 8500000}}, Status: "sent", CreatedAt: "2026-06-28", DueDate: "2026-07-12", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1040", CompanyName: "Initech", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Bug-fix retainer", Quantity: 1, UnitPrice: 3200000}}, Status: "overdue", CreatedAt: "2026-06-01", DueDate: "2026-06-15", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1041", CompanyName: "Globex Corp", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Platform migration", Quantity: 1, UnitPrice: 12400000}}, Status: "paid", CreatedAt: "2026-06-14", DueDate: "2026-06-28", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1039", CompanyName: "Soylent Inc", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Q2 engineering retainer", Quantity: 1, UnitPrice: 9800000}}, Status: "paid", CreatedAt: "2026-05-27", DueDate: "2026-06-10", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
			},
```

And the `"Side projects"` one:

```go
			Invoices: []domain.Invoice{
				{Number: "INV-2001", CompanyName: "Consulting — retainer", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Consulting retainer", Quantity: 1, UnitPrice: 1500000}}, Status: "sent", CreatedAt: "2026-07-04", DueDate: "2026-07-18", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
			},
```

- [ ] **Step 8: Update `backend/internal/handler/invoice.go`**

Replace the whole file with:

```go
package handler

import (
	"net/http"
	"time"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// InvoiceHandler handles invoice CRUD endpoints.
type InvoiceHandler struct {
	st *store.Store
}

// NewInvoiceHandler creates an invoice handler.
func NewInvoiceHandler(st *store.Store) *InvoiceHandler {
	return &InvoiceHandler{st: st}
}

func (h *InvoiceHandler) PostInvoice(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Number            *string              `json:"number"`
		CompanyName       *string              `json:"companyName"`
		CompanyAddress    *string              `json:"companyAddress"`
		Items             []domain.InvoiceItem `json:"items"`
		DueDate           *string              `json:"dueDate"`
		Status            *string              `json:"status"`
		BankName          *string              `json:"bankName"`
		BankAccountName   *string              `json:"bankAccountName"`
		BankAccountNumber *string              `json:"bankAccountNumber"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// createdAt is a server-assigned timestamp, never client-supplied.
	createdAt := time.Now().UTC().Format("2006-01-02")
	iv, err := h.st.CreateInvoice(
		r.PathValue("wsId"), str(body.Number), str(body.CompanyName), str(body.CompanyAddress),
		body.Items, str(body.DueDate), createdAt, str(body.Status),
		str(body.BankName), str(body.BankAccountName), str(body.BankAccountNumber),
	)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iv)
}

func (h *InvoiceHandler) PatchInvoice(w http.ResponseWriter, r *http.Request) {
	var p port.InvoicePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	iv, err := h.st.UpdateInvoice(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iv)
}

func (h *InvoiceHandler) DeleteInvoice(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteInvoice(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 9: Run the invoice tests to verify they pass**

Run: `cd backend && go test ./internal/store/... -run 'TestCreateInvoiceComputesAmountFromItems|TestInvoiceItemsRoundTripThroughReload|TestUpdateInvoiceItemsRecomputesAmount' -v`
Expected: PASS (all three tests).

- [ ] **Step 10: Verify the whole backend builds and all store tests pass**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: build and vet produce no output (exit 0); `go test ./...` reports `ok` for every package (existing worktree/service/detect/etc. tests must still pass unchanged).

- [ ] **Step 11: Commit**

```bash
git add backend/internal/domain/models.go backend/internal/store/db.go \
  backend/internal/store/invoice.go backend/internal/store/invoice_test.go \
  backend/internal/store/seed.go backend/internal/port/store.go \
  backend/internal/handler/invoice.go
git commit -m "feat: restructure Invoice around company snapshot + line items"
```

(Skip this step if the working directory is not a git repository.)

---

### Task 4: Frontend — Company & Bank types, API client, query hooks

**Files:**
- Modify: `frontend/src/store/types.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Produces: `Company{id, name, shortAddress}`, `Bank{id, bankName, accountName, accountNumber}` (types.ts); `fetchCompanies/createCompany/updateCompany/deleteCompany`, `fetchBanks/createBank/updateBank/deleteBank`, `CreateCompanyBody/UpdateCompanyBody`, `CreateBankBody/UpdateBankBody` (api.ts); `qk.companies`, `qk.banks` (keys.ts); `useCompanies/useCreateCompany/useUpdateCompany/useDeleteCompany`, `useBanks/useCreateBank/useUpdateBank/useDeleteBank` (queries.ts).

- [ ] **Step 1: Add `Company` and `Bank` to `frontend/src/store/types.ts`**

Add directly after the `BankDetail` interface:

```ts
export interface Company {
  id: string
  name: string
  shortAddress: string
}

export interface Bank {
  id: string
  bankName: string
  accountName: string
  accountNumber: string
}
```

- [ ] **Step 2: Add API client functions to `frontend/src/lib/api.ts`**

Add `Bank` and `Company` to the `import type { ... } from '@/store/types'` block at the top of the file (alphabetically, between `Agent...` entries and `FsEntry`):

```ts
import type {
  Agent,
  AgentModel,
  AgentSkill,
  AgentSummary,
  Bank,
  Company,
  FsEntry,
  Invoice,
  InvoiceStatus,
  NewsItem,
  Priority,
  Project,
  Settings,
  TermLine,
  Todo,
  Workspace,
  Worktree,
} from '@/store/types'
```

Add these body-shape interfaces, next to `CreateTodoBody`/`UpdateTodoBody`:

```ts
export interface CreateCompanyBody {
  name?: string
  shortAddress?: string
}

export interface UpdateCompanyBody {
  name?: string
  shortAddress?: string
}

export interface CreateBankBody {
  bankName?: string
  accountName?: string
  accountNumber?: string
}

export interface UpdateBankBody {
  bankName?: string
  accountName?: string
  accountNumber?: string
}
```

Add fetch/mutation functions, in a new section right after the `// ---- Invoices ----` block:

```ts
// ---- Companies ----

export function fetchCompanies(): Promise<Company[]> {
  return request<Company[]>('GET', '/companies')
}

export function createCompany(body: CreateCompanyBody): Promise<Company> {
  return request<Company>('POST', '/companies', body)
}

export function updateCompany(id: string, patch: UpdateCompanyBody): Promise<Company> {
  return request<Company>('PATCH', `/companies/${id}`, patch)
}

export function deleteCompany(id: string): Promise<void> {
  return request<void>('DELETE', `/companies/${id}`)
}

// ---- Banks ----

export function fetchBanks(): Promise<Bank[]> {
  return request<Bank[]>('GET', '/banks')
}

export function createBank(body: CreateBankBody): Promise<Bank> {
  return request<Bank>('POST', '/banks', body)
}

export function updateBank(id: string, patch: UpdateBankBody): Promise<Bank> {
  return request<Bank>('PATCH', `/banks/${id}`, patch)
}

export function deleteBank(id: string): Promise<void> {
  return request<void>('DELETE', `/banks/${id}`)
}
```

- [ ] **Step 3: Add cache keys to `frontend/src/features/data/keys.ts`**

Add to the `qk` object:

```ts
  companies: ['companies'] as const,
  banks: ['banks'] as const,
```

- [ ] **Step 4: Add query hooks to `frontend/src/features/data/queries.ts`**

Replace the two `import ... from '@/lib/api'` blocks at the top of the file with:

```ts
import {
  clearDoneTodos,
  createBank,
  createCompany,
  createInvoice,
  createNews,
  createProject,
  createTodo,
  createWorkspace,
  createWorktree,
  deleteBank,
  deleteCompany,
  deleteInvoice,
  deleteNews,
  deleteProject,
  deleteTodo,
  deleteWorkspace,
  deleteWorktree,
  fetchAgentModels,
  fetchAgentSkills,
  fetchAgents,
  fetchBanks,
  fetchCompanies,
  fetchFsList,
  fetchProjectBranches,
  fetchSettings,
  fetchWorkspaces,
  markAllNewsRead,
  seed,
  updateBank,
  updateCompany,
  updateInvoice,
  updateNews,
  updateProject,
  updateSettings,
  updateTodo,
  updateWorkspace,
  updateWorktree,
} from '@/lib/api'
import type {
  CreateBankBody,
  CreateCompanyBody,
  CreateInvoiceBody,
  CreateNewsBody,
  CreateProjectBody,
  CreateTodoBody,
  CreateWorkspaceBody,
  CreateWorktreeBody,
  SettingsPatch,
  UpdateBankBody,
  UpdateCompanyBody,
  UpdateInvoiceBody,
  UpdateNewsBody,
  UpdateProjectBody,
  UpdateTodoBody,
  UpdateWorkspaceBody,
  UpdateWorktreeBody,
} from '@/lib/api'
```

Then append this block right after the existing `useDeleteInvoice` function:

```ts
export function useCompanies() {
  return useQuery({ queryKey: qk.companies, queryFn: fetchCompanies })
}

function useInvalidateCompanies() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: qk.companies })
}

export function useCreateCompany() {
  const invalidate = useInvalidateCompanies()
  return useMutation({
    mutationFn: (body: CreateCompanyBody) => createCompany(body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateCompany() {
  const invalidate = useInvalidateCompanies()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateCompanyBody }) => updateCompany(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteCompany() {
  const invalidate = useInvalidateCompanies()
  return useMutation({
    mutationFn: (id: string) => deleteCompany(id),
    onSuccess: () => invalidate(),
  })
}

export function useBanks() {
  return useQuery({ queryKey: qk.banks, queryFn: fetchBanks })
}

function useInvalidateBanks() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: qk.banks })
}

export function useCreateBank() {
  const invalidate = useInvalidateBanks()
  return useMutation({
    mutationFn: (body: CreateBankBody) => createBank(body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateBank() {
  const invalidate = useInvalidateBanks()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateBankBody }) => updateBank(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteBank() {
  const invalidate = useInvalidateBanks()
  return useMutation({
    mutationFn: (id: string) => deleteBank(id),
    onSuccess: () => invalidate(),
  })
}
```

- [ ] **Step 5: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors (this task only adds new, unreferenced types/functions/hooks — nothing existing changed shape yet).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/types.ts frontend/src/lib/api.ts \
  frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts
git commit -m "feat: add Company/Bank API client and query hooks (frontend)"
```

(Skip this step if the working directory is not a git repository.)

---

### Task 5: Frontend — CompanyPicker & BankPicker components

Small "load preset" dropdowns. They only read presets and hand the picked values back to the caller via `onPick` — the invoice draft form (Task 7) owns the actual editable fields and is responsible for persisting a new preset.

**Files:**
- Create: `frontend/src/features/modules/CompanyPicker.tsx`
- Create: `frontend/src/features/modules/BankPicker.tsx`

**Interfaces:**
- Consumes: `useCompanies()`/`useBanks()` from Task 4.
- Produces: `<CompanyPicker onPick={(c: { name: string; shortAddress: string }) => void} />`, `<BankPicker onPick={(b: { bankName: string; accountName: string; accountNumber: string }) => void} />`.

- [ ] **Step 1: Create `frontend/src/features/modules/CompanyPicker.tsx`**

```tsx
import { Select } from '@/components/ui/select'
import { useCompanies } from '@/features/data/queries'

interface CompanyPickerProps {
  onPick: (company: { name: string; shortAddress: string }) => void
}

/** Loads company name + short address from a saved preset into the invoice form. */
export function CompanyPicker({ onPick }: CompanyPickerProps) {
  const { data: companies = [] } = useCompanies()
  const options = [
    { value: '', label: 'Load preset…' },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ]

  return (
    <div className="w-[160px]">
      <Select
        value=""
        onValueChange={(id) => {
          if (!id) return
          const c = companies.find((c) => c.id === id)
          if (c) onPick({ name: c.name, shortAddress: c.shortAddress })
        }}
        options={options}
        aria-label="Load company preset"
      />
    </div>
  )
}
```

- [ ] **Step 2: Create `frontend/src/features/modules/BankPicker.tsx`**

```tsx
import { Select } from '@/components/ui/select'
import { useBanks } from '@/features/data/queries'

interface BankPickerProps {
  onPick: (bank: { bankName: string; accountName: string; accountNumber: string }) => void
}

/** Loads bank-detail values from a saved preset into the invoice form. */
export function BankPicker({ onPick }: BankPickerProps) {
  const { data: banks = [] } = useBanks()
  const options = [
    { value: '', label: 'Load preset…' },
    ...banks.map((b) => ({ value: b.id, label: `${b.bankName} — ${b.accountNumber}` })),
  ]

  return (
    <div className="w-[200px]">
      <Select
        value=""
        onValueChange={(id) => {
          if (!id) return
          const b = banks.find((b) => b.id === id)
          if (b) onPick({ bankName: b.bankName, accountName: b.accountName, accountNumber: b.accountNumber })
        }}
        options={options}
        aria-label="Load bank preset"
      />
    </div>
  )
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors (these components aren't imported anywhere yet, but must still be internally well-typed).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/modules/CompanyPicker.tsx frontend/src/features/modules/BankPicker.tsx
git commit -m "feat: add CompanyPicker/BankPicker preset-loader components"
```

(Skip this step if the working directory is not a git repository.)

---

### Task 6: Frontend — Rupiah formatter + fixed issuer identity

**Files:**
- Modify: `frontend/src/lib/format.ts`
- Create: `frontend/src/lib/issuer.ts`

**Interfaces:**
- Produces: `fmtRupiah(n: number): string` (format.ts); `ISSUER: { name, title, location, email, phone }` (issuer.ts).

- [ ] **Step 1: Sanity-check the underlying `Intl` formatting before wiring it in**

Run: `node -e "console.log(new Intl.NumberFormat('id-ID',{maximumFractionDigits:0}).format(5600000))"`
Expected: `5.600.000`

- [ ] **Step 2: Add `fmtRupiah` to `frontend/src/lib/format.ts`**

Add after `fmtMoney`:

```ts
/** Indonesian Rupiah, no decimals, e.g. 5600000 → "Rp5.600.000". */
export function fmtRupiah(n: number): string {
  return 'Rp' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })
}
```

- [ ] **Step 3: Create `frontend/src/lib/issuer.ts`**

```ts
/** The invoice issuer's fixed personal details — not user-editable. */
export const ISSUER = {
  name: 'Andi Syahruddin',
  title: 'Backend Enginer',
  location: 'Tangerang, Banten, Indonesia',
  email: 'iam@kiyora.dev',
  phone: '081382636662',
} as const
```

- [ ] **Step 4: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/format.ts frontend/src/lib/issuer.ts
git commit -m "feat: add Rupiah formatter and fixed issuer identity"
```

(Skip this step if the working directory is not a git repository.)

---

### Task 7: Frontend — Invoice type rewrite + InvoicesModule form/list

This is one atomic change: the `Invoice` shape changes, so every consumer (`InvoicesModule.tsx`) must be updated in the same task to keep the project typechecking.

**Files:**
- Modify: `frontend/src/store/types.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/modules/InvoicesModule.tsx`

**Interfaces:**
- Consumes: `CompanyPicker`/`BankPicker` (Task 5), `fmtRupiah` (Task 6), `useCreateCompany`/`useCreateBank` (Task 4).
- Produces: updated `Invoice`/`InvoiceItem` types consumed by Task 8 (`invoiceDocument.ts`).

- [ ] **Step 1: Update `Invoice` and add `InvoiceItem` in `frontend/src/store/types.ts`**

Replace the existing `Invoice` interface with:

```ts
export interface InvoiceItem {
  description: string
  quantity: number
  unitPrice: number
}

export interface Invoice {
  id: string
  number: string
  companyName: string
  companyAddress: string
  items: InvoiceItem[]
  amount: number
  status: InvoiceStatus
  /** ISO date (YYYY-MM-DD), server-assigned on creation. */
  createdAt: string
  /** ISO date (YYYY-MM-DD). */
  dueDate: string
  bankDetail: BankDetail
}
```

- [ ] **Step 2: Update `CreateInvoiceBody`/`UpdateInvoiceBody` in `frontend/src/lib/api.ts`**

Add `InvoiceItem` to the `import type { ... } from '@/store/types'` block, then replace both interfaces:

```ts
export interface CreateInvoiceBody {
  number?: string
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  dueDate?: string
  status?: InvoiceStatus
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
}

export interface UpdateInvoiceBody {
  number?: string
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  dueDate?: string
  status?: InvoiceStatus
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
}
```

- [ ] **Step 3: Run typecheck to see the expected breakage**

Run: `cd frontend && npm run typecheck`
Expected: FAIL — errors in `frontend/src/features/modules/InvoicesModule.tsx` and `frontend/src/lib/invoiceDocument.ts` referencing the removed `client`/`company` fields. This confirms the type change took effect; both files are fixed in this task and the next.

- [ ] **Step 4: Replace `frontend/src/features/modules/InvoicesModule.tsx`**

Replace the whole file with:

```tsx
import { useState } from 'react'
import { Download, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/ui/pill'
import { Select } from '@/components/ui/select'
import { INVST } from '@/lib/constants'
import { fmtDate, fmtRupiah, isPastDue } from '@/lib/format'
import { downloadInvoice } from '@/lib/invoiceDocument'
import type { Invoice, InvoiceStatus } from '@/store/types'
import {
  useCreateBank,
  useCreateCompany,
  useCreateInvoice,
  useDeleteInvoice,
  useUpdateInvoice,
  useWorkspace,
} from '@/features/data/queries'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { InvoicesEmpty } from '@/features/screens/InvoicesEmpty'
import { BankPicker } from './BankPicker'
import { CompanyPicker } from './CompanyPicker'
import { ModuleHeader } from './ModuleHeader'

const STATUS_OPTIONS = (['draft', 'sent', 'paid', 'overdue'] as InvoiceStatus[]).map((s) => ({
  value: s,
  label: INVST[s].label,
}))

interface DraftItem {
  description: string
  quantity: string
  unitPrice: string
}

interface Draft {
  editId: string | null
  number: string
  companyName: string
  companyAddress: string
  items: DraftItem[]
  dueDate: string
  status: InvoiceStatus
  bankName: string
  bankAccountName: string
  bankAccountNumber: string
}

function emptyItem(): DraftItem {
  return { description: '', quantity: '1', unitPrice: '' }
}

function itemTotal(it: DraftItem): number {
  return (parseFloat(it.quantity) || 0) * (parseFloat(it.unitPrice.replace(/[^0-9.]/g, '')) || 0)
}

/** Per-workspace invoicing: reusable company/bank presets, a job-details table, and per-invoice download. */
export function InvoicesModule({ wsId }: { wsId: string }) {
  const q = useWorkspace(wsId)
  const createInvoice = useCreateInvoice()
  const updateInvoice = useUpdateInvoice()
  const deleteInvoice = useDeleteInvoice()
  const createCompany = useCreateCompany()
  const createBank = useCreateBank()

  const [draft, setDraft] = useState<Draft | null>(null)

  if (q.isPending) return <DataLoading label="loading invoices…" />
  if (q.isError) return <DataError error={q.error} onRetry={() => q.refetch()} />

  const workspace = q.data
  const invoices = workspace?.invoices ?? []
  const total = invoices.reduce((sum, iv) => sum + iv.amount, 0)
  const outstanding = invoices
    .filter((iv) => iv.status !== 'paid' && iv.status !== 'draft')
    .reduce((sum, iv) => sum + iv.amount, 0)

  function openNew() {
    setDraft({
      editId: null,
      number: 'INV-' + (1044 + invoices.length),
      companyName: '',
      companyAddress: '',
      items: [emptyItem()],
      dueDate: '',
      status: 'draft',
      bankName: '',
      bankAccountName: '',
      bankAccountNumber: '',
    })
  }

  function openEdit(iv: Invoice) {
    setDraft({
      editId: iv.id,
      number: iv.number,
      companyName: iv.companyName,
      companyAddress: iv.companyAddress,
      items: iv.items.length
        ? iv.items.map((it) => ({
            description: it.description,
            quantity: String(it.quantity),
            unitPrice: String(it.unitPrice),
          }))
        : [emptyItem()],
      dueDate: iv.dueDate,
      status: iv.status,
      bankName: iv.bankDetail.bankName,
      bankAccountName: iv.bankDetail.accountName,
      bankAccountNumber: iv.bankDetail.accountNumber,
    })
  }

  function updateItem(index: number, patch: Partial<DraftItem>) {
    if (!draft) return
    setDraft({ ...draft, items: draft.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) })
  }

  function addItem() {
    if (!draft) return
    setDraft({ ...draft, items: [...draft.items, emptyItem()] })
  }

  function removeItem(index: number) {
    if (!draft || draft.items.length <= 1) return
    setDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) })
  }

  function saveCompanyPreset() {
    if (!draft || !draft.companyName.trim()) return
    createCompany.mutate({ name: draft.companyName.trim(), shortAddress: draft.companyAddress.trim() })
    toast.success('Company saved as preset')
  }

  function saveBankPreset() {
    if (!draft || !draft.bankName.trim() || !draft.bankAccountNumber.trim()) return
    createBank.mutate({
      bankName: draft.bankName.trim(),
      accountName: draft.bankAccountName.trim(),
      accountNumber: draft.bankAccountNumber.trim(),
    })
    toast.success('Bank saved as preset')
  }

  function save() {
    if (!draft) return
    const bankName = draft.bankName.trim()
    const bankAccountName = draft.bankAccountName.trim()
    const bankAccountNumber = draft.bankAccountNumber.trim()
    if (!bankName || !bankAccountName || !bankAccountNumber) {
      toast.error('Bank detail (bank name, account name, account number) is required')
      return
    }
    if (!draft.dueDate) {
      toast.error('Due date is required')
      return
    }
    const companyName = draft.companyName.trim() || 'Untitled client'
    const companyAddress = draft.companyAddress.trim()
    const items = draft.items
      .filter((it) => it.description.trim())
      .map((it) => ({
        description: it.description.trim(),
        quantity: parseFloat(it.quantity) || 0,
        unitPrice: parseFloat(it.unitPrice.replace(/[^0-9.]/g, '')) || 0,
      }))
    if (items.length === 0) {
      toast.error('At least one job-detail line item is required')
      return
    }
    const number = draft.number.trim() || 'INV-' + (1044 + invoices.length)
    const body = {
      number,
      companyName,
      companyAddress,
      items,
      dueDate: draft.dueDate,
      status: draft.status,
      bankName,
      bankAccountName,
      bankAccountNumber,
    }
    if (draft.editId) {
      updateInvoice.mutate({ id: draft.editId, patch: body }, { onSuccess: () => setDraft(null) })
    } else {
      createInvoice.mutate({ wsId, body }, { onSuccess: () => setDraft(null) })
    }
  }

  const saving = createInvoice.isPending || updateInvoice.isPending
  const draftGrandTotal = draft ? draft.items.reduce((sum, it) => sum + itemTotal(it), 0) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader
        title="Invoices"
        meta={
          invoices.length
            ? `${invoices.length} · ${fmtRupiah(total)} total · ${fmtRupiah(outstanding)} outstanding`
            : undefined
        }
        actions={
          <Button size="sm" onClick={openNew}>
            <Plus size={13} />
            New invoice
          </Button>
        }
      />

      {draft ? (
        <div className="flex-none border-b border-loom-border bg-loom-card/40 px-4 py-3">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="font-mono text-[11.5px] text-loom-muted-2">
              {draft.editId ? 'Edit invoice' : 'New invoice'}
            </span>
            <button
              onClick={() => setDraft(null)}
              aria-label="Close"
              className="cursor-pointer p-0.5 text-loom-muted-2 hover:text-loom-fg"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Number</span>
              <Input
                value={draft.number}
                onChange={(e) => setDraft({ ...draft, number: e.target.value })}
                placeholder="INV-1044"
                className="w-[120px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Due date</span>
              <Input
                type="date"
                value={draft.dueDate}
                onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                className="w-[150px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Status</span>
              <div className="w-[120px]">
                <Select
                  value={draft.status}
                  onValueChange={(v) => setDraft({ ...draft, status: v as InvoiceStatus })}
                  options={STATUS_OPTIONS}
                  aria-label="Status"
                />
              </div>
            </label>

            <div className="basis-full" />

            <label className="flex min-w-[180px] flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Company (bill to)</span>
              <Input
                value={draft.companyName}
                onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
                placeholder="Umbrella LLC"
              />
            </label>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Short address</span>
              <Input
                value={draft.companyAddress}
                onChange={(e) => setDraft({ ...draft, companyAddress: e.target.value })}
                placeholder="Jakarta, Indonesia"
              />
            </label>
            <CompanyPicker onPick={(c) => setDraft({ ...draft, companyName: c.name, companyAddress: c.shortAddress })} />
            <Button size="sm" variant="secondary" onClick={saveCompanyPreset} disabled={createCompany.isPending}>
              + Save preset
            </Button>

            <div className="basis-full" />

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Bank name *</span>
              <Input
                value={draft.bankName}
                onChange={(e) => setDraft({ ...draft, bankName: e.target.value })}
                placeholder="BCA"
                className="w-[140px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Account name *</span>
              <Input
                value={draft.bankAccountName}
                onChange={(e) => setDraft({ ...draft, bankAccountName: e.target.value })}
                placeholder="Andi Syahruddin"
                className="w-[160px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Account number *</span>
              <Input
                value={draft.bankAccountNumber}
                onChange={(e) => setDraft({ ...draft, bankAccountNumber: e.target.value })}
                placeholder="6281892573"
                className="w-[160px]"
              />
            </label>
            <BankPicker
              onPick={(b) =>
                setDraft({ ...draft, bankName: b.bankName, bankAccountName: b.accountName, bankAccountNumber: b.accountNumber })
              }
            />
            <Button size="sm" variant="secondary" onClick={saveBankPreset} disabled={createBank.isPending}>
              + Save preset
            </Button>

            <div className="basis-full" />

            <div className="w-full">
              <span className="font-mono text-[10px] text-loom-dim">Job details</span>
              <table className="mt-1 w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-left font-mono text-[10px] text-loom-dim uppercase">
                    <th className="w-8 py-1">No.</th>
                    <th className="py-1">Deskripsi Pekerjaan (Jasa Engineer)</th>
                    <th className="w-20 py-1 text-right">Kuantitas</th>
                    <th className="w-32 py-1 text-right">Harga Satuan (Rp)</th>
                    <th className="w-32 py-1 text-right">Total (Rp)</th>
                    <th className="w-8 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {draft.items.map((it, i) => (
                    <tr key={i}>
                      <td className="py-1 text-loom-dim">{i + 1}</td>
                      <td className="py-1 pr-1">
                        <Input
                          value={it.description}
                          onChange={(e) => updateItem(i, { description: e.target.value })}
                          placeholder="Backend API development"
                        />
                      </td>
                      <td className="py-1 pr-1">
                        <Input
                          value={it.quantity}
                          onChange={(e) => updateItem(i, { quantity: e.target.value })}
                          className="text-right"
                        />
                      </td>
                      <td className="py-1 pr-1">
                        <Input
                          value={it.unitPrice}
                          onChange={(e) => updateItem(i, { unitPrice: e.target.value })}
                          placeholder="0"
                          className="text-right"
                        />
                      </td>
                      <td className="py-1 text-right font-mono text-loom-fg">{fmtRupiah(itemTotal(it))}</td>
                      <td className="py-1 text-right">
                        <button
                          onClick={() => removeItem(i)}
                          aria-label="Remove line item"
                          className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1.5 flex items-center justify-between">
                <button
                  onClick={addItem}
                  className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-loom-accent-soft hover:underline"
                >
                  <Plus size={12} />
                  Add line item
                </button>
                <span className="font-mono text-[12.5px] text-loom-fg">
                  Grand total: {fmtRupiah(draftGrandTotal)}
                </span>
              </div>
            </div>

            <Button size="lg" disabled={saving} onClick={save}>
              {draft.editId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      ) : null}

      {invoices.length === 0 ? (
        <InvoicesEmpty />
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full min-w-[900px] border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-loom-border text-left font-mono text-[10px] tracking-wide text-loom-dim uppercase">
                <th className="px-3 py-2 font-medium">Number</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Bank detail</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((iv) => {
                const st = INVST[iv.status]
                const overdue = iv.status !== 'paid' && isPastDue(iv.dueDate)
                return (
                  <tr
                    key={iv.id}
                    className="border-b border-loom-border-card last:border-none hover:bg-loom-card/50"
                  >
                    <td className="px-3 py-2.5 font-mono text-[11.5px] whitespace-nowrap text-loom-muted-2">
                      {iv.number}
                    </td>
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-loom-fg">
                      {iv.companyName || '—'}
                    </td>
                    <td className="max-w-[180px] px-3 py-2.5 text-loom-dim">
                      <div className="truncate">{iv.bankDetail.bankName || '—'}</div>
                      <div className="truncate font-mono text-[10.5px] text-loom-dim">
                        {iv.bankDetail.accountNumber}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-loom-dim">
                      {fmtDate(iv.createdAt)}
                    </td>
                    <td
                      className={`px-3 py-2.5 font-mono text-[11px] whitespace-nowrap ${
                        overdue ? 'text-loom-red-soft' : 'text-loom-dim'
                      }`}
                    >
                      {fmtDate(iv.dueDate)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] whitespace-nowrap text-loom-fg">
                      {fmtRupiah(iv.amount)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill color={st.color}>{st.label}</Pill>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          onClick={() => downloadInvoice(iv)}
                          aria-label="Download invoice"
                          title="Download"
                          className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft"
                        >
                          <Download size={13} />
                        </button>
                        {iv.status !== 'paid' ? (
                          <button
                            onClick={() =>
                              updateInvoice.mutate({ id: iv.id, patch: { status: 'paid' } })
                            }
                            className="cursor-pointer rounded-md px-1.5 py-1 font-mono text-[10.5px] text-loom-muted-2 hover:text-loom-green-soft"
                          >
                            mark paid
                          </button>
                        ) : null}
                        <button
                          onClick={() => openEdit(iv)}
                          aria-label="Edit invoice"
                          className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => deleteInvoice.mutate(iv.id)}
                          aria-label="Delete invoice"
                          className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/types.ts frontend/src/lib/api.ts \
  frontend/src/features/modules/InvoicesModule.tsx
git commit -m "feat: rebuild invoice draft form around company/bank presets + line items"
```

(Skip this step if the working directory is not a git repository. Note: `npm run typecheck` will still fail after this step — `invoiceDocument.ts` is fixed in Task 8. That's expected.)

---

### Task 8: Frontend — Rebuild the printable invoice document

**Files:**
- Modify: `frontend/src/lib/invoiceDocument.ts`

**Interfaces:**
- Consumes: `Invoice`/`InvoiceItem` (Task 7), `fmtRupiah` (Task 6), `ISSUER` (Task 6).

- [ ] **Step 1: Replace `frontend/src/lib/invoiceDocument.ts`**

```ts
// Generates a self-contained, printable invoice document and triggers a
// browser download. No PDF dependency: the downloaded .html file opens (and
// prints to PDF via the browser's own "Save as PDF") without any extra libs.

import { fmtDate, fmtRupiah } from '@/lib/format'
import { INVST } from '@/lib/constants'
import { ISSUER } from '@/lib/issuer'
import type { Invoice } from '@/store/types'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildInvoiceHtml(iv: Invoice): string {
  const st = INVST[iv.status]
  const e = escapeHtml
  const itemRows = iv.items
    .map(
      (it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${e(it.description)}</td>
        <td class="amount">${it.quantity}</td>
        <td class="amount">${e(fmtRupiah(it.unitPrice))}</td>
        <td class="amount">${e(fmtRupiah(it.quantity * it.unitPrice))}</td>
      </tr>`,
    )
    .join('')
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${e(iv.number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Geist", system-ui, sans-serif;
    color: #1a1c20;
    max-width: 720px;
    margin: 48px auto;
    padding: 0 24px;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a1c20; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .muted { color: #6b7280; font-size: 12.5px; }
  .status { display: inline-block; margin-top: 8px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #fff; background: ${st.color}; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  .meta-block h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin: 0 0 6px; }
  .meta-block p { margin: 0; font-size: 13.5px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
  th, td { text-align: left; padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #e5e7eb; }
  th { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  td.amount, th.amount { text-align: right; }
  .total-row td { font-weight: 700; font-size: 15px; border-bottom: none; border-top: 2px solid #1a1c20; }
  .payment { background: #f7f7f8; border-radius: 10px; padding: 14px 16px; font-size: 13px; line-height: 1.7; margin-bottom: 28px; }
  .payment h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin: 0 0 6px; }
  .payment ul { margin: 6px 0 0; padding-left: 18px; }
  .signature { font-size: 13.5px; line-height: 1.6; }
  @media print { body { margin: 0 auto; } }
</style>
</head>
<body>
  <header>
    <div>
      <h1>Invoice ${e(iv.number)}</h1>
      <span class="status">${e(st.label)}</span>
    </div>
    <div class="muted" style="text-align:right">
      Created ${e(fmtDate(iv.createdAt))}<br>
      Due ${e(fmtDate(iv.dueDate))}
    </div>
  </header>

  <div class="meta-grid">
    <div class="meta-block">
      <h2>From</h2>
      <p>
        ${e(ISSUER.name)}<br>
        ${e(ISSUER.title)}<br>
        ${e(ISSUER.location)}<br>
        Email: ${e(ISSUER.email)}<br>
        No. HP: ${e(ISSUER.phone)}
      </p>
    </div>
    <div class="meta-block">
      <h2>Bill To</h2>
      <p>
        ${e(iv.companyName || '—')}<br>
        ${e(iv.companyAddress || '')}
      </p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>No.</th>
        <th>Deskripsi Pekerjaan (Jasa Engineer)</th>
        <th class="amount">Kuantitas</th>
        <th class="amount">Harga Satuan (Rp)</th>
        <th class="amount">Total (Rp)</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      <tr class="total-row">
        <td colspan="4">Total</td>
        <td class="amount">${e(fmtRupiah(iv.amount))}</td>
      </tr>
    </tbody>
  </table>

  <div class="payment">
    <h2>Metode Pembayaran</h2>
    Mohon agar pembayaran dapat dilakukan melalui transfer bank ke rekening berikut:
    <ul>
      <li>Nama Bank: ${e(iv.bankDetail.bankName || '—')}</li>
      <li>Nomor Rekening: ${e(iv.bankDetail.accountNumber || '—')}</li>
      <li>Atas Nama: ${e(iv.bankDetail.accountName || '—')}</li>
    </ul>
  </div>

  <div class="signature">
    Hormat saya,<br><br>
    ${e(ISSUER.name)}
  </div>
</body>
</html>`
}

/** Builds a printable invoice document and downloads it as an .html file. */
export function downloadInvoice(iv: Invoice): void {
  const blob = new Blob([buildInvoiceHtml(iv)], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${iv.number || 'invoice'}.html`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 2: Verify the whole frontend typechecks clean**

Run: `cd frontend && npm run typecheck`
Expected: no errors — this closes out the interim breakage expected after Task 7.

- [ ] **Step 3: Verify the production build**

Run: `cd frontend && npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/invoiceDocument.ts
git commit -m "feat: rebuild printable invoice document around issuer block + items table"
```

(Skip this step if the working directory is not a git repository.)

---

### Task 9: End-to-end manual verification

No frontend test framework exists, so the golden path is verified by hand against the running app, per project convention (start the dev server, exercise the feature, check for regressions).

**Files:** none (verification only).

- [ ] **Step 1: Run full backend checks**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: build/vet produce no output; every package reports `ok`.

- [ ] **Step 2: Run full frontend checks**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 3: Start the dev servers**

Run: `cd frontend && npm run dev` (starts Vite on :5173 and the Go backend on :8989 together — see COMMANDS.md).
Expected: both processes start; no port-in-use errors (if :8989 is already bound by a stale process, kill it first — `lsof -nP -iTCP:8989 -sTCP:LISTEN`).

- [ ] **Step 4: Reset to fresh seed data**

`curl -X POST http://localhost:8989/api/seed`
Expected: 200 response with the seeded workspace tree; the two seed companies ("Umbrella LLC", "Northwind Traders") and one seed bank ("BCA") now exist.

- [ ] **Step 5: Exercise the golden path in the browser**

Open `http://localhost:5173`, navigate to a workspace's Invoices tab, and:
1. Click "New invoice." Use the Company picker to load "Umbrella LLC" — confirm the Company name/Short address inputs populate.
2. Use the Bank picker to load "BCA" — confirm the bank inputs populate.
3. Add a second job-details line item (click "Add line item"), fill in description/quantity/unit price for both rows, and confirm each row's Total and the "Grand total" footer update live and read in `Rp` formatting.
4. Set a due date, click "Create." Confirm the new invoice appears in the list with the correct Rupiah amount.
5. Click the download icon on the new invoice. Open the downloaded `.html` file and confirm it shows: the fixed `ISSUER` block (Andi Syahruddin / Backend Enginer / Tangerang, Banten, Indonesia / iam@kiyora.dev / 081382636662) under "From," the picked company under "Bill To," both line items with correct Rupiah totals, the "Mohon agar pembayaran..." paragraph with the BCA bank details, and the "Hormat saya," signature.
6. Click the edit (pencil) icon on that invoice, change a line item's quantity, save, and confirm the list's Amount column updates.
7. Type a brand-new company name/address (not from a preset) into the form, click "+ Save preset" next to Company, then open the Company picker dropdown again and confirm the new entry now appears — this exercises the create-inline-preset path.

Expected: every step behaves as described, with no console errors in the browser dev tools.

- [ ] **Step 6: Spot-check company/bank preset CRUD directly**

```bash
curl http://localhost:8989/api/companies
curl -X DELETE http://localhost:8989/api/companies/<some-id-from-above>
curl http://localhost:8989/api/companies
```

Expected: the list reflects the deletion; a second `DELETE` on the same id returns `{"error":"not found"}` with a 404 status.

- [ ] **Step 7: Report results**

Summarize which checks passed. If anything in Step 5 or 6 didn't behave as expected, fix it in the relevant task's files before considering the plan complete — do not report success without having actually run these checks.
