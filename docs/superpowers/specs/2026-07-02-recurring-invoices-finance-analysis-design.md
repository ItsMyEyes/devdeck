# Recurring Invoices + Finance Analysis — Design

**Goal:** extend the Invoices module with (1) monthly recurring invoice templates that
auto-generate draft invoices on a configurable day, and (2) a Finance Analysis tab with
charts (revenue/month, status breakdown, revenue/company, outstanding & overdue).

**Scope:** additions to the existing per-workspace Invoices module only. No changes to
News/Todos/Agents.

## 1. Recurring invoice templates

### Data model

New domain type, mirrors `Invoice`'s billing fields plus scheduling fields:

```go
// backend/internal/domain/models.go
type RecurringInvoiceTemplate struct {
	ID              string        `json:"id"`
	CompanyName     string        `json:"companyName"`
	CompanyAddress  string        `json:"companyAddress"`
	Items           []InvoiceItem `json:"items"`
	BankDetail      BankDetail    `json:"bankDetail"`
	DayOfMonth      int           `json:"dayOfMonth"`      // 1-28
	PaymentTermDays int           `json:"paymentTermDays"` // due = generatedAt + N days
	Active          bool          `json:"active"`
	LastGeneratedYm string        `json:"lastGeneratedYm"` // "2026-07" or "" if never run
	CreatedAt       string        `json:"createdAt"`
}
```

`Workspace` gets a new field `RecurringTemplates []RecurringInvoiceTemplate`, following the
same nesting pattern as `Invoices`/`Todos`/`News` (no `WorkspaceID` in the JSON body; scoping
is via the parent object and the SQL `workspace_id` column, same as `invoices`).

### Storage

New table `recurring_templates`, same shape as `invoices` plus the schedule columns:

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

No migration needed (`CREATE TABLE IF NOT EXISTS`, brand-new table), same as `companies`/`banks`.

### Scheduler

Since the Go backend is normally started manually (not an always-on daemon), generation is
driven by two triggers that call the same underlying function,
`Store.RunDueRecurringInvoices() ([]domain.Invoice, error)`:

1. **Startup check** — called once from `main.go` right after `store.Open()`, before
   `http.ListenAndServe`.
2. **Daily ticker** — a goroutine started in `main.go` with `time.NewTicker(24 * time.Hour)`
   that calls the same function; catches templates that come due while the process stays running
   across a day boundary.

`RunDueRecurringInvoices` logic, per active template:

- Compute this month's scheduled date: `min(template.DayOfMonth, daysInCurrentMonth)` (handles
  Feb/30-day months for `dayOfMonth` values like 29-31 — capped at 28 in the UI so this is a
  pure safety clamp).
- Skip if `today < scheduledDate` (not due yet) or `template.LastGeneratedYm == currentYm`
  (already generated this month).
