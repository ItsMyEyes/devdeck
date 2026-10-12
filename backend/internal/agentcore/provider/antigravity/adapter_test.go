package antigravity

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// A fake executable exercises real pipe/process lifetimes without credentials
// or paid requests. The shell only execs this test binary on Unix.
func fakeCLI(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "agy")
	script := "#!/bin/sh\nexec '" + strings.ReplaceAll(exe, "'", "'\\''") + "' -test.run=TestCLIHelper -- \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCLIHelper(t *testing.T) {
	if os.Getenv("DEVDECK_AGY_FIXTURE") != "1" {
		return
	}
	args := os.Args[slices.Index(os.Args, "--")+1:]
	if slices.Contains(args, "--version") {
		fmt.Println("agy v1.3.3")
		os.Exit(0)
	}
	var prompt string
	if i := slices.Index(args, "-p"); i >= 0 {
		prompt = args[i+1]
	}
	log, _ := os.OpenFile("commands.ndjson", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	_ = json.NewEncoder(log).Encode(map[string]any{"args": args, "home": os.Getenv("HOME"), "override": os.Getenv("AGY_OVERRIDE")})
	_ = log.Close()
	if prompt == "auth" {
		fmt.Fprintln(os.Stderr, "authentication required; run agy interactively")
		os.Exit(1)
	}
	if prompt == "early" {
		os.Exit(0)
	}
	if prompt == "malformed" {
		fmt.Println("not JSON")
		os.Exit(0)
	}
	id := "conversation-" + os.Getenv("AGY_THREAD")
	if i := slices.Index(args, "--conversation"); i >= 0 {
		id = args[i+1]
	}
	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(map[string]any{"event": "init", "conversation_id": id, "init": map[string]any{"cwd": "fixture"}})
	if prompt == "failed-tool" {
		_ = enc.Encode(map[string]any{"event": "step_update", "step_update": map[string]any{"conversation_id": id, "step_index": 0, "state": "DONE", "step_type": "system_message"}})
		for _, state := range []string{"ACTIVE", "ERROR"} {
			tool := map[string]any{"name": "read_url_content"}
			if state == "ERROR" {
				tool["error"] = map[string]string{"type": "TOOL_ERROR", "message": "status code 404"}
			}
			_ = enc.Encode(map[string]any{"event": "step_update", "step_update": map[string]any{"conversation_id": id, "step_index": 1, "state": state, "step_type": "tool", "tool_name": "read_url_content", "tool_info": tool}})
		}
	}
	if prompt == "wait" || prompt == "ignore" {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt)
		_ = enc.Encode(map[string]any{"event": "step_update", "step_update": map[string]any{"conversation_id": id, "step_index": 1, "state": "ACTIVE", "step_type": "tool", "tool_name": "run_command"}})
		for {
			select {
			case <-ch:
				if prompt == "ignore" {
					continue
				}
				_ = enc.Encode(map[string]any{"event": "result", "result": map[string]any{"conversation_id": id, "status": "INTERRUPTED"}})
				os.Exit(0)
			case <-time.After(20 * time.Millisecond):
				if _, err := os.Stat("release"); err == nil {
					goto finish
				}
			}
		}
	}
finish:
	if prompt == "burst" {
		for range 1024 {
			_ = enc.Encode(map[string]any{"event": "step_update", "step_update": map[string]any{"conversation_id": id, "step_index": 2, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "x"}})
		}
	}
	if prompt == "native-denial" {
		fmt.Fprintln(os.Stderr, "\x00Action denied by native permission policy; configure agy permissions")
	}
	if prompt == "descendant" {
		child := exec.Command("/bin/sleep", "30")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(5)
		}
	}
	for i, text := range []string{"hello", " world"} {
		state := "ACTIVE"
		if i == 1 {
			state = "DONE"
		}
		_ = enc.Encode(map[string]any{"event": "step_update", "step_update": map[string]any{"conversation_id": id, "step_index": 2, "state": state, "step_type": "agent_response", "text_delta": text}})
	}
	u := wireUsage{Input: 100, Output: 10, Cache: 50}
	if prompt == "second" {
		u = wireUsage{Input: 160, Output: 15, Cache: 70}
	}
	status := "SUCCESS"
	if prompt == "unknown" {
		status = "FUTURE_STATUS"
	}
	if prompt == "waiting" {
		status = "WAITING"
	}
	_ = enc.Encode(map[string]any{"event": "result", "result": map[string]any{"conversation_id": id, "status": status, "response": "hello world", "usage": u}})
	if prompt == "exit-after-success" {
		os.Exit(3)
	}
	os.Exit(0)
}

