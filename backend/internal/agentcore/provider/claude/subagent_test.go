package claude

import (
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
)

// testdata/subagent.ndjson is cut from a live capture against claude 2.1.246
// (`capture/subagent/`): one turn whose agent spawns a general-purpose
// subagent that runs three Bash calls and reports back, recorded WITH
// --forward-subagent-text. Lines irrelevant to subagents (telemetry, hook
// chatter, the parent's own token deltas) were dropped; nothing was added,
// edited or reordered, and only two path prefixes were substituted.
//
// It deliberately keeps one oddity of the real run: an earlier `Agent`
// tool_use block (toolu_…NUb1U161) that the CLI RETRACTED after a model
// refusal fallback — no task_started ever arrived for it. See
// TestRetractedSpawnNeverBecomesAnAgent.
const (
	subagentFixture = "testdata/subagent.ndjson"
	// The tool_use id of the spawn that actually ran — the grouping key every
	// child event carries.
	liveSpawnID = "toolu_01Db85xcC3QgQQcqR5bN4eXy"
	// The spawn that was retracted before it ever started.
	retractedSpawnID = "toolu_0178amA4gEG3iL1EUNUb1U161"
	fixtureTaskID    = "a748d696578aca208"
)

func agentEvents(evts []event.Event, agentID string) []event.Event {
	var out []event.Event
	for _, e := range evts {
		if e.AgentID == agentID {
			out = append(out, e)
		}
	}
	return out
}

func firstOfType(evts []event.Event, t event.Type) (event.Event, bool) {
	for _, e := range evts {
		if e.Type == t {
			return e, true
		}
	}
	return event.Event{}, false
}

// The whole point of the feature: a subagent's work must be attributable, and
// the parent's must never be swept up with it. Before this, subagent frames
// were dropped on the floor (no --forward-subagent-text) and the four
// system/task_* frames fell through parseSystem's "recognized noise" tail.
func TestSubagentWorkIsAttributedToTheSpawningToolCall(t *testing.T) {
	evts := parseFixture(t, subagentFixture)

	child := agentEvents(evts, liveSpawnID)
	if len(child) == 0 {
		t.Fatal("no event was attributed to the subagent; the fixture's forwarded frames produced nothing")
	}

	// Every attributed event must belong to the ONE agent in this fixture —
	// an id that is not the spawning tool call would mean the grouping key
	// drifted between the lifecycle rows and the content rows, which is
	// exactly what makes an agent render as two half-agents in the client.
	seen := map[string]bool{}
	for _, e := range evts {
		if e.AgentID != "" {
			seen[e.AgentID] = true
		}
	}
	if len(seen) != 1 || !seen[liveSpawnID] {
		t.Fatalf("attributed agent ids = %v, want exactly {%s}", seen, liveSpawnID)
	}
}

// The parent's own traffic must stay unattributed, or the client re-homes it
// into a subagent's fold and the main transcript goes blank.
func TestParentTrafficCarriesNoAgentID(t *testing.T) {
	evts := parseFixture(t, subagentFixture)

	// The parent's Agent tool_use block (its ItemStarted) is the row the
	// subagent will be rendered against — it is parent traffic, not child.
	for _, e := range evts {
		if e.Type != event.ItemStarted {
			continue
		}
		p, ok := e.Payload.(*event.ItemStartedPayload)
		if !ok || p.Title != "Agent" {
			continue
		}
		if e.AgentID != "" {
			t.Fatalf("the spawning Agent tool row was attributed to agent %q; it belongs to the parent", e.AgentID)
		}
	}
}

