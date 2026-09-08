package domain

// Agent represents a supported coding agent type.
type Agent struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Icon        string  `json:"icon"`
	Installed   bool    `json:"installed"`
	Models      []Model `json:"models"`
	Skills      []Skill `json:"skills"`
}

// Model represents an AI model available for a specific agent.
type Model struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ContextWindow int    `json:"contextWindow"`
}

// Skill represents a capability or specialization an agent can use.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	ReadOnly    bool   `json:"readOnly"`
}

// MCPServer is a redacted MCP server configuration discovered from an agent.
// Environment values are never exposed through the API.
type MCPServer struct {
	Name      string   `json:"name"`
	AgentID   string   `json:"agentId"`
	Transport string   `json:"transport"`
	Target    string   `json:"target"`
	ArgCount  int      `json:"argCount"`
	EnvKeys   []string `json:"envKeys"`
	Enabled   bool     `json:"enabled"`
	Status    string   `json:"status"`
}

// AgentSummary is a lightweight agent listing (no nested models/skills).
//
// Version, BinaryPath, and Detail come from a per-machine CLI probe (see
// AgentService.ListAgents): Version and BinaryPath describe what is actually
// installed on THIS process's machine, and Detail explains why an agent is
// unavailable when Installed is false. A missing binary is a status the chat
// header renders (disabled entry + tooltip), not an entry the list omits —
// the runtime a worktree lives on is not necessarily the hub the operator's
// browser talks to, so this must reflect the runtime's own probe, never a
// cached hub-side assumption.
type AgentSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Installed   bool   `json:"installed"`
	ModelCount  int    `json:"modelCount"`
	SkillCount  int    `json:"skillCount"`
	Version     string `json:"version,omitempty"`
	BinaryPath  string `json:"binaryPath,omitempty"`
	Detail      string `json:"detail,omitempty"`
}

// EnvProfile is a saved LLM-provider profile: the `env` block of an agent's
// settings.json (Claude → ~/.claude/ , Codex → ~/.codex/).
// This is the on-disk / internal form: AuthToken is present so the profile
// persists to disk, but it is never returned by the API (callers serialize
// via EnvProfileSummary). The 8 ANTHROPIC_* env keys form the default schema
// for Claude profiles — always present, non-deletable; ExtraEnv holds custom keys.
// Codex profiles use Models["model"] for the model name and Codex* fields for
// provider config; activation writes config.toml + auth.json instead of the env block.
type EnvProfile struct {
	ID        string            `json:"id"`
	AgentID   string            `json:"agentId"`
	Name      string            `json:"name"`
	BaseURL   string            `json:"baseUrl"`
	AuthToken string            `json:"authToken"`
	Models    map[string]string `json:"models"`   // claude: opus/sonnet/haiku -> model id; codex: "model" -> model name
	ExtraEnv  map[string]string `json:"extraEnv"` // custom keys beyond the defaults

	// Codex-specific provider config (ignored for Claude)
	CodexProviderName  string `json:"codexProviderName,omitempty"`
	CodexWireAPI       string `json:"codexWireAPI,omitempty"`       // "chat" (default) or "responses"
	CodexEnvKey        string `json:"codexEnvKey,omitempty"`        // e.g. "OPENAI_API_KEY"
	CodexContextWindow int    `json:"codexContextWindow,omitempty"` // 0 = unset
	CodexMaxTokens     int    `json:"codexMaxTokens,omitempty"`

	Active    bool   `json:"active"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// EnvProfileSummary is the redacted API view of an EnvProfile: the auth token
// is exposed only as HasToken (the sole designated secret). Custom ExtraEnv
// values are returned in full so the operator can edit them — they are the
// operator's own local provider config, not credentials.
type EnvProfileSummary struct {
	ID        string            `json:"id"`
	AgentID   string            `json:"agentId"`
	Name      string            `json:"name"`
	BaseURL   string            `json:"baseUrl"`
	HasToken  bool              `json:"hasToken"`
	Models    map[string]string `json:"models"`
	ExtraEnv  map[string]string `json:"extraEnv"`

	// Codex-specific (see EnvProfile for docs)
	CodexProviderName  string `json:"codexProviderName,omitempty"`
	CodexWireAPI       string `json:"codexWireAPI,omitempty"`
	CodexEnvKey        string `json:"codexEnvKey,omitempty"`
	CodexContextWindow int    `json:"codexContextWindow,omitempty"`
	CodexMaxTokens     int    `json:"codexMaxTokens,omitempty"`

	Active    bool   `json:"active"`
	UpdatedAt string `json:"updatedAt"`
}

// EnvModelOption is a single model id advertised by a provider's model catalog.
type EnvModelOption struct {
	ID string `json:"id"`
}

// AgentSettingsFile is an agent CLI's own configuration file, returned for
// direct editing. Every installed agent has one, unlike EnvProfile — see
// detect/settingsfile.go for where each agent keeps it.
type AgentSettingsFile struct {
	// Path is ~-shortened for display; the absolute path stays on the machine.
	Path string `json:"path"`
	// Syntax is the editor language: "json", "jsonc" or "toml".
	Syntax string `json:"syntax"`
	// Content is the file's raw text, or the empty default for its format when
	// the agent has not written one yet.
	Content string `json:"content"`
}

// AgentThread is a chat thread's read-model row for the sessions sidebar —
// title, status, and recency without replaying the thread's whole event log.
// Written by store.CommitAgentEvents when it commits an EvtThreadCreated
// event (a projection into a read table, inside the same transaction as the
// append), and touched again (UpdatedAt only) on every later commit for the
// thread. CreatedAt/UpdatedAt are epoch milliseconds, matching
// orchestration.Event.CreatedAt — the source these are derived from.
type AgentThread struct {
	ID         string `json:"id"`
	WorktreeID string `json:"worktreeId"`
	InstanceID string `json:"instanceId"`
	Title      string `json:"title"`
	AgentID    string `json:"agentId"`
	Model      string `json:"model"`
	Status     string `json:"status"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
	// PlanReady mirrors the engine's live Thread.ProposedPlan != nil, the
	// same overlay pattern Status already gets from withLiveStatus. There is
	// no SQL column behind it — a stored copy of a rule the projector owns
	// would be a second implementation to keep in step (see withLiveStatus's
	// doc comment). Zero value (false) is exactly right for a thread the
	// engine has never heard of: "no live state" and "no plan on the table"
	// mean the same thing here.
	PlanReady bool `json:"planReady"`
}
