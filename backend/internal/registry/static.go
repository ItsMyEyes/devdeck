package registry

import (
	"loom/backend/internal/domain"
)

// StaticRegistry implements port.AgentRegistry with built-in agent definitions.
type StaticRegistry struct {
	agents map[string]domain.Agent
}

// NewStaticRegistry creates a static registry with all known agents.
func NewStaticRegistry() *StaticRegistry {
	agents := map[string]domain.Agent{
		"claude": {
			ID:          "claude",
			Name:        "Claude Code",
			Description: "Anthropic's AI coding agent — deep reasoning, large context, tool-rich",
			Icon:        "claude",
			Models: []domain.Model{
				{ID: "claude-sonnet-5", Name: "Sonnet 5", ContextWindow: 200000},
				{ID: "claude-opus-4-8", Name: "Opus 4.8", ContextWindow: 200000},
				{ID: "claude-opus-4-7", Name: "Opus 4.7", ContextWindow: 200000},
				{ID: "claude-haiku-4-5", Name: "Haiku 4.5", ContextWindow: 200000},
				{ID: "claude-fable-5", Name: "Fable 5", ContextWindow: 200000},
			},
			Skills: []domain.Skill{
				{Name: "code-review", Description: "Review code for bugs, style, and security", Category: "analysis"},
				{Name: "refactor", Description: "Refactor code for clarity and maintainability", Category: "editing"},
				{Name: "debug", Description: "Systematically find and fix bugs", Category: "analysis"},
				{Name: "test-write", Description: "Write comprehensive unit and integration tests", Category: "testing"},
				{Name: "explain", Description: "Explain how code works in plain language", Category: "analysis"},
				{Name: "plan-architecture", Description: "Design system architecture and component boundaries", Category: "design"},
				{Name: "migrate", Description: "Perform large-scale code migrations", Category: "editing"},
				{Name: "document", Description: "Generate API docs, READMEs, and inline comments", Category: "documentation"},
			},
		},
		"codex": {
			ID:          "codex",
			Name:        "Codex",
			Description: "OpenAI's coding agent — fast, broad ecosystem knowledge, strong at generation",
			Icon:        "codex",
			Models: []domain.Model{
				{ID: "gpt-5", Name: "GPT-5", ContextWindow: 128000},
				{ID: "gpt-5.4", Name: "GPT-5.4", ContextWindow: 128000},
				{ID: "gpt-5.5", Name: "GPT-5.5", ContextWindow: 200000},
				{ID: "o4-mini", Name: "o4-mini", ContextWindow: 200000},
				{ID: "o3", Name: "o3", ContextWindow: 200000},
			},
			Skills: []domain.Skill{
				{Name: "code-review", Description: "Review code for bugs and optimizations", Category: "analysis"},
				{Name: "refactor", Description: "Refactor for performance and readability", Category: "editing"},
				{Name: "generate", Description: "Generate new code from specifications", Category: "editing"},
				{Name: "test-write", Description: "Write and maintain test suites", Category: "testing"},
				{Name: "debug", Description: "Debug with stack traces and logs", Category: "analysis"},
				{Name: "api-design", Description: "Design REST and GraphQL APIs", Category: "design"},
			},
		},
		"pi": {
			ID:          "pi",
			Name:        "Pi",
			Description: "Gemini-powered agent with 1M+ context window and multimodal understanding",
			Icon:        "pi",
			Models: []domain.Model{
				{ID: "gemini-2.5-pro", Name: "Gemini 2.5 Pro", ContextWindow: 1000000},
				{ID: "gemini-2.5-flash", Name: "Gemini 2.5 Flash", ContextWindow: 1000000},
				{ID: "gemini-3-pro", Name: "Gemini 3 Pro", ContextWindow: 2000000},
				{ID: "gemini-3-flash", Name: "Gemini 3 Flash", ContextWindow: 1000000},
			},
			Skills: []domain.Skill{
				{Name: "code-review", Description: "Comprehensive code analysis with deep context", Category: "analysis"},
				{Name: "refactor", Description: "Large-scale refactoring across many files", Category: "editing"},
				{Name: "analyze-codebase", Description: "Understand and map entire codebases", Category: "analysis"},
				{Name: "test-write", Description: "Generate comprehensive test coverage", Category: "testing"},
				{Name: "design-review", Description: "Architectural design review and recommendations", Category: "design"},
				{Name: "multimodal", Description: "Analyze screenshots, diagrams, and UI mockups", Category: "analysis"},
			},
		},
		"opencode": {
			ID:          "opencode",
			Name:        "OpenCode",
			Description: "Open-source agent runner — local-first, multi-model, extensible",
			Icon:        "opencode",
			Models: []domain.Model{
				{ID: "claude-sonnet-5", Name: "Sonnet 5 (via OpenCode)", ContextWindow: 200000},
				{ID: "gpt-5", Name: "GPT-5 (via OpenCode)", ContextWindow: 128000},
			},
			Skills: []domain.Skill{
				{Name: "code-review", Description: "Review code for issues", Category: "analysis"},
				{Name: "refactor", Description: "Apply automated refactoring", Category: "editing"},
			},
		},
		"gemini": {
			ID:          "gemini",
			Name:        "Gemini CLI",
			Description: "Google's official Gemini CLI — direct access to Gemini models",
			Icon:        "gemini",
			Models: []domain.Model{
				{ID: "gemini-2.5-pro", Name: "Gemini 2.5 Pro", ContextWindow: 1000000},
				{ID: "gemini-2.5-flash", Name: "Gemini 2.5 Flash", ContextWindow: 1000000},
			},
			Skills: []domain.Skill{
				{Name: "code-review", Description: "Review code with large context", Category: "analysis"},
			},
		},
	}
	return &StaticRegistry{agents: agents}
}

// ListAgents returns all agent summaries.
func (r *StaticRegistry) ListAgents() ([]domain.AgentSummary, error) {
	out := make([]domain.AgentSummary, 0, len(r.agents))
	for _, a := range r.agents {
		out = append(out, domain.AgentSummary{
			ID:          a.ID,
			Name:        a.Name,
			Description: a.Description,
			Icon:        a.Icon,
			ModelCount:  len(a.Models),
			SkillCount:  len(a.Skills),
		})
	}
	return out, nil
}

// GetAgent returns the full agent definition.
func (r *StaticRegistry) GetAgent(agentID string) (*domain.Agent, error) {
	a, ok := r.agents[agentID]
	if !ok {
		return nil, nil
	}
	return &a, nil
}

// ListModels returns models for an agent.
func (r *StaticRegistry) ListModels(agentID string) ([]domain.Model, error) {
	a, ok := r.agents[agentID]
	if !ok {
		return nil, nil
	}
	return a.Models, nil
}

// ListSkills returns skills for an agent.
func (r *StaticRegistry) ListSkills(agentID string) ([]domain.Skill, error) {
	a, ok := r.agents[agentID]
	if !ok {
		return nil, nil
	}
	return a.Skills, nil
}
