# Invoices rebuild: companies, banks, line items, fixed issuer identity

## Problem

The current Invoices module (`InvoicesModule.tsx`, `invoiceDocument.ts`,
`domain.Invoice`) lets you free-type a "company" (from) and "client" (bill-to)
string and a single flat `amount` per invoice. Every invoice re-types the
issuer's identity and bank details from scratch, there's no reusable list of
billed companies or payout banks, and there's no line-item breakdown of work
performed — just one number.

## Goal

Rebuild the invoice around the user's actual freelance-invoicing workflow:

1. Pick (or inline-create) a **Company** being billed — reusable across
   invoices, with a short address.
2. Pick (or inline-create) a **Bank** to receive payment — reusable across
   invoices.
3. A fixed, non-editable **personal-details block** (the issuer's identity)
   appears on every invoice.
4. A **job-details table** (line items: description, quantity, unit price,
   computed total) replaces the single flat amount.
5. A **payment-method paragraph** is generated from the selected bank in a
   fixed Indonesian phrasing.
6. The printable/downloadable document and the invoice list are rebuilt
   around these fields.

Everything else about invoices (status tracking, due dates, per-invoice
download, the browse table) is unchanged.

## Data model

### New: `Company` (global, not scoped to a workspace)

```go
type Company struct {
    ID           string `json:"id"`
    Name         string `json:"name"`
    ShortAddress string `json:"shortAddress"`
}
```

### New: `Bank` (global, not scoped to a workspace)

```go
type Bank struct {
    ID            string `json:"id"`
    BankName      string `json:"bankName"`
    AccountName   string `json:"accountName"`
    AccountNumber string `json:"accountNumber"`
}
```

Both are simple standalone resources — no relation to `Workspace`. They exist
purely as pickable presets: selecting one **copies its values onto the
invoice** at create/edit time (the same denormalized-snapshot pattern already
used for bank fields on `Invoice` today). The invoice does **not** store a
`companyId`/`bankId` foreign key — this keeps issued invoices immutable if a
Company/Bank record is edited or deleted later, and avoids join logic.

CRUD: Create, List, Update, Delete for each (matches existing resource
conventions — Todo, News, etc.).

### Changed: `Invoice`

Drop `client` and `company` (free-text). Add:

```go
type InvoiceItem struct {
    Description string  `json:"description"`
    Quantity    float64 `json:"quantity"`
    UnitPrice   float64 `json:"unitPrice"`
}

type Invoice struct {
    ID              string        `json:"id"`
    Number          string        `json:"number"`
    CompanyName     string        `json:"companyName"`
    CompanyAddress  string        `json:"companyAddress"`
    Items           []InvoiceItem `json:"items"`
    Amount          float64       `json:"amount"` // derived: sum(qty * unitPrice), stored for list/sort
    Status          string        `json:"status"`
    CreatedAt       string        `json:"createdAt"`
    DueDate         string        `json:"dueDate"`
    BankName        string        `json:"bankName"`
    BankAccountName string        `json:"bankAccountName"`
    BankAccountNumber string      `json:"bankAccountNumber"`
}
```

`Amount` stays a stored, server-computed field (sum of item totals) so the
existing list-view totals ("N · total · outstanding") keep working without
recomputing from items on every read.

### Fixed personal details (issuer) — not persisted, not editable via UI

A constant in the frontend (`frontend/src/lib/issuer.ts`):

```ts
export const ISSUER = {
  name: 'Andi Syahruddin',
  title: 'Backend Enginer',
  location: 'Tangerang, Banten, Indonesia',
  email: 'iam@kiyora.dev',
  phone: '081382636662',
}
```

Rendered on the invoice document/preview and print export. Not a domain type
— it's presentation-only, single-user, hardcoded per the user's request.

## Schema changes (`backend/internal/store/db.go`)

```sql
CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  short_address TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS banks (
  id                  TEXT PRIMARY KEY,
  bank_name           TEXT NOT NULL DEFAULT '',
  account_name        TEXT NOT NULL DEFAULT '',
  account_number      TEXT NOT NULL DEFAULT ''
);
```

`invoices` table: replace `client`, `company` columns with `company_name`,
`company_address`; add `items_json TEXT NOT NULL DEFAULT '[]'`. Follow the
existing `migrateInvoiceColumns` pattern (`ALTER TABLE ... ADD COLUMN` guarded
by a `PRAGMA table_info` check) to add the new columns to any pre-existing
local `loom.db` without dropping data; the two obsolete columns are simply
left unused (SQLite can't drop columns without a rebuild, and this is a
single-user local dev database — not worth the complexity).

Items are stored as a JSON TEXT column (marshaled/unmarshaled in
`store/invoice.go`, same technique `worktrees.lines` already uses) rather
than a child table — items are always replaced wholesale with the invoice, so
there's no need for row-level item CRUD.

## API surface

New, global (not workspace-nested) resources, mirroring the existing
Todo/News handler/service/store layering:

```
GET    /api/companies
POST   /api/companies
PATCH  /api/companies/{id}
DELETE /api/companies/{id}

GET    /api/banks
POST   /api/banks
PATCH  /api/banks/{id}
DELETE /api/banks/{id}
```

`port.Store` gains:

```go
Companies() ([]domain.Company, error)
CreateCompany(name, shortAddress string) (domain.Company, error)
UpdateCompany(id string, p CompanyPatch) (domain.Company, error)
DeleteCompany(id string) error

Banks() ([]domain.Bank, error)
CreateBank(bankName, accountName, accountNumber string) (domain.Bank, error)
UpdateBank(id string, p BankPatch) (domain.Bank, error)
DeleteBank(id string) error
```

Existing invoice endpoints (`POST /api/workspaces/{wsId}/invoices`,
`PATCH /api/invoices/{id}`, `DELETE /api/invoices/{id}`) stay under their
workspace, with their request/response bodies updated for the new fields
(`companyName`, `companyAddress`, `items[]` instead of `client`, `company`,
`amount`).

## Frontend

- `frontend/src/lib/api.ts` / `features/data/queries.ts`: add
  `fetchCompanies`/`useCompanies`/`useCreateCompany`/`useUpdateCompany`/`useDeleteCompany`
  and the equivalent Bank set, following the existing `useTodos`-style
  query/mutation pairs. These are top-level queries (not nested under
  `useWorkspace`), invalidated independently of the workspace tree.
- New `frontend/src/features/modules/CompanyBankPicker.tsx` (or two small
  combobox components): a `<select>`-like control listing existing
  Companies/Banks plus an inline "+ new" affordance that opens a tiny form
  (name + short address, or bank name + account name + number), and on
  submit creates the record via the mutation and selects it immediately.
  No separate settings screen for v1.
- `InvoicesModule.tsx` draft form: replace the `company`/`client` text
  inputs with the Company picker; replace the single `amount` input with a
  dynamic line-items table (add/remove rows; No. auto-numbered; Kuantitas ×
  Harga Satuan → Total per row, read-only; grand total footer row bound to
  `draft.amount`); replace the bank text inputs with the Bank picker.
- `invoiceDocument.ts` (`buildInvoiceHtml`) and any in-app preview: rebuild
  around — header (invoice number + dates), `ISSUER` block ("From"),
  Company block ("Bill To": name + short address), items table with a total
  row, payment-method paragraph (bulleted bank detail using the fixed
  Indonesian template), and a closing signature line ("Hormat saya," +
  `ISSUER.name`).
- The existing browse table (past invoices: number/company/created/due/
  amount/status/actions) keeps its shape, swapping the `company` column to
  read `companyName`.

## Out of scope

- No settings page for managing/renaming/pruning Company or Bank lists —
  create-inline-from-the-invoice-form only. Deleting a stale Company/Bank
  preset can come later if the list gets unwieldy.
- No `companyId`/`bankId` foreign key on `Invoice` — snapshot-only, per the
  "why" above.
- Company/Bank are global across all workspaces, not per-workspace — the
  issuer only has one identity and one set of payout banks regardless of
  which client workspace an invoice is filed under.
- No PDF library — keeps the existing "downloadable HTML, print to PDF via
  browser" approach in `invoiceDocument.ts`.
- `News`/`Todos` deferred modules are untouched.

## Testing

- Store: `CreateCompany`/`CreateBank` round-trip; `CreateInvoice` persists
  and reloads `items` (JSON round-trip) and the new company/bank snapshot
  fields.
- Service/handler: 400 on empty `items` or a `PATCH` with malformed
  `items_json`; `handleStoreErr` mapping unchanged.
- Frontend: adding/removing line item rows recomputes the row total and
  grand total; picking a Company/Bank preset fills the form fields; creating
  a new Company/Bank inline persists it and it appears in the dropdown on
  next open; downloaded HTML contains the `ISSUER` block, items table, and
  payment-method paragraph with the selected bank's values substituted.
