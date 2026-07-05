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
type AgentSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Installed   bool   `json:"installed"`
	ModelCount  int    `json:"modelCount"`
	SkillCount  int    `json:"skillCount"`
}