func testAdapter(t *testing.T) *adapter {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	a := newAdapter(ctx, "antigravity:test", Config{BinaryName: fakeCLI(t)}, map[string]string{"DEVDECK_AGY_FIXTURE": "1", "AGY_OVERRIDE": "instance"})
	t.Cleanup(func() {
		cancel()
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		for {
			select {
			case _, ok := <-a.Events():
				if !ok {
					return
				}
			case <-deadline.C:
				t.Error("adapter shutdown timed out")
				return
			}
		}
	})
	return a
}
func start(t *testing.T, a *adapter, thread string) string {
	t.Helper()
	cwd := t.TempDir()
	_, err := a.StartSession(context.Background(), provider.SessionStartInput{ThreadID: thread, Cwd: cwd, Env: map[string]string{"AGY_THREAD": thread, "AGY_OVERRIDE": "session"}})
	if err != nil {
		t.Fatal(err)
	}
	return cwd
}
func send(t *testing.T, a *adapter, thread, turnID, text string) {
	t.Helper()
	if _, err := a.SendTurn(context.Background(), provider.SendTurnInput{ThreadID: thread, TurnID: turnID, Text: text}); err != nil {
		t.Fatal(err)
	}
}
func collectUntil(t *testing.T, a *adapter, typ event.Type, thread string) []event.Event {
	t.Helper()
	timer := time.NewTimer(6 * time.Second)
	defer timer.Stop()
	var out []event.Event
	for {
		select {
		case e, ok := <-a.Events():
			if !ok {
				t.Fatal("events closed early")
			}
			out = append(out, e)
			if e.Type == typ && (thread == "" || e.ThreadID == thread) {
				return out
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %s %s: %+v", typ, thread, out)
		}
	}
}
func completion(t *testing.T, events []event.Event) *event.TurnCompletedPayload {
	t.Helper()
	for _, e := range events {
		if e.Type == event.TurnCompleted {
			return e.Payload.(*event.TurnCompletedPayload)
		}
	}
	t.Fatal("missing completion")
	return nil
}

// agy 1.3.3 emits ERROR for failed tools, then continues to a SUCCESS result.
func TestFailedToolDoesNotInterruptTurn(t *testing.T) {
	a := testAdapter(t)
	start(t, a, "tool-error")
	send(t, a, "tool-error", "turn", "failed-tool")
	events := collectUntil(t, a, event.TurnCompleted, "tool-error")
	if got := completion(t, events); got.Status != "completed" {
		t.Fatalf("recoverable tool error interrupted turn: %+v", events)
	}
	var failedTools int
	var text string
	for _, e := range events {
		switch e.Type {
		case event.RuntimeError, event.RuntimeWarning:
			t.Fatalf("valid CLI step produced runtime error/warning: %+v", e.Payload)
		case event.ItemCompleted:
			p := e.Payload.(*event.ItemCompletedPayload)
			if p.ItemType == event.ItemToolCall {
				if p.Status != "failed" || !strings.Contains(string(p.Detail), "status code 404") {
					t.Fatalf("lost tool failure: %+v", p)
				}
				failedTools++
			}
		case event.ContentDelta:
			text += e.Payload.(*event.ContentDeltaPayload).Text
		}
	}
	if failedTools != 1 || text != "hello world" || a.ListSessions()[0].ProviderSessionID != "conversation-tool-error" {
		t.Fatalf("lost/duplicated failure, recovery text, or cursor: %d %q", failedTools, text)
	}
}

func TestStreamResumeAndCumulativeUsage(t *testing.T) {
	a := testAdapter(t)
	cwd := start(t, a, "one")
	send(t, a, "one", "turn-1", "first")
	events := collectUntil(t, a, event.TurnCompleted, "one")
	var text string
	var resume json.RawMessage
	for _, e := range events {
		if e.Type == event.ContentDelta {
			text += e.Payload.(*event.ContentDeltaPayload).Text
		}
		if e.Type == event.SessionStarted {
			resume = e.Payload.(*event.SessionStartedPayload).Resume
		}
	}
	if text != "hello world" {
		t.Fatalf("duplicated/lost response: %q", text)
	}
	if got := completion(t, events); got.Status != "completed" || got.Usage.InputTokens != 100 {
		t.Fatalf("completion: %+v", got)
	}
	if a.ListSessions()[0].ProviderSessionID != "conversation-one" {
		t.Fatal("native ID missing")
	}
	if err := a.StopSession(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.StartSession(context.Background(), provider.SessionStartInput{ThreadID: "one", Cwd: cwd, ResumeCursor: resume}); err != nil {
		t.Fatal(err)
	}
	send(t, a, "one", "turn-2", "second")
	got := completion(t, collectUntil(t, a, event.TurnCompleted, "one"))
	if got.Usage.InputTokens != 60 || got.Usage.OutputTokens != 5 || got.Usage.CacheReadTokens != 20 {
		t.Fatalf("double-counted resumed usage: %+v", got.Usage)
	}
	data, err := os.ReadFile(filepath.Join(cwd, "commands.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	var log struct {
		Args     []string
		Override string
	}
	if err := json.Unmarshal([]byte(lines[0]), &log); err != nil {
		t.Fatal(err)
	}
	if log.Override != "session" {
		t.Fatalf("environment not layered: %+v", log)
	}
	if strings.Contains(lines[0], "--continue") || strings.Contains(lines[0], "--conversation") {
		t.Fatal("new conversation was resumed")
	}
	if !strings.Contains(lines[1], "--conversation") || !strings.Contains(lines[1], "conversation-one") || strings.Contains(lines[1], "--continue") {
		t.Fatalf("unsafe resume args: %s", lines[1])
	}
}

func TestSlowConsumerKeepsCompletionAndEveryDelta(t *testing.T) {
	a := testAdapter(t)
	start(t, a, "burst")
	send(t, a, "burst", "turn", "burst")
	deadline := time.Now().Add(5 * time.Second)
	for {
		a.mu.Lock()
		done := a.sessions["burst"].active == nil
		a.mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("producer stalled behind full event channel")
		}
		time.Sleep(10 * time.Millisecond)
	}
	events := collectUntil(t, a, event.TurnCompleted, "burst")
	var text string
	for _, e := range events {
		if e.Type == event.ContentDelta {
			text += e.Payload.(*event.ContentDeltaPayload).Text
		}
	}
	if text != strings.Repeat("x", 1024)+"hello world" || completion(t, events).Status != "completed" {
		t.Fatal("lost stream or completion", len(text))
	}
}

func TestDescendantCannotHoldTurnOpen(t *testing.T) {
	a := testAdapter(t)
	start(t, a, "child")
	send(t, a, "child", "turn", "descendant")
	if got := completion(t, collectUntil(t, a, event.TurnCompleted, "child")); got.Status != "completed" {
		t.Fatal(got)
	}
}

func TestExplicitCLIDefaultClearsPreviousModelAndEffort(t *testing.T) {
	a := testAdapter(t)
	cwd := start(t, a, "default")
	for i, model := range []provider.ModelSelection{
		{InstanceID: "antigravity:test", Model: "selected", Options: map[string]any{"effort": "high"}},
		{InstanceID: "antigravity:test"},
	} {
		_, err := a.SendTurn(context.Background(), provider.SendTurnInput{ThreadID: "default", TurnID: fmt.Sprint(i), Text: "first", Model: model})
		if err != nil {
			t.Fatal(err)
		}
		collectUntil(t, a, event.TurnCompleted, "default")
	}
	data, err := os.ReadFile(filepath.Join(cwd, "commands.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if strings.Contains(lines[1], "--model") || strings.Contains(lines[1], "--effort") {
		t.Fatal("CLI default inherited previous overrides", lines[1])
	}
}

func TestNativeDenialVisibleEvenOnSuccess(t *testing.T) {
	a := testAdapter(t)
	start(t, a, "denial")
	send(t, a, "denial", "turn", "native-denial")
	events := collectUntil(t, a, event.TurnCompleted, "denial")
	if completion(t, events).Status != "completed" {
		t.Fatal("native soft denial must retain native result")
	}
	found := false
	for _, e := range events {
		if e.Type == event.RuntimeWarning {
			msg := e.Payload.(*event.WarningPayload).Message
			found = strings.Contains(msg, "Action denied") && !strings.ContainsRune(msg, 0)
		}
	}
	if !found {
		t.Fatal("native permission diagnostic missing")
	}
}

func TestShutdownDoesNotWaitForEventConsumer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	a := newAdapter(ctx, "test", Config{}, nil)
	a.mu.Lock()
	for range 1024 {
		a.emitLocked(envelope("test", "thread", "turn", event.TurnCompleted))
	}
	a.mu.Unlock()
	cancel()
	deadline := time.Now().Add(time.Second)
	for {
		a.mu.Lock()
		closed := a.closed
		a.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shutdown blocked on a consumer")
		}
		time.Sleep(time.Millisecond)
	}
	for range a.Events() {
	}
}

func TestTwoSessionsInterruptAndNextTurnSettings(t *testing.T) {
	a := testAdapter(t)
	one := start(t, a, "one")
	two := start(t, a, "two")
	send(t, a, "one", "turn-1", "wait")
	send(t, a, "two", "turn-2", "wait")
	// Both native processes must have reached a tool before sending signals.
	seen := map[string]bool{}
	for len(seen) < 2 {
		for _, e := range collectUntil(t, a, event.ItemStarted, "") {
			if e.Type == event.ItemStarted {
				seen[e.ThreadID] = true
			}
		}
	}
	_ = one
	if err := a.InterruptTurn(context.Background(), "two", "wrong-turn"); err != nil {
		t.Fatal(err)
	}
	if err := a.SetRuntimeMode(context.Background(), "two", provider.ModeFullAccess); err != nil {
		t.Fatal(err)
	}
	if err := a.SetInteractionMode(context.Background(), "two", provider.InteractionPlan); err != nil {
		t.Fatal(err)
	}
	if err := a.InterruptTurn(context.Background(), "one", "turn-1"); err != nil {
		t.Fatal(err)
	}
	got := completion(t, collectUntil(t, a, event.TurnCompleted, "one"))
	if got.Status != "interrupted" {
		t.Fatalf("interrupt result: %+v", got)
	}
	a.mu.Lock()
	running := a.sessions["two"].active != nil
	a.mu.Unlock()
	if !running {
		t.Fatal("interrupt crossed threads or setter stopped process")
	}
	if err := os.WriteFile(filepath.Join(two, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if got := completion(t, collectUntil(t, a, event.TurnCompleted, "two")); got.Status != "completed" {
		t.Fatal(got.Status)
	}
	_, err := a.SendTurn(context.Background(), provider.SendTurnInput{ThreadID: "two", TurnID: "turn-3", Text: "first", Model: provider.ModelSelection{Model: "chosen-model", Options: map[string]any{"effort": "max"}}})
	if err != nil {
		t.Fatal(err)
	}
	collectUntil(t, a, event.TurnCompleted, "two")
	data, _ := os.ReadFile(filepath.Join(two, "commands.ndjson"))
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if strings.Contains(lines[0], "--dangerously") || strings.Contains(lines[0], "--mode") {
		t.Fatalf("default process flags: %s", lines[0])
	}
	for _, flag := range []string{"--dangerously-skip-permissions", "--mode", "plan", "--model", "chosen-model", "--effort", "max"} {
		if !strings.Contains(lines[1], flag) {
			t.Errorf("missing %s: %s", flag, lines[1])
		}
	}
}

func TestStopAllShutdownAndBoundedKill(t *testing.T) {
	for _, action := range []string{"stop-session", "stop-all", "cancel"} {
		t.Run(action, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a := newAdapter(ctx, "test", Config{BinaryName: fakeCLI(t)}, map[string]string{"DEVDECK_AGY_FIXTURE": "1"})
			start(t, a, "one")
			start(t, a, "two")
			send(t, a, "one", "one", "ignore")
			send(t, a, "two", "two", "ignore")
			seen := map[string]bool{}
			deadline := time.After(5 * time.Second)
			for len(seen) < 2 {
				select {
				case e := <-a.Events():
					if e.Type == event.ItemStarted {
						seen[e.ThreadID] = true
					}
				case <-deadline:
					t.Fatal("processes never started")
				}
			}
			started := time.Now()
			if action == "cancel" {
				cancel()
			} else if action == "stop-all" {
				if err := a.StopAll(context.Background()); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := a.StopSession(context.Background(), "one"); err != nil {
					t.Fatal(err)
				}
				if !a.HasSession("two") {
					t.Fatal("stop-session removed another session")
				}
				if err := a.StopSession(context.Background(), "two"); err != nil {
					t.Fatal(err)
				}
			}
			cancel()
			for {
				select {
				case _, ok := <-a.Events():
					if !ok {
						if len(a.ListSessions()) != 0 {
							t.Fatal("shutdown left sessions")
						}
						if time.Since(started) > 5*time.Second {
							t.Fatal("teardown was not bounded")
						}
						return
					}
				case <-time.After(6 * time.Second):
					t.Fatal("events did not close")
				}
			}
		})
	}
}

func TestRejectedTurnDoesNotInterruptActiveTurn(t *testing.T) {
	a := testAdapter(t)
	cwd := start(t, a, "one")
	send(t, a, "one", "turn-1", "wait")
	collectUntil(t, a, event.ItemStarted, "one")
	if _, err := a.SendTurn(context.Background(), provider.SendTurnInput{ThreadID: "one", TurnID: "turn-2", Text: "first"}); err == nil {
		t.Fatal("concurrent send accepted")
	}
	a.mu.Lock()
	active := a.sessions["one"].active.id
	a.mu.Unlock()
	if active != "turn-1" {
		t.Fatal("rejected send changed running turn")
	}
	_ = os.WriteFile(filepath.Join(cwd, "release"), nil, 0600)
	if got := completion(t, collectUntil(t, a, event.TurnCompleted, "one")); got.Status != "completed" {
		t.Fatal(got.Status)
	}
}

func TestErrorsSettleTurn(t *testing.T) {
	for _, prompt := range []string{"auth", "early", "malformed", "unknown", "waiting", "exit-after-success"} {
		t.Run(prompt, func(t *testing.T) {
			a := testAdapter(t)
			start(t, a, "one")
			send(t, a, "one", "turn-1", prompt)
			events := collectUntil(t, a, event.TurnCompleted, "one")
			if got := completion(t, events); got.Status != "failed" {
				t.Fatalf("failure became %s", got.Status)
			}
			found := false
			for _, e := range events {
				if e.Type == event.RuntimeError {
					found = true
					if prompt == "auth" && !strings.Contains(e.Payload.(*event.ErrorPayload).Message, "authentication required") {
						t.Fatal("auth diagnostic lost")
					}
				}
			}
			if !found {
				t.Fatal("missing failure diagnostic")
			}
		})
	}
}

func TestValidationHasNoTurnSideEffects(t *testing.T) {
	a := testAdapter(t)
	start(t, a, "one")
	<-a.Events()
	for _, in := range []provider.SendTurnInput{
		{Mode: provider.ModeApprovalRequired}, {Mode: provider.ModeAutoAcceptEdits}, {Mode: "bogus"}, {Interact: "bogus"},
		{Attachments: []provider.Attachment{{Kind: "image"}}}, {Model: provider.ModelSelection{Options: map[string]any{"contextWindow": "200k"}}},
		{Model: provider.ModelSelection{Options: map[string]any{"effort": true}}}, {Model: provider.ModelSelection{Options: map[string]any{"effort": "bogus"}}},
	} {
		in.ThreadID = "one"
		in.TurnID = "bad"
		in.Text = "first"
		if _, err := a.SendTurn(context.Background(), in); err == nil {
			t.Errorf("accepted invalid turn: %+v", in)
		}
	}
	select {
	case e := <-a.Events():
		t.Fatalf("invalid turn emitted %s", e.Type)
	default:
	}
	for _, mode := range []provider.RuntimeMode{provider.ModeApprovalRequired, provider.ModeAutoAcceptEdits, "bogus"} {
		if a.SetRuntimeMode(context.Background(), "one", mode) == nil {
			t.Error("accepted runtime mode", mode)
		}
	}
	if a.SetInteractionMode(context.Background(), "one", "bogus") == nil {
		t.Fatal("accepted invalid interaction mode")
	}
	for _, raw := range []string{`null`, `[]`, `{"extraArgs":["--dangerously-skip-permissions"]}`, `{"binaryName":2}`, `{"foo":"bar"}`} {
		if _, err := NewDriver().DecodeConfig(json.RawMessage(raw)); err == nil {
			t.Error("accepted config", raw)
		}
	}
	for _, raw := range []string{`{}`, `{"conversationId":""}`, `true`} {
		if _, err := a.StartSession(context.Background(), provider.SessionStartInput{ThreadID: "bad", ResumeCursor: json.RawMessage(raw)}); err == nil {
			t.Error("accepted resume", raw)
		}
	}
	for _, mode := range []provider.RuntimeMode{provider.ModeApprovalRequired, provider.ModeAutoAcceptEdits} {
		if _, err := a.StartSession(context.Background(), provider.SessionStartInput{ThreadID: "bad", Mode: mode}); err == nil {
			t.Error("accepted session mode", mode)
		}
	}
}

func TestDriverProbeAndConcurrentMethods(t *testing.T) {
	d := NewDriver()
	c, err := d.DecodeConfig(d.DefaultConfig())
	if err != nil || c.(Config).BinaryName != "agy" || d.Kind() != Kind {
		t.Fatal(c, err)
	}
	missing, err := d.Probe(context.Background(), Config{BinaryName: "no-such-agy-fixture"})
	if err != nil || missing.Available || missing.Detail == "" {
		t.Fatal(missing, err)
	}
	t.Setenv("DEVDECK_AGY_FIXTURE", "1")
	snap, err := d.Probe(context.Background(), Config{BinaryName: fakeCLI(t)})
	if err != nil || !snap.Available || snap.Authed || snap.Version != "agy v1.3.3" {
		t.Fatal(snap, err)
	}
	a := testAdapter(t)
	start(t, a, "one")
	send(t, a, "one", "one", "first")
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				_ = a.ListSessions()
				_ = a.HasSession("one")
				_ = a.SetInteractionMode(context.Background(), "one", provider.InteractionPlan)
				_ = a.SetRuntimeMode(context.Background(), "one", provider.ModeAuto)
			}
		}()
	}
	collectUntil(t, a, event.TurnCompleted, "one")
	wg.Wait()
}
