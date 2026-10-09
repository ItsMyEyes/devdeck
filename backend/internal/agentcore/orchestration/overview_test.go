package orchestration

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func officeEvent(seq uint64, typ EventType, payload string) Event {
	return Event{Seq: seq, EventID: "e", ThreadID: "w-1", Type: typ, CreatedAt: int64(seq), Payload: json.RawMessage(payload)}
}

func TestOfficeOverviewReplayAndImmutableSnapshots(t *testing.T) {
	events := []Event{
		officeEvent(1, EvtThreadCreated, `{"instanceId":"claude:default"}`),
		officeEvent(2, EvtThreadTurnStartRequested, `{"text":"secret prompt"}`),
		officeEvent(3, EvtThreadActivityAppended, `{"type":"task.started","agentId":"child","payload":{"taskId":"task","title":"Inspect tests","prompt":"secret"}}`),
		officeEvent(4, EvtThreadActivityAppended, `{"type":"task.progress","agentId":"child","payload":{"taskId":"task","usage":{"totalTokens":12},"lastToolName":"Read"}}`),
	}
	first := Apply(NewState(), events)
	encodedBefore, _ := json.Marshal(first)
	last := officeEvent(5, EvtThreadActivityAppended, `{"type":"task.completed","agentId":"child","payload":{"taskId":"task","status":"completed","usage":{"totalTokens":10},"summary":"secret output"}}`)
	live := Apply(first, []Event{last})
	replay := Apply(NewState(), append(events, last))
	if !reflect.DeepEqual(live, replay) {
		t.Fatal("replay differs")
	}
	encodedAfter, _ := json.Marshal(first)
	if string(encodedBefore) != string(encodedAfter) {
		t.Fatal("mutated previous snapshot")
	}
	child := live.Threads["w-1"].Overview.Subagents["child"]
	if child.Status != "completed" || child.Tokens == nil || *child.Tokens != 12 {
		t.Fatalf("bad child: %+v", child)
	}
}

func TestOfficeOverviewDoesNotTreatAProcessAsWork(t *testing.T) {
	s := Apply(NewState(), []Event{officeEvent(1, EvtThreadCreated, `{}`), officeEvent(2, EvtThreadSessionSet, `{"status":"running"}`)})
	if got := s.Threads["w-1"].OfficeStatus(); got != "idle" {
		t.Fatalf("got %s", got)
	}
	s = Apply(s, []Event{officeEvent(3, EvtThreadTurnStartRequested, `{}`), officeEvent(4, EvtThreadActivityAppended, `{"type":"runtime.error","payload":{"message":"secret"}}`)})
	if got := s.Threads["w-1"].OfficeStatus(); got != "error" {
		t.Fatalf("got %s", got)
	}
	s = Apply(s, []Event{officeEvent(5, EvtThreadTurnStartRequested, `{}`)})
	if got := s.Threads["w-1"].OfficeStatus(); got != "running" {
		t.Fatalf("got %s", got)
	}
}

func TestOfficeOverviewSeparatesQuestionsAndApprovalsAndClearsStoppedTasks(t *testing.T) {
	s := Apply(NewState(), []Event{
		officeEvent(1, EvtThreadCreated, `{}`),
		officeEvent(2, EvtThreadTurnStartRequested, `{}`),
		officeEvent(3, EvtThreadActivityAppended, `{"type":"user-input.requested","requestId":"q","payload":{"questions":[{"question":"secret"}]}}`),
		officeEvent(4, EvtThreadActivityAppended, `{"type":"request.opened","requestId":"a","payload":{"args":{"password":"secret"}}}`),
		officeEvent(5, EvtThreadActivityAppended, `{"type":"task.started","agentId":"child","payload":{"taskId":"child"}}`),
	})
	if s.Threads["w-1"].OfficeStatus() != "waiting" || s.Threads["w-1"].Overview.Pending["q"] != "question" || s.Threads["w-1"].Overview.Pending["a"] != "approval" {
		t.Fatal("lost pending type")
	}
	s = Apply(s, []Event{officeEvent(6, EvtThreadUserInputResponseRequested, `{"requestId":"q"}`)})
	if s.Threads["w-1"].OfficeStatus() != "waiting" {
		t.Fatal("approval still outstanding")
	}
	raw, _ := json.Marshal(s.Threads["w-1"].Overview)
	if strings.Contains(string(raw), "secret") {
		t.Fatal("overview retained private payload")
	}
	s = Apply(s, []Event{officeEvent(7, EvtThreadSessionSet, `{"status":"stopped","clearPending":true}`)})
	if s.Threads["w-1"].OfficeStatus() != "stopped" || s.Threads["w-1"].Overview.Subagents["child"].Status != "stopped" {
		t.Fatal("stopped tasks remain live")
	}
}

func TestOfficeOverviewSessionExitWithPendingEngineRequest(t *testing.T) {
	s := Apply(NewState(), []Event{
		officeEvent(1, EvtThreadCreated, `{}`),
		officeEvent(2, EvtThreadSessionSet, `{"status":"waiting","pendingRequestAdd":"approval"}`),
		officeEvent(3, EvtThreadSessionSet, `{"status":"stopped"}`),
	})
	if got := s.Threads["w-1"].OfficeStatus(); got != "stopped" {
		t.Fatalf("exited session is %s", got)
	}
}

func TestOfficeOverviewPreservesChildOutcomes(t *testing.T) {
	for _, status := range []string{"completed", "failed", "stopped"} {
		t.Run(status, func(t *testing.T) {
			s := Apply(NewState(), []Event{
				officeEvent(1, EvtThreadCreated, `{}`),
				officeEvent(2, EvtThreadActivityAppended, `{"type":"task.started","agentId":"child","payload":{"taskId":"child"}}`),
				officeEvent(3, EvtThreadActivityAppended, `{"type":"task.completed","agentId":"child","payload":{"taskId":"child","status":"`+status+`"}}`),
			})
			if got := s.Threads["w-1"].Overview.Subagents["child"].Status; got != status {
				t.Fatalf("got %s, want %s", got, status)
			}
		})
	}
}
