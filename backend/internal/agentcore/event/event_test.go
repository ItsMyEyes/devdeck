package event

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRoundTripContentDelta(t *testing.T) {
	in := Event{
		EventID:    "ae-1",
		Type:       ContentDelta,
		Provider:   "claude",
		InstanceID: "claude:default",
		ThreadID:   "w-abc",
		TurnID:     "turn-1",
		ItemID:     "item-1",
		CreatedAt:  time.UnixMilli(1700000000000).UTC(),
		Refs:       &Refs{SessionID: "native-uuid"},
		Payload: &ContentDeltaPayload{
			ItemType: ItemAssistantMessage,
			Stream:   StreamText,
			Text:     "hello",
			Sequence: 7,
		},
	}

	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var out Event
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if out.Type != ContentDelta || out.ItemID != "item-1" {
		t.Fatalf("envelope lost: %+v", out)
	}
	if out.Refs == nil || out.Refs.SessionID != "native-uuid" {
		t.Fatalf("refs lost: %+v", out.Refs)
	}
	p, ok := out.Payload.(*ContentDeltaPayload)
	if !ok {
		t.Fatalf("payload type = %T, want *ContentDeltaPayload", out.Payload)
	}
	if p.Text != "hello" || p.Sequence != 7 || p.Stream != StreamText {
		t.Fatalf("payload lost: %+v", p)
	}
}

// An unknown event type must not fail the whole stream. This happens every
// time a provider ships a new event before we add a handler for it.
func TestUnknownTypeDecodesWithNilPayload(t *testing.T) {
	raw := []byte(`{"eventId":"ae-2","type":"some.future.event","threadId":"w-abc","payload":{"x":1}}`)

	var out Event
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unknown type must not error, got: %v", err)
	}
	if out.Payload != nil {
		t.Fatalf("payload = %v, want nil for unknown type", out.Payload)
	}
	if out.EventID != "ae-2" {
		t.Fatalf("envelope lost on unknown type: %+v", out)
	}
}

// Decision is the approval vocabulary; an invalid one must be rejected at the
// boundary rather than reaching a provider.
func TestDecisionValid(t *testing.T) {
	for _, d := range []Decision{DecisionAccept, DecisionAcceptForSession, DecisionDecline, DecisionCancel} {
		if !d.Valid() {
			t.Errorf("%q should be valid", d)
		}
	}
	if Decision("yolo").Valid() {
		t.Error(`"yolo" should not be valid`)
	}
}

func TestToolDeniedPayloadRegistered(t *testing.T) {
	raw := []byte(`{"eventId":"e1","type":"tool.denied","threadId":"w-abc","requestId":"r1",
		"createdAt":"2026-01-01T00:00:00Z","payload":{"toolName":"Write","message":"nope"}}`)
	var e Event
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p, ok := e.Payload.(*ToolDeniedPayload)
	if !ok {
		t.Fatalf("payload = %T, want *ToolDeniedPayload", e.Payload)
	}
	if p.ToolName != "Write" || p.Message != "nope" {
		t.Fatalf("payload = %+v", p)
	}
}

// ProposedPlanPayload carries the plan the agent captured via ExitPlanMode
// (design.md §2). It must round-trip through the same registry-driven
// UnmarshalJSON every other payload uses.
func TestProposedPlanPayloadRoundTrips(t *testing.T) {
	in := Event{
		EventID:   "ae-3",
		Type:      TurnProposedCompleted,
		Provider:  "claude",
		ThreadID:  "w-abc",
		TurnID:    "turn-1",
		CreatedAt: time.UnixMilli(1700000000000).UTC(),
		Payload: &ProposedPlanPayload{
			PlanMarkdown: "# Plan\n\n1. Do the thing.",
			PlanFilePath: "/Users/agent/.claude/plans/do-the-thing.md",
			ToolUseID:    "toolu_01UNeXLedXjsmJ25eWTgfoHr",
		},
	}

	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var out Event
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if out.Type != TurnProposedCompleted || out.ThreadID != "w-abc" {
		t.Fatalf("envelope lost: %+v", out)
	}
	p, ok := out.Payload.(*ProposedPlanPayload)
	if !ok {
		t.Fatalf("payload type = %T, want *ProposedPlanPayload", out.Payload)
	}
	want := in.Payload.(*ProposedPlanPayload)
	if p.PlanMarkdown != want.PlanMarkdown || p.PlanFilePath != want.PlanFilePath || p.ToolUseID != want.ToolUseID {
		t.Fatalf("payload lost: got %+v, want %+v", p, want)
	}
}

// If TurnProposedCompleted were ever missing from payloadRegistry, decoding
// must degrade to a nil payload rather than error — the same contract
// TestUnknownTypeDecodesWithNilPayload pins for a genuinely unknown type.
// This test proves it is the registry entry (not some special case in
// UnmarshalJSON) that makes TestProposedPlanPayloadRoundTrips pass: it
// removes the entry for the duration of the test and restores it after.
func TestProposedPlanPayloadUnregisteredDecodesToNilPayload(t *testing.T) {
	saved, ok := payloadRegistry[TurnProposedCompleted]
	if !ok {
		t.Fatalf("TurnProposedCompleted must be registered in payloadRegistry before this test can prove anything by removing it")
	}
	delete(payloadRegistry, TurnProposedCompleted)
	defer func() { payloadRegistry[TurnProposedCompleted] = saved }()

	in := Event{
		EventID:  "ae-4",
		Type:     TurnProposedCompleted,
		ThreadID: "w-abc",
		Payload: &ProposedPlanPayload{
			PlanMarkdown: "# Plan\n\n1. Do the thing.",
		},
	}

	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var out Event
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unregistered type must not error, got: %v", err)
	}
	if out.Payload != nil {
		t.Fatalf("payload = %v, want nil when TurnProposedCompleted is unregistered", out.Payload)
	}
	if out.EventID != "ae-4" {
		t.Fatalf("envelope lost when unregistered: %+v", out)
	}
}
