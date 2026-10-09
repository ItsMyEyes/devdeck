package handler

import (
	"net/http"
	"sort"
	"time"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/store"
)

// GetWorkspaceOverview is read-only: it never attaches sockets or starts sessions.
func (h *AgentThreadHandler) GetWorkspaceOverview(w http.ResponseWriter, r *http.Request) {
	wsID := r.URL.Query().Get("workspaceId")
	if wsID == "" {
		writeErr(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	spaces, err := h.store.Workspaces()
	if handleStoreErr(w, err) {
		return
	}
	var workspace *domain.Workspace
	for i := range spaces {
		if spaces[i].ID == wsID {
			workspace = &spaces[i]
			break
		}
	}
	if workspace == nil {
		handleStoreErr(w, store.ErrNotFound)
		return
	}
	out := domain.OfficeOverview{WorkspaceID: wsID, SampledAt: time.Now().UnixMilli(), Sessions: []domain.OfficeSession{}}
	state := orchestration.NewState()
	if h.engine != nil {
		state = h.engine.State()
	}
	add := func(scope, projectID, connectionID string) error {
		threads, err := h.store.AgentThreads(scope)
		if err != nil {
			return err
		}
		for _, row := range threads {
			item := domain.OfficeSession{ID: row.ID, Title: row.Title, Agent: row.AgentID, Model: row.Model, Status: "unknown", UpdatedAt: row.UpdatedAt, ProjectID: projectID, ConnectionID: connectionID, Subagents: []domain.OfficeSubagent{}, Recent: []domain.OfficeActivity{}}
			if connectionID == "" {
				item.WorktreeID = scope
			}
			if t, ok := state.Thread(row.ID); ok {
				if t.Deleted {
					continue
				}
				item.Status = t.OfficeStatus()
				item.TurnInFlight = t.TurnInFlight
				item.PlanReady = t.ProposedPlan != nil
				item.Activity = t.Overview.Activity
				if t.Overview.Agent != "" {
					item.Agent = t.Overview.Agent
				}
				if t.Overview.Model != "" {
					item.Model = t.Overview.Model
				}
				item.UpdatedAt = max(row.UpdatedAt, t.UpdatedAt, t.Overview.UpdatedAt)
				for _, kind := range t.Overview.Pending {
					if kind == "question" {
						item.Questions++
					} else {
						item.Approvals++
					}
				}
				for _, child := range t.Overview.Subagents {
					item.Subagents = append(item.Subagents, child)
				}
				sort.Slice(item.Subagents, func(i, j int) bool { return item.Subagents[i].ID < item.Subagents[j].ID })
				item.Recent = append(item.Recent, t.Overview.Recent...)
			}
			out.Sessions = append(out.Sessions, item)
		}
		return nil
	}
	for _, p := range workspace.Projects {
		for _, wt := range p.Worktrees {
			if handleStoreErr(w, add(wt.ID, p.ID, "")) {
				return
			}
		}
	}
	// SSH is global in the current catalog. The client labels this Shared SSH,
	// and keeps only the executor's copy when aggregating multiple backends.
	connections, err := h.store.SSHConnections()
	if handleStoreErr(w, err) {
		return
	}
	for _, c := range connections {
		if handleStoreErr(w, add("ssh:"+c.ID, "", c.ID)) {
			return
		}
	}
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].ID < out.Sessions[j].ID })
	writeJSON(w, http.StatusOK, out)
}
