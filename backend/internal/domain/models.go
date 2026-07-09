package domain

// TermLine is a single terminal-log line.
type TermLine struct {
	K string `json:"k"`
	T string `json:"t"`
}

// Worktree mirrors the frontend Worktree type.
type Worktree struct {
	ID        string     `json:"id"`
	Root      bool       `json:"root,omitempty"`
	Branch    string     `json:"branch"`
	Base      string     `json:"base"`
	Ahead     int        `json:"ahead"`
	Behind    int        `json:"behind"`
	Model     string     `json:"model"`
	Agent     string     `json:"agent"`
	State     string     `json:"state"`
	Task      string     `json:"task"`
	Tokens    int        `json:"tokens"`
	Elapsed   int        `json:"elapsed"`
	Added     int        `json:"added"`
	Removed   int        `json:"removed"`
	Files     int        `json:"files"`
	Lines     []TermLine `json:"lines"`
	Pending   *string    `json:"pending"`
	ProjectID string     `json:"-"` // internal use, not exposed to frontend
}

// Project mirrors the frontend Project type.
type Project struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Repo      string     `json:"repo"`
	Path      string     `json:"path"`
	Expanded  bool       `json:"expanded"`
	Worktrees []Worktree `json:"worktrees"`
	Issues    []Issue    `json:"issues"`
}

// Issue mirrors the frontend Issue type.
type Issue struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	Priority    string  `json:"priority"`
	Assignee    *string `json:"assignee"`
	Position    float64 `json:"position"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	ProjectID   string  `json:"-"` // internal use, not exposed to frontend — matches Worktree.ProjectID
}

// Attachment mirrors the frontend Attachment type. Raw file bytes are
// fetched separately via GET /api/attachments/{id}, not embedded here.
type Attachment struct {
	ID        string `json:"id"`
	IssueID   string `json:"issueId"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mimeType"`
	Size      int64  `json:"size"`
	CreatedAt string `json:"createdAt"`
}

// IssueComment mirrors the frontend IssueComment type — a comment on an
// issue's Activity timeline, or (when ParentID is set) a single-level-deep
// reply to another comment.
type IssueComment struct {
	ID        string  `json:"id"`
	IssueID   string  `json:"issueId"`
	ParentID  *string `json:"parentId"`
	Author    string  `json:"author"`
	Body      string  `json:"body"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

// IssueEvent mirrors the frontend IssueEvent type — a single Activity
// timeline entry auto-recorded when UpdateIssue changes a tracked field
// (status, priority, assignee). Read-only from the API: there's no
// create/update/delete endpoint, only ListIssueEvents.
type IssueEvent struct {
	ID        string  `json:"id"`
	IssueID   string  `json:"issueId"`
	Kind      string  `json:"kind"`
	FromValue *string `json:"fromValue"`
	ToValue   *string `json:"toValue"`
	CreatedAt string  `json:"createdAt"`
}

// NewsItem mirrors the frontend NewsItem type.
type NewsItem struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Title  string `json:"title"`
	Tag    string `json:"tag"`
	Time   string `json:"time"`
	Unread bool   `json:"unread"`
}

// Todo mirrors the frontend Todo type.
type Todo struct {
	ID       string `json:"id"`
	Text     string `json:"text"`
	Done     bool   `json:"done"`
	Priority string `json:"priority"`
}

// BankDetail holds the payee bank information printed on an invoice.
type BankDetail struct {
	BankName      string `json:"bankName"`
	AccountName   string `json:"accountName"`
	AccountNumber string `json:"accountNumber"`
}

// Company mirrors the frontend Company type — a reusable billing preset
// for the client being invoiced.
type Company struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ShortAddress string `json:"shortAddress"`
}

// Bank mirrors the frontend Bank type — a reusable payout-account preset
// used to prefill an invoice's payment-method section.
type Bank struct {
	ID            string `json:"id"`
	BankName      string `json:"bankName"`
	AccountName   string `json:"accountName"`
	AccountNumber string `json:"accountNumber"`
}

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

// Workspace mirrors the frontend Workspace type (full nested tree).
type Workspace struct {
	ID                 string                     `json:"id"`
	Name               string                     `json:"name"`
	Projects           []Project                  `json:"projects"`
	News               []NewsItem                 `json:"news"`
	Todos              []Todo                     `json:"todos"`
	Invoices           []Invoice                  `json:"invoices"`
	RecurringTemplates []RecurringInvoiceTemplate `json:"recurringTemplates"`
}

// Settings mirrors the frontend Settings type.
type Settings struct {
	ActiveWorkspaceID *string `json:"activeWorkspaceId"`
	DefaultModel      string  `json:"defaultModel"`
}

// Machine mirrors the frontend Machine type — a registered runtime machine
// in the hub's machine registry.
type Machine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
	// Key is the runtime's static API key. Deliberately serialized: the hub
	// distributes it to authenticated clients for direct-first connections
	// (spec: docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md).
	Key string `json:"key"`
}

// FsEntry describes a single directory entry returned by the filesystem browser.
type FsEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Git   bool   `json:"git"`
}

// User mirrors the frontend User type. Sensitive fields are tagged json:"-"
// and never serialize into an API response — same mechanism already used
// for Worktree.ProjectID / Issue.ProjectID.
type User struct {
	ID               string   `json:"id"`
	Email            string   `json:"email"`
	TotpEnabled      bool     `json:"totpEnabled"`
	CreatedAt        string   `json:"createdAt"`
	PasswordHash     string   `json:"-"`
	TotpSecretEnc    string   `json:"-"`
	BackupCodeHashes []string `json:"-"`
	FailedAttempts   int      `json:"-"`
	LockoutLevel     int      `json:"-"`
	LockedUntil      *string  `json:"-"`
	LastFailedAt     *string  `json:"-"`
}
