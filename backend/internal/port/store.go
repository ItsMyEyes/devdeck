package port

import "loom/backend/internal/domain"

// Store is the data-access interface. All persistence operations go through this
// interface, making it possible to swap implementations (SQLite, Postgres, etc.)
// or inject mocks for testing.
type Store interface {
	// Settings
	Settings() (domain.Settings, error)
	UpdateSettings(p SettingsPatch) (domain.Settings, error)

	// Workspaces (returns full nested tree)
	Workspaces() ([]domain.Workspace, error)
	CreateWorkspace(name string) (domain.Workspace, error)
	UpdateWorkspace(id string, name *string) (domain.Workspace, error)
	DeleteWorkspace(id string) error

	// Projects
	CreateProject(wsID, name, path, repo string) (domain.Project, error)
	UpdateProject(id string, name, path, repo *string, expanded *bool) (domain.Project, error)
	DeleteProject(id string) error
	ProjectByID(id string) (domain.Project, error)

	// Worktrees
	CreateWorktree(projectID, mode, branch, base, model, agent, task string) (domain.Worktree, error)
	UpdateWorktree(id string, p WorktreePatch) (domain.Worktree, error)
	DeleteWorktree(id string) error
	WorktreeByID(id string) (domain.Worktree, error)

	// Todos
	CreateTodo(wsID, text, priority string) (domain.Todo, error)
	UpdateTodo(id string, p TodoPatch) (domain.Todo, error)
	DeleteTodo(id string) error
	ClearDoneTodos(wsID string) (int64, error)

	// Invoices
	CreateInvoice(wsID, number, companyName, companyAddress string, items []domain.InvoiceItem, dueDate, createdAt, status, bankName, bankAccountName, bankAccountNumber string) (domain.Invoice, error)
	UpdateInvoice(id string, p InvoicePatch) (domain.Invoice, error)
	DeleteInvoice(id string) error

	// Companies (global billing presets, not scoped to a workspace)
	Companies() ([]domain.Company, error)
	CreateCompany(name, shortAddress string) (domain.Company, error)
	UpdateCompany(id string, p CompanyPatch) (domain.Company, error)
	DeleteCompany(id string) error

	// Banks (global payout-account presets, not scoped to a workspace)
	Banks() ([]domain.Bank, error)
	CreateBank(bankName, accountName, accountNumber string) (domain.Bank, error)
	UpdateBank(id string, p BankPatch) (domain.Bank, error)
	DeleteBank(id string) error

	// News
	CreateNews(wsID, source, title, tag, time string, unread bool) (domain.NewsItem, error)
	UpdateNews(id string, p NewsPatch) (domain.NewsItem, error)
	MarkAllNewsRead(wsID string) (int64, error)
	DeleteNews(id string) error

	// Seed — wipes all data and inserts demo dataset.
	Seed() ([]domain.Workspace, error)
}

// SettingsPatch carries optional fields for a partial settings update.
type SettingsPatch struct {
	ActiveWorkspaceID *string
	DefaultModel      *string
	HasActive         bool // true when the JSON key was present (allows explicit null)
}

// WorktreePatch carries optional fields for a partial worktree update.
type WorktreePatch struct {
	Branch     *string
	Base       *string
	Model      *string
	Task       *string
	State      *string
	Pending    *string
	Ahead      *int
	Behind     *int
	Tokens     *int
	Elapsed    *int
	Added      *int
	Removed    *int
	Files      *int
	AppendLine *domain.TermLine
	HasPending bool // true when the JSON key "pending" was present
}

// TodoPatch carries optional fields for a partial todo update.
type TodoPatch struct {
	Text     *string
	Done     *bool
	Priority *string
}

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

// CompanyPatch carries optional fields for a partial company update.
type CompanyPatch struct {
	Name         *string
	ShortAddress *string
}

// BankPatch carries optional fields for a partial bank update.
type BankPatch struct {
	BankName      *string
	AccountName   *string
	AccountNumber *string
}

// NewsPatch carries optional fields for a partial news update.
type NewsPatch struct {
	Unread *bool
}
