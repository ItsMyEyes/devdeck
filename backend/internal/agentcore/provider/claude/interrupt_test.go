package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// interruptFrame decodes the single control_request InterruptTurn wrote.
func interruptFrame(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("want exactly one frame on stdin, got %d: %q", len(lines), buf.String())
	}
	var frame map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &frame); err != nil {
		t.Fatalf("interrupt frame is not JSON: %v (%q)", err, lines[0])
	}
	return frame
}

func newInterruptSession(t *testing.T) (*adapter, *session, *bytes.Buffer) {
	t.Helper()
	buf := &bytes.Buffer{}
	st := newParseState("w-abc", "claude:default")
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(buf), state: st}
	a := &adapter{
		instanceID: "claude:default",
		events:     make(chan event.Event, 4),
		sessions:   map[string]*session{"w-abc": sess},
	}
	return a, sess, buf
}

// initLine is the CLI's session announcement, carrying the capability list
// this package gates the interrupt shape on. Verbatim shape from a live
// capture against 2.1.241.
func initLine(capabilities string) []byte {
	return []byte(`{"type":"system","subtype":"init","session_id":"58fdb4ad-38da-4929-ad09-6b68032c9442","capabilities":` + capabilities + `}`)
}

// Stop must stop the AGENT, not merely the turn.
//
// The CLI queues user messages behind a running turn, and a plain `interrupt`
// aborts only the turn in flight. Live capture against 2.1.241: send a second
// message while the first is streaming, then interrupt — the abort lands, and
// 200ms later the CLI emits a fresh system/init and runs the queued message
// through to completion with no further input. That is the reported
// "distop benar distop, tetapi tiba tiba jalan lagi": genuinely stopped, then
// running again on its own. The same capture with `cancel_queued` set answers
// `{"still_queued":[],"cancelled":[]}` and stays silent.
func TestInterruptCancelsQueuedMessagesWhenTheCLISupportsIt(t *testing.T) {
	a, sess, buf := newInterruptSession(t)
	parseLine(initLine(`["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`), sess.state)

	if err := a.InterruptTurn(context.Background(), "w-abc", "turn-1"); err != nil {
		t.Fatalf("InterruptTurn: %v", err)
	}

	frame := interruptFrame(t, buf)
	request, _ := frame["request"].(map[string]any)
	if request["subtype"] != "interrupt" {
		t.Fatalf("wrong subtype: %+v", frame)
	}
	if request["cancel_queued"] != true {
		t.Fatalf("interrupt did not ask the CLI to drop queued messages — the next one runs itself right after the abort: %+v", frame)
	}
	// The control envelope documents request_id as the key the CLI's
	// control_response echoes; without one the receipt (still_queued /
	// cancelled) cannot be correlated to this request at all.
	if id, _ := frame["request_id"].(string); id == "" {
		t.Fatalf("interrupt carried no request_id, so its receipt is uncorrelatable: %+v", frame)
	}
}

// The flag rides ONLY on a build that announced it. A Stop that a strict
// schema rejected outright would be a worse failure than the one it fixes, so
// a CLI whose system/init lists no capabilities gets the exact frame it has
// always understood.
func TestInterruptOmitsCancelQueuedWhenTheCLIDidNotAnnounceIt(t *testing.T) {
	for _, tc := range []struct {
		name string
		init string
	}{
		{"no capabilities field at all", `null`},
		{"capabilities without this one", `["interrupt_receipt_v1","msg_lifecycle_v1"]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, sess, buf := newInterruptSession(t)
			parseLine(initLine(tc.init), sess.state)

			if err := a.InterruptTurn(context.Background(), "w-abc", "turn-1"); err != nil {
				t.Fatalf("InterruptTurn: %v", err)
			}
			frame := interruptFrame(t, buf)
			request, _ := frame["request"].(map[string]any)
			if request["subtype"] != "interrupt" {
				t.Fatalf("wrong subtype: %+v", frame)
			}
			if _, present := request["cancel_queued"]; present {
				t.Fatalf("sent cancel_queued to a CLI that never announced support for it: %+v", frame)
			}
		})
	}
}

// A session that never saw system/init (interrupted before the CLI announced
// itself) must still send a usable interrupt rather than panic on a nil map.
func TestInterruptBeforeInitStillSendsAPlainInterrupt(t *testing.T) {
	a, _, buf := newInterruptSession(t)

	if err := a.InterruptTurn(context.Background(), "w-abc", "turn-1"); err != nil {
		t.Fatalf("InterruptTurn: %v", err)
	}
	request, _ := interruptFrame(t, buf)["request"].(map[string]any)
	if request["subtype"] != "interrupt" {
		t.Fatalf("wrong subtype before init: %+v", request)
	}
	if _, present := request["cancel_queued"]; present {
		t.Fatal("assumed a capability the CLI has not announced yet")
	}
}
