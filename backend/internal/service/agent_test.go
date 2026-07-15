package service

import (
	"errors"
	"testing"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

type skillContentRegistry struct {
	port.AgentManager
	agent     *domain.Agent
	content   string
	readOnly  bool
	linked    bool
	readErr   error
	writeErr  error
	written   string
	writeName string
}

func (r *skillContentRegistry) ListAgents() ([]domain.AgentSummary, error) { return nil, nil }

func (r *skillContentRegistry) GetAgent(agentID string) (*domain.Agent, error) {
	if r.agent == nil || r.agent.ID != agentID {
		return nil, nil
	}
	copy := *r.agent
	return &copy, nil
}

func (r *skillContentRegistry) ListModels(string) ([]domain.Model, error) { return nil, nil }

func (r *skillContentRegistry) ListSkills(string) ([]domain.Skill, error) { return nil, nil }

func (r *skillContentRegistry) ReadSkillContent(string, string) (string, bool, bool, error) {
	return r.content, r.readOnly, r.linked, r.readErr
}

func (r *skillContentRegistry) WriteSkillContent(_ string, skillName, content string) error {
	r.writeName = skillName
	r.written = content
	return r.writeErr
}

func TestAgentServiceSkillContent(t *testing.T) {
	registry := &skillContentRegistry{
		agent:    &domain.Agent{ID: "claude", Name: "Claude", Installed: true},
		content:  "---\nname: demo\n---\n",
		readOnly: false,
		linked:   true,
	}
	svc := NewAgentService(registry)

	got, err := svc.GetSkillContent("claude", "demo")
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != "SKILL.md" || got.Content != registry.content || got.ReadOnly || !got.Linked {
		t.Fatalf("GetSkillContent = %#v", got)
	}

	updated := "---\nname: demo\n---\n\nUpdated.\n"
	if err := svc.UpdateSkillContent("claude", "demo", updated); err != nil {
		t.Fatal(err)
	}
	if registry.writeName != "demo" || registry.written != updated {
		t.Fatalf("write = (%q, %q)", registry.writeName, registry.written)
	}
}

func TestAgentServiceSkillContentValidation(t *testing.T) {
	t.Run("requires installed agent", func(t *testing.T) {
		registry := &skillContentRegistry{
			agent: &domain.Agent{ID: "claude", Name: "Claude", Installed: false},
		}
		_, err := NewAgentService(registry).GetSkillContent("claude", "demo")
		if !errors.Is(err, ErrValidation) {
			t.Fatalf("GetSkillContent error = %v, want validation", err)
		}
	})

	t.Run("rejects invalid skill name", func(t *testing.T) {
		registry := &skillContentRegistry{
			agent: &domain.Agent{ID: "claude", Name: "Claude", Installed: true},
		}
		err := NewAgentService(registry).UpdateSkillContent("claude", "../demo", "content")
		if !errors.Is(err, ErrValidation) {
			t.Fatalf("UpdateSkillContent error = %v, want validation", err)
		}
	})
}

func TestAgentServiceSkillContentMapsManagementErrors(t *testing.T) {
	t.Run("read conflict", func(t *testing.T) {
		registry := &skillContentRegistry{
			agent:   &domain.Agent{ID: "claude", Name: "Claude", Installed: true},
			readErr: port.ErrIntegrationConflict,
		}
		_, err := NewAgentService(registry).GetSkillContent("claude", "demo")
		if !errors.Is(err, ErrConflict) {
			t.Fatalf("GetSkillContent error = %v, want conflict", err)
		}
	})

	t.Run("write missing skill", func(t *testing.T) {
		registry := &skillContentRegistry{
			agent:    &domain.Agent{ID: "claude", Name: "Claude", Installed: true},
			writeErr: port.ErrIntegrationNotFound,
		}
		err := NewAgentService(registry).UpdateSkillContent("claude", "demo", "content")
		if !errors.Is(err, ErrValidation) {
			t.Fatalf("UpdateSkillContent error = %v, want validation", err)
		}
	})
}
