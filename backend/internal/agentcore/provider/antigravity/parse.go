package antigravity

import (
	"encoding/json"
	"fmt"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// Wire shapes come from https://www.antigravity.google/docs/cli/headless/.
// Result.response is the same text as the deltas; result.usage is cumulative.
type wireUsage struct {
	Input  int64 `json:"input_tokens"`
	Output int64 `json:"output_tokens"`
	Cache  int64 `json:"cache_read_tokens"`
}
type wireStep struct {
	ConversationID string     `json:"conversation_id"`
	Index          int        `json:"step_index"`
	State          string     `json:"state"`
	Type           string     `json:"step_type"`
	Text           string     `json:"text_delta"`
	ToolName       string     `json:"tool_name"`
	Usage          *wireUsage `json:"usage"`
	Tool           *struct {
		Name       string          `json:"name"`
		Parameters json.RawMessage `json:"parameters"`
		Output     json.RawMessage `json:"output"`
		Error      *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	} `json:"tool_info"`
	Subagent *struct {
		Subagents []struct {
			ID            string   `json:"conversation_id"`
			Type          string   `json:"type_name"`
			Role          string   `json:"role"`
			LogURI        string   `json:"log_uri"`
			WorkspaceURIs []string `json:"workspace_uris"`
		} `json:"subagents"`
	} `json:"subagent_info"`
}
type wireResult struct {
	ConversationID string          `json:"conversation_id"`
	Status         string          `json:"status"`
	Response       string          `json:"response"`
	Error          string          `json:"error"`
	Usage          *wireUsage      `json:"usage"`
	Structured     json.RawMessage `json:"structured_output"`
}
type parsedItem struct {
	typeName event.ItemType
	seq      uint64
	done     bool
}
type parseState struct {
	instanceID                  provider.InstanceID
	threadID, turnID            string
	resume                      cursor
	baseline                    *wireUsage
	resuming                    bool
	items                       map[string]*parsedItem
	subagentWarning             bool
	steps                       map[int]bool
	stepUsage                   wireUsage
	gotStepUsage                bool
	gotInit, gotResult, gotText bool
	status, failure             string
	turnUsage                   *event.Usage
}

func newParseState(instanceID provider.InstanceID, threadID, turnID string, resume cursor) *parseState {
	return &parseState{instanceID: instanceID, threadID: threadID, turnID: turnID, resume: resume,
		baseline: resume.Usage, resuming: resume.ConversationID != "", items: make(map[string]*parsedItem), steps: make(map[int]bool)}
}
func envelope(id provider.InstanceID, thread, turn string, typ event.Type) event.Event {
	return event.Event{Type: typ, Provider: string(Kind), InstanceID: string(id), ThreadID: thread, TurnID: turn, CreatedAt: time.Now().UTC()}
}
func (st *parseState) event(typ event.Type, payload event.Payload) event.Event {
	e := envelope(st.instanceID, st.threadID, st.turnID, typ)
	e.Payload = payload
	e.Refs = &event.Refs{SessionID: st.resume.ConversationID}
	return e
}
func (st *parseState) sessionEvent() event.Event {
	raw, _ := json.Marshal(st.resume)
	return st.event(event.SessionStarted, &event.SessionStartedPayload{Resume: raw})
}
func (st *parseState) conversation(id string) error {
	if id == "" {
		return nil
	}
	if st.resume.ConversationID != "" && st.resume.ConversationID != id {
		return fmt.Errorf("stream switched conversation from %q to %q", st.resume.ConversationID, id)
	}
	st.resume.ConversationID = id
	return nil
}

func (st *parseState) parse(raw []byte) ([]event.Event, error) {
	var w struct {
		Event          string          `json:"event"`
		ConversationID string          `json:"conversation_id"`
		Init           json.RawMessage `json:"init"`
		Step           *wireStep       `json:"step_update"`
		Result         *wireResult     `json:"result"`
	}
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, fmt.Errorf("malformed JSON output: %w", err)
	}
	if st.gotResult {
		return nil, fmt.Errorf("unexpected output after result")
	}
	switch w.Event {
	case "init":
		if st.gotInit || len(w.Init) == 0 || w.ConversationID == "" {
			return nil, fmt.Errorf("invalid init event")
		}
		var init map[string]json.RawMessage
		if err := json.Unmarshal(w.Init, &init); err != nil || init == nil {
			return nil, fmt.Errorf("invalid init payload")
		}
		if err := st.conversation(w.ConversationID); err != nil {
			return nil, err
		}
		st.gotInit = true
		return []event.Event{st.sessionEvent()}, nil
	case "step_update":
		if !st.gotInit || w.Step == nil {
			return nil, fmt.Errorf("step_update without init or payload")
		}
		if err := st.conversation(w.Step.ConversationID); err != nil {
			return nil, err
		}
		return st.step(*w.Step)
	case "result":
		if w.Result == nil {
			return nil, fmt.Errorf("result missing payload")
		}
		r := w.Result
		if err := st.conversation(r.ConversationID); err != nil {
			return nil, err
		}
		if len(r.Structured) > 0 && string(r.Structured) != "null" {
			return nil, fmt.Errorf("structured output is unsupported")
		}
		switch r.Status {
		case "SUCCESS":
			if !st.gotInit || st.resume.ConversationID == "" {
				return nil, fmt.Errorf("successful result without initialized conversation")
			}
			st.status = "completed"
		case "CANCELED", "INTERRUPTED":
			st.status = "interrupted"
		case "ERROR", "INVALID", "WAITING", "RUNNING":
			st.status, st.failure = "failed", r.Error
			if st.failure == "" {
				st.failure = "CLI result status " + r.Status
			}
		default:
			return nil, fmt.Errorf("unsupported result status %q", r.Status)
		}
		st.gotResult = true
		var events []event.Event
		if !st.gotText && r.Response != "" && st.status == "completed" {
			events = append(events, st.text("response", event.ItemAssistantMessage, r.Response)...)
		}
		if r.Usage != nil {
			if r.Usage.Input < 0 || r.Usage.Output < 0 || r.Usage.Cache < 0 {
				return nil, fmt.Errorf("negative token usage")
			}
			u := *r.Usage
			if st.baseline != nil {
				u.Input -= st.baseline.Input
				u.Output -= st.baseline.Output
				u.Cache -= st.baseline.Cache
				if u.Input < 0 || u.Output < 0 || u.Cache < 0 {
					if !st.gotStepUsage {
						return nil, fmt.Errorf("cumulative token usage decreased without per-step usage")
					}
					u = st.stepUsage
				}
			} else if st.resuming {
				// A legacy ID-only cursor has no baseline. Per-step usage is
				// the only trustworthy cost for its first resumed turn.
				u = st.stepUsage
			}
			if !st.resuming || st.baseline != nil || st.gotStepUsage {
				st.turnUsage = &event.Usage{InputTokens: u.Input, OutputTokens: u.Output, CacheReadTokens: u.Cache}
			}
			st.resume.Usage = r.Usage
		} else {
			st.resume.Usage = nil
			if st.gotStepUsage {
				st.turnUsage = &event.Usage{InputTokens: st.stepUsage.Input, OutputTokens: st.stepUsage.Output, CacheReadTokens: st.stepUsage.Cache}
			}
		}
		if st.resume.ConversationID != "" {
			events = append(events, st.sessionEvent())
		}
		return events, nil
	default:
		return nil, fmt.Errorf("unsupported stream event %q", w.Event)
	}
}

