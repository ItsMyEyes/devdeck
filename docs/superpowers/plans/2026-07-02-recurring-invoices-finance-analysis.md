# Recurring Invoices + Finance Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add monthly recurring invoice templates (auto-generate a draft invoice on a
configurable day) and a Finance Analysis tab with charts (revenue/month, status breakdown,
revenue/company, outstanding & overdue) to the existing per-workspace Invoices module.

**Architecture:** `RecurringInvoiceTemplate` is a new workspace-scoped domain entity, stored
and CRUD'd exactly like `Invoice`, plus a `Store.RunDueRecurringInvoices()` method invoked both
at backend startup and from a daily in-process ticker (the backend isn't a 24/7 daemon, so
generation can't rely on wall-clock cron). The frontend's `InvoicesModule` gains a small tab bar
(Invoices / Recurring / Finance Analysis); Finance Analysis renders four Recharts charts wrapped
in a hand-vendored `ChartContainer`/`ChartTooltip` primitive (shadcn's chart API, restyled for
this project's `@base-ui/react` + Tailwind v4 stack instead of running the shadcn CLI).

**Tech Stack:** Go 1.25 stdlib `net/http`, SQLite (`modernc.org/sqlite`), React 19,
`@tanstack/react-query`, `recharts` (new dependency).

## Global Constraints

- No git repository in this project directory — skip every `git add`/`git commit` step in every task.
- No frontend test framework exists — frontend verification is `npm run typecheck` and
  `npm run build`, plus manual/Playwright checks in the final task, not unit tests.
- New ID prefix: `rt-` for `RecurringInvoiceTemplate`, matching the existing
  `ws-`/`p-`/`w-`/`n-`/`t-`/`iv-`/`co-`/`bk-` convention (`backend/internal/store/helpers.go`'s
  `idGen`).
- `dayOfMonth` is clamped to `1..28` both client-side (input `min`/`max`) and server-side (in
  `CreateRecurringTemplate`) — this sidesteps every month-length edge case.
- Auto-generated invoice numbers follow the existing manual-creation convention:
  `"INV-" + (1044 + currentInvoiceCountInWorkspace)` (see
  `frontend/src/features/modules/InvoicesModule.tsx`'s `openNew()`), computed server-side in
  `RunDueRecurringInvoicesAt` since that path has no client to supply a number.
- Recurring templates and invoices generated from them are workspace-scoped and nested inside
  `Workspace` (`workspace.recurringTemplates`), the same pattern already used for
  `workspace.invoices`/`workspace.todos`/`workspace.news` — no separate top-level `GET` list
  endpoint (mirrors Todo/Invoice, not Company/Bank, which are global presets).
- Every new/changed Go file must pass `go build ./... && go vet ./... && go test ./...` from
  `backend/`. Every changed frontend file must pass `npm run typecheck` from `frontend/`.

---

### Task 1: Domain model + SQLite schema for recurring templates

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `backend/internal/store/db.go`

**Interfaces:**
- Produces: `domain.RecurringInvoiceTemplate` struct (`ID, CompanyName, CompanyAddress string`,
  `Items []InvoiceItem`, `BankDetail BankDetail`, `DayOfMonth, PaymentTermDays int`,
  `Active bool`, `LastGeneratedYm, CreatedAt string`), and `domain.Workspace.RecurringTemplates
  []RecurringInvoiceTemplate`, both consumed by every later task.
- Produces: SQLite table `recurring_templates` (columns: `id, workspace_id, company_name,
  company_address, items_json, bank_name, bank_account_name, bank_account_number,
  day_of_month, payment_term_days, active, last_generated_ym, created_at`), consumed by Task 2.

- [ ] **Step 1: Add the `RecurringInvoiceTemplate` struct and nest it in `Workspace`**

In `backend/internal/domain/models.go`, insert this new type directly after the `Invoice`
struct (after its closing `}`, before `// Workspace mirrors...`):

```go
// RecurringInvoiceTemplate mirrors the frontend RecurringInvoiceTemplate type — a saved
// billing snapshot that generates a draft Invoice on a monthly schedule.
type RecurringInvoiceTemplate struct {
	ID              string        `json:"id"`
	CompanyName     string        `json:"companyName"`
	CompanyAddress  string        `json:"companyAddress"`
	Items           []InvoiceItem `json:"items"`
	BankDetail      BankDetail    `json:"bankDetail"`
	DayOfMonth      int           `json:"dayOfMonth"`
	PaymentTermDays int           `json:"paymentTermDays"`
	Active          bool          `json:"active"`
	LastGeneratedYm string        `json:"lastGeneratedYm"`
	CreatedAt       string        `json:"createdAt"`
}
```

Then update the `Workspace` struct to nest the new list, adding a field after `Invoices`:

```go
// Workspace mirrors the frontend Workspace type (full nested tree).
type Workspace struct {
	ID                 string                      `json:"id"`
	Name               string                      `json:"name"`
	Projects           []Project                   `json:"projects"`
	News               []NewsItem                  `json:"news"`
	Todos              []Todo                      `json:"todos"`
	Invoices           []Invoice                   `json:"invoices"`
	RecurringTemplates []RecurringInvoiceTemplate   `json:"recurringTemplates"`
}
```

- [ ] **Step 2: Add the `recurring_templates` table to the schema**

In `backend/internal/store/db.go`, insert this block into the `schema` const, right after the
`invoices` table's `CREATE INDEX IF NOT EXISTS idx_invoices_ws ...` line and before the
`settings` table:

```sql
CREATE TABLE IF NOT EXISTS recurring_templates (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_name        TEXT NOT NULL DEFAULT '',
  company_address     TEXT NOT NULL DEFAULT '',
  items_json          TEXT NOT NULL DEFAULT '[]',
  bank_name           TEXT NOT NULL DEFAULT '',
  bank_account_name   TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  day_of_month        INTEGER NOT NULL DEFAULT 1,
  payment_term_days   INTEGER NOT NULL DEFAULT 14,
  active              INTEGER NOT NULL DEFAULT 1,
  last_generated_ym   TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recurring_templates_ws ON recurring_templates(workspace_id);
```

This is a brand-new table (`CREATE TABLE IF NOT EXISTS`), so no `ALTER TABLE` migration
function is needed — same as `companies`/`banks` in the existing schema.

- [ ] **Step 3: Verify it builds**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no output, exit code 0. (`Workspaces()`/`workspaceByID()` in `workspace.go` don't
populate `RecurringTemplates` yet — that's fine, the zero value `nil` marshals to JSON `null`
until Task 2 wires it up. The struct/schema changes alone must compile clean.)

---

### Task 2: Store CRUD + port interface for recurring templates

**Files:**
- Modify: `backend/internal/port/store.go`
- Modify: `backend/internal/store/workspace.go`
- Create: `backend/internal/store/recurring_template.go`
- Create: `backend/internal/store/recurring_template_test.go`

**Interfaces:**
- Consumes: `domain.RecurringInvoiceTemplate`, `domain.Workspace.RecurringTemplates` (Task 1);
  `idGen`, `scanner`, `mapNotFound`, `firstErr`, `setStr`, `setInt`, `boolInt`, `ErrNotFound`
  (`backend/internal/store/helpers.go`); `newTestStore(t)` (`backend/internal/store/worktree_test.go`).
- Produces: `port.RecurringTemplatePatch` struct; `Store.CreateRecurringTemplate(wsID,
  companyName, companyAddress string, items []domain.InvoiceItem, bankName, bankAccountName,
  bankAccountNumber string, dayOfMonth, paymentTermDays int, createdAt string)
  (domain.RecurringInvoiceTemplate, error)`; `Store.UpdateRecurringTemplate(id string, p
  port.RecurringTemplatePatch) (domain.RecurringInvoiceTemplate, error)`;
  `Store.DeleteRecurringTemplate(id string) error` — all consumed by Task 4 (handler) and
  Task 3 (scheduler, which reads templates directly via SQL).

- [ ] **Step 1: Add `RecurringTemplatePatch` and the interface methods to `port/store.go`**

Add to the `Store` interface in `backend/internal/port/store.go`, right after the `Banks`
block (`DeleteBank() error`) and before `// News`:

```go
	// Recurring invoice templates (workspace-scoped; auto-generate draft Invoices on schedule)
	CreateRecurringTemplate(wsID, companyName, companyAddress string, items []domain.InvoiceItem, bankName, bankAccountName, bankAccountNumber string, dayOfMonth, paymentTermDays int, createdAt string) (domain.RecurringInvoiceTemplate, error)
	UpdateRecurringTemplate(id string, p RecurringTemplatePatch) (domain.RecurringInvoiceTemplate, error)
	DeleteRecurringTemplate(id string) error
	RunDueRecurringInvoices() ([]domain.Invoice, error)
```

Add the patch struct after `BankPatch`:

```go
// RecurringTemplatePatch carries optional fields for a partial recurring-template update.
type RecurringTemplatePatch struct {
	CompanyName       *string
	CompanyAddress    *string
	Items             *[]domain.InvoiceItem
	BankName          *string
	BankAccountName   *string
	BankAccountNumber *string
	DayOfMonth        *int
	PaymentTermDays   *int
	Active            *bool
}
```

- [ ] **Step 2: Write the failing store test**

Create `backend/internal/store/recurring_template_test.go`:

```go
package store

import (
	"testing"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/... -run TestCreateRecurringTemplatePersistsAndNestsInWorkspace -v`
Expected: FAIL — `s.CreateRecurringTemplate` undefined (method doesn't exist yet).

- [ ] **Step 4: Implement `recurring_template.go`**

Create `backend/internal/store/recurring_template.go`:

```go
package store

import (
	"encoding/json"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

const recurringTemplateColumns = `id, company_name, company_address, items_json, bank_name, bank_account_name, bank_account_number, day_of_month, payment_term_days, active, last_generated_ym, created_at`

func scanRecurringTemplate(sc scanner) (domain.RecurringInvoiceTemplate, error) {
	var t domain.RecurringInvoiceTemplate
	var itemsJSON string
	var active int
	err := sc.Scan(&t.ID, &t.CompanyName, &t.CompanyAddress, &itemsJSON,
		&t.BankDetail.BankName, &t.BankDetail.AccountName, &t.BankDetail.AccountNumber,
		&t.DayOfMonth, &t.PaymentTermDays, &active, &t.LastGeneratedYm, &t.CreatedAt)
	if err != nil {
		return t, err
	}
	t.Active = active != 0
	if itemsJSON == "" {
		t.Items = []domain.InvoiceItem{}
	} else if err := json.Unmarshal([]byte(itemsJSON), &t.Items); err != nil {
		return t, err
	}
	if t.Items == nil {
		t.Items = []domain.InvoiceItem{}
	}
	return t, nil
}

func (s *Store) recurringTemplatesOf(wsID string) ([]domain.RecurringInvoiceTemplate, error) {
	rows, err := s.db.Query(`SELECT `+recurringTemplateColumns+` FROM recurring_templates WHERE workspace_id = ? ORDER BY rowid DESC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.RecurringInvoiceTemplate{}
	for rows.Next() {
		t, err := scanRecurringTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) recurringTemplateByID(id string) (domain.RecurringInvoiceTemplate, error) {
	t, err := scanRecurringTemplate(s.db.QueryRow(`SELECT `+recurringTemplateColumns+` FROM recurring_templates WHERE id = ?`, id))
	if err != nil {
		return domain.RecurringInvoiceTemplate{}, mapNotFound(err)
	}
	return t, nil
}

// CreateRecurringTemplate creates a recurring invoice template for a workspace. dayOfMonth is
// clamped to 1..28 so every month-length edge case (Feb, 30-day months) is a pure display/
// scheduling concern, never a stored out-of-range value.
func (s *Store) CreateRecurringTemplate(wsID, companyName, companyAddress string, items []domain.InvoiceItem, bankName, bankAccountName, bankAccountNumber string, dayOfMonth, paymentTermDays int, createdAt string) (domain.RecurringInvoiceTemplate, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	if !ok {
		return domain.RecurringInvoiceTemplate{}, ErrNotFound
	}
	if dayOfMonth < 1 {
		dayOfMonth = 1
	}
	if dayOfMonth > 28 {
		dayOfMonth = 28
	}
	if paymentTermDays < 0 {
		paymentTermDays = 0
	}
	if items == nil {
		items = []domain.InvoiceItem{}
	}
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	id := idGen("rt-")
	if _, err := s.db.Exec(`INSERT INTO recurring_templates (id, workspace_id, company_name, company_address, items_json, bank_name, bank_account_name, bank_account_number, day_of_month, payment_term_days, active, last_generated_ym, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '', ?)`,
		id, wsID, companyName, companyAddress, string(itemsJSON), bankName, bankAccountName, bankAccountNumber, dayOfMonth, paymentTermDays, createdAt); err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	return s.recurringTemplateByID(id)
}

// UpdateRecurringTemplate applies a partial update to a recurring template.
func (s *Store) UpdateRecurringTemplate(id string, p port.RecurringTemplatePatch) (domain.RecurringInvoiceTemplate, error) {
	if _, err := s.recurringTemplateByID(id); err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	if err := firstErr(
		setStr(s.db, "recurring_templates", "company_name", id, p.CompanyName),
		setStr(s.db, "recurring_templates", "company_address", id, p.CompanyAddress),
		setStr(s.db, "recurring_templates", "bank_name", id, p.BankName),
		setStr(s.db, "recurring_templates", "bank_account_name", id, p.BankAccountName),
		setStr(s.db, "recurring_templates", "bank_account_number", id, p.BankAccountNumber),
		setInt(s.db, "recurring_templates", "day_of_month", id, p.DayOfMonth),
		setInt(s.db, "recurring_templates", "payment_term_days", id, p.PaymentTermDays),
	); err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	if p.Active != nil {
		if _, err := s.db.Exec(`UPDATE recurring_templates SET active = ? WHERE id = ?`, boolInt(*p.Active), id); err != nil {
			return domain.RecurringInvoiceTemplate{}, err
		}
	}
	if p.Items != nil {
		itemsJSON, err := json.Marshal(*p.Items)
		if err != nil {
			return domain.RecurringInvoiceTemplate{}, err
		}
		if _, err := s.db.Exec(`UPDATE recurring_templates SET items_json = ? WHERE id = ?`, string(itemsJSON), id); err != nil {
			return domain.RecurringInvoiceTemplate{}, err
		}
	}
	return s.recurringTemplateByID(id)
}

// DeleteRecurringTemplate deletes a recurring template.
func (s *Store) DeleteRecurringTemplate(id string) error {
	res, err := s.db.Exec(`DELETE FROM recurring_templates WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
```

- [ ] **Step 5: Wire `RecurringTemplates` into the nested workspace tree**

In `backend/internal/store/workspace.go`, in `Workspaces()`, add after the existing
`if ws.Invoices, err = s.invoicesOf(ws.ID); err != nil { return nil, err }` line:

```go
		if ws.RecurringTemplates, err = s.recurringTemplatesOf(ws.ID); err != nil {
			return nil, err
		}
```

And in `workspaceByID()`, add after `if ws.Invoices, err = s.invoicesOf(id); err != nil { return ws, err }`:

```go
	if ws.RecurringTemplates, err = s.recurringTemplatesOf(id); err != nil {
		return ws, err
	}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/store/... -run RecurringTemplate -v`
Expected: `PASS` for all three tests (`TestCreateRecurringTemplatePersistsAndNestsInWorkspace`,
`TestUpdateRecurringTemplateAppliesPartialPatch`, `TestDeleteRecurringTemplateRemovesIt`).

- [ ] **Step 7: Full backend check**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: all packages build, vet is clean, all tests pass (note: `*Store` won't yet satisfy
`port.Store` fully until this task's methods exist — they now do, so this must be clean, aside
from `RunDueRecurringInvoices` which Task 3 still needs to implement. If `go build` fails on a
missing `RunDueRecurringInvoices` method, that's expected until Task 3 — proceed to Task 3
immediately rather than treating it as a regression).

---

### Task 3: Monthly generation scheduler (`RunDueRecurringInvoices`)

**Files:**
- Create: `backend/internal/store/recurring_schedule.go`
- Create: `backend/internal/store/recurring_schedule_test.go`

**Interfaces:**
- Consumes: `Store.CreateInvoice(...)` (existing, `backend/internal/store/invoice.go`);
  `domain.RecurringInvoiceTemplate`/`domain.Invoice`/`domain.InvoiceItem`;
  `port.RecurringTemplatePatch` (Task 2).
- Produces: `Store.RunDueRecurringInvoicesAt(today time.Time) ([]domain.Invoice, error)` and
  `Store.RunDueRecurringInvoices() ([]domain.Invoice, error)` (wraps the former with
  `time.Now().UTC()`) — consumed by Task 4's handler wiring and `main.go`'s startup/ticker hooks.

- [ ] **Step 1: Write the failing scheduler tests**

Create `backend/internal/store/recurring_schedule_test.go`:

```go
package store

import (
	"testing"
	"time"

	"loom/backend/internal/port"
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/store/... -run TestRunDueRecurringInvoices -v`
Expected: FAIL — `s.RunDueRecurringInvoicesAt` undefined.

- [ ] **Step 3: Implement `recurring_schedule.go`**

Create `backend/internal/store/recurring_schedule.go`:

```go
package store

import (
	"encoding/json"
	"strconv"
	"time"

	"loom/backend/internal/domain"
)

// daysInMonth returns the number of days in the given month of the given year.
func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func (s *Store) invoiceCount(wsID string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM invoices WHERE workspace_id = ?`, wsID).Scan(&n)
	return n, err
}

type dueTemplateRow struct {
	id, wsID, companyName, companyAddress, itemsJSON string
	bankName, bankAccountName, bankAccountNumber     string
	lastGeneratedYm                                  string
	dayOfMonth, paymentTermDays                       int
}

// RunDueRecurringInvoices generates a draft Invoice for every active
// RecurringInvoiceTemplate whose scheduled day has passed and that hasn't already generated
// one this month, using the current UTC date.
func (s *Store) RunDueRecurringInvoices() ([]domain.Invoice, error) {
	return s.RunDueRecurringInvoicesAt(time.Now().UTC())
}

// RunDueRecurringInvoicesAt is the pure-logic entry point (today is caller-supplied) so
// scheduling behavior can be tested deterministically.
func (s *Store) RunDueRecurringInvoicesAt(today time.Time) ([]domain.Invoice, error) {
	rows, err := s.db.Query(`SELECT id, workspace_id, company_name, company_address, items_json,
		bank_name, bank_account_name, bank_account_number, day_of_month, payment_term_days, last_generated_ym
		FROM recurring_templates WHERE active = 1`)
	if err != nil {
		return nil, err
	}
	var candidates []dueTemplateRow
	for rows.Next() {
		var r dueTemplateRow
		if err := rows.Scan(&r.id, &r.wsID, &r.companyName, &r.companyAddress, &r.itemsJSON,
			&r.bankName, &r.bankAccountName, &r.bankAccountNumber, &r.dayOfMonth, &r.paymentTermDays,
			&r.lastGeneratedYm); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	currentYm := today.Format("2006-01")
	generated := []domain.Invoice{}
	for _, r := range candidates {
		if r.lastGeneratedYm == currentYm {
			continue
		}
		due := r.dayOfMonth
		if max := daysInMonth(today.Year(), today.Month()); due > max {
			due = max
		}
		if today.Day() < due {
			continue
		}
		var items []domain.InvoiceItem
		if r.itemsJSON != "" {
			if err := json.Unmarshal([]byte(r.itemsJSON), &items); err != nil {
				return nil, err
			}
		}
		count, err := s.invoiceCount(r.wsID)
		if err != nil {
			return nil, err
		}
		number := "INV-" + strconv.Itoa(1044+count)
		createdAt := today.Format("2006-01-02")
		dueDate := today.AddDate(0, 0, r.paymentTermDays).Format("2006-01-02")
		iv, err := s.CreateInvoice(r.wsID, number, r.companyName, r.companyAddress, items, dueDate, createdAt, "draft",
			r.bankName, r.bankAccountName, r.bankAccountNumber)
		if err != nil {
			return nil, err
		}
		if _, err := s.db.Exec(`UPDATE recurring_templates SET last_generated_ym = ? WHERE id = ?`, currentYm, r.id); err != nil {
			return nil, err
		}
		generated = append(generated, iv)
	}
	return generated, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/store/... -run TestRunDueRecurringInvoices -v`
Expected: `PASS` for all three tests.

- [ ] **Step 5: Full backend check**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: clean build, clean vet, all tests pass. `*store.Store` now satisfies the full
`port.Store` interface (Task 2 + this task added every new method the interface declares).

---

### Task 4: HTTP handler + route + scheduler wiring in `main.go`

**Files:**
- Create: `backend/internal/handler/recurring_template.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `Store.CreateRecurringTemplate/UpdateRecurringTemplate/DeleteRecurringTemplate`
  (Task 2), `Store.RunDueRecurringInvoices` (Task 3), `str()` (`handler/project.go`),
  `decodeBody`/`writeJSON`/`writeErr`/`handleStoreErr` (`handler/middleware.go`).
- Produces: routes `POST /api/workspaces/{wsId}/recurring-templates`,
  `PATCH /api/recurring-templates/{id}`, `DELETE /api/recurring-templates/{id}` — consumed by
  Task 5's frontend API client.

- [ ] **Step 1: Implement the handler**

Create `backend/internal/handler/recurring_template.go`:

```go
package handler

import (
	"net/http"
	"time"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// RecurringTemplateHandler handles recurring-invoice-template CRUD endpoints.
type RecurringTemplateHandler struct {
	st *store.Store
}

// NewRecurringTemplateHandler creates a recurring template handler.
func NewRecurringTemplateHandler(st *store.Store) *RecurringTemplateHandler {
	return &RecurringTemplateHandler{st: st}
}

func intOr(v *int, fallback int) int {
	if v == nil {
		return fallback
	}
	return *v
}

// PostRecurringTemplate creates a recurring invoice template for a workspace.
func (h *RecurringTemplateHandler) PostRecurringTemplate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CompanyName       *string              `json:"companyName"`
		CompanyAddress    *string              `json:"companyAddress"`
		Items             []domain.InvoiceItem `json:"items"`
		BankName          *string              `json:"bankName"`
		BankAccountName   *string              `json:"bankAccountName"`
		BankAccountNumber *string              `json:"bankAccountNumber"`
		DayOfMonth        *int                 `json:"dayOfMonth"`
		PaymentTermDays   *int                 `json:"paymentTermDays"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	createdAt := time.Now().UTC().Format("2006-01-02")
	tpl, err := h.st.CreateRecurringTemplate(
		r.PathValue("wsId"), str(body.CompanyName), str(body.CompanyAddress), body.Items,
		str(body.BankName), str(body.BankAccountName), str(body.BankAccountNumber),
		intOr(body.DayOfMonth, 1), intOr(body.PaymentTermDays, 14), createdAt,
	)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, tpl)
}

// PatchRecurringTemplate updates a recurring invoice template.
func (h *RecurringTemplateHandler) PatchRecurringTemplate(w http.ResponseWriter, r *http.Request) {
	var p port.RecurringTemplatePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	tpl, err := h.st.UpdateRecurringTemplate(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, tpl)
}

// DeleteRecurringTemplate deletes a recurring invoice template.
func (h *RecurringTemplateHandler) DeleteRecurringTemplate(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteRecurringTemplate(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 2: Wire the handler and routes into `main.go`**

In `backend/cmd/server/main.go`, add the handler construction after `bankH :=
handler.NewBankHandler(st)`:

```go
	recH := handler.NewRecurringTemplateHandler(st)
```

Add the routes after the existing bank routes (`mux.HandleFunc("DELETE /api/banks/{id}", ...)`),
before the `// News` `mux.HandleFunc` lines:

```go
	mux.HandleFunc("POST /api/workspaces/{wsId}/recurring-templates", recH.PostRecurringTemplate)
	mux.HandleFunc("PATCH /api/recurring-templates/{id}", recH.PatchRecurringTemplate)
	mux.HandleFunc("DELETE /api/recurring-templates/{id}", recH.DeleteRecurringTemplate)
```

- [ ] **Step 3: Add the startup check and daily ticker**

In `main.go`, add `"time"` to the import block (alongside `"flag"`, `"log"`, `"net/http"`,
`"os"`). Then, right after `st := store.New(db)`, add:

```go

	if generated, err := st.RunDueRecurringInvoices(); err != nil {
		log.Printf("recurring invoices: startup check failed: %v", err)
	} else if len(generated) > 0 {
		log.Printf("recurring invoices: generated %d draft invoice(s) on startup", len(generated))
	}

	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if generated, err := st.RunDueRecurringInvoices(); err != nil {
				log.Printf("recurring invoices: daily check failed: %v", err)
			} else if len(generated) > 0 {
				log.Printf("recurring invoices: generated %d draft invoice(s)", len(generated))
			}
		}
	}()
```

- [ ] **Step 4: Verify**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: clean build, clean vet, all tests pass (including the Task 2/3 store tests).

---

### Task 5: Frontend types, API client, and React Query hooks

**Files:**
- Modify: `frontend/src/store/types.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: route contract from Task 4 (`POST /api/workspaces/{wsId}/recurring-templates`,
  `PATCH /api/recurring-templates/{id}`, `DELETE /api/recurring-templates/{id}`);
  `useInvalidateWorkspaces` pattern already used by `useCreateInvoice` etc.
  (`frontend/src/features/data/queries.ts`).
- Produces: `RecurringInvoiceTemplate` type, `Workspace.recurringTemplates` field;
  `createRecurringTemplate/updateRecurringTemplate/deleteRecurringTemplate` API functions;
  `useCreateRecurringTemplate/useUpdateRecurringTemplate/useDeleteRecurringTemplate` hooks —
  all consumed by Task 6.

- [ ] **Step 1: Add the type to `store/types.ts`**

In `frontend/src/store/types.ts`, insert after the `Invoice` interface (after its closing `}`,
before `export interface Workspace`):

```ts
export interface RecurringInvoiceTemplate {
  id: string
  companyName: string
  companyAddress: string
  items: InvoiceItem[]
  bankDetail: BankDetail
  dayOfMonth: number
  paymentTermDays: number
  active: boolean
  lastGeneratedYm: string
  createdAt: string
}
```

Then add a field to `Workspace`:

```ts
export interface Workspace {
  id: string
  name: string
  projects: Project[]
  news: NewsItem[]
  todos: Todo[]
  invoices: Invoice[]
  recurringTemplates: RecurringInvoiceTemplate[]
}
```

- [ ] **Step 2: Add API client functions to `lib/api.ts`**

Add `RecurringInvoiceTemplate` to the `import type { ... } from '@/store/types'` block at the
top of `frontend/src/lib/api.ts` (alphabetically, between `Project` and `Settings`).

Add these body interfaces after `UpdateBankBody`:

```ts
export interface CreateRecurringTemplateBody {
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
  dayOfMonth?: number
  paymentTermDays?: number
}

export interface UpdateRecurringTemplateBody {
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
  dayOfMonth?: number
  paymentTermDays?: number
  active?: boolean
}
```

Add these functions after the `// ---- Banks ----` section, in a new `// ---- Recurring
templates ----` section:

```ts
// ---- Recurring templates ----

export function createRecurringTemplate(wsId: string, body: CreateRecurringTemplateBody): Promise<RecurringInvoiceTemplate> {
  return request<RecurringInvoiceTemplate>('POST', `/workspaces/${wsId}/recurring-templates`, body)
}

export function updateRecurringTemplate(id: string, patch: UpdateRecurringTemplateBody): Promise<RecurringInvoiceTemplate> {
  return request<RecurringInvoiceTemplate>('PATCH', `/recurring-templates/${id}`, patch)
}

export function deleteRecurringTemplate(id: string): Promise<void> {
  return request<void>('DELETE', `/recurring-templates/${id}`)
}
```

- [ ] **Step 3: Add mutation hooks to `features/data/queries.ts`**

Add `createRecurringTemplate, deleteRecurringTemplate, updateRecurringTemplate` to the
`import { ... } from '@/lib/api'` function-import block (alphabetically), and
`CreateRecurringTemplateBody, UpdateRecurringTemplateBody` to the `import type { ... } from
'@/lib/api'` block.

Add these hooks after `useDeleteInvoice` and before `useCompanies`:

```ts
export function useCreateRecurringTemplate() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ wsId, body }: { wsId: string; body: CreateRecurringTemplateBody }) =>
      createRecurringTemplate(wsId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateRecurringTemplate() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateRecurringTemplateBody }) =>
      updateRecurringTemplate(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteRecurringTemplate() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteRecurringTemplate(id),
    onSuccess: () => invalidate(),
  })
}
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

