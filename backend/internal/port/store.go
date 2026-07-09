package port

import (
	"time"

	"loom/backend/internal/domain"
)

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
	CreateProject(wsID, name, path, repo, machineID string) (domain.Project, error)
	UpdateProject(id string, name, path, repo, machineID *string, expanded *bool) (domain.Project, error)
	DeleteProject(id string) error
	ProjectByID(id string) (domain.Project, error)

	// Worktrees
	CreateWorktree(projectID, mode, branch, base, model, agent, task string) (domain.Worktree, error)
	UpdateWorktree(id string, p WorktreePatch) (domain.Worktree, error)
	DeleteWorktree(id string) error
	WorktreeByID(id string) (domain.Worktree, error)

	// Issues
	CreateIssue(projectID, title, status, createdAt string) (domain.Issue, error)
	UpdateIssue(id, updatedAt string, p IssuePatch) (domain.Issue, error)
	DeleteIssue(id string) error

	// Attachments (files uploaded from an issue's description editor)
	CreateAttachment(issueID, filename, mimeType string, data []byte, createdAt string) (domain.Attachment, error)
	ListAttachments(issueID string) ([]domain.Attachment, error)
	AttachmentData(id string) (domain.Attachment, []byte, error)
	DeleteAttachment(id string) error

	// Issue comments (top-level, or a reply when parentID is set)
	CreateIssueComment(issueID string, parentID *string, author, body, createdAt string) (domain.IssueComment, error)
	ListIssueComments(issueID string) ([]domain.IssueComment, error)
	UpdateIssueComment(id, updatedAt, body string) (domain.IssueComment, error)
	DeleteIssueComment(id string) error

	// Issue timeline — auto-recorded field-change events, read-only from the API.
	ListIssueEvents(issueID string) ([]domain.IssueEvent, error)

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

	// Machines (runtime registry, hub role only)
	Machines() ([]domain.Machine, error)
	CreateMachine(name, url, key string) (domain.Machine, error)
	UpdateMachine(id string, p MachinePatch) (domain.Machine, error)
	DeleteMachine(id string) error
	MachineByID(id string) (domain.Machine, error)

	// Recurring invoice templates (workspace-scoped; auto-generate draft Invoices on schedule)
	CreateRecurringTemplate(wsID, companyName, companyAddress string, items []domain.InvoiceItem, bankName, bankAccountName, bankAccountNumber string, dayOfMonth, paymentTermDays int, createdAt string) (domain.RecurringInvoiceTemplate, error)
	UpdateRecurringTemplate(id string, p RecurringTemplatePatch) (domain.RecurringInvoiceTemplate, error)
	DeleteRecurringTemplate(id string) error
	RunDueRecurringInvoices() ([]domain.Invoice, error)

	// News
	CreateNews(wsID, source, title, tag, time string, unread bool) (domain.NewsItem, error)
	UpdateNews(id string, p NewsPatch) (domain.NewsItem, error)
	MarkAllNewsRead(wsID string) (int64, error)
	DeleteNews(id string) error

	// Seed — wipes all data and inserts demo dataset.
	Seed() ([]domain.Workspace, error)

	// Users (single-operator: at most one row ever exists)
	CreateUser(email, passwordHash, createdAt string) (domain.User, error)
	UserByEmail(email string) (domain.User, error)
	UserByID(id string) (domain.User, error)
	UserCount() (int, error)
	UpdateUser(id string, p UserPatch) (domain.User, error)

	// Sessions and pending (post-password, pre-TOTP) logins
	CreateSession(userID, tokenHash string, expiresAt time.Time) error
	SessionUserID(tokenHash string, now time.Time) (string, error)
	DeleteSession(tokenHash string) error
	CreatePendingLogin(userID, tokenHash string, expiresAt time.Time) error
	PendingLoginUserID(tokenHash string, now time.Time) (string, error)
	DeletePendingLogin(tokenHash string) error
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

// MachinePatch carries optional fields for a partial machine update.
type MachinePatch struct {
	Name *string
	URL  *string
	Key  *string
}

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

// NewsPatch carries optional fields for a partial news update.
type NewsPatch struct {
	Unread *bool
}

// IssuePatch carries optional fields for a partial issue update.
type IssuePatch struct {
	Title       *string
	Description *string
	Status      *string
	Priority    *string
	Position    *float64
	Assignee    *string
	HasAssignee bool // true when the JSON key "assignee" was present (allows explicit null)
}

// UserPatch carries optional fields for a partial user update.
type UserPatch struct {
	TotpSecretEnc    *string
	TotpEnabled      *bool
	BackupCodeHashes *[]string
	FailedAttempts   *int
	LockoutLevel     *int
	LockedUntil      *string
	HasLockedUntil   bool // true when the "lockedUntil" field was explicitly set (allows clearing to null)
	LastFailedAt     *string
}
