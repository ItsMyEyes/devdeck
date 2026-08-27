// Subagent (Task/Agent tool) support for the claude provider.
//
// Everything here is derived from a live capture against claude 2.1.246 —
// `capture/subagent/README.md` has the raw NDJSON and the frame-by-frame
// evidence. The short version of the wire contract:
//
//   - Attribution is `parent_tool_use_id`, a TOP-LEVEL envelope field, and it
//     is three-valued: absent (system/result frames), null (the parent
//     conversation), or the id of the `Agent` tool call that spawned the
//     subagent. Hence *string on wireLine — absent and null must not collapse.
//
//   - `--forward-subagent-text` (buildArgs) is what makes the subagent's own
//     text and tool calls appear at all. Without it the CLI forwards nothing
//     but the spawn and its final result, and a ten-minute subagent is ten
//     minutes of an empty pane.
//
//   - `stream_event` NEVER carries a non-null parent_tool_use_id — verified
//     across three captures, 0 of 179 frames. So subagent content arrives
//     only as whole `assistant` frames, and a subagent transcript can never
//     be token-streamed the way the parent's is. That inverts this package's
//     usual rule: a parent `assistant` frame is ignored because its text was
//     already streamed, while a SUBAGENT one is the only copy there will ever
//     be and must be turned into real events here.
//
//   - Lifecycle is four `system` subtypes keyed by task_id + tool_use_id:
//     task_started, task_progress, task_updated (a bare status patch),
//     task_notification (terminal).
//
// The grouping key (event.Event.AgentID) is the SPAWNING TOOL CALL's id, not
// claude's `task_id`. Two reasons: it is the one id present on every single
// subagent-attributed frame (task_id never appears on content frames), and it
// is what the client anchors the agent's row to — the parent's own tool row
// carries the same id as its toolCallId, so the subagent renders in place of
// the call that spawned it rather than as a second, unrelated row.
package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/detect"
)

// ---------------------------------------------------------------------------
// CLI flag capability probe
// ---------------------------------------------------------------------------

// forwardSubagentTextFlag is what makes a subagent visible at all. It is NOT
// passed unconditionally, and the reason is the harshest failure mode this
// package has: commander.js rejects an unknown option outright, so a CLI old
// enough not to know this flag would exit the instant it spawned and EVERY
// session on that machine would die with "thread has no active session" — a
// total outage in exchange for a feature.
//
// So it is probed against the binary that is actually about to run. Once per
// binary path per process: `--help` is a ~200ms exec and the answer cannot
// change under a running process (a CLI upgrade lands at a different
// versioned path, which re-probes).
const forwardSubagentTextFlag = "--forward-subagent-text"

// probeHelpText is swappable so tests can exercise both branches without a
// real binary — see subagent_test.go.
var probeHelpText = func(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--help")
	cmd.Env = detect.AugmentedEnv()
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	_ = cmd.Run()
	return out.String()
}

var helpFlagCache sync.Map // resolved binary path + "\x00" + flag -> bool

// supportsFlag reports whether the CLI at binaryName advertises flag in its
// own `--help`. Shared by every optional flag buildArgs adds, because they all
// carry the same failure mode described above: commander.js exits 1 on an
// unknown option, so guessing wrong is an outage rather than a missing
// feature.
//
// Fails CLOSED: an unresolvable binary or a `--help` that produced nothing
// answers false, so the session still starts (without the flag's feature)
// rather than not starting at all. Losing a feature beats losing the agent.
//
// Cached per binary path AND per flag: two flags on the same binary are two
// independent answers, and a single-key cache would have handed the second
// one whatever the first happened to resolve to.
func supportsFlag(binaryName, flag string) bool {
	bin, err := detect.ResolveBinary(binaryName)
	if err != nil {
		return false
	}
	key := bin + "\x00" + flag
	if cached, ok := helpFlagCache.Load(key); ok {
		return cached.(bool)
	}
	supported := strings.Contains(probeHelpText(bin), flag)
	helpFlagCache.Store(key, supported)
	return supported
}

// supportsForwardSubagentText reports whether this CLI accepts the flag.
func supportsForwardSubagentText(binaryName string) bool {
	return supportsFlag(binaryName, forwardSubagentTextFlag)
}

// spawnToolNames are the names a subagent spawn can arrive under. The wire
// consistently says "Agent" (every emitted block in the capture), but
// system/init advertises the string "Task" in its tools list, and older
// builds emitted "Task" as the block name too. Matching only one of them
// silently misses every spawn, so both are accepted.
var spawnToolNames = map[string]bool{"Agent": true, "Task": true}

