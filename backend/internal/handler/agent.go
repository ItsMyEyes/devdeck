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
