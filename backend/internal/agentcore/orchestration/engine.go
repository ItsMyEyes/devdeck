package orchestration

import (
	"encoding/json"
	"errors"
	"fmt"

	"devdeck/backend/internal/agentcore/provider"
)

// ---------------------------------------------------------------------------
// State & projection
// ---------------------------------------------------------------------------

type ThreadStatus string

const (
	ThreadIdle    ThreadStatus = "idle"
	ThreadRunning ThreadStatus = "running"
	ThreadWaiting ThreadStatus = "waiting" // waiting on approval / user input
	ThreadStopped ThreadStatus = "stopped"
)

type Thread struct {
	ID          string
	InstanceID  provider.InstanceID
	Status      ThreadStatus
	Mode        provider.RuntimeMode
	Interact    provider.InteractionMode
	CurrentTurn string
	// ResumeCursor: an opaque value from the adapter. The engine stores it,
	// never reads it.
	ResumeCursor    json.RawMessage
	PendingRequests map[string]bool
	Deleted         bool
	UpdatedAt       int64
}

// State is the in-memory read model. Immutable by convention: the projector
// returns a new copy rather than mutating the old one. That is what makes
// "swap after commit" below safe.
type State struct {
	Threads map[string]*Thread
}

func NewState() *State { return &State{Threads: make(map[string]*Thread)} }

func (s *State) clone() *State {
	n := &State{Threads: make(map[string]*Thread, len(s.Threads))}
	for k, v := range s.Threads {
		c := *v
		c.PendingRequests = make(map[string]bool, len(v.PendingRequests))
		for r := range v.PendingRequests {
			c.PendingRequests[r] = true
		}
		n.Threads[k] = &c
	}
	return n
}

func (s *State) Thread(id string) (*Thread, bool) {
	t, ok := s.Threads[id]
	return t, ok
}

// ---------------------------------------------------------------------------
// Decider — PURE. No I/O, no clock, no random.
// ---------------------------------------------------------------------------

// Decide turns (state, command) into events. This is the only place business
// rules are allowed to live.
//
// Purity here is not idealism: because it is pure, the entire rule set of the
// system can be tested with input/output tables, with no database and no
// agent process. The moment you slip a time.Now() in here, you lose that —
// which is why `now` is passed in as a parameter.
func Decide(s *State, cmd Command, now int64, newID func() string) ([]Event, error) {
	mk := func(t EventType, payload any) Event {
		var raw json.RawMessage
		if payload != nil {
			b, _ := json.Marshal(payload)
			raw = b
		}
		return Event{
			EventID:   newID(),
			Type:      t,
			ThreadID:  cmd.ThreadID,
			CommandID: cmd.CommandID,
			CreatedAt: now,
			Payload:   raw,
		}
	}

	switch cmd.Type {
	case CmdThreadCreate:
		if _, exists := s.Threads[cmd.ThreadID]; exists {
			return nil, fmt.Errorf("thread %s already exists", cmd.ThreadID)
		}
		return []Event{mk(EvtThreadCreated, json.RawMessage(cmd.Payload))}, nil

	case CmdThreadTurnStart:
		t, ok := s.Threads[cmd.ThreadID]
		if !ok || t.Deleted {
			return nil, fmt.Errorf("thread %s does not exist", cmd.ThreadID)
		}
		// Design note: we do NOT reject this while the thread is already
		// running. Modern providers support "steering" — a follow-up message
		// gets merged into the in-flight turn. The adapter decides, via
		// TurnStartResult.Steered.
		var p TurnStartPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return nil, fmt.Errorf("invalid turn.start payload: %w", err)
		}
		if p.Text == "" && len(p.Attachments) == 0 {
			return nil, errors.New("empty turn")
		}
		return []Event{
			mk(EvtThreadMessageSent, p),
			mk(EvtThreadTurnStartRequested, p),
		}, nil

	case CmdThreadApprovalRespond:
		t, ok := s.Threads[cmd.ThreadID]
		if !ok {
			return nil, fmt.Errorf("thread %s does not exist", cmd.ThreadID)
		}
		var p ApprovalRespondPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return nil, err
		}
		if !p.Decision.Valid() {
			return nil, errors.New("invalid decision")
		}
		// Rejecting a request that is not pending is what keeps a double-tap
		// from two devices from producing two events.
		if !t.PendingRequests[p.RequestID] {
			return nil, fmt.Errorf("request %s is not pending", p.RequestID)
		}
		return []Event{mk(EvtThreadApprovalResponseRequested, p)}, nil

	case CmdThreadTurnInterrupt:
		return []Event{mk(EvtThreadTurnInterruptRequested, nil)}, nil

	case CmdThreadSessionStop:
		return []Event{mk(EvtThreadSessionStopRequested, nil)}, nil

	case CmdThreadRuntimeModeSet:
		var p RuntimeModeSetPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return nil, err
		}
		return []Event{mk(EvtThreadRuntimeModeSet, p)}, nil

	case CmdThreadAssistantDelta:
		return []Event{mk(EvtThreadActivityAppended, json.RawMessage(cmd.Payload))}, nil

	case CmdThreadSessionSet:
		return []Event{mk(EvtThreadSessionSet, json.RawMessage(cmd.Payload))}, nil

	case CmdThreadDelete:
		return []Event{mk(EvtThreadDeleted, nil)}, nil

	default:
		return nil, fmt.Errorf("unrecognized command: %s", cmd.Type)
	}
}

