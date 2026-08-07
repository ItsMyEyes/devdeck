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