// taskAgent is the identity remembered from task_started, so later rows that
// carry less can be completed from it.
//
// It exists for exactly one frame shape: `task_updated` carries ONLY
// `task_id` — no tool_use_id, no description, no role — so without this map
// its status patch could not be attributed to the agent every other row is
// grouped under.
type taskAgent struct {
	toolUseID string
	title     string
	role      string
}

// agentIDForTaskID resolves claude's own task_id to this package's grouping
// key (the spawning tool call's id). Falls back to the task_id itself when
// the start row was never seen — a status patch under a key nothing else
// shares is inert, which is strictly better than dropping it or, worse,
// attributing it to the wrong agent.
func (st *parseState) agentIDForTaskID(taskID string) string {
	if a, ok := st.agents[taskID]; ok && a.toolUseID != "" {
		return a.toolUseID
	}
	return taskID
}

// taskUsageFrom decodes the `usage` blob on task_progress/task_notification.
// It is a DIFFERENT shape from the `usage` on a turn's `result` line (which
// resultUsage handles): a subagent reports one running total plus a tool
// count, never the input/output/cache breakdown.
func taskUsageFrom(raw json.RawMessage) *event.TaskUsage {
	if len(raw) == 0 {
		return nil
	}
	var u struct {
		TotalTokens int64 `json:"total_tokens"`
		ToolUses    int64 `json:"tool_uses"`
		DurationMs  int64 `json:"duration_ms"`
	}
	if err := json.Unmarshal(raw, &u); err != nil {
		return nil
	}
	if u.TotalTokens == 0 && u.ToolUses == 0 && u.DurationMs == 0 {
		return nil
	}
	return &event.TaskUsage{TotalTokens: u.TotalTokens, ToolUses: u.ToolUses, DurationMs: u.DurationMs}
}

// taskStatusFrom maps claude's own status vocabulary onto the canonical one.
// `killed` and `paused` appear on task_updated patches; everything else the
// capture showed is already one of the canonical words.
func taskStatusFrom(s string) event.TaskStatus {
	switch s {
	case "completed":
		return event.TaskStatusCompleted
	case "failed", "error":
		return event.TaskStatusFailed
	case "stopped", "killed", "cancelled", "canceled":
		return event.TaskStatusStopped
	case "":
		return ""
	default:
		// in_progress, running, pending, paused — anything not terminal.
		return event.TaskStatusRunning
	}
}

// parseTaskSystem handles the four `system` subtypes that describe a
// subagent's life. Returns nil for any other subtype so parseSystem's own
// switch keeps its existing behaviour.
func parseTaskSystem(w wireLine, st *parseState, raw []byte) []event.Event {
	switch w.Subtype {
	case "task_started":
		if w.TaskID == "" {
			return warning(st, "system/task_started missing task_id", raw, "system.task_started")
		}
		st.agents[w.TaskID] = &taskAgent{
			toolUseID: w.ToolUseID,
			title:     w.Description,
			role:      w.SubagentType,
		}
		agentID := st.agentIDForTaskID(w.TaskID)
		e := st.envelope(event.TaskStarted)
		e.AgentID = agentID
		e.Payload = &event.TaskStartedPayload{
			TaskID:       w.TaskID,
			ToolCallID:   w.ToolUseID,
			Title:        w.Description,
			Role:         w.SubagentType,
			Prompt:       w.Prompt,
			Depth:        w.SpawnDepth,
			Backgrounded: w.IsBackgrounded,
		}
		return []event.Event{e}

	case "task_progress":
		if w.TaskID == "" {
			return nil
		}
		e := st.envelope(event.TaskProgress)
		e.AgentID = st.agentIDForTaskID(w.TaskID)
		e.Payload = &event.TaskProgressPayload{
			TaskID:       w.TaskID,
			Title:        w.Description,
			Role:         w.SubagentType,
			LastToolName: w.LastToolName,
			Usage:        taskUsageFrom(w.Usage),
		}
		return []event.Event{e}

	case "task_updated":
		// The one frame that carries nothing but a task_id and a patch —
		// see taskAgent's doc comment.
		if w.TaskID == "" {
			return nil
		}
		var patch struct {
			Status string `json:"status"`
		}
		if len(w.Patch) > 0 {
			_ = json.Unmarshal(w.Patch, &patch)
		}
		status := taskStatusFrom(patch.Status)
		if status == "" {
			// A patch about something else entirely (end_time alone, say).
			// Nothing to say about the agent's state, so say nothing.
			return nil
		}
		e := st.envelope(event.TaskUpdated)
		e.AgentID = st.agentIDForTaskID(w.TaskID)
		e.Payload = &event.TaskUpdatedPayload{TaskID: w.TaskID, Status: status}
		return []event.Event{e}

	case "task_notification":
		if w.TaskID == "" {
			return nil
		}
		agent := st.agents[w.TaskID]
		payload := &event.TaskCompletedPayload{
			TaskID:     w.TaskID,
			Status:     taskStatusFrom(w.Status),
			Summary:    w.Summary,
			OutputFile: w.OutputFile,
			Usage:      taskUsageFrom(w.Usage),
		}
		// Identity repeated on the terminal row too: a client whose replay
		// window no longer reaches task_started must still be able to render
		// a complete agent from this alone.
		if agent != nil {
			payload.Title, payload.Role = agent.title, agent.role
		}
		if payload.Title == "" {
			payload.Title = w.Description
		}
		if payload.Role == "" {
			payload.Role = w.SubagentType
		}
		if payload.Status == "" {
			payload.Status = event.TaskStatusCompleted
		}
		e := st.envelope(event.TaskCompleted)
		e.AgentID = st.agentIDForTaskID(w.TaskID)
		e.Payload = payload
		return []event.Event{e}
	}
	return nil
}