// Lifecycle: one task.started, progress ticks, and a terminal task.completed
// carrying the summary the parent actually consumes.
func TestSubagentLifecycleEventsCarryIdentityAndUsage(t *testing.T) {
	evts := parseFixture(t, subagentFixture)
	child := agentEvents(evts, liveSpawnID)

	started, ok := firstOfType(child, event.TaskStarted)
	if !ok {
		t.Fatal("no task.started emitted")
	}
	sp := started.Payload.(*event.TaskStartedPayload)
	if sp.TaskID != fixtureTaskID {
		t.Errorf("TaskID = %q, want %q", sp.TaskID, fixtureTaskID)
	}
	if sp.ToolCallID != liveSpawnID {
		t.Errorf("ToolCallID = %q, want the spawning call %q — the client anchors the agent's row on it", sp.ToolCallID, liveSpawnID)
	}
	if sp.Role != "general-purpose" {
		t.Errorf("Role = %q, want general-purpose", sp.Role)
	}
	if sp.Title == "" {
		t.Error("Title is empty; the agent row would have nothing to name the job")
	}
	if sp.Depth != 1 {
		t.Errorf("Depth = %d, want 1", sp.Depth)
	}
	if sp.Prompt == "" {
		t.Error("Prompt is empty; it is the only record of what was delegated")
	}

	progress := 0
	var lastUsage *event.TaskUsage
	for _, e := range child {
		if e.Type != event.TaskProgress {
			continue
		}
		progress++
		p := e.Payload.(*event.TaskProgressPayload)
		// Identity is repeated on every tick on purpose — a client whose
		// replay window no longer reaches task.started must still be able to
		// render the agent.
		if p.Role == "" || p.Title == "" {
			t.Errorf("task.progress %d dropped its identity: %+v", progress, p)
		}
		if p.LastToolName != "Bash" {
			t.Errorf("task.progress %d LastToolName = %q, want Bash", progress, p.LastToolName)
		}
		lastUsage = p.Usage
	}
	if progress != 3 {
		t.Errorf("task.progress count = %d, want 3", progress)
	}
	if lastUsage == nil || lastUsage.TotalTokens == 0 || lastUsage.ToolUses == 0 {
		t.Fatalf("last task.progress usage = %+v, want real cumulative counters", lastUsage)
	}

	done, ok := firstOfType(child, event.TaskCompleted)
	if !ok {
		t.Fatal("no task.completed emitted")
	}
	cp := done.Payload.(*event.TaskCompletedPayload)
	if cp.Status != event.TaskStatusCompleted {
		t.Errorf("Status = %q, want completed", cp.Status)
	}
	if cp.Summary == "" {
		t.Error("Summary is empty — it is the subagent's report back to its parent")
	}
	if cp.Usage == nil || cp.Usage.TotalTokens == 0 {
		t.Errorf("Usage = %+v, want the final totals", cp.Usage)
	}
	// Identity survives onto the terminal row too, sourced from the
	// remembered task_started (the notification itself carries no role).
	if cp.Role != "general-purpose" || cp.Title == "" {
		t.Errorf("terminal row lost its identity: role=%q title=%q", cp.Role, cp.Title)
	}
}

// task_updated is the one frame that carries ONLY a task_id — no
// tool_use_id, no description. Without the remembered identity it could not
// be attributed to the agent every other row is grouped under, and its status
// change would land on an id nothing else shares.
func TestTaskUpdatedIsAttributedThroughTheRememberedStartRow(t *testing.T) {
	evts := parseFixture(t, subagentFixture)

	updated, ok := firstOfType(evts, event.TaskUpdated)
	if !ok {
		t.Fatal("no task.updated emitted")
	}
	if updated.AgentID != liveSpawnID {
		t.Fatalf("task.updated AgentID = %q, want %q resolved from its task_id", updated.AgentID, liveSpawnID)
	}
	if p := updated.Payload.(*event.TaskUpdatedPayload); p.Status != event.TaskStatusCompleted {
		t.Errorf("Status = %q, want completed", p.Status)
	}
}

// The subagent's narration is the only copy there will ever be: no
// stream_event carries a non-null parent_tool_use_id (0 of 179 frames across
// three captures), so if these frames are not turned into deltas here the
// text is simply lost.
func TestSubagentNarrationBecomesTextDeltas(t *testing.T) {
	evts := parseFixture(t, subagentFixture)

	var text strings.Builder
	items := map[string]bool{}
	for _, e := range agentEvents(evts, liveSpawnID) {
		if e.Type != event.ContentDelta {
			continue
		}
		p := e.Payload.(*event.ContentDeltaPayload)
		if p.Stream != event.StreamText {
			continue
		}
		text.WriteString(p.Text)
		items[e.ItemID] = true
	}
	got := text.String()
	if !strings.Contains(got, "I'll run the three commands one at a time.") {
		t.Fatalf("subagent narration missing; got %q", got)
	}
	if !strings.Contains(got, "three separate bash commands") {
		t.Errorf("subagent's final report missing; got %q", got)
	}
	// Each forwarded frame is its own message and must land in its own item —
	// merging them would render the whole subagent as one run-on paragraph.
	if len(items) < 4 {
		t.Errorf("subagent text landed in %d items, want one per forwarded message", len(items))
	}
}

// Forwarded `thinking` blocks arrive with an empty `thinking` string and only
// a signature — the CLI forwards the envelope, not the reasoning. Emitting a
// delta for that opens a reasoning row that never receives any text.
func TestEmptyForwardedThinkingProducesNoReasoningRow(t *testing.T) {
	for _, e := range parseFixture(t, subagentFixture) {
		if e.Type != event.ContentDelta {
			continue
		}
		p := e.Payload.(*event.ContentDeltaPayload)
		if p.Stream == event.StreamReasoning && strings.TrimSpace(p.Text) == "" {
			t.Fatalf("emitted an empty reasoning delta for item %s", e.ItemID)
		}
	}
}

