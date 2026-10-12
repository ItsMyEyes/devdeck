package orchestration

import (
	"context"
	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestArchiveBlocksTurnsUntilConfirmedAndExplicitResume(t *testing.T) {
	s := Apply(NewState(), []Event{officeEvent(1, EvtThreadCreated, `{}`)})
	command := func(typ string) Command {
		return Command{Type: CommandType(typ), ThreadID: "w-1", Payload: json.RawMessage(`{"text":"continue"}`)}
	}
	events, err := Decide(s, command("thread.archive"), 10, func() string { return "archive" })
	if err != nil {
		t.Fatal(err)
	}
	s = Apply(s, events)
	if _, err = Decide(s, command("thread.turn.start"), 11, func() string { return "turn" }); err == nil {
		t.Fatal("turn accepted while archive pending")
	}
	events, err = Decide(s, command("thread.archive.complete"), 12, func() string { return "done" })
	if err != nil {
		t.Fatal(err)
	}
	s = Apply(s, events)
	if _, err = Decide(s, command("thread.turn.start"), 13, func() string { return "turn" }); err == nil {
		t.Fatal("archived turn accepted")
	}
	replay := Apply(NewState(), append([]Event{officeEvent(1, EvtThreadCreated, `{}`)}, events...))
	if _, err = Decide(replay, command("thread.turn.start"), 14, func() string { return "turn" }); err == nil {
		t.Fatal("replay lost archive")
	}
	events, err = Decide(s, command("thread.resume"), 15, func() string { return "resume" })
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if IntentEvents[e.Type] {
			t.Fatal("resume starts provider")
		}
	}
	s = Apply(s, events)
	if s.Threads["w-1"].TurnInFlight {
		t.Fatal("resume starts turn")
	}
	if _, err = Decide(s, command("thread.turn.start"), 16, func() string { return "turn" }); err != nil {
		t.Fatal(err)
	}
}
func TestArchiveFailureAllowsRetryWithoutChangingTurnState(t *testing.T) {
	s := Apply(NewState(), []Event{officeEvent(1, EvtThreadCreated, `{}`), officeEvent(2, EvtThreadTurnStartRequested, `{}`)})
	cmd := Command{Type: CommandType("thread.archive"), ThreadID: "w-1"}
	e, err := Decide(s, cmd, 3, func() string { return "a" })
	if err != nil {
		t.Fatal(err)
	}
	s = Apply(s, e)
	e, err = Decide(s, Command{Type: CommandType("thread.archive.failed"), ThreadID: "w-1"}, 4, func() string { return "f" })
	if err != nil {
		t.Fatal(err)
	}
	s = Apply(s, e)
	if !s.Threads["w-1"].TurnInFlight {
		t.Fatal("failed stop falsely settled work")
	}
	e, err = Decide(s, cmd, 5, func() string { return "retry" })
	if err != nil || len(e) == 0 {
		t.Fatalf("cannot retry: %v", err)
	}
}

func TestArchiveLateProviderStateCannotReviveArchivedThread(t *testing.T) {
	s := Apply(NewState(), []Event{officeEvent(1, EvtThreadCreated, `{}`), officeEvent(2, EvtThreadArchiveRequested, `{}`), officeEvent(3, EvtThreadArchived, `{}`), officeEvent(4, EvtThreadSessionSet, `{"status":"running","pendingRequestAdd":"old"}`)})
	if s.Threads["w-1"].Status != ThreadStopped || len(s.Threads["w-1"].PendingRequests) > 0 {
		t.Fatal("late provider revived archive")
	}
	for _, typ := range []CommandType{CmdThreadArchive, CmdThreadResume} {
		if !ClientDispatchable[typ] {
			t.Fatal("lifecycle not client dispatchable")
		}
	}
	if ClientDispatchable[CmdThreadArchiveComplete] || ClientDispatchable[CmdThreadArchiveFailed] {
		t.Fatal("client can forge archive confirmation")
	}
}

func TestNoopResumeReceiptCannotResumeALaterArchive(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()
	dispatchCreate(t, e, "w-abc")
	resume := Command{CommandID: "noop-resume", Type: CmdThreadResume, ThreadID: "w-abc"}
	if _, err := e.Dispatch(context.Background(), resume); err != nil {
		t.Fatal(err)
	}
	for _, typ := range []CommandType{CmdThreadArchive, CmdThreadArchiveComplete} {
		if _, err := e.Dispatch(context.Background(), Command{CommandID: string(typ), Type: typ, ThreadID: "w-abc"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.Dispatch(context.Background(), resume); err != nil {
		t.Fatal(err)
	}
	if e.State().Threads["w-abc"].ArchivedAt == 0 {
		t.Fatal("repeated no-op resume affected a later archive")
	}
}

func TestArchiveFenceDropsQueuedProviderEventsAfterResume(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()
	dispatchCreate(t, e, "w-abc")
	ctx := context.Background()
	cutoff := time.Now()
	for _, cmd := range []Command{{CommandID: "end", Type: CmdThreadArchive, ThreadID: "w-abc"}, {CommandID: "confirm", Type: CmdThreadArchiveComplete, ThreadID: "w-abc", Payload: mustJSON(map[string]any{"providerEventCutoff": cutoff.UnixNano()})}, {CommandID: "resume", Type: CmdThreadResume, ThreadID: "w-abc"}} {
		if _, err := e.Dispatch(ctx, cmd); err != nil {
			t.Fatal(err)
		}
	}
	n := 0
	in := NewIngestion(e, approval.NoopBroker{}, func() string { n++; return fmt.Sprint("ingest-", n) })
	for _, typ := range []event.Type{event.SessionStarted, event.RequestOpened, event.UserInputRequested, event.TurnCompleted, event.TurnProposedCompleted, event.TaskStarted} {
		ev := event.Event{ThreadID: "w-abc", Type: typ, CreatedAt: cutoff.Add(-time.Second), RequestID: "old"}
		if typ == event.TurnProposedCompleted {
			ev.Payload = &event.ProposedPlanPayload{PlanMarkdown: "obsolete"}
		}
		if err := in.Inject(ctx, ev); err != nil {
			t.Fatal(err)
		}
		state := e.State().Threads["w-abc"]
		if state.Status != ThreadIdle || len(state.PendingRequests) > 0 || state.ProposedPlan != nil {
			t.Fatalf("late %s revived resumed session: %+v", typ, state)
		}
	}
	if err := in.Inject(ctx, event.Event{ThreadID: "w-abc", Type: event.SessionStarted, CreatedAt: cutoff.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	if e.State().Threads["w-abc"].Status != ThreadRunning {
		t.Fatal("fresh provider event rejected")
	}
}
func TestArchivedPlanProposalCannotRestoreResponse(t *testing.T) {
	s := Apply(NewState(), []Event{officeEvent(1, EvtThreadCreated, `{}`), officeEvent(2, EvtThreadArchiveRequested, `{}`), officeEvent(3, EvtThreadArchived, `{}`), officeEvent(4, EvtThreadPlanProposed, `{"planMarkdown":"late"}`)})
	if s.Threads["w-1"].ProposedPlan != nil {
		t.Fatal("archived plan restored response")
	}
}
