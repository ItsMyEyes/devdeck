package orchestration

import (
	"encoding/json"
	"testing"

	"devdeck/backend/internal/agentcore/provider"
)

// TestTurnStartPayload_EightAttachments_Under4KB is the regression guard
// named directly by the composer-context-attachments spec: attachment
// metadata (id/kind/mime/name) travels over the WebSocket command channel,
// but the raw bytes (provider.Attachment.Data, tagged `json:"-"`) must
// never leak into a thread.turn.start command — that would blow past
// agent_ws.go's 1MB read limit for a handful of images and would also mean
// replaying the event log re-sends bytes that belong in the attachment
// store, not the command stream.
func TestTurnStartPayload_EightAttachments_Under4KB(t *testing.T) {
	atts := make([]provider.Attachment, 8)
	for i := range atts {
		atts[i] = provider.Attachment{
			ID:   "attachment-id-0123456789",
			Kind: "image",
			MIME: "image/png",
			Name: "screenshot-from-terminal-capture.png",
			// Data must not be serialized even though it's populated here —
			// this is exactly the shape the reactor produces after T7 loads
			// bytes server-side before handing the input to the provider.
			Data: make([]byte, 512*1024),
		}
	}

	payload := TurnStartPayload{
		Text:        "please look at these screenshots and tell me what's wrong",
		Attachments: atts,
	}

	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) >= 4096 {
		t.Fatalf("marshaled TurnStartPayload with 8 attachments = %d bytes, want < 4096 (raw Data leaked into the wire payload?)", len(b))
	}
}
