package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

func TestPermissionResultForDecision(t *testing.T) {
	input := json.RawMessage(`{"file_path":"/tmp/hello.txt","content":"hi"}`)
	suggestions := json.RawMessage(`[{"type":"setMode","mode":"acceptEdits","destination":"session"}]`)

	cases := []struct {
		name string
		d    event.Decision
		want map[string]any
	}{
		{"accept", event.DecisionAccept, map[string]any{
			"behavior": "allow", "updatedInput": map[string]any{"file_path": "/tmp/hello.txt", "content": "hi"},
		}},
		{"acceptForSession", event.DecisionAcceptForSession, map[string]any{
			"behavior": "allow", "updatedInput": map[string]any{"file_path": "/tmp/hello.txt", "content": "hi"},
			"updatedPermissions": []any{map[string]any{"type": "setMode", "mode": "acceptEdits", "destination": "session"}},
		}},
		{"decline", event.DecisionDecline, map[string]any{
			"behavior": "deny", "message": "User declined tool execution.",
		}},
		{"cancel", event.DecisionCancel, map[string]any{
			"behavior": "deny", "message": "User cancelled tool execution.",
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := permissionResult(c.d, input, suggestions)
			var gotMap map[string]any
			b, _ := json.Marshal(got)
			_ = json.Unmarshal(b, &gotMap)
			if !reflect.DeepEqual(gotMap, c.want) {
				t.Fatalf("got %#v, want %#v", gotMap, c.want)
			}
		})
	}
}

// acceptForSession must NOT echo updatedPermissions when the CLI sent no
// suggestions — the parser already withholds the Options entry (T11), and
// the adapter must not manufacture one anyway if it's ever called this way.
func TestPermissionResultAcceptForSessionOmitsEmptySuggestions(t *testing.T) {
	got := permissionResult(event.DecisionAcceptForSession, json.RawMessage(`{}`), nil)
	if _, ok := got["updatedPermissions"]; ok {
		t.Fatal("updatedPermissions must be absent when there were no suggestions to echo")
	}
}

func TestRespondToRequestWritesTheMappedDecisionAndRetiresPending(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	st.setPending("req-1", &pendingRequest{
		requestID: "req-1", toolUseID: "toolu_1", toolName: "Write",
		kind: pendingKindApproval, requestType: event.ReqFileChangeApproval,
		input: json.RawMessage(`{"file_path":"/tmp/hello.txt"}`),
	})
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}
	a := &adapter{instanceID: "claude:default", sessions: map[string]*session{"w-abc": sess}, events: make(chan event.Event, 4)}

	if err := a.RespondToRequest(context.Background(), "w-abc", "req-1", event.DecisionAccept); err != nil {
		t.Fatalf("respond: %v", err)
	}
	var wire map[string]any
	_ = json.Unmarshal(buf.Bytes(), &wire)
	inner := wire["response"].(map[string]any)["response"].(map[string]any)
	if inner["behavior"] != "allow" {
		t.Fatalf("behavior = %v", inner["behavior"])
	}

	buf.Reset()
	if err := a.RespondToRequest(context.Background(), "w-abc", "req-1", event.DecisionAccept); err != nil {
		t.Fatalf("second respond: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatal("second respond on a retired request must be a no-op")
	}
}
