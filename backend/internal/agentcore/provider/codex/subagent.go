// Subagent (multi-agent / AgentControl) support for the codex provider.
//
// Codex ships `multi_agent` as a STABLE, default-on feature in codex-cli
// 0.145.0 (`codex features list`), so everything here is live for every user
// rather than gated behind a flag. The wire contract below is read off the
// installed binary's own schema (`codex app-server generate-json-schema --out
// <dir> --experimental`, definitions SubAgentActivityThreadItem,
// CollabAgentToolCallThreadItem, CollabAgentTool, CollabAgentStatus,
// SubAgentSource, Thread) — not from documentation.
//
// The short version:
//
//   - A subagent is A WHOLE OTHER CODEX THREAD, not a tool call. That is the
//     single most important difference from claude, where a subagent lives
//     inside the parent's frame stream under `parent_tool_use_id`. Here the
//     child gets its own `threadId` and its work arrives as ordinary
//     item/turn notifications carrying THAT id. The app-server has no
//     `thread/subscribe` at all (only `thread/unsubscribe`), i.e. those
//     notifications are pushed unasked on the one shared stdout stream — so
//     before this file existed they landed in dispatchNotification, missed
//     `byCodex`, and were dropped as "server-wide chatter". Every minute of a
//     codex subagent's work was invisible.
//
//   - Two ThreadItem variants describe it, and NEITHER carries a `content`
//     field:
//
//     subAgentActivity  {agentPath, agentThreadId, kind:started|interacted|interrupted}
//     collabAgentToolCall {tool, status, senderThreadId, receiverThreadIds[],
//     agentsStates{}, prompt?, model?, reasoningEffort?}
//
//     itemTypeOf's `default:` used to turn both into a bare event.ItemToolCall
//     with no Title and a null Detail — a blank, unlabelled row in the MAIN
//     transcript, with no warning that anything was misread.
//
//   - The grouping key (event.Event.AgentID) is codex's `agentThreadId`, i.e.
//     the CHILD THREAD ID — the same string that appears in a spawn's
//     `receiverThreadIds` ("In case of spawn operation, this corresponds to
//     the newly spawned agent"), in `Thread.parentThreadId`'s child, and on
//     every notification the child itself emits. It is the only id present on
//     all three, which is exactly the property claude/subagent.go picks its
//     own key for.
//
// Identity (Title/Role) is repeated on progress and terminal rows rather than
// only on the start row, for the same reason it is in claude/subagent.go: a
// client whose replay window no longer reaches task.started must still be able
// to render a complete agent from the row in front of it.
package codex

import (
	"encoding/json"
	"path"
	"sort"
	"strings"

	"devdeck/backend/internal/agentcore/event"
)

// ---------------------------------------------------------------------------
// Per-agent bookkeeping
// ---------------------------------------------------------------------------

// codexAgent is what the parser remembers about one subagent thread, so a
// later row that carries less than the first one can still be completed.
//
// It exists because the three sources of subagent information are disjoint:
// `collabAgentToolCall` knows the spawning tool call and the prompt but no
// role, `subAgentActivity` knows the agentPath but not the prompt, and
// `thread/started` for the child knows agentRole/agentNickname/depth but says
// nothing about either. Only the union of the three describes the agent.
type codexAgent struct {
	title      string
	role       string
	toolCallID string
	depth      int
	// started records that a task.started has already been emitted for this
	// agent, so the spawn tool call and the subAgentActivity item — which
	// arrive in an order this integration does not control — cannot announce
	// the same agent twice.
	started bool
	// lastStatus dedupes `agentsStates`, which is a full snapshot repeated on
	// every collab tool call rather than a change feed. Without this a
	// three-agent fan-out re-emits every agent's status on every wait().
	lastStatus event.TaskStatus
}

// agentSnapshot is a COPY of a codexAgent handed back out of the locked
// accessors below. The parser runs on one goroutine today, but returning the
// live pointer would put every field one `-race` run away from a data race the
// moment that stops being true.
type agentSnapshot struct {
	title      string
	role       string
	toolCallID string
	depth      int
	started    bool
}

