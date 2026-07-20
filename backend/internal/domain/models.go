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
	Path      string     `json:"-"`
}

// Project mirrors the frontend Project type.
type Project struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Repo     string `json:"repo"`
	Path     string `json:"path"`
	Expanded bool   `json:"expanded"`
	// MachineID links the project to a registered runtime machine (hub
	// registry). Empty string = local/unassigned; existing rows default to it.
	MachineID string `json:"machineId"`
	// WorkspaceID is the owning workspace. Populated by machine-scoped reads
	// (store.ProjectsByMachine) that ship Project rows flattened outside a
	// Workspace tree, e.g. in CatalogSnapshot; the pre-existing workspace-tree
	// reads (Workspaces/ProjectByID) leave it unset since the parent is
	// already implied by nesting there.
	WorkspaceID string     `json:"workspaceId"`
	Worktrees   []Worktree `json:"worktrees"`
	Issues      []Issue    `json:"issues"`
	// Origin distinguishes a runtime-replica row synced from the hub ("hub")
	// from one created locally while the hub was unreachable ("local").
	// Only meaningful on a runtime; the hub's own projects are always "hub"
	// and never read this field.
	Origin string `json:"origin"`
	// SyncError is set when this runtime's most recent replay attempt for a
	// origin="local" project failed permanently (its workspace no longer
	// exists on the hub). Nil means either already synced, or not yet
	// attempted, or the last attempt failed only transiently.
	SyncError *string `json:"syncError,omitempty"`
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

// CatalogSnapshot is one runtime's slice of the hub's catalog: every
// workspace (they are the grouping), but only the projects and SSH
// connections bound to that machine. Rows for other machines are never
// included — not merely hidden.
type CatalogSnapshot struct {
	Workspaces     []Workspace     `json:"workspaces"`
	Projects       []Project       `json:"projects"`
	SSHConnections []SSHConnection `json:"sshConnections"`
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
	// IsLocal marks the Tauri desktop shell's self-registered embedded
	// runtime. The hub UI protects this entry from edit/delete since it's
	// managed automatically by the desktop app's own lifecycle, not the
	// operator, and auto-selects it as the default machine.
	IsLocal bool `json:"isLocal"`
}

// SSHConnection is a saved connection to an arbitrary external SSH host —
// a separate concept from Machine (an already-running DevDeck runtime trusted
// via a shared key). Mirrors the frontend SSHConnection type. Credentials
// live in SSHSecret rows, never on this struct.
type SSHConnection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Group    string `json:"group"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	// AuthType is "password" or "privatekey".
	AuthType string `json:"authType"`
	// JumpConnectionID chains to another SSHConnection for bastion hops.
	// Stored since phase 1 so the schema never needs reworking, but only
	// used once jump-host chaining ships (build-order phase 3).
	JumpConnectionID *string `json:"jumpConnectionId"`
	// ExecutorMachineID selects which Machine dials this host; nil = the
	// hub itself. Phase 1 always executes on the hub regardless — routing
	// ships with a later phase.
	ExecutorMachineID *string `json:"executorMachineId"`
	// HostKeyFingerprint is the TOFU-pinned SHA256 host-key fingerprint,
	// set on the first successful connect; later mismatches hard-block.
	HostKeyFingerprint *string `json:"hostKeyFingerprint"`
}

// SSHSecret is one encrypted credential for an SSHConnection. Every field
// is json:"-": unlike Machine.Key (deliberately distributed to clients),
// SSH credentials never serialize into any API response.
type SSHSecret struct {
	ConnectionID string  `json:"-"`
	Kind         string  `json:"-"` // "password" | "privatekey" | "passphrase"
	StorageKind  string  `json:"-"` // "db" today; "keychain" arrives with the Tauri phase
	CipherText   string  `json:"-"` // base64 "nonce||ciphertext" (AES-256-GCM)
	KeychainRef  *string `json:"-"`
}

// DBConnection is a saved connection to an external SQL database — the
// registry behind the Database module. Credentials live in DBSecret rows,
// never on this struct, exactly like SSHConnection/SSHSecret.
type DBConnection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Group    string `json:"group"`
	Engine   string `json:"engine"`   // "postgres" | "mysql" | "sqlite"
	Host     string `json:"host"`     // ignored for sqlite
	Port     int    `json:"port"`     // ignored for sqlite
	Username string `json:"username"` // ignored for sqlite
	Database string `json:"database"` // initial database; for sqlite: file path
	SSLMode  string `json:"sslMode"`

	// ExecutorMachineID selects which Machine dials this database;
	// nil = the hub itself.
	ExecutorMachineID *string `json:"executorMachineId"`
	// TunnelConnectionID references an SSHConnection used as a tunnel;
	// nil = direct connection.
	TunnelConnectionID *string `json:"tunnelConnectionId"`
	// IsProduction colors the tab, forces extra confirmation on commits and
	// DDL, and rejects unverified TLS modes. An error-reduction affordance,
	// NOT a security control — the operator holds full credentials either way.
	IsProduction bool `json:"isProduction"`
	// ServerCertFingerprint is a TOFU-pinned SHA256 fingerprint of the database
	// server's TLS certificate, for private CAs. Mirrors
	// SSHConnection.HostKeyFingerprint: set on first connect, mismatch blocks.
	ServerCertFingerprint *string `json:"serverCertFingerprint"`
}

// DBSecret is one encrypted credential for a DBConnection. Every field is
// json:"-": these never serialize into any API response.
type DBSecret struct {
	ConnectionID string  `json:"-"`
	Kind         string  `json:"-"` // "password" | "ca_cert" | "client_cert" | "client_key"
	StorageKind  string  `json:"-"` // "db" today; "keychain" with the Tauri phase
	CipherText   string  `json:"-"` // base64 "nonce||ciphertext" (AES-256-GCM)
	KeychainRef  *string `json:"-"`
}

// DBSavedQuery is a named SQL snippet attached to a connection — the
// "Queries" node in the object tree.
type DBSavedQuery struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	Name         string `json:"name"`
	SQL          string `json:"sql"`
	UpdatedAt    string `json:"updatedAt"`
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