// A subagent's tool calls carry their arguments INLINE on the forwarded frame
// — there is no input_json_delta stream for them, which is the only reason
// the parent's path splits started/completed across two frames. Both halves
// must be emitted from the one frame, or the row never leaves "running".
func TestSubagentToolCallsArriveCompleteWithArguments(t *testing.T) {
	evts := parseFixture(t, subagentFixture)
	child := agentEvents(evts, liveSpawnID)

	started, completed := map[string]string{}, map[string]json.RawMessage{}
	for _, e := range child {
		switch p := e.Payload.(type) {
		case *event.ItemStartedPayload:
			started[e.ItemID] = p.Title
		case *event.ItemCompletedPayload:
			completed[e.ItemID] = p.Detail
		}
	}
	if len(started) != 3 {
		t.Fatalf("subagent tool calls started = %d, want 3", len(started))
	}
	var commands []string
	for id, name := range started {
		if name != "Bash" {
			t.Errorf("tool %s named %q, want Bash", id, name)
		}
		detail, ok := completed[id]
		if !ok {
			t.Fatalf("tool %s never completed; its row would spin forever", id)
		}
		var args struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(detail, &args); err != nil {
			t.Fatalf("tool %s arguments not decodable: %v", id, err)
		}
		if args.Command == "" {
			t.Errorf("tool %s completed with no command argument", id)
		}
		commands = append(commands, args.Command)
	}
	joined := strings.Join(commands, " ")
	for _, want := range []string{"echo ALPHA", "echo BRAVO", "echo CHARLIE"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q among the subagent's commands: %v", want, commands)
		}
	}
}

// The real capture contains an `Agent` tool_use that the CLI retracted after
// a model-refusal fallback — a later frame superseded it and no task_started
// ever arrived. Spawning agent state on the first tool_use block would leak a
// phantom subagent that never starts and never ends.
func TestRetractedSpawnNeverBecomesAnAgent(t *testing.T) {
	evts := parseFixture(t, subagentFixture)

	if got := agentEvents(evts, retractedSpawnID); len(got) != 0 {
		t.Fatalf("retracted spawn produced %d attributed events, want 0", len(got))
	}
	for _, e := range evts {
		if e.Type != event.TaskStarted {
			continue
		}
		if p := e.Payload.(*event.TaskStartedPayload); p.ToolCallID == retractedSpawnID {
			t.Fatal("emitted task.started for the retracted spawn")
		}
	}
}

// --forward-subagent-text is probed, never assumed: an unknown option makes
// the CLI exit 1 immediately ("error: unknown option '--x'", verified against
// 2.1.246), which would turn a missing feature into every session on that
// machine failing to start.
func TestBuildArgsOnlyPassesForwardSubagentTextWhenTheCLIAcceptsIt(t *testing.T) {
	if _, err := detect.ResolveBinary("claude"); err != nil {
		t.Skip("claude CLI not installed; the probe resolves a real binary path")
	}

	// BinaryName as DecodeConfig sets it — the probe resolves a real path, so
	// a bare Config{} would fail to resolve and answer false for the wrong
	// reason.
	probeCfg := Config{BinaryName: "claude"}

	original := probeHelpText
	t.Cleanup(func() {
		probeHelpText = original
		helpFlagCache.Clear()
	})

	has := func(args []string, want string) bool {
		for _, a := range args {
			if a == want {
				return true
			}
		}
		return false
	}

	helpFlagCache.Clear()
	probeHelpText = func(string) string {
		return "  --forward-subagent-text   Forward subagent text and thinking blocks\n"
	}
	if !has(buildArgs(probeCfg, provider.SessionStartInput{}), forwardSubagentTextFlag) {
		t.Error("a CLI that advertises the flag must be given it, or subagents stay invisible")
	}

	helpFlagCache.Clear()
	probeHelpText = func(string) string { return "  --print   Print response and exit\n" }
	if has(buildArgs(probeCfg, provider.SessionStartInput{}), forwardSubagentTextFlag) {
		t.Error("a CLI that does not advertise the flag must not be given it — it would exit 1 on startup")
	}

	// The probe runs once per binary: a second call must not re-exec --help.
	calls := 0
	probeHelpText = func(string) string { calls++; return "" }
	buildArgs(probeCfg, provider.SessionStartInput{})
	buildArgs(probeCfg, provider.SessionStartInput{})
	if calls != 0 {
		t.Errorf("probe ran %d more times after the answer was cached", calls)
	}
}
