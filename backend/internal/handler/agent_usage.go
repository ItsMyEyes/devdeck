package handler

import (
	"devdeck/backend/internal/usage"
	"net/http"
)

func (h *AgentHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("agentId")
	if provider != "claude" && provider != "codex" && provider != "antigravity" {
		writeErr(w, http.StatusBadRequest, "unsupported agent")
		return
	}
	writeJSON(w, http.StatusOK, usage.Read(r.Context(), provider))
}
