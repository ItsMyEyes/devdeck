package handler

import (
	"net/http"

	"loom/backend/internal/service"
)

// AgentHandler handles agent/skill/model listing endpoints.
type AgentHandler struct {
	svc *service.AgentService
}

// NewAgentHandler creates an agent handler.
func NewAgentHandler(svc *service.AgentService) *AgentHandler {
	return &AgentHandler{svc: svc}
}

// ListAgents returns summaries of all available agent types.
func (h *AgentHandler) ListAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := h.svc.ListAgents()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

// GetAgent returns the full agent definition with models and skills.
func (h *AgentHandler) GetAgent(w http.ResponseWriter, r *http.Request) {
	agent, err := h.svc.GetAgent(r.PathValue("agentId"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if agent == nil {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	writeJSON(w, http.StatusOK, agent)
}

// ListModels returns models available for a specific agent.
func (h *AgentHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	models, err := h.svc.ListModels(r.PathValue("agentId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, models)
}

// ListSkills returns skills available for a specific agent.
func (h *AgentHandler) ListSkills(w http.ResponseWriter, r *http.Request) {
	skills, err := h.svc.ListSkills(r.PathValue("agentId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, skills)
}

// InstallSkill installs an existing local skill into one agent.
func (h *AgentHandler) InstallSkill(w http.ResponseWriter, r *http.Request) {
	err := h.svc.InstallSkill(r.PathValue("agentId"), r.PathValue("skillName"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveSkill removes a skill from one agent.
func (h *AgentHandler) RemoveSkill(w http.ResponseWriter, r *http.Request) {
	err := h.svc.RemoveSkill(r.PathValue("agentId"), r.PathValue("skillName"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListMCPServers returns redacted native MCP configuration for one agent.
func (h *AgentHandler) ListMCPServers(w http.ResponseWriter, r *http.Request) {
	servers, err := h.svc.ListMCPServers(r.PathValue("agentId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, servers)
}

// AddMCPServer configures an MCP server through the native agent CLI.
func (h *AgentHandler) AddMCPServer(w http.ResponseWriter, r *http.Request) {
	var body service.AddMCPServerInput
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := h.svc.AddMCPServer(r.PathValue("agentId"), body); handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveMCPServer removes an MCP server through the native agent CLI.
func (h *AgentHandler) RemoveMCPServer(w http.ResponseWriter, r *http.Request) {
	err := h.svc.RemoveMCPServer(r.PathValue("agentId"), r.PathValue("serverName"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