// ---------------------------------------------------------------------------
// Projector — also pure.
// ---------------------------------------------------------------------------

// Apply derives new state from events. Must be deterministic: replaying the
// whole event log from the start must produce identical state.
func Apply(s *State, evts []Event) *State {
	next := s.clone()
	for _, e := range evts {
		applyOne(next, e)
	}
	return next
}

func applyOne(s *State, e Event) {
	switch e.Type {
	case EvtThreadCreated:
		var p struct {
			InstanceID provider.InstanceID      `json:"instanceId"`
			Mode       provider.RuntimeMode     `json:"mode"`
			Interact   provider.InteractionMode `json:"interactionMode"`
		}
		_ = json.Unmarshal(e.Payload, &p)
		if p.Mode == "" {
			p.Mode = provider.ModeApprovalRequired
		}
		if p.Interact == "" {
			p.Interact = provider.InteractionDefault
		}
		s.Threads[e.ThreadID] = &Thread{
			ID: e.ThreadID, InstanceID: p.InstanceID, Status: ThreadIdle,
			Mode: p.Mode, Interact: p.Interact,
			PendingRequests: map[string]bool{}, UpdatedAt: e.CreatedAt,
		}

	case EvtThreadTurnStartRequested:
		if t, ok := s.Threads[e.ThreadID]; ok {
			t.Status = ThreadRunning
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadApprovalResponseRequested:
		if t, ok := s.Threads[e.ThreadID]; ok {
			var p ApprovalRespondPayload
			_ = json.Unmarshal(e.Payload, &p)
			delete(t.PendingRequests, p.RequestID)
			if len(t.PendingRequests) == 0 && t.Status == ThreadWaiting {
				t.Status = ThreadRunning
			}
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadRuntimeModeSet:
		if t, ok := s.Threads[e.ThreadID]; ok {
			var p RuntimeModeSetPayload
			_ = json.Unmarshal(e.Payload, &p)
			t.Mode = p.Mode
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadSessionSet:
		if t, ok := s.Threads[e.ThreadID]; ok {
			var p struct {
				Status       ThreadStatus    `json:"status"`
				ResumeCursor json.RawMessage `json:"resumeCursor,omitempty"`
				PendingAdd   string          `json:"pendingRequestAdd,omitempty"`
			}
			_ = json.Unmarshal(e.Payload, &p)
			if p.Status != "" {
				t.Status = p.Status
			}
			if len(p.ResumeCursor) > 0 {
				t.ResumeCursor = p.ResumeCursor
			}
			if p.PendingAdd != "" {
				t.PendingRequests[p.PendingAdd] = true
				t.Status = ThreadWaiting
			}
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadDeleted:
		if t, ok := s.Threads[e.ThreadID]; ok {
			t.Deleted = true
			t.Status = ThreadStopped
		}
	}
}