// subagentItemID keys one content block of one forwarded frame.
//
// The frame's own `uuid` is the base rather than `message.id`: uuid is unique
// per frame and is what the on-disk transcript joins on, so an item id built
// from it is stable across a replay and can never collide with the parent's
// (which are built from a message id and a block index).
func subagentItemID(uuid string, index int) string {
	return uuid + "#" + strconv.Itoa(index)
}

// parseSubagentAssistant turns ONE forwarded subagent `assistant` frame into
// canonical events, every one stamped with the owning agent.
//
// This is the inversion described in the package comment: for the parent
// conversation an `assistant` frame is a duplicate of text that already
// streamed through stream_event and is deliberately ignored, but no
// stream_event ever carries a subagent's content, so here the frame is the
// only copy and every block has to be turned into a real event.
//
// Blocks map exactly as the parent's do, so a subagent's work renders with
// the same vocabulary the rest of the transcript uses:
//
//	text      -> ContentDelta{StreamText}
//	thinking  -> ContentDelta{StreamReasoning}   (see the empty-text note)
//	tool_use  -> ItemStarted + ItemCompleted     (input arrives inline, whole)
//
// A tool call gets both halves from this one frame because its arguments are
// already complete here — there is no input_json_delta stream to wait for,
// which is the only reason the parent's path splits them across two frames.
func parseSubagentAssistant(w wireLine, st *parseState, raw []byte) []event.Event {
	agentID := *w.ParentToolUseID
	if agentID == "" {
		return nil
	}

	var body struct {
		Message assistantMessage `json:"message"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return warning(st, "malformed subagent assistant frame: "+err.Error(), raw, "assistant")
	}

	// A frame with no uuid should not happen (every captured frame has one),
	// but an item id built on an empty string would collide across frames and
	// silently merge two different messages into one row.
	uuid := w.UUID
	if uuid == "" {
		uuid = agentID
	}

	var evts []event.Event
	for i, block := range body.Message.Content {
		switch block.Type {
		case "text", "thinking":
			text := block.Text
			stream := event.StreamText
			if block.Type == "thinking" {
				text, stream = block.Thinking, event.StreamReasoning
			}
			// Forwarded thinking blocks are EMPTY in practice — the capture
			// shows `{"type":"thinking","thinking":"","signature":"…"}`, i.e.
			// the signature is forwarded and the reasoning itself is not.
			// Emitting the empty string would open a reasoning row that never
			// gets any text in it.
			if text == "" {
				continue
			}
			id := subagentItemID(uuid, i)
			e := st.contentDelta(id, stream, text)
			e.AgentID = agentID
			evts = append(evts, e)

		case "tool_use":
			id := subagentItemID(uuid, i)
			started := st.envelope(event.ItemStarted)
			started.ItemID = id
			started.AgentID = agentID
			detail, _ := json.Marshal(map[string]string{"toolCallId": block.ID, "name": block.Name})
			started.Payload = &event.ItemStartedPayload{
				ItemType: event.ItemToolCall, Title: block.Name, Detail: detail,
			}

			completed := st.envelope(event.ItemCompleted)
			completed.ItemID = id
			completed.AgentID = agentID
			var args json.RawMessage
			if json.Valid(block.Input) {
				args = block.Input
			}
			completed.Payload = &event.ItemCompletedPayload{
				ItemType: event.ItemToolCall, Status: "completed", Detail: args,
			}
			evts = append(evts, started, completed)
		}
	}
	return evts
}