---

### Task 6: Tab bar + Recurring tab UI in `InvoicesModule`

**Files:**
- Modify: `frontend/src/features/modules/InvoicesModule.tsx`
- Create: `frontend/src/features/modules/recurring/RecurringTab.tsx`

**Interfaces:**
- Consumes: `useCreateRecurringTemplate/useUpdateRecurringTemplate/useDeleteRecurringTemplate`,
  `useCreateCompany/useCreateBank` (Task 5 + existing); `RecurringInvoiceTemplate` (Task 5);
  `CompanyPicker`/`BankPicker` (`frontend/src/features/modules/{CompanyPicker,BankPicker}.tsx`,
  existing); `cn` (`@/lib/utils`); `fmtRupiah` (`@/lib/format`).
- Produces: `RecurringTab` component (`{ wsId: string; templates: RecurringInvoiceTemplate[]
  }`) and a `tab` state (`'invoices' | 'recurring' | 'finance'`) in `InvoicesModule` — the
  `'finance'` branch is wired to a placeholder in this task and replaced by `FinanceAnalysisTab`
  in Task 7.

- [ ] **Step 1: Implement `RecurringTab.tsx`**

Create `frontend/src/features/modules/recurring/RecurringTab.tsx`:

```tsx
import { useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmtRupiah } from '@/lib/format'
import type { RecurringInvoiceTemplate } from '@/store/types'
import {
  useCreateBank,
  useCreateCompany,
  useCreateRecurringTemplate,
  useDeleteRecurringTemplate,
  useUpdateRecurringTemplate,
} from '@/features/data/queries'
import { BankPicker } from '../BankPicker'
import { CompanyPicker } from '../CompanyPicker'

interface DraftItem {
  description: string
  quantity: string
  unitPrice: string
}

interface Draft {
  editId: string | null
  companyName: string
  companyAddress: string
  items: DraftItem[]
  bankName: string
  bankAccountName: string
  bankAccountNumber: string
  dayOfMonth: string
  paymentTermDays: string
}

function emptyItem(): DraftItem {
  return { description: '', quantity: '1', unitPrice: '' }
}

function itemTotal(it: DraftItem): number {
  return (parseFloat(it.quantity) || 0) * (parseFloat(it.unitPrice.replace(/[^0-9.]/g, '')) || 0)
}

function nextRunLabel(tpl: RecurringInvoiceTemplate): string {
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const day = Math.min(tpl.dayOfMonth, daysInMonth)
  const generatedThisMonth = tpl.lastGeneratedYm === ym
  const target = new Date(now.getFullYear(), now.getMonth() + (generatedThisMonth ? 1 : 0), day)
  return target.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Recurring invoice templates: create/edit/delete monthly billing schedules. */
export function RecurringTab({ wsId, templates }: { wsId: string; templates: RecurringInvoiceTemplate[] }) {
  const createTemplate = useCreateRecurringTemplate()
  const updateTemplate = useUpdateRecurringTemplate()
  const deleteTemplate = useDeleteRecurringTemplate()
  const createCompany = useCreateCompany()
  const createBank = useCreateBank()

  const [draft, setDraft] = useState<Draft | null>(null)

  function openNew() {
    setDraft({
      editId: null,
      companyName: '',
      companyAddress: '',
      items: [emptyItem()],
      bankName: '',
      bankAccountName: '',
      bankAccountNumber: '',
      dayOfMonth: '1',
      paymentTermDays: '14',
    })
  }

  function openEdit(tpl: RecurringInvoiceTemplate) {
    setDraft({
      editId: tpl.id,
      companyName: tpl.companyName,
      companyAddress: tpl.companyAddress,
      items: tpl.items.length
        ? tpl.items.map((it) => ({ description: it.description, quantity: String(it.quantity), unitPrice: String(it.unitPrice) }))
        : [emptyItem()],
      bankName: tpl.bankDetail.bankName,
      bankAccountName: tpl.bankDetail.accountName,
      bankAccountNumber: tpl.bankDetail.accountNumber,
      dayOfMonth: String(tpl.dayOfMonth),
      paymentTermDays: String(tpl.paymentTermDays),
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
    const dayOfMonth = Math.min(28, Math.max(1, parseInt(draft.dayOfMonth, 10) || 1))
    const paymentTermDays = Math.max(0, parseInt(draft.paymentTermDays, 10) || 0)
    const body = {
      companyName: draft.companyName.trim() || 'Untitled client',
      companyAddress: draft.companyAddress.trim(),
      items,
      bankName,
      bankAccountName,
      bankAccountNumber,
      dayOfMonth,
      paymentTermDays,
    }
    if (draft.editId) {
      updateTemplate.mutate({ id: draft.editId, patch: body }, { onSuccess: () => setDraft(null) })
    } else {
      createTemplate.mutate({ wsId, body }, { onSuccess: () => setDraft(null) })
    }
  }

  const saving = createTemplate.isPending || updateTemplate.isPending
  const draftGrandTotal = draft ? draft.items.reduce((sum, it) => sum + itemTotal(it), 0) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-loom-border px-4 py-2.5">
        <span className="font-mono text-[11px] text-loom-dim">
          Auto-generates a draft invoice on the scheduled day each month.
        </span>
        <Button size="sm" onClick={openNew}>
          <Plus size={13} />
          New template
        </Button>
      </div>

      {draft ? (
        <div className="flex-none border-b border-loom-border bg-loom-card/40 px-4 py-3">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="font-mono text-[11.5px] text-loom-muted-2">
              {draft.editId ? 'Edit template' : 'New template'}
            </span>
            <button onClick={() => setDraft(null)} aria-label="Close" className="cursor-pointer p-0.5 text-loom-muted-2 hover:text-loom-fg">
              <X size={14} />
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Day of month</span>
              <Input
                type="number"
                min={1}
                max={28}
                value={draft.dayOfMonth}
                onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })}
                className="w-[100px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Due N days after generation</span>
              <Input
                type="number"
                min={0}
                value={draft.paymentTermDays}
                onChange={(e) => setDraft({ ...draft, paymentTermDays: e.target.value })}
                className="w-[140px]"
              />
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
              <Input value={draft.bankName} onChange={(e) => setDraft({ ...draft, bankName: e.target.value })} placeholder="BCA" className="w-[140px]" />
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
              onPick={(b) => setDraft({ ...draft, bankName: b.bankName, bankAccountName: b.accountName, bankAccountNumber: b.accountNumber })}
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
                        <Input value={it.description} onChange={(e) => updateItem(i, { description: e.target.value })} placeholder="Backend API development" />
                      </td>
                      <td className="py-1 pr-1">
                        <Input value={it.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })} className="text-right" />
                      </td>
                      <td className="py-1 pr-1">
                        <Input value={it.unitPrice} onChange={(e) => updateItem(i, { unitPrice: e.target.value })} placeholder="0" className="text-right" />
                      </td>
                      <td className="py-1 text-right font-mono text-loom-fg">{fmtRupiah(itemTotal(it))}</td>
                      <td className="py-1 text-right">
                        <button onClick={() => removeItem(i)} aria-label="Remove line item" className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft">
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1.5 flex items-center justify-between">
                <button onClick={addItem} className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-loom-accent-soft hover:underline">
                  <Plus size={12} />
                  Add line item
                </button>
                <span className="font-mono text-[12.5px] text-loom-fg">Grand total: {fmtRupiah(draftGrandTotal)}</span>
              </div>
            </div>

            <Button size="lg" disabled={saving} onClick={save}>
              {draft.editId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      ) : null}

      {templates.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center font-mono text-[12px] text-loom-dim">
          No recurring templates yet. Create one to auto-generate a draft invoice every month.
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-loom-border text-left font-mono text-[10px] tracking-wide text-loom-dim uppercase">
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Next run</th>
                <th className="px-3 py-2 text-right font-medium">Monthly total</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {templates.map((tpl) => {
                const total = tpl.items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0)
                return (
                  <tr key={tpl.id} className="border-b border-loom-border-card last:border-none hover:bg-loom-card/50">
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-loom-fg">{tpl.companyName || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-loom-dim">
                      Day {tpl.dayOfMonth}, net {tpl.paymentTermDays}d
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-loom-dim">{nextRunLabel(tpl)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] whitespace-nowrap text-loom-fg">{fmtRupiah(total)}</td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => updateTemplate.mutate({ id: tpl.id, patch: { active: !tpl.active } })}
                        className={`cursor-pointer rounded-md px-2 py-1 font-mono text-[10.5px] ${
                          tpl.active ? 'bg-loom-green-tint text-loom-green-soft' : 'bg-loom-card text-loom-muted-2'
                        }`}
                      >
                        {tpl.active ? 'Active' : 'Paused'}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <button onClick={() => openEdit(tpl)} aria-label="Edit template" className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => deleteTemplate.mutate(tpl.id)} aria-label="Delete template" className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft">
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

- [ ] **Step 2: Add the tab bar and wire `RecurringTab` into `InvoicesModule.tsx`**

In `frontend/src/features/modules/InvoicesModule.tsx`, replace the import block from `import
type { Invoice, InvoiceStatus } from '@/store/types'` through `import { ModuleHeader } from
'./ModuleHeader'` with:

```ts
import { cn } from '@/lib/utils'
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
import { RecurringTab } from './recurring/RecurringTab'
```

(The `FinanceAnalysisTab` import and its render branch are added in Task 7 — for now, replace
`tab === 'finance'` output with `null` per the next edit below, so this task compiles and is
independently testable.)

Replace:

```ts
  const [draft, setDraft] = useState<Draft | null>(null)

  if (q.isPending) return <DataLoading label="loading invoices…" />
  if (q.isError) return <DataError error={q.error} onRetry={() => q.refetch()} />

  const workspace = q.data
  const invoices = workspace?.invoices ?? []
  const total = invoices.reduce((sum, iv) => sum + iv.amount, 0)
