// Subagent support for the pi provider — deliberately the thinnest of the
// four, because pi gives the least to work with.
//
// pi has NO built-in subagent tool. Subagents exist only as an opt-in example
// extension shipped with the CLI (`examples/extensions/subagent/`), which is
// not installed by default. That extension registers an ordinary tool named
// `subagent` and, when called, spawns a SEPARATE child process
// (`pi --mode json -p --no-session …`) whose output it consumes entirely
// itself. None of the child's events ever reach the parent's RPC stdout, and
// pi's RPC vocabulary has no task/agent/delegation event of any kind
// (verified against pi 0.84.3's own `rpc-types.d.ts`).
//
// So a pi subagent's interior work is STRUCTURALLY unavailable — there is
// nothing to parse, and nothing here pretends otherwise. What DevDeck can
// show is the one thing pi does report: the tool's own lifecycle, plus the
// `partialResult` it streams while running. That turns a multi-minute
// fan-out from a single motionless row into an agent row that visibly ticks.
package pi

import (
	"encoding/json"
	"strings"

	"devdeck/backend/internal/agentcore/event"
)

// subagentToolName is the tool the example extension registers. Matching by
// name is the only option available: the wire carries no attribution field,
// no child session id, and no agent name at the event level.
const subagentToolName = "subagent"

// isSubagentTool reports whether this tool call is a subagent spawn.
func isSubagentTool(toolName string) bool {
	return strings.EqualFold(toolName, subagentToolName)
}

// subagentArgs is what the extension's tool takes. Only the fields that name
// the job are read; `mode`/`agentScope` describe how the extension resolves
// agent definitions and say nothing a transcript row can use.
type subagentArgs struct {
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
	Agent       string `json:"agent"`
	Agents      []struct {
		Agent  string `json:"agent"`
		Prompt string `json:"prompt"`
	} `json:"agents"`
}

// subagentTitle names the delegated job for the agent's row. A row titled
// only "subagent" tells the operator nothing, so this reaches for the
// description, then the prompt's first line, then the fan-out's size.
func subagentTitle(raw json.RawMessage) (title, role string) {
	var in subagentArgs
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &in)
	}
	role = strings.TrimSpace(in.Agent)
	if role == "" && len(in.Agents) > 0 {
		role = strings.TrimSpace(in.Agents[0].Agent)
	}

	if d := strings.TrimSpace(in.Description); d != "" {
		return d, role
	}
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" && len(in.Agents) > 0 {
		prompt = strings.TrimSpace(in.Agents[0].Prompt)
	}
	if prompt == "" {
		if n := len(in.Agents); n > 1 {
			return "Subagent fan-out", role
		}
		return "Subagent", role
	}
	if i := strings.IndexByte(prompt, '\n'); i > 0 {
		prompt = prompt[:i]
	}
	const maxTitle = 80
	if r := []rune(prompt); len(r) > maxTitle {
		return string(r[:maxTitle]) + "…", role
	}
	return prompt, role
}

// progressLine turns the extension's streamed `partialResult` into one line
// of activity text.
//
// It is a growing blob, not a status line — the extension appends each
// finished sub-result to it — so the LAST non-empty line is what "where is it
// now" means. Sending the whole thing on every tick would put a second
// transcript inside a one-line row.
func progressLine(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		// Not a bare string: take whatever textual field the shape offers
		// rather than rendering JSON at the operator.
		var obj struct {
			Text    string `json:"text"`
			Content string `json:"content"`
			Status  string `json:"status"`
		}
		if json.Unmarshal(raw, &obj) != nil {
			return ""
		}
		text = firstNonEmpty(obj.Text, obj.Content, obj.Status)
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			const maxLine = 120
			if r := []rune(line); len(r) > maxLine {
				return string(r[:maxLine]) + "…"
			}
			return line
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// piAgent is the identity remembered from the spawn, so the progress and
// terminal rows can repeat it — a client whose replay window no longer
// reaches task.started must still be able to render a complete agent.
type piAgent struct {
	title string
	role  string
}

func (st *parseState) rememberAgent(callID, title, role string) {
	if callID == "" {
		return
	}
	if st.agents == nil {
		st.agents = map[string]piAgent{}
	}
	st.agents[callID] = piAgent{title: title, role: role}
}

func (st *parseState) agentIdentity(callID string) (title, role string) {
	a, ok := st.agents[callID]
	if !ok {
		return "", ""
	}
	return a.title, a.role
}

// subagentStarted announces the agent alongside the tool row.
//
// Unlike the other providers this does NOT replace the tool row: pi reports
// nothing about the agent that the tool call does not already carry, so the
// row and the agent are the same thing either way, and suppressing the tool
// row would only lose the arguments disclosure. The client anchors the agent
// on `ToolCallID`, which is this row's id.
func (st *parseState) subagentStarted(w wireLine) []event.Event {
	title, role := subagentTitle(w.Args)
	st.rememberAgent(w.ToolCallID, title, role)

	e := st.envelope(event.TaskStarted)
	e.AgentID = w.ToolCallID
	e.Payload = &event.TaskStartedPayload{
		TaskID:     w.ToolCallID,
		ToolCallID: w.ToolCallID,
		Title:      title,
		Role:       role,
		Depth:      1,
	}
	return []event.Event{e}
}

// subagentProgress is the only liveness signal pi offers for a subagent, and
// before this it was dropped wholesale with every other `tool_execution_update`
// — so a fan-out that ran for minutes showed nothing at all until it finished.
func (st *parseState) subagentProgress(w wireLine, partial json.RawMessage) []event.Event {
	line := progressLine(partial)
	if line == "" {
		return nil
	}
	_, role := st.agentIdentity(w.ToolCallID)
	e := st.envelope(event.TaskProgress)
	e.AgentID = w.ToolCallID
	// Title carries the progress line, which is what the client renders as
	// the agent's activity text. The agent's NAME is not repeated here: it was
	// established on task.started and this is the one field that changes.
	//
	// No Usage: pi reports no per-subagent cost anywhere — the child runs in a
	// process spawned outside the RPC session and its spend never crosses
	// back — and a zero would read as "free" rather than "not reported".
	e.Payload = &event.TaskProgressPayload{TaskID: w.ToolCallID, Title: line, Role: role}
	return []event.Event{e}
}

// subagentFinished closes the agent out with whatever the tool returned — the
// extension's own summary of what its children did, which is the only report
// that ever crosses back into this process.
func (st *parseState) subagentFinished(w wireLine) []event.Event {
	title, role := st.agentIdentity(w.ToolCallID)
	status := event.TaskStatusCompleted
	if w.IsError {
		status = event.TaskStatusFailed
	}
	e := st.envelope(event.TaskCompleted)
	e.AgentID = w.ToolCallID
	e.Payload = &event.TaskCompletedPayload{
		TaskID:  w.ToolCallID,
		Status:  status,
		Title:   title,
		Role:    role,
		Summary: progressLine(w.Result),
	}
	return []event.Event{e}
}
