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
