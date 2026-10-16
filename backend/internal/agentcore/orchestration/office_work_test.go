package orchestration

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestOfficeWorkLifecycleAndActorIsolation(t *testing.T) {
	events := []Event{
		officeEvent(1, EvtThreadCreated, `{"instanceId":"codex:default"}`),
		officeEvent(2, EvtThreadTurnStartRequested, `{}`),
		officeEvent(3, EvtThreadActivityAppended, `{"type":"turn.started","provider":"codex","turnId":"t1"}`),
		officeEvent(4, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","turnId":"t1","itemId":"a","payload":{"itemType":"command_execution"}}`),
		officeEvent(5, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","turnId":"t1","itemId":"b","payload":{"itemType":"file_change"}}`),
		officeEvent(6, EvtThreadActivityAppended, `{"type":"task.started","agentId":"child","payload":{"taskId":"child"}}`),
		officeEvent(7, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","agentId":"child","turnId":"ct","itemId":"a","payload":{"itemType":"command_execution"}}`),
	}
	s := Apply(NewState(), events)
	before, _ := json.Marshal(s)
	w := s.Threads["w-1"].Overview.Work
	if w.Kind != "file_change" || w.ActiveCount != 2 || w.Coverage != "item_lifecycle" {
		t.Fatalf("work: %+v", w)
	}
	tail := []Event{
		officeEvent(8, EvtThreadTurnStartRequested, `{"text":"steering"}`),
		officeEvent(9, EvtThreadActivityAppended, `{"type":"item.completed","provider":"codex","turnId":"t1","itemId":"b","payload":{"itemType":"file_change"}}`),
		officeEvent(10, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","turnId":"t1","itemId":"b","payload":{"itemType":"file_change"}}`),
	}
	s2 := Apply(s, tail)
	if got := s2.Threads["w-1"].Overview.Work; got.Kind != "command" || got.ActiveCount != 1 {
		t.Fatalf("steering/late start lost identity: %+v", got)
	}
	if got := s2.Threads["w-1"].Overview.Subagents["child"].Work; got.ActiveCount != 1 {
		t.Fatalf("child: %+v", got)
	}
	after, _ := json.Marshal(s)
	if string(before) != string(after) {
		t.Fatal("mutated snapshot")
	}
	if !reflect.DeepEqual(s2, Apply(NewState(), append(events, tail...))) {
		t.Fatal("replay differs")
	}
	s3 := Apply(s2, []Event{officeEvent(11, EvtThreadSessionSet, `{"status":"idle","clearPending":true}`)})
	if s3.Threads["w-1"].Overview.Work.ActiveCount != 0 || s3.Threads["w-1"].Overview.Subagents["child"].Work.ActiveCount != 0 {
		t.Fatal("unsettled operations")
	}
}

func TestOfficeWorkProviderCoverage(t *testing.T) {
	for _, provider := range []string{"claude", "antigravity", "unknown", "pi", "opencode", "codex"} {
		t.Run(provider, func(t *testing.T) {
			s := Apply(NewState(), []Event{
				officeEvent(1, EvtThreadCreated, `{"instanceId":"`+provider+`:default"}`),
				officeEvent(2, EvtThreadTurnStartRequested, `{}`),
				officeEvent(3, EvtThreadActivityAppended, `{"type":"item.started","provider":"`+provider+`","turnId":"t","itemId":"a","payload":{"itemType":"tool_call","title":"SECRET"}}`),
			})
			w := s.Threads["w-1"].Overview.Work
			supported := provider == "codex" || provider == "pi" || provider == "opencode"
			if supported && (w.Kind != "tool" || w.ActiveCount != 1) {
				t.Fatalf("missing coverage: %+v", w)
			}
			if !supported && (w.Kind != "generic" || w.ActiveCount != 0 || w.Coverage != "turn_only") {
				t.Fatalf("invented execution: %+v", w)
			}
			raw, _ := json.Marshal(s.Threads["w-1"].Overview)
			if strings.Contains(string(raw), "SECRET") {
				t.Fatal("leaked metadata")
			}
		})
	}
}

func TestOfficeWorkClearsCompletedTaskUpdates(t *testing.T) {
	s := Apply(NewState(), []Event{
		officeEvent(1, EvtThreadCreated, `{"instanceId":"codex:default"}`),
		officeEvent(2, EvtThreadTurnStartRequested, `{}`),
		officeEvent(3, EvtThreadActivityAppended, `{"type":"task.started","agentId":"child","payload":{"taskId":"child"}}`),
		officeEvent(4, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","agentId":"child","turnId":"ct","itemId":"a","payload":{"itemType":"command_execution"}}`),
		officeEvent(5, EvtThreadActivityAppended, `{"type":"task.updated","agentId":"child","payload":{"status":"completed"}}`),
	})
	if s.Threads["w-1"].Overview.Subagents["child"].Work.ActiveCount != 0 {
		t.Fatal("completed task kept active operations")
	}
}
func TestOfficeWorkTurnBoundariesAndDuplicateCompletion(t *testing.T) {
	events := []Event{
		officeEvent(1, EvtThreadCreated, `{"instanceId":"codex:default"}`),
		officeEvent(2, EvtThreadTurnStartRequested, `{}`),
		officeEvent(3, EvtThreadActivityAppended, `{"type":"turn.started","provider":"codex","turnId":"old"}`),
		officeEvent(4, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","turnId":"old","itemId":"a","payload":{"itemType":"command_execution"}}`),
		officeEvent(5, EvtThreadActivityAppended, `{"type":"turn.started","provider":"codex","turnId":"new"}`),
		officeEvent(6, EvtThreadActivityAppended, `{"type":"item.completed","provider":"codex","turnId":"new","itemId":"b","payload":{"itemType":"command_execution"}}`),
		officeEvent(7, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","turnId":"new","itemId":"b","payload":{"itemType":"command_execution"}}`),
		officeEvent(8, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","turnId":"old","itemId":"a","payload":{"itemType":"command_execution"}}`),
	}
	s := Apply(NewState(), events)
	if got := s.Threads["w-1"].Overview.Work; got.ActiveCount != 0 || got.Kind != "generic" {
		t.Fatalf("resurrected: %+v", got)
	}
	for _, status := range []string{"idle", "stopped"} {
		settled := Apply(s, []Event{officeEvent(9, EvtThreadSessionSet, `{"status":"`+status+`"}`), officeEvent(10, EvtThreadActivityAppended, `{"type":"item.started","provider":"codex","turnId":"old","itemId":"a","payload":{"itemType":"command_execution"}}`)})
		if settled.Threads["w-1"].Overview.Work.ActiveCount != 0 {
			t.Fatal("late event revived settled work")
		}
	}
}
