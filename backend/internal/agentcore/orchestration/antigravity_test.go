package orchestration

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

func TestAntigravityCreationAndPermissions(t *testing.T) {
	s := NewState()
	evts, err := Decide(s, Command{Type: CmdThreadCreate, ThreadID: "agy", Payload: mustJSON(map[string]any{"instanceId": "antigravity:default"})}, 1, func() string { return "evt" })
	if err != nil {
		t.Fatal(err)
	}
	s = Apply(s, evts)
	if s.Threads["agy"].Mode != provider.ModeAuto {
		t.Fatal("new Antigravity thread must use native permissions")
	}
	var payload map[string]any
	_ = json.Unmarshal(evts[0].Payload, &payload)
	if payload["mode"] != "auto" {
		t.Fatal("default must be durable and visible to the frontend")
	}
	for _, mode := range []provider.RuntimeMode{provider.ModeAuto, provider.ModeFullAccess, provider.ModeApprovalRequired, provider.ModeAutoAcceptEdits} {
		_, err := Decide(s, Command{Type: CmdThreadRuntimeModeSet, ThreadID: "agy", Payload: mustJSON(RuntimeModeSetPayload{Mode: mode})}, 2, func() string { return "evt" })
		allowed := mode == provider.ModeAuto || mode == provider.ModeFullAccess
		if (err == nil) != allowed {
			t.Fatalf("mode %s: %v", mode, err)
		}
	}
}

func TestAntigravitySwitchClearsForeignResumeCursor(t *testing.T) {
	s := NewState()
	s.Threads["chat"] = &Thread{ID: "chat", InstanceID: "claude:default", Mode: provider.ModeApprovalRequired, ResumeCursor: json.RawMessage(`"claude-session"`)}
	cmd := Command{Type: CmdThreadTurnStart, ThreadID: "chat", Payload: mustJSON(TurnStartPayload{Text: "hello", Model: provider.ModelSelection{InstanceID: "antigravity:default"}})}
	evts, err := Decide(s, cmd, 1, func() string { return "evt" })
	if err != nil {
		t.Fatal(err)
	}
	s = Apply(s, evts)
	thread := s.Threads["chat"]
	if thread.Mode != provider.ModeAuto || thread.InstanceID != "antigravity:default" || len(thread.ResumeCursor) != 0 {
		t.Fatalf("incorrect switch: %+v", thread)
	}
	if _, err := Decide(s, cmd, 2, func() string { return "evt" }); err == nil {
		t.Fatal("a second send must not disturb the running turn")
	}
	thread.TurnInFlight = false
	p := TurnStartPayload{Text: "image", Attachments: []provider.Attachment{{ID: "a"}}}
	if _, err := Decide(s, Command{Type: CmdThreadTurnStart, ThreadID: "chat", Payload: mustJSON(p)}, 3, func() string { return "evt" }); err != nil {
		t.Fatalf("image attachment rejected: %v", err)
	}
}

func TestLatePreviousProviderCannotSettleAntigravity(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()
	ctx := context.Background()
	_, err := e.Dispatch(ctx, Command{CommandID: "create-agy", Type: CmdThreadCreate, ThreadID: "chat", Payload: mustJSON(map[string]any{"instanceId": "antigravity:default"})})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.Dispatch(ctx, Command{CommandID: "send-agy", Type: CmdThreadTurnStart, ThreadID: "chat", Payload: mustJSON(TurnStartPayload{Text: "work"})})
	if err != nil {
		t.Fatal(err)
	}
	in := NewIngestion(e, nil, func() string { return "late" })
	if err := in.Inject(ctx, event.Event{ThreadID: "chat", InstanceID: "claude:default", Type: event.SessionExited, Payload: &event.SessionExitedPayload{Reason: "stopped"}}); err != nil {
		t.Fatal(err)
	}
	if thread, _ := e.State().Thread("chat"); thread.Status != ThreadRunning {
		t.Fatal("old provider settled the replacement")
	}
}

func TestAntigravityReadySessionIsIdleAndActiveInitKeepsWorking(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()
	ctx := context.Background()
	_, err := e.Dispatch(ctx, Command{CommandID: "create", Type: CmdThreadCreate, ThreadID: "chat", Payload: mustJSON(map[string]any{"instanceId": "antigravity:default"})})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	in := NewIngestion(e, nil, func() string { n++; return fmt.Sprint(n) })
	ready := event.Event{ThreadID: "chat", InstanceID: "antigravity:default", Type: event.SessionStarted, Payload: &event.SessionStartedPayload{}}
	if err := in.Inject(ctx, ready); err != nil {
		t.Fatal(err)
	}
	if thread, _ := e.State().Thread("chat"); thread.Status != ThreadIdle {
		t.Fatal("ready session looked busy", thread.Status)
	}
	_, err = e.Dispatch(ctx, Command{CommandID: "turn", Type: CmdThreadTurnStart, ThreadID: "chat", Payload: mustJSON(TurnStartPayload{Text: "work"})})
	if err != nil {
		t.Fatal(err)
	}
	ready.TurnID = "turn"
	if err := in.Inject(ctx, ready); err != nil {
		t.Fatal(err)
	}
	if thread, _ := e.State().Thread("chat"); thread.Status != ThreadRunning || !thread.TurnInFlight {
		t.Fatal("native init cleared working status")
	}
}