func (st *parseState) agentLocked(id string) *codexAgent {
	if st.agents == nil {
		st.agents = map[string]*codexAgent{}
	}
	a := st.agents[id]
	if a == nil {
		a = &codexAgent{}
		st.agents[id] = a
	}
	return a
}

func snapshotOf(a *codexAgent) agentSnapshot {
	return agentSnapshot{title: a.title, role: a.role, toolCallID: a.toolCallID, depth: a.depth, started: a.started}
}

// noteAgentIdentity merges whatever this row happened to know into the agent's
// record and returns the merged result. Empty arguments never overwrite a
// value already learned — a later, thinner row must not erase identity.
func (st *parseState) noteAgentIdentity(id, title, role, toolCallID string, depth int) agentSnapshot {
	st.mu.Lock()
	defer st.mu.Unlock()
	a := st.agentLocked(id)
	if title != "" {
		a.title = title
	}
	if role != "" {
		a.role = role
	}
	if toolCallID != "" {
		a.toolCallID = toolCallID
	}
	if depth > 0 {
		a.depth = depth
	}
	return snapshotOf(a)
}

// markAgentStarted reports whether THIS caller is the one that gets to emit
// task.started for the agent. Exactly one caller ever wins.
func (st *parseState) markAgentStarted(id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	a := st.agentLocked(id)
	if a.started {
		return false
	}
	a.started = true
	return true
}

// noteAgentStatus reports whether the agent's status actually moved. See
// codexAgent.lastStatus for why the snapshot needs de-duplicating.
func (st *parseState) noteAgentStatus(id string, s event.TaskStatus) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	a := st.agentLocked(id)
	if a.lastStatus == s {
		return false
	}
	a.lastStatus = s
	return true
}

// knownAgent reports whether this id has ever been seen as a subagent of this
// thread. Used to filter `agentsStates`, whose key type the schema declares
// only as `additionalProperties` — see parseCollabAgentToolCall.
func (st *parseState) knownAgent(id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	_, ok := st.agents[id]
	return ok
}

// firstSightOfItem is the dedupe for items whose two lifecycle notifications
// carry IDENTICAL information. A subAgentActivity item is an instantaneous
// marker: item/started and item/completed both deliver the same
// {agentThreadId, kind} and turning both into task events would double every
// row. (collabAgentToolCall is NOT deduped this way — there the two halves
// genuinely differ, and become item.started and item.completed.)
func (st *parseState) firstSightOfItem(itemID string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.seenItems == nil {
		st.seenItems = map[string]bool{}
	}
	if st.seenItems[itemID] {
		return false
	}
	st.seenItems[itemID] = true
	return true
}

// registerChild tells the adapter that childID is another codex thread
// belonging to this session, so a notification arriving on that thread id is
// re-homed onto this session instead of being dropped. Nil in tests that do
// not exercise routing.
func (st *parseState) registerChild(childID string) {
	if childID == "" || st.onChildThread == nil {
		return
	}
	st.onChildThread(childID)
}

// ---------------------------------------------------------------------------
// Status vocabularies
// ---------------------------------------------------------------------------

// collabTaskStatusFrom maps CollabAgentStatus (the app-server's own enum:
// pendingInit | running | interrupted | completed | errored | shutdown |
// notFound) onto the canonical vocabulary.
//
// `notFound` is failed rather than stopped on purpose: the parent asked about
// an agent the server cannot find, which is a broken delegation, not an
// orderly cancellation.
func collabTaskStatusFrom(s string) event.TaskStatus {
	switch s {
	case "completed":
		return event.TaskStatusCompleted
	case "errored", "notFound":
		return event.TaskStatusFailed
	case "interrupted", "shutdown":
		return event.TaskStatusStopped
	case "pendingInit", "running":
		return event.TaskStatusRunning
	case "":
		return ""
	default:
		// A status this build has not seen. Running is the safe read: it says
		// "still going", so a client neither buries the row as finished nor
		// invents a failure.
		return event.TaskStatusRunning
	}
}

