package orchestration

import (
	"encoding/json"
	"strings"

	"devdeck/backend/internal/domain"
)

// OfficeProjection retains metadata only; the durable event log remains the source.
type OfficeProjection struct {
	Agent     string
	Model     string
	Failed    bool
	Activity  string
	UpdatedAt int64
	Pending   map[string]string
	Subagents map[string]domain.OfficeSubagent
	Recent    []domain.OfficeActivity
}

func (t *Thread) OfficeStatus() string {
	if t.Overview.Failed {
		return "error"
	}
	if t.Status == ThreadStopped {
		return "stopped"
	}
	if len(t.PendingRequests) > 0 || len(t.Overview.Pending) > 0 {
		return "waiting"
	}
	if t.TurnInFlight {
		return "running"
	}
	return "idle"
}

func cloneOffice(p OfficeProjection) OfficeProjection {
	out := p
	if p.Pending != nil {
		out.Pending = make(map[string]string, len(p.Pending))
	}
	for k, v := range p.Pending {
		out.Pending[k] = v
	}
	if p.Subagents != nil {
		out.Subagents = make(map[string]domain.OfficeSubagent, len(p.Subagents))
	}
	for k, v := range p.Subagents {
		out.Subagents[k] = v
	}
	out.Recent = append([]domain.OfficeActivity(nil), p.Recent...)
	return out
}

func officeLabel(s string) string {
	r := []rune(strings.Join(strings.Fields(s), " "))
	if len(r) > 100 {
		return string(r[:100]) + "…"
	}
	return string(r)
}

func projectOffice(t *Thread, e Event) {
	p := &t.Overview
	activity := ""
	agentID := ""
	switch e.Type {
	case EvtThreadTurnStartRequested:
		p.Failed = false
		activity = "Turn started"
	case EvtThreadApprovalResponseRequested, EvtThreadUserInputResponseRequested:
		var v struct {
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(e.Payload, &v) == nil {
			delete(p.Pending, v.RequestID)
		}
		activity = "Response sent"
	case EvtThreadSessionSet:
		var v struct {
			Status        string `json:"status"`
			PendingRemove string `json:"pendingRequestRemove"`
			Clear         bool   `json:"clearPending"`
			Tokens        *int64 `json:"turnTokens"`
			Outcome       string `json:"turnOutcome"`
		}
		if json.Unmarshal(e.Payload, &v) != nil {
			return
		}
		delete(p.Pending, v.PendingRemove)
		if v.Outcome == "failed" {
			p.Failed = true
		}
		if v.Status == "stopped" || v.Clear {
			p.Pending = nil
			for id, c := range p.Subagents {
				if c.Status == "running" {
					c.Status = "stopped"
					c.UpdatedAt = e.CreatedAt
					p.Subagents[id] = c
				}
			}
		}
		if v.Status == "idle" {
			activity = "Turn finished"
			if p.Failed {
				activity = "Turn failed"
			}
		}
		if v.Status == "stopped" {
			activity = "Session stopped"
		}
	case EvtThreadPlanProposed:
		activity = "Plan ready for review"
	case EvtThreadActivityAppended:
		var v struct {
			Type      string `json:"type"`
			Provider  string `json:"provider"`
			AgentID   string `json:"agentId"`
			RequestID string `json:"requestId"`
			Payload   struct {
				TaskID   string `json:"taskId"`
				Title    string `json:"title"`
				Role     string `json:"role"`
				Status   string `json:"status"`
				Model    string `json:"model"`
				ItemType string `json:"itemType"`
				LastTool string `json:"lastToolName"`
				Usage    *struct {
					TotalTokens *int64 `json:"totalTokens"`
				} `json:"usage"`
			} `json:"payload"`
		}
		if json.Unmarshal(e.Payload, &v) != nil {
			return
		}
		agentID = v.AgentID
		switch v.Type {
		case "turn.started":
			if agentID != "" {
				return
			}
			p.Agent = v.Provider
			p.Model = v.Payload.Model
		case "runtime.error":
			if agentID == "" {
				p.Failed = true
			}
			activity = "Agent reported an error"
		case "request.opened", "user-input.requested":
			if v.RequestID == "" {
				return
			}
			if p.Pending == nil {
				p.Pending = map[string]string{}
			}
			kind := "approval"
			activity = "Approval needed"
			if v.Type == "user-input.requested" {
				kind = "question"
				activity = "Answer needed"
			}
			p.Pending[v.RequestID] = kind
		case "request.resolved", "user-input.resolved":
			delete(p.Pending, v.RequestID)
		case "item.started":
			if v.Payload.ItemType != "tool_call" && v.Payload.ItemType != "command_execution" && v.Payload.ItemType != "file_change" {
				return
			}
			// Titles may contain command arguments; show only the canonical activity kind.
			activity = "Using a tool"
			if v.Payload.ItemType == "command_execution" {
				activity = "Running a command"
			}
			if v.Payload.ItemType == "file_change" {
				activity = "Editing files"
			}
		case "task.started", "task.progress", "task.updated", "task.completed":
			id := v.AgentID
			if id == "" {
				id = v.Payload.TaskID
			}
			if id == "" {
				return
			}
			agentID = id
			if p.Subagents == nil {
				p.Subagents = map[string]domain.OfficeSubagent{}
			}
			child := p.Subagents[id]
			child.ID = id
			child.UpdatedAt = e.CreatedAt
			if v.Payload.Title != "" {
				child.Title = officeLabel(v.Payload.Title)
			}
			if v.Payload.Role != "" {
				child.Role = officeLabel(v.Payload.Role)
			}
			if child.Status == "" {
				child.Status = "running"
			}
			switch v.Payload.Status {
			case "running", "completed", "failed", "stopped":
				child.Status = v.Payload.Status
			}
			if v.Type == "task.completed" && child.Status == "running" {
				child.Status = "completed"
			}
			if v.Payload.Usage != nil && v.Payload.Usage.TotalTokens != nil && (child.Tokens == nil || *v.Payload.Usage.TotalTokens > *child.Tokens) {
				n := *v.Payload.Usage.TotalTokens
				child.Tokens = &n
			}
			if v.Payload.LastTool != "" {
				child.Activity = "Using a tool"
			}
			p.Subagents[id] = child
			if v.Type != "task.progress" {
				activity = "Subagent " + child.Status
			}
		}
	}
	if activity != "" {
		p.Activity = activity
		p.UpdatedAt = e.CreatedAt
		p.Recent = append(p.Recent, domain.OfficeActivity{ID: e.EventID, AgentID: agentID, Text: activity, CreatedAt: e.CreatedAt})
		if len(p.Recent) > 10 {
			p.Recent = append([]domain.OfficeActivity(nil), p.Recent[len(p.Recent)-10:]...)
		}
	}
}
