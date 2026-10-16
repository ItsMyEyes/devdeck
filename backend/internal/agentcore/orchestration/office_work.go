package orchestration

import (
	"encoding/json"
	"maps"

	"devdeck/backend/internal/domain"
)

// Item completion is execution completion only for these adapter contracts.
func executionCoverage(provider string) bool {
	return provider == "codex" || provider == "pi" || provider == "opencode"
}

type officeOperations struct {
	Turn    string
	Active  map[string]string
	Done    map[string]bool
	Retired map[string]bool
}

func cloneOperations(in map[string]*officeOperations) map[string]*officeOperations {
	if in == nil {
		return nil
	}
	out := make(map[string]*officeOperations, len(in))
	for key, value := range in {
		copy := *value
		copy.Active = maps.Clone(value.Active)
		copy.Done = maps.Clone(value.Done)
		copy.Retired = maps.Clone(value.Retired)
		out[key] = &copy
	}
	return out
}
func genericWork() domain.OfficeWork {
	return domain.OfficeWork{Kind: "generic", Coverage: "turn_only"}
}
func (p *OfficeProjection) clearWork() {
	p.Work = genericWork()
	// Preserve retired turn identities so a late item cannot revive an old turn.
	for _, ops := range p.operations {
		if ops.Turn != "" {
			ops.Retired[ops.Turn] = true
		}
		ops.Turn = ""
		clear(ops.Active)
		clear(ops.Done)
	}
	for id, child := range p.Subagents {
		child.Work = genericWork()
		p.Subagents[id] = child
	}
}
func projectOfficeWork(t *Thread, e Event) {
	p := &t.Overview
	switch e.Type {
	case EvtThreadTurnStartRequested:
		if !t.TurnInFlight {
			p.clearWork()
		}
		if p.Work.Kind == "" {
			p.Work = genericWork()
		}
		return
	case EvtThreadSessionSet:
		var v struct {
			Status string `json:"status"`
			Clear  bool   `json:"clearPending"`
		}
		if json.Unmarshal(e.Payload, &v) == nil && (v.Status == "idle" || v.Status == "stopped" || v.Clear) {
			p.clearWork()
		}
		return
	case EvtThreadActivityAppended:
	default:
		return
	}
	var v struct {
		Type     string `json:"type"`
		Provider string `json:"provider"`
		AgentID  string `json:"agentId"`
		TurnID   string `json:"turnId"`
		ItemID   string `json:"itemId"`
		Payload  struct {
			ItemType string `json:"itemType"`
			TaskID   string `json:"taskId"`
			Status   string `json:"status"`
		} `json:"payload"`
	}
	if json.Unmarshal(e.Payload, &v) != nil {
		return
	}
	actor := v.AgentID
	if v.Type == "task.started" || v.Type == "task.completed" || v.Type == "task.updated" {
		if actor == "" {
			actor = v.Payload.TaskID
		}
		if actor != "" && (v.Type == "task.completed" || v.Payload.Status == "completed" || v.Payload.Status == "failed" || v.Payload.Status == "stopped") {
			if ops := p.operations[actor]; ops != nil {
				ops.Retired[ops.Turn] = true
				clear(ops.Active)
				clear(ops.Done)
				ops.Turn = ""
			}
			if p.Subagents == nil {
				p.Subagents = map[string]domain.OfficeSubagent{}
			}
			child := p.Subagents[actor]
			child.Work = genericWork()
			p.Subagents[actor] = child
		}
		return
	}
	if !t.TurnInFlight && actor == "" {
		return
	}
	provider := v.Provider
	if provider == "" {
		provider = string(instanceKind(t.InstanceID))
	}
	if !executionCoverage(provider) || v.TurnID == "" {
		return
	}
	if actor != "" {
		child, exists := p.Subagents[actor]
		if !exists || child.Status != "running" {
			return
		}
		// Pi child processes expose tasks, not their item execution lifecycle.
		if provider == "pi" {
			return
		}
	}
	if v.Type != "turn.started" && v.Type != "item.started" && v.Type != "item.completed" {
		return
	}
	if p.operations == nil {
		p.operations = map[string]*officeOperations{}
	}
	ops := p.operations[actor]
	if ops == nil {
		ops = &officeOperations{Active: map[string]string{}, Done: map[string]bool{}, Retired: map[string]bool{}}
		p.operations[actor] = ops
	}
	if ops.Retired[v.TurnID] {
		return
	}
	if ops.Turn != v.TurnID {
		if ops.Turn != "" {
			ops.Retired[ops.Turn] = true
		}
		ops.Turn = v.TurnID
		clear(ops.Active)
		clear(ops.Done)
	}
	kind := ""
	switch v.Payload.ItemType {
	case "command_execution":
		kind = "command"
	case "file_change":
		kind = "file_change"
	case "tool_call":
		kind = "tool"
	}
	if v.ItemID != "" && kind != "" {
		if v.Type == "item.completed" {
			delete(ops.Active, v.ItemID)
			ops.Done[v.ItemID] = true
		}
		if v.Type == "item.started" && !ops.Done[v.ItemID] {
			ops.Active[v.ItemID] = kind
		}
	}
	work := domain.OfficeWork{Kind: "generic", Coverage: "item_lifecycle", ActiveCount: len(ops.Active)}
	for _, priority := range []string{"tool", "command", "file_change"} {
		for _, kind := range ops.Active {
			if kind == priority {
				work.Kind = priority
				break
			}
		}
	}
	if actor == "" {
		p.Work = work
	} else {
		child := p.Subagents[actor]
		child.Work = work
		p.Subagents[actor] = child
	}
}
