package opencode

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

func newTestAdapter(baseURL string) *adapter {
	return &adapter{
		instanceID: "opencode:default",
		baseURL:    baseURL,
		http:       &http.Client{},
		events:     make(chan event.Event, 16),
		sessions:   map[string]*session{},
		byOpencode: map[string]*session{},
	}
}

func newTestSession(devdeckThreadID, opencodeSessionID string) *session {
	return &session{
		threadID:  devdeckThreadID,
		sessionID: opencodeSessionID,
		state:     newParseState(devdeckThreadID, opencodeSessionID, "opencode:default"),
	}
}

// RespondToRequest was a no-op before this file's fix — not because the HTTP
// call was hard to write, but because subscribe's per-session stream never
// delivered a permission request for it to answer (see parse.go's package
// comment and adapter.go's subscribeGlobal). This asserts the wire format
// itself: POST /api/session/{sessionID}/permission/{requestID}/reply with
// {"reply": "once"|"always"|"reject"} — verified live, 2026-08-18, against a
// real pending bash approval that the exact same body actually unblocked.
func TestRespondToRequestPostsTheMappedReply(t *testing.T) {
	var gotPath, gotMethod string
	var gotBody struct {
		Reply string `json:"reply"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	a := newTestAdapter(srv.URL)
	a.sessions["w-1"] = newTestSession("w-1", "ses_1")

	if err := a.RespondToRequest(context.Background(), "w-1", "per_1", event.DecisionAccept); err != nil {
		t.Fatalf("RespondToRequest: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %s, want POST", gotMethod)
	}
	if gotPath != "/api/session/ses_1/permission/per_1/reply" {
		t.Fatalf("path = %s, want the v2 session-scoped reply endpoint", gotPath)
	}
	if gotBody.Reply != "once" {
		t.Fatalf("reply = %q, want DecisionAccept to map to \"once\"", gotBody.Reply)
	}
}

func TestOpencodeReplyMapsEveryDecision(t *testing.T) {
	cases := map[event.Decision]string{
		event.DecisionAccept:           "once",
		event.DecisionAcceptForSession: "always",
		event.DecisionDecline:          "reject",
		// OpenCode's reply vocabulary has no distinct cancel-and-abort — both
		// DevDeck denial variants collapse onto the same "reject".
		event.DecisionCancel: "reject",
	}
	for d, want := range cases {
		if got := opencodeReply(d); got != want {
			t.Errorf("opencodeReply(%s) = %q, want %q", d, got, want)
		}
	}
}

// RespondToRequest on a thread with no live session must be a benign no-op
// (mirrors codex/claude's own not-found path), not a panic or a call into a
// zero-value baseURL.
func TestRespondToRequestOnUnknownThreadIsANoop(t *testing.T) {
	a := newTestAdapter("http://unused.invalid")
	if err := a.RespondToRequest(context.Background(), "w-missing", "per_1", event.DecisionAccept); err != nil {
		t.Fatalf("RespondToRequest on an unknown thread must be a no-op, got: %v", err)
	}
}

// This is the actual bug closed: dispatchGlobalEvent (fed by subscribeGlobal,
// the ONE subscription in the whole adapter that can ever see a permission
// request) must route a live permission.v2.asked frame to the right session
// and emit a request.opened DevDeck can render as an approval card.
func TestDispatchGlobalEventRoutesPermissionAskedToItsSession(t *testing.T) {
	a := newTestAdapter("http://unused.invalid")
	a.byOpencode["ses_1"] = newTestSession("w-1", "ses_1")

	payload := []byte(`{"id":"evt_1","type":"permission.v2.asked","data":{"id":"per_1","sessionID":"ses_1",` +
		`"action":"bash","resources":["echo hi"],"source":{"type":"tool","messageID":"msg_1","callID":"call_1"}}}`)
	a.dispatchGlobalEvent(payload)

	select {
	case e := <-a.events:
		if e.Type != event.RequestOpened {
			t.Fatalf("event type = %s, want request.opened", e.Type)
		}
		if e.ThreadID != "w-1" {
			t.Fatalf("ThreadID = %q, want the session's own DevDeck thread", e.ThreadID)
		}
	default:
		t.Fatal("dispatchGlobalEvent must emit a request.opened event")
	}
}

// A frame naming a session this adapter doesn't own (another instance's,
// server-wide chatter with no sessionID, or a stopped session) must be
// dropped silently — the global bus is server-wide, not this adapter's own.
func TestDispatchGlobalEventDropsUnknownSession(t *testing.T) {
	a := newTestAdapter("http://unused.invalid")

	payload := []byte(`{"id":"evt_1","type":"permission.v2.asked","data":{"id":"per_1","sessionID":"ses_other",` +
		`"action":"bash","resources":["echo hi"]}}`)
	a.dispatchGlobalEvent(payload)

	select {
	case e := <-a.events:
		t.Fatalf("no session owns ses_other; must not emit, got %+v", e)
	default:
	}
}