// collabItemStatusFrom maps CollabAgentToolCallStatus (inProgress | completed
// | failed) onto the string event.ItemCompletedPayload carries.
func collabItemStatusFrom(s string) string {
	if s == "failed" {
		return "failed"
	}
	return "completed"
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

// subagentItemParams re-reads item/started and item/completed params keeping
// the ITEM RAW. itemParams (parse.go) types only `content`, which neither
// subagent variant even has — decoding through it is precisely how both ended
// up as blank rows.
type subagentItemParams struct {
	Item     json.RawMessage `json:"item"`
	ThreadID string          `json:"threadId"`
	TurnID   string          `json:"turnId"`
}

// subAgentActivityItem — SubAgentActivityThreadItem, verbatim from the 0.145.0
// schema. All five fields are `required` there.
type subAgentActivityItem struct {
	ID            string `json:"id"`
	AgentPath     string `json:"agentPath"`
	AgentThreadID string `json:"agentThreadId"`
	Kind          string `json:"kind"` // started | interacted | interrupted
}

// collabAgentState — CollabAgentState. `message` is the agent's last word,
// which is the closest thing a collab call carries to a result summary.
type collabAgentState struct {
	Status  string `json:"status"`
	Message string `json:"message"`
}

// collabAgentToolCallItem — CollabAgentToolCallThreadItem. tool, status,
// senderThreadId, receiverThreadIds, agentsStates and id are `required`;
// prompt, model and reasoningEffort are nullable extras present only on the
// calls they apply to.
type collabAgentToolCallItem struct {
	ID                string                      `json:"id"`
	Tool              string                      `json:"tool"`   // spawnAgent | sendInput | resumeAgent | wait | closeAgent
	Status            string                      `json:"status"` // inProgress | completed | failed
	SenderThreadID    string                      `json:"senderThreadId"`
	ReceiverThreadIDs []string                    `json:"receiverThreadIds"`
	AgentsStates      map[string]collabAgentState `json:"agentsStates"`
	Prompt            string                      `json:"prompt"`
	Model             string                      `json:"model"`
	ReasoningEffort   string                      `json:"reasoningEffort"`
}

// itemPhase distinguishes the two notifications that deliver the same item.
type itemPhase int

const (
	phaseStarted itemPhase = iota
	phaseCompleted
)

// isSubagentItemType reports whether this ThreadItem type is one this file
// owns. parse.go consults it BEFORE its generic item path so neither variant
// can fall through to an untitled tool row again.
func isSubagentItemType(codexType string) bool {
	return codexType == "subAgentActivity" || codexType == "collabAgentToolCall"
}

// parseSubagentItem is the entry point parse.go calls for both variants.
func parseSubagentItem(params json.RawMessage, codexType string, phase itemPhase, st *parseState) []event.Event {
	var p subagentItemParams
	if err := json.Unmarshal(params, &p); err != nil {
		return warning(st, "malformed subagent item: "+err.Error(), params, "item."+codexType)
	}
	if p.TurnID != "" {
		st.setTurnID(p.TurnID)
	}
	switch codexType {
	case "subAgentActivity":
		return parseSubAgentActivity(p.Item, st, params)
	case "collabAgentToolCall":
		return parseCollabAgentToolCall(p.Item, phase, st, params)
	}
	return nil
}

// parseSubAgentActivity turns the lifecycle marker into task.* events.
//
// This item is NEVER rendered as a row of its own: it carries no content, no
// title and no result, and everything it does say is already expressed by the
// task.* vocabulary the client groups under AgentID. Emitting it as an item
// too would put an empty tool row next to the agent it describes.
func parseSubAgentActivity(rawItem json.RawMessage, st *parseState, params json.RawMessage) []event.Event {
	var it subAgentActivityItem
	if err := json.Unmarshal(rawItem, &it); err != nil {
		return warning(st, "malformed subAgentActivity item: "+err.Error(), params, "item.subAgentActivity")
	}
	if it.AgentThreadID == "" {
		// Without the grouping key there is nothing to attribute this to, and
		// guessing would attach a stranger's work to some other agent's row.
		return warning(st, "subAgentActivity without agentThreadId", params, "item.subAgentActivity")
	}
	// item/started and item/completed deliver this marker twice, identically.
	if it.ID != "" && !st.firstSightOfItem(it.ID) {
		return nil
	}

	// The child thread is now known to belong to this session, whichever of
	// the two spawn signals got here first.
	st.registerChild(it.AgentThreadID)

	role := roleFromAgentPath(it.AgentPath)
	agent := st.noteAgentIdentity(it.AgentThreadID, "", role, "", 0)
	title := agent.title
	if title == "" {
		title = role
	}

	switch it.Kind {
	case "started":
		if !st.markAgentStarted(it.AgentThreadID) {
			// The spawn tool call already announced this agent. A second
			// task.started would render a duplicate agent row, so the same
			// information goes out as a progress tick instead.
			return []event.Event{st.taskProgress(it.AgentThreadID, title, agent.role, "")}
		}
		st.noteAgentStatus(it.AgentThreadID, event.TaskStatusRunning)
		e := st.envelope(event.TaskStarted)
		e.AgentID = it.AgentThreadID
		e.Payload = &event.TaskStartedPayload{
			TaskID:     it.AgentThreadID,
			ToolCallID: agent.toolCallID,
			Title:      title,
			Role:       agent.role,
			Depth:      agent.depth,
		}
		return []event.Event{e}

	case "interacted":
		return []event.Event{st.taskProgress(it.AgentThreadID, title, agent.role, "")}

	case "interrupted":
		st.noteAgentStatus(it.AgentThreadID, event.TaskStatusStopped)
		e := st.envelope(event.TaskCompleted)
		e.AgentID = it.AgentThreadID
		e.Payload = &event.TaskCompletedPayload{
			TaskID: it.AgentThreadID,
			Status: event.TaskStatusStopped,
			Title:  title,
			Role:   agent.role,
		}
		return []event.Event{e}
	}

	// A fourth kind would be a protocol change, and the warning path is how
	// this package finds out about one instead of rotting quietly.
	return warning(st, "unrecognized subAgentActivity kind "+it.Kind, params, "item.subAgentActivity")
}

func (st *parseState) taskProgress(agentID, title, role, lastTool string) event.Event {
	e := st.envelope(event.TaskProgress)
	e.AgentID = agentID
	e.Payload = &event.TaskProgressPayload{
		TaskID: agentID, Title: title, Role: role, LastToolName: lastTool,
	}
	return e
}

// parseCollabAgentToolCall renders the parent's own side of the delegation: a
// REAL, TITLED tool row for spawnAgent/sendInput/resumeAgent/wait/closeAgent,
// plus the task.* consequences of that call.
//
// Two things come out of one item:
//
//  1. The tool row. Title is the tool name — the whole bug being fixed is that
//     it used to be empty — and Detail is synthesised here because the item
//     has no `content` field for the generic path to pass through.
//
//  2. For `spawnAgent`, every id in receiverThreadIds is a newly spawned agent
//     ("In case of spawn operation, this corresponds to the newly spawned
//     agent"). Each is registered as a child of this session so its own
//     notifications get re-homed, and announced with task.started unless
//     subAgentActivity beat us to it.
func parseCollabAgentToolCall(rawItem json.RawMessage, phase itemPhase, st *parseState, params json.RawMessage) []event.Event {
	var it collabAgentToolCallItem
	if err := json.Unmarshal(rawItem, &it); err != nil {
		return warning(st, "malformed collabAgentToolCall item: "+err.Error(), params, "item.collabAgentToolCall")
	}

	title := it.Tool
	if title == "" {
		// Still never blank: an unnamed collab call is a labelled unknown, not
		// an anonymous row indistinguishable from a rendering bug.
		title = "collabAgentToolCall"
	}
	detail := collabDetail(it)

	var evts []event.Event
	if phase == phaseStarted {
		e := st.envelope(event.ItemStarted)
		e.ItemID = it.ID
		e.Payload = &event.ItemStartedPayload{ItemType: event.ItemToolCall, Title: title, Detail: detail}
		evts = append(evts, e)
	} else {
		e := st.envelope(event.ItemCompleted)
		e.ItemID = it.ID
		e.Payload = &event.ItemCompletedPayload{
			ItemType: event.ItemToolCall,
			Status:   collabItemStatusFrom(it.Status),
			Detail:   detail,
		}
		evts = append(evts, e)
	}

	if it.Tool == "spawnAgent" {
		evts = append(evts, st.announceSpawned(it)...)
	}
	evts = append(evts, st.foldAgentStates(it)...)
	return evts
}

// announceSpawned registers and announces the agents a spawn created.
func (st *parseState) announceSpawned(it collabAgentToolCallItem) []event.Event {
	var evts []event.Event
	for _, child := range it.ReceiverThreadIDs {
		if child == "" {
			continue
		}
		st.registerChild(child)
		agent := st.noteAgentIdentity(child, titleFromPrompt(it.Prompt), "", it.ID, 0)
		if !st.markAgentStarted(child) {
			continue
		}
		st.noteAgentStatus(child, event.TaskStatusRunning)
		e := st.envelope(event.TaskStarted)
		e.AgentID = child
		e.Payload = &event.TaskStartedPayload{
			TaskID:     child,
			ToolCallID: it.ID,
			Title:      agent.title,
			Role:       agent.role,
			Prompt:     it.Prompt,
			Depth:      agent.depth,
		}
		evts = append(evts, e)
	}
	return evts
}

// foldAgentStates turns `agentsStates` — a full snapshot of "last known status
// of the target agents", repeated on every collab call — into status events.
//
// Only ALREADY-KNOWN agents are folded. The schema declares the map's keys as
// bare `additionalProperties` with no key type, so that they are thread ids is
// an inference from every other id in this item being one; filtering to agents
// this thread has already registered makes a wrong inference inert (a skipped
// status) instead of harmful (a phantom agent row under a nickname).
func (st *parseState) foldAgentStates(it collabAgentToolCallItem) []event.Event {
	if len(it.AgentsStates) == 0 {
		return nil
	}
	// Map iteration order is randomised; a stable event order keeps replays
	// and tests deterministic.
	ids := make([]string, 0, len(it.AgentsStates))
	for id := range it.AgentsStates {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var evts []event.Event
	for _, id := range ids {
		if !st.knownAgent(id) {
			continue
		}
		status := collabTaskStatusFrom(it.AgentsStates[id].Status)
		if status == "" || !st.noteAgentStatus(id, status) {
			continue
		}
		agent := st.noteAgentIdentity(id, "", "", "", 0)
		switch status {
		case event.TaskStatusCompleted, event.TaskStatusFailed, event.TaskStatusStopped:
			e := st.envelope(event.TaskCompleted)
			e.AgentID = id
			e.Payload = &event.TaskCompletedPayload{
				TaskID:  id,
				Status:  status,
				Title:   agent.title,
				Role:    agent.role,
				Summary: it.AgentsStates[id].Message,
			}
			evts = append(evts, e)
		default:
			e := st.envelope(event.TaskUpdated)
			e.AgentID = id
			e.Payload = &event.TaskUpdatedPayload{TaskID: id, Status: status}
			evts = append(evts, e)
		}
	}
	return evts
}

// collabDetail is the tool row's arguments. Built by hand because the item has
// no `content`: without it the row would render as a titled but empty step,
// and the prompt a spawn carried is the only record of what was delegated.
func collabDetail(it collabAgentToolCallItem) json.RawMessage {
	d := map[string]any{"tool": it.Tool}
	if it.Status != "" {
		d["status"] = it.Status
	}
	if it.SenderThreadID != "" {
		d["senderThreadId"] = it.SenderThreadID
	}
	if len(it.ReceiverThreadIDs) > 0 {
		d["receiverThreadIds"] = it.ReceiverThreadIDs
	}
	if it.Prompt != "" {
		d["prompt"] = it.Prompt
	}
	if it.Model != "" {
		d["model"] = it.Model
	}
	if it.ReasoningEffort != "" {
		d["reasoningEffort"] = it.ReasoningEffort
	}
	b, err := json.Marshal(d)
	if err != nil {
		return nil
	}
	return b
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

// roleFromAgentPath derives a display role from subAgentActivity's `agentPath`.
//
// ASSUMPTION, NOT VERIFIED against a live spawn: the schema types AgentPath as
// a bare `string` and says nothing about its shape, and no capture of a real
// multi-agent turn was available while writing this (the account's model
// rejected the effort level that triggers proactive delegation). The handling
// is deliberately lossless in the ambiguous direction — a plain name like
// "reviewer" is returned unchanged, and only an actual path is reduced to its
// file name — so if the guess is wrong the role is merely longer than ideal
// rather than wrong.
func roleFromAgentPath(agentPath string) string {
	p := strings.TrimSpace(agentPath)
	if p == "" {
		return ""
	}
	if strings.ContainsAny(p, "/\\") {
		p = path.Base(strings.ReplaceAll(p, "\\", "/"))
	}
	if ext := path.Ext(p); ext == ".md" || ext == ".toml" || ext == ".yaml" || ext == ".yml" {
		p = strings.TrimSuffix(p, ext)
	}
	return p
}

// titleFromPrompt is the fallback human label for an agent spawned through
// collabAgentToolCall, which reports the prompt but no name or role. The first
// line of the instruction is what a person would call the job.
const maxAgentTitleRunes = 80

func titleFromPrompt(prompt string) string {
	line := strings.TrimSpace(prompt)
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	if line == "" {
		return ""
	}
	r := []rune(line)
	if len(r) > maxAgentTitleRunes {
		return strings.TrimSpace(string(r[:maxAgentTitleRunes])) + "…"
	}
	return line
}

// ---------------------------------------------------------------------------
// Child-thread discovery from `thread/started`
// ---------------------------------------------------------------------------

// childThreadInfo is what a `thread/started` naming a SUBAGENT thread tells
// us. Thread.parentThreadId is documented as "only set if this thread is a
// subagent", which makes it the one unambiguous declaration of the parent /
// child edge — the two ThreadItem variants above imply it, this states it.
type childThreadInfo struct {
	ThreadID       string
	ParentThreadID string
	Role           string
	Title          string
	Depth          int
}

// childThreadInfoFrom decodes a thread/started params blob, reporting false
// for an ordinary top-level thread.
//
// Both spellings of the parent edge are read: the camelCase `parentThreadId`
// on Thread itself, and the snake_case `source.thread_spawn.parent_thread_id`
// (SubAgentSource is serialised with snake_case keys in the same schema, which
// is unusual enough to be worth reading rather than assuming).
func childThreadInfoFrom(params json.RawMessage) (childThreadInfo, bool) {
	var p struct {
		Thread struct {
			ID             string `json:"id"`
			ParentThreadID string `json:"parentThreadId"`
			AgentNickname  string `json:"agentNickname"`
			AgentRole      string `json:"agentRole"`
			Source         struct {
				ThreadSpawn *struct {
					Depth          int    `json:"depth"`
					ParentThreadID string `json:"parent_thread_id"`
					AgentNickname  string `json:"agent_nickname"`
					AgentRole      string `json:"agent_role"`
					AgentPath      string `json:"agent_path"`
				} `json:"thread_spawn"`
			} `json:"source"`
		} `json:"thread"`
	}
	// Thread.source is `string | object` depending on the variant, so a decode
	// error here is expected for a plain CLI thread and must not be loud.
	_ = json.Unmarshal(params, &p)

	info := childThreadInfo{
		ThreadID:       p.Thread.ID,
		ParentThreadID: p.Thread.ParentThreadID,
		Role:           p.Thread.AgentRole,
		Title:          p.Thread.AgentNickname,
	}
	if s := p.Thread.Source.ThreadSpawn; s != nil {
		if info.ParentThreadID == "" {
			info.ParentThreadID = s.ParentThreadID
		}
		if info.Role == "" {
			info.Role = s.AgentRole
		}
		if info.Role == "" {
			info.Role = roleFromAgentPath(s.AgentPath)
		}
		if info.Title == "" {
			info.Title = s.AgentNickname
		}
		info.Depth = s.Depth
	}
	if info.ThreadID == "" || info.ParentThreadID == "" {
		return childThreadInfo{}, false
	}
	return info, true
}