```

with:

```ts
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tab, setTab] = useState<'invoices' | 'recurring' | 'finance'>('invoices')

  if (q.isPending) return <DataLoading label="loading invoices…" />
  if (q.isError) return <DataError error={q.error} onRetry={() => q.refetch()} />

  const workspace = q.data
  const invoices = workspace?.invoices ?? []
  const recurringTemplates = workspace?.recurringTemplates ?? []
  const total = invoices.reduce((sum, iv) => sum + iv.amount, 0)
```

Replace:

```tsx
        actions={
          <Button size="sm" onClick={openNew}>
            <Plus size={13} />
            New invoice
          </Button>
        }
      />

      {draft ? (
```

with:

```tsx
        actions={
          tab === 'invoices' ? (
            <Button size="sm" onClick={openNew}>
              <Plus size={13} />
              New invoice
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-none items-center gap-1 border-b border-loom-border px-4 py-2">
        {(
          [
            { key: 'invoices', label: 'Invoices' },
            { key: 'recurring', label: 'Recurring' },
            { key: 'finance', label: 'Finance Analysis' },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'cursor-pointer rounded-md px-2.5 py-1.5 font-mono text-[11.5px] transition-colors',
              tab === t.key ? 'bg-loom-accent/10 text-loom-fg' : 'text-loom-muted hover:text-loom-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'recurring' ? <RecurringTab wsId={wsId} templates={recurringTemplates} /> : null}
      {tab === 'finance' ? null : null}

      {tab === 'invoices' && draft ? (
```

Replace:

```tsx
      {invoices.length === 0 ? (
        <InvoicesEmpty />
      ) : (
        <div className="flex-1 overflow-auto p-4">
```

with:

```tsx
      {tab === 'invoices' && (invoices.length === 0 ? (
        <InvoicesEmpty />
      ) : (
        <div className="flex-1 overflow-auto p-4">
```

Replace the file's closing lines:

```tsx
        </div>
      )}
    </div>
  )
}
```

with:

```tsx
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (`{tab === 'finance' ? null : null}` is intentionally inert — it's a
placeholder slot Task 7 replaces with `<FinanceAnalysisTab invoices={invoices} />`.)

---

### Task 7: `recharts` + vendored chart primitives + Finance Analysis charts

**Files:**
- Modify: `frontend/package.json` (via `npm install`)
- Create: `frontend/src/components/ui/chart.tsx`
- Create: `frontend/src/features/modules/finance/RevenueByMonthChart.tsx`
- Create: `frontend/src/features/modules/finance/StatusBreakdownChart.tsx`
- Create: `frontend/src/features/modules/finance/RevenueByCompanyChart.tsx`
- Create: `frontend/src/features/modules/finance/OutstandingTrendChart.tsx`
- Create: `frontend/src/features/modules/finance/FinanceAnalysisTab.tsx`
- Modify: `frontend/src/features/modules/InvoicesModule.tsx`

**Interfaces:**
- Consumes: `cn` (`@/lib/utils`); `fmtRupiah` (`@/lib/format`); `INVST` (`@/lib/constants`);
  `Invoice`/`InvoiceStatus` (`@/store/types`); the `tab === 'finance'` slot from Task 6.
- Produces: `ChartContainer`/`ChartTooltip`/`ChartTooltipContent`/`ChartConfig`
  (`@/components/ui/chart`) and `FinanceAnalysisTab` (`{ invoices: Invoice[] }`) — this is the
  final task that completes `InvoicesModule`'s tab bar.

- [ ] **Step 1: Install `recharts`**

Run: `cd frontend && npm install recharts`
Expected: `recharts` added to `frontend/package.json` dependencies, `package-lock.json` (or
equivalent lockfile) updated.

- [ ] **Step 2: Vendor the chart primitives**

Create `frontend/src/components/ui/chart.tsx`:

```tsx
import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '@/lib/utils'

export type ChartConfig = Record<string, { label: string; color?: string }>

interface ChartContainerProps extends Omit<ComponentProps<'div'>, 'children'> {
  config: ChartConfig
  children: ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}

/** Wraps a Recharts chart in a ResponsiveContainer and exposes `--color-<key>` CSS vars from config. */
export function ChartContainer({ config, className, children, ...props }: ChartContainerProps) {
  const style = Object.fromEntries(
    Object.entries(config)
      .filter(([, v]) => v.color)
      .map(([key, v]) => [`--color-${key}`, v.color]),
  ) as CSSProperties

  return (
    <div className={cn('h-full w-full', className)} style={style} {...props}>
      <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  )
}

interface ChartTooltipContentProps {
  active?: boolean
  payload?: Array<{ name?: ReactNode; value?: number | string; color?: string }>
  label?: string
  formatter?: (value: number | string) => string
}

/** Dark-themed tooltip body matching Loom's card styling. */
export function ChartTooltipContent({ active, payload, label, formatter }: ChartTooltipContentProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-loom-border-card bg-loom-surface-2 px-3 py-2 text-[11.5px] shadow-lg">
      {label ? <div className="mb-1 font-mono text-[10px] text-loom-dim">{label}</div> : null}
      <div className="flex flex-col gap-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm" style={{ background: p.color }} />
            <span className="text-loom-muted">{p.name}</span>
            <span className="ml-auto font-mono font-semibold text-loom-fg">
              {formatter && p.value !== undefined ? formatter(p.value) : p.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export const ChartTooltip = RechartsPrimitive.Tooltip
```

- [ ] **Step 3: Implement the four chart components**

Create `frontend/src/features/modules/finance/RevenueByMonthChart.tsx`:

```tsx
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtRupiah } from '@/lib/format'
import type { Invoice } from '@/store/types'

const config: ChartConfig = { revenue: { label: 'Revenue', color: '#6d8bff' } }

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

/** Sum of invoice amounts grouped by createdAt's YYYY-MM, trailing 12 months. */
export function RevenueByMonthChart({ invoices }: { invoices: Invoice[] }) {
  const now = new Date()
  const months: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const totals = new Map(months.map((m) => [m, 0]))
  for (const iv of invoices) {
    const ym = iv.createdAt.slice(0, 7)
    if (totals.has(ym)) totals.set(ym, (totals.get(ym) ?? 0) + iv.amount)
  }
  const data = months.map((ym) => ({ month: monthLabel(ym), revenue: totals.get(ym) ?? 0 }))

  return (
    <div className="flex h-[260px] flex-col gap-2 rounded-lg border border-loom-border-card bg-loom-surface-2 p-4">
      <span className="font-mono text-[11px] text-loom-dim uppercase">Revenue per month</span>
      <ChartContainer config={config} className="flex-1">
        <BarChart data={data}>
          <CartesianGrid vertical={false} stroke="var(--loom-border-card)" />
          <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" />
          <YAxis tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" tickFormatter={(v) => fmtRupiah(v)} width={80} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
          <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
```

Create `frontend/src/features/modules/finance/StatusBreakdownChart.tsx`:

```tsx
import { Cell, Pie, PieChart } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { INVST } from '@/lib/constants'
import { fmtRupiah } from '@/lib/format'
import type { Invoice, InvoiceStatus } from '@/store/types'

const config: ChartConfig = Object.fromEntries(
  (Object.keys(INVST) as InvoiceStatus[]).map((s) => [s, { label: INVST[s].label, color: INVST[s].color }]),
)

/** Count and total value of invoices grouped by status. */
export function StatusBreakdownChart({ invoices }: { invoices: Invoice[] }) {
  const statuses = Object.keys(INVST) as InvoiceStatus[]
  const data = statuses
    .map((s) => {
      const matching = invoices.filter((iv) => iv.status === s)
      return { status: s, name: INVST[s].label, value: matching.reduce((sum, iv) => sum + iv.amount, 0), count: matching.length }
    })
    .filter((d) => d.count > 0)

  return (
    <div className="flex h-[260px] flex-col gap-2 rounded-lg border border-loom-border-card bg-loom-surface-2 p-4">
      <span className="font-mono text-[11px] text-loom-dim uppercase">Status breakdown</span>
      {data.length === 0 ? (
        <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-loom-dim">No invoices yet</div>
      ) : (
        <ChartContainer config={config} className="flex-1">
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
              {data.map((d) => (
                <Cell key={d.status} fill={INVST[d.status].color} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
      )}
    </div>
  )
}
```

Create `frontend/src/features/modules/finance/RevenueByCompanyChart.tsx`:

```tsx
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtRupiah } from '@/lib/format'
import type { Invoice } from '@/store/types'

const config: ChartConfig = { total: { label: 'Total', color: '#c7a3ff' } }

/** Sum of invoice amounts grouped by company, top 8 by value (rest bucketed as "Other"). */
export function RevenueByCompanyChart({ invoices }: { invoices: Invoice[] }) {
  const totals = new Map<string, number>()
  for (const iv of invoices) {
    const key = iv.companyName || 'Untitled client'
    totals.set(key, (totals.get(key) ?? 0) + iv.amount)
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, 8)
  const rest = sorted.slice(8)
  const data = top.map(([company, total]) => ({ company, total }))
  if (rest.length > 0) {
    data.push({ company: 'Other', total: rest.reduce((sum, [, v]) => sum + v, 0) })
  }

  return (
    <div className="flex h-[260px] flex-col gap-2 rounded-lg border border-loom-border-card bg-loom-surface-2 p-4">
      <span className="font-mono text-[11px] text-loom-dim uppercase">Revenue per company</span>
      <ChartContainer config={config} className="flex-1">
        <BarChart data={data} layout="vertical" margin={{ left: 8 }}>
          <CartesianGrid horizontal={false} stroke="var(--loom-border-card)" />
          <XAxis type="number" tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" tickFormatter={(v) => fmtRupiah(v)} />
          <YAxis type="category" dataKey="company" tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" width={100} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
          <Bar dataKey="total" fill="var(--color-total)" radius={4} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
```

Create `frontend/src/features/modules/finance/OutstandingTrendChart.tsx`:

```tsx
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { fmtRupiah } from '@/lib/format'
import type { Invoice } from '@/store/types'

const config: ChartConfig = { outstanding: { label: 'Outstanding', color: '#f5c451' } }

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

/** Outstanding (sent+overdue) total per month, trailing 12 months, plus current summary. */
export function OutstandingTrendChart({ invoices }: { invoices: Invoice[] }) {
  const outstandingNow = invoices.filter((iv) => iv.status === 'sent' || iv.status === 'overdue').reduce((sum, iv) => sum + iv.amount, 0)
  const overdueNow = invoices.filter((iv) => iv.status === 'overdue').reduce((sum, iv) => sum + iv.amount, 0)

  const now = new Date()
  const months: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const totals = new Map(months.map((m) => [m, 0]))
  for (const iv of invoices) {
    if (iv.status !== 'sent' && iv.status !== 'overdue') continue
    const ym = iv.createdAt.slice(0, 7)
    if (totals.has(ym)) totals.set(ym, (totals.get(ym) ?? 0) + iv.amount)
  }
  const data = months.map((ym) => ({ month: monthLabel(ym), outstanding: totals.get(ym) ?? 0 }))

  return (
    <div className="flex h-[260px] flex-col gap-3 rounded-lg border border-loom-border-card bg-loom-surface-2 p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-loom-dim uppercase">Outstanding &amp; overdue</span>
        <div className="flex gap-3 font-mono text-[11px]">
          <span className="text-loom-fg">Outstanding: {fmtRupiah(outstandingNow)}</span>
          <span className="text-loom-red-soft">Overdue: {fmtRupiah(overdueNow)}</span>
        </div>
      </div>
      <ChartContainer config={config} className="flex-1">
        <LineChart data={data}>
          <CartesianGrid vertical={false} stroke="var(--loom-border-card)" />
          <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" />
          <YAxis tickLine={false} axisLine={false} fontSize={10} stroke="var(--loom-dim)" tickFormatter={(v) => fmtRupiah(v)} width={80} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v) => fmtRupiah(Number(v))} />} />
          <Line type="monotone" dataKey="outstanding" stroke="var(--color-outstanding)" strokeWidth={2} dot={false} />
        </LineChart>
      </ChartContainer>
    </div>
  )
}
```

Create `frontend/src/features/modules/finance/FinanceAnalysisTab.tsx`:

```tsx
import type { Invoice } from '@/store/types'
import { OutstandingTrendChart } from './OutstandingTrendChart'
import { RevenueByCompanyChart } from './RevenueByCompanyChart'
import { RevenueByMonthChart } from './RevenueByMonthChart'
import { StatusBreakdownChart } from './StatusBreakdownChart'

/** Finance Analysis tab: revenue, status, and outstanding charts computed from a workspace's invoices. */
export function FinanceAnalysisTab({ invoices }: { invoices: Invoice[] }) {
  if (invoices.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center font-mono text-[12px] text-loom-dim">
        No invoices yet — charts will appear once you create one.
      </div>
    )
  }
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RevenueByMonthChart invoices={invoices} />
        <StatusBreakdownChart invoices={invoices} />
        <RevenueByCompanyChart invoices={invoices} />
        <OutstandingTrendChart invoices={invoices} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Wire `FinanceAnalysisTab` into `InvoicesModule.tsx`**

Add the import to `frontend/src/features/modules/InvoicesModule.tsx`, in the same import group
added in Task 6 — insert `import { FinanceAnalysisTab } from './finance/FinanceAnalysisTab'`
right before `import { ModuleHeader } from './ModuleHeader'`.

Replace the Task 6 placeholder line:

```tsx
      {tab === 'finance' ? null : null}
```

with:

```tsx
      {tab === 'finance' ? <FinanceAnalysisTab invoices={invoices} /> : null}
```

- [ ] **Step 5: Verify**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: no type errors, build succeeds.

---

### Task 8: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full backend check**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: clean build, clean vet, all tests pass (including all `Recurring*` tests from Tasks 2
and 3).

- [ ] **Step 2: Full frontend check**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 3: Manual/Playwright smoke test**

Start both dev servers (`cd frontend && npm run dev`, which also starts the Go backend per
`dev:api` — see `COMMANDS.md`), then verify in a browser (or via the webapp-testing skill's
Playwright pattern):

1. Navigate to a workspace's Invoices page. Confirm the new tab bar (Invoices / Recurring /
   Finance Analysis) renders, defaulting to the Invoices tab, and the existing invoice list,
   create/edit form, and "Download" flow still work exactly as before (this is a regression
   check on Task 6/7's edits to `InvoicesModule.tsx`).
2. Switch to the Recurring tab. Create a new template (company, bank, one job-detail line item,
   day-of-month, payment-term-days). Confirm it appears in the list with a computed "Next run"
   date. Toggle it to "Paused" and back to "Active". Edit it and confirm the form pre-fills.
   Delete it and confirm it disappears.
3. Switch to the Finance Analysis tab. Confirm all four charts render without console errors:
   revenue-per-month bar chart, status-breakdown donut, revenue-per-company bar chart, and the
   outstanding/overdue line chart with its summary numbers. If the workspace has zero invoices,
   confirm the "No invoices yet" empty state renders instead.
4. Restart the backend process (`go run ./cmd/server` or via `npm run dev:api`) with a recurring
   template whose `dayOfMonth` is today's date or earlier and `lastGeneratedYm` not yet this
   month (create one via the UI, or via `sqlite3 backend/loom.db "UPDATE recurring_templates SET
   last_generated_ym = ''"`), and confirm the startup log line `recurring invoices: generated N
   draft invoice(s) on startup` appears, and the new draft invoice shows up in the Invoices tab.

Expected: all four checks pass with no console/network errors.