func (st *parseState) text(id string, typ event.ItemType, text string) []event.Event {
	var events []event.Event
	if st.items[id] == nil {
		st.items[id] = &parsedItem{typeName: typ}
		e := st.event(event.ItemStarted, &event.ItemStartedPayload{ItemType: typ})
		e.ItemID = id
		events = append(events, e)
	}
	item := st.items[id]
	item.seq++
	stream := event.StreamText
	if typ == event.ItemReasoning {
		stream = event.StreamReasoning
	}
	e := st.event(event.ContentDelta, &event.ContentDeltaPayload{ItemType: typ, Stream: stream, Text: text, Sequence: item.seq})
	e.ItemID = id
	return append(events, e)
}

func (st *parseState) step(s wireStep) ([]event.Event, error) {
	if s.Index < 0 || (s.State != "ACTIVE" && s.State != "DONE" && s.State != "ERROR") {
		return nil, fmt.Errorf("invalid step state/index: state %q, index %d", s.State, s.Index)
	}
	// agy emits ERROR for a failed tool while the surrounding turn can continue.
	terminal := s.State == "DONE" || s.State == "ERROR"
	if s.Usage != nil && (s.Usage.Input < 0 || s.Usage.Output < 0 || s.Usage.Cache < 0) {
		return nil, fmt.Errorf("negative step token usage")
	}
	var events []event.Event
	id := fmt.Sprintf("%s:step:%d", st.turnID, s.Index)
	if s.Usage != nil && terminal && !st.steps[s.Index] {
		st.gotStepUsage = true
		st.stepUsage.Input += s.Usage.Input
		st.stepUsage.Output += s.Usage.Output
		st.stepUsage.Cache += s.Usage.Cache
		st.steps[s.Index] = true
	}
	switch s.Type {
	case "agent_response":
		if s.Text != "" {
			st.gotText = true
			events = append(events, st.text(id, event.ItemAssistantMessage, s.Text)...)
		}
	case "tool":
		name := s.ToolName
		if s.Tool != nil && s.Tool.Name != "" {
			name = s.Tool.Name
		}
		if name == "" {
			return nil, fmt.Errorf("tool step has no name")
		}
		if st.items[id] == nil {
			st.items[id] = &parsedItem{typeName: event.ItemToolCall}
			var detail json.RawMessage
			if s.Tool != nil {
				detail = s.Tool.Parameters
			}
			if s.Subagent != nil {
				detail, _ = json.Marshal(map[string]any{"subagent_info": s.Subagent, "tool_info": s.Tool})
			}
			e := st.event(event.ItemStarted, &event.ItemStartedPayload{ItemType: event.ItemToolCall, Title: name, Detail: detail})
			e.ItemID = id
			events = append(events, e)
		}
		if terminal && !st.items[id].done {
			st.items[id].done = true
			status := "completed"
			if s.State == "ERROR" {
				status = "failed"
			}
			var detail json.RawMessage
			if s.Tool != nil {
				detail = s.Tool.Output
				if s.Tool.Error != nil {
					status = "failed"
					detail, _ = json.Marshal(s.Tool.Error)
				}
			}
			if s.Subagent != nil {
				detail, _ = json.Marshal(map[string]any{"subagent_info": s.Subagent, "tool_info": s.Tool})
			}
			e := st.event(event.ItemCompleted, &event.ItemCompletedPayload{ItemType: event.ItemToolCall, Status: status, Detail: detail})
			e.ItemID = id
			events = append(events, e)
		}
		if s.Subagent != nil && !st.subagentWarning {
			st.subagentWarning = true
			events = append(events, st.event(event.RuntimeWarning, &event.WarningPayload{Message: "Antigravity reports subagent identities only; child activity and status are unavailable."}))
		}
	case "user_input", "checkpoint", "system_message":
	default:
		e := st.event(event.RuntimeWarning, &event.WarningPayload{Message: "antigravity: unsupported step type " + s.Type})
		raw, _ := json.Marshal(s)
		e.Raw = &event.Raw{Source: "antigravity.stream-json", Method: "step_update", Payload: raw}
		events = append(events, e)
	}
	if terminal && st.items[id] != nil && !st.items[id].done {
		st.items[id].done = true
		status := "completed"
		if s.State == "ERROR" {
			status = "failed"
		}
		e := st.event(event.ItemCompleted, &event.ItemCompletedPayload{ItemType: st.items[id].typeName, Status: status})
		e.ItemID = id
		events = append(events, e)
	}
	return events, nil
}

func (st *parseState) finishItems(status string) []event.Event {
	var events []event.Event
	for id, item := range st.items {
		if item.done {
			continue
		}
		item.done = true
		e := st.event(event.ItemCompleted, &event.ItemCompletedPayload{ItemType: item.typeName, Status: status})
		e.ItemID = id
		events = append(events, e)
	}
	return events
}