- Otherwise: build a new `Invoice` from the template's company/items/bank snapshot, `status =
  "draft"`, `createdAt = today`, `dueDate = today + PaymentTermDays`, `number` auto-assigned
  using the same convention the frontend already uses for manual creation —
  `"INV-" + (1044 + currentInvoiceCountInWorkspace)` — computed server-side in the store method
  since this path has no client to supply a number. Insert it, then set
  `LastGeneratedYm = currentYm` on the template.
- Errors for one template are logged and skipped; they don't abort the rest of the batch.

### API surface

Follows the workspace-nested pattern (Todo/Invoice), not the global-preset pattern
(Company/Bank): no standalone list endpoint — templates are read via the nested
`workspace.recurringTemplates` field returned by the existing `GET /api/workspaces` tree.

- `POST /api/workspaces/{wsId}/recurring-templates`
- `PATCH /api/recurring-templates/{id}`
- `DELETE /api/recurring-templates/{id}`

Patch struct `RecurringTemplatePatch` follows the existing `*T`-pointer-optional-field
convention (`CompanyName, CompanyAddress *string`, `Items *[]domain.InvoiceItem`, `BankName,
BankAccountName, BankAccountNumber *string`, `DayOfMonth, PaymentTermDays *int`, `Active *bool`).

### Frontend

- `Workspace.recurringTemplates: RecurringInvoiceTemplate[]` added to `store/types.ts`.
- `useRecurringTemplates`-style hooks added alongside the existing invoice hooks in
  `queries.ts`/`keys.ts`/`api.ts`.
- New **"Recurring" tab** inside `InvoicesModule` (see tab structure below): a list of
  templates (company, next scheduled date computed client-side from `dayOfMonth` +
  `lastGeneratedYm`, active toggle, edit/delete) plus a create/edit form reusing the same
  company/bank/item-table UI already built for one-off invoices (`CompanyPicker`, `BankPicker`,
  the job-details table), with two extra fields: day-of-month picker (1–28) and payment-term
  (days) input.

## 2. Finance Analysis tab

### Tab structure

`InvoicesModule` gets a small tab bar above its current content:

```
[ Invoices ]  [ Recurring ]  [ Finance Analysis ]
```

Implemented as local component state (`useState<'invoices' | 'recurring' | 'finance'>`), no new
route — everything stays under the existing `/w/:wsId/invoices` route and nav entry. Switching
tabs swaps the body; the "New invoice" header action only shows on the Invoices tab.

### Charts (all computed client-side from `workspace.invoices`, no new backend aggregation)

1. **Revenue per month** — bar chart, sum of `amount` grouped by `createdAt`'s `YYYY-MM`, last
   12 months.
2. **Status breakdown** — donut chart, count and total Rupiah value per `status`
   (draft/sent/paid/overdue), reusing `INVST` for status colors/labels.
3. **Revenue per company** — horizontal bar chart, sum of `amount` grouped by `companyName`,
   top 8 by value (rest bucketed as "Other" if more than 8 distinct companies).
4. **Outstanding & overdue summary** — two stat cards (outstanding = sent+overdue total,
   overdue = overdue-only total, matching the existing `Sidebar.tsx` computation) plus a small
   trend line of outstanding total by month.

### Chart library

- Add `recharts` as a new frontend dependency.
- The project uses `@base-ui/react` (not Radix) for its existing primitives, so rather than
  running the `shadcn` CLI (which assumes Radix and would touch Tailwind config), hand-vendor a
  minimal `src/components/ui/chart.tsx` with a `ChartContainer`/`ChartTooltip`/`ChartLegend` API
  matching shadcn's chart component shape, styled with the project's existing `cn()` helper and
  Loom CSS tokens (`--loom-*` variables) instead of shadcn's default theme tokens. Each finance
  chart component (`RevenueByMonthChart`, `StatusBreakdownChart`, `RevenueByCompanyChart`,
  `OutstandingTrendChart`) wraps a `recharts` chart (`BarChart`/`PieChart`/`LineChart`) inside
  `ChartContainer`.
- New file `frontend/src/features/modules/finance/` holding the four chart components plus a
  `FinanceAnalysisTab.tsx` that lays them out in a grid.

## Out of scope

- Emailing or auto-sending generated recurring invoices (they land as `draft`).
- Server-side/SQL aggregation endpoints for the charts (invoice lists are already small enough
  to aggregate client-side, consistent with how `Sidebar.tsx` already computes outstanding/overdue).
- Editing a template to run more than once per month, or on a non-monthly cadence (weekly, etc).
- Exporting finance charts as images/PDF.
- Full `shadcn` CLI adoption project-wide — only the hand-vendored chart primitives are added.

## Testing plan

- **Backend**: `recurring_template_test.go` (CRUD, mirrors `company_test.go`) +
  `TestRunDueRecurringInvoicesGeneratesOnceThenSkipsSameMonth`,
  `TestRunDueRecurringInvoicesSkipsInactiveAndNotYetDue`,
  `TestRunDueRecurringInvoicesClampsDayOfMonthToShortMonths`. Run via
  `go build ./... && go vet ./... && go test ./...`.
- **Frontend**: `npm run typecheck && npm run build`; manual/Playwright verification of the tab
  bar, template create/edit/delete, and that the three chart components render with seeded
  invoice data.
