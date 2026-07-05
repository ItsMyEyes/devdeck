package service

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

var (
	integrationNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`)
	envKeyPattern          = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// AddMCPServerInput is the API-facing MCP configuration payload.
type AddMCPServerInput struct {
	Name      string            `json:"name"`
	Transport string            `json:"transport"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	URL       string            `json:"url"`
	Env       map[string]string `json:"env"`
}

// AgentService resolves agent, model, and skill information.
type AgentService struct {
	registry port.AgentRegistry
}

// NewAgentService creates an agent service backed by the given registry.
func NewAgentService(r port.AgentRegistry) *AgentService {
	return &AgentService{registry: r}
}

// ListAgents returns summaries of all available agents.
func (svc *AgentService) ListAgents() ([]domain.AgentSummary, error) {
	return svc.registry.ListAgents()
}

// GetAgent returns the full agent definition.
func (svc *AgentService) GetAgent(agentID string) (*domain.Agent, error) {
	return svc.registry.GetAgent(agentID)
}

// ListModels returns models available for a specific agent.
func (svc *AgentService) ListModels(agentID string) ([]domain.Model, error) {
	if agentID == "" {
		return nil, errors.New("agent id is required")
	}
	return svc.registry.ListModels(agentID)
}

// ListSkills returns skills available for a specific agent.
func (svc *AgentService) ListSkills(agentID string) ([]domain.Skill, error) {
	if agentID == "" {
		return nil, errors.New("agent id is required")
	}
	return svc.registry.ListSkills(agentID)
}

// InstallSkill installs an existing local skill into another installed agent.
func (svc *AgentService) InstallSkill(agentID, skillName string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	if !integrationNamePattern.MatchString(skillName) {
		return fmt.Errorf("invalid skill name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.InstallSkill(agentID, skillName))
}

// RemoveSkill removes a skill from one installed agent.
func (svc *AgentService) RemoveSkill(agentID, skillName string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	if !integrationNamePattern.MatchString(skillName) {
		return fmt.Errorf("invalid skill name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.RemoveSkill(agentID, skillName))
}

// ListMCPServers returns redacted MCP configuration for one installed agent.
func (svc *AgentService) ListMCPServers(agentID string) ([]domain.MCPServer, error) {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return nil, err
	}
	manager, err := svc.manager()
	if err != nil {
		return nil, err
	}
	servers, err := manager.ListMCPServers(agentID)
	return servers, mapManagementError(err)
}

// AddMCPServer validates and delegates MCP configuration to the local agent.
func (svc *AgentService) AddMCPServer(agentID string, input AddMCPServerInput) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Transport = strings.ToLower(strings.TrimSpace(input.Transport))
	input.Command = strings.TrimSpace(input.Command)
	input.URL = strings.TrimSpace(input.URL)
	if !integrationNamePattern.MatchString(input.Name) {
		return fmt.Errorf("invalid MCP server name: %w", ErrValidation)
	}
	if input.Transport != "stdio" && input.Transport != "http" {
		return fmt.Errorf("transport must be stdio or http: %w", ErrValidation)
	}
	if len(input.Args) > 64 {
		return fmt.Errorf("MCP server accepts at most 64 arguments: %w", ErrValidation)
	}
	for _, argument := range input.Args {
		if len(argument) > 4096 {
			return fmt.Errorf("MCP server argument is too long: %w", ErrValidation)
		}
	}
	if len(input.Env) > 64 {
		return fmt.Errorf("MCP server accepts at most 64 environment values: %w", ErrValidation)
	}
	for key, value := range input.Env {
		if !envKeyPattern.MatchString(key) || len(value) > 16<<10 {
			return fmt.Errorf("invalid MCP environment value for %q: %w", key, ErrValidation)
		}
	}
	if input.Transport == "stdio" {
		if input.Command == "" {
			return fmt.Errorf("command is required for stdio MCP servers: %w", ErrValidation)
		}
		input.URL = ""
	} else {
		parsed, err := url.Parse(input.URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return fmt.Errorf("a valid http or https URL is required: %w", ErrValidation)
		}
		input.Command = ""
		input.Args = nil
		input.Env = nil
	}

	manager, err := svc.manager()
	if err != nil {
		return err
	}
	err = manager.AddMCPServer(agentID, port.MCPServerInput{
		Name:      input.Name,
		Transport: input.Transport,
		Command:   input.Command,
		Args:      input.Args,
		URL:       input.URL,
		Env:       input.Env,
	})
	return mapManagementError(err)
}

// RemoveMCPServer removes one native MCP server configuration.
func (svc *AgentService) RemoveMCPServer(agentID, serverName string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	if !integrationNamePattern.MatchString(serverName) {
		return fmt.Errorf("invalid MCP server name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.RemoveMCPServer(agentID, serverName))
}

func (svc *AgentService) manager() (port.AgentManager, error) {
	manager, ok := svc.registry.(port.AgentManager)
	if !ok {
		return nil, fmt.Errorf("agent registry is read-only: %w", ErrValidation)
	}
	return manager, nil
}

func (svc *AgentService) validateManagedAgent(agentID string) error {
	if agentID == "" {
		return fmt.Errorf("agent id is required: %w", ErrValidation)
	}
	agent, err := svc.registry.GetAgent(agentID)
	if err != nil {
		return err
	}
	if agent == nil {
		return fmt.Errorf("agent not found: %w", ErrValidation)
	}
	if !agent.Installed {
		return fmt.Errorf("%s is not installed: %w", agent.Name, ErrValidation)
	}
	return nil
}

func mapManagementError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, port.ErrIntegrationConflict):
		return fmt.Errorf("%v: %w", err, ErrConflict)
	case errors.Is(err, port.ErrAgentManagementUnsupported),
		errors.Is(err, port.ErrIntegrationNotFound):
		return fmt.Errorf("%v: %w", err, ErrValidation)
	default:
		return err
	}
}
