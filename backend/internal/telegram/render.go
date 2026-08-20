package telegram

import (
	"encoding/json"
	"fmt"
	"strings"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
)

// Rendered is what one orchestration.Event becomes on Telegram.
//
// The four sinks exist because a Telegram thread is a CHAT, and a chat is a
// sequence of finished messages — not one message rewritten in place, which
// is what this bridge used to do. Reading back a turn that was edited into
// existence tells you only where it ended up; the discrete messages below
// preserve the order things actually happened in:
//
//	👤 hi
//	⏳ memproses…
//	⚙️ Bash          ← Notices, sent the moment they are rendered
//	bla bla bla      ← Text, one message per answer block
//
//   - Text and Reasoning are RAW markdown, deliberately not converted here.
//     They arrive as many small deltas and are concatenated by the pump before
//     a single ToMarkdownV2 pass runs over the whole block. Converting each
//     delta on its own would escape half of a "**bold**" whose other half has
//     not arrived yet, and the emphasis would never close.
//   - Notices are FINAL MarkdownV2, sent immediately and in order. They are
//     the events that are interesting on their own — the prompt, a tool call,
//     an error — and each is its own message so it keeps its own timestamp.
//   - Card is a Notice with an inline keyboard.
type Rendered struct {
	// Text is assistant prose, buffered by the pump into one message per
	// answer block. Raw markdown; see above.
	Text string
	// Reasoning is the model's thinking, buffered separately so it can be
	// sent as its own message ahead of the answer rather than run together
	// with it. Raw markdown.
	Reasoning string
	// Echo is the user's own prompt mirrored back, already MarkdownV2.
	//
	// Its own field, not just another Notice, because the pump DROPS it for
	// any turn this bridge itself started: the operator typed that message
	// into this very chat and can already see it, so sending it back is pure
	// noise. It survives only for turns started somewhere else — the browser
	// — where it is the sole record in Telegram of what was even asked.
	Echo string
	// Notices are standalone messages, already MarkdownV2, in send order.
	Notices []string
	Card    *Card
	// EndTurn says the turn finished, so the pump flushes whatever text is
	// still buffered instead of holding it for a continuation that will
	// never come.
	EndTurn bool
}

type Card struct {
	Text      string
	Buttons   []CardButton
	RequestID string
}

// CardButton's Action is an opaque intent — "accept", "decline", or an answer
// to a question. The bridge, not the renderer, turns it into the <=64-byte
// callback_data Telegram allows.
type CardButton struct {
	Label  string
	Action string
}

// Render turns one orchestration.Event into Telegram-ready output. Pure: no
// I/O, no state, no clock — every fact it needs is either on the event or
// baked into the copy below.
//
// Only the event/payload shapes listed in Task 3's rules table are
// recognized. Anything else — including event types this package will
// plausibly grow support for later (RuntimeError, RuntimeWarning,
// ToolDenied forwarded as thread.activity-appended, any bookkeeping event) —
// renders as a zero Rendered on purpose: guessing at an unlisted shape here
// is how a botched card silently corrupts the transcript three tasks from
// now, and session/turn bookkeeping flows through this function on every
// single tick of every thread, so the empty path has to be fast and boring.
func Render(ev orchestration.Event) Rendered {
	switch ev.Type {
	case orchestration.EvtThreadMessageSent:
		return renderMessageSent(ev.Payload)
	case orchestration.EvtThreadActivityAppended:
		return renderActivityAppended(ev.Payload)
	case orchestration.EvtThreadSessionSet:
		return renderSessionSet(ev.Payload)
	default:
		return Rendered{}
	}
}

// renderSessionSet is what actually ends a turn, and getting this wrong is
// why a finished answer could sit in the pump's buffer forever while the chat
// showed nothing but "memproses…".
//
// The obvious trigger — a forwarded event.TurnCompleted — never arrives.
// Ingestion CONSUMES that event and translates it into
// CmdThreadSessionSet{status:idle, ...} (workers.go), so the bridge sees a
// status change and no turn-completed event at all. Not one exists in a
// database with thousands of turns in it. renderTurnEnd is kept for a
// provider that might forward one, but this is the path that fires.
//
// Only the TERMINAL statuses flush. "running" is a turn starting, and
// "waiting" is an approval pending — whose card is a Notice, which already
// flushes the prose ahead of it.
func renderSessionSet(raw json.RawMessage) Rendered {
	var p struct {
		Status           string `json:"status"`
		TurnTokens       int64  `json:"turnTokens"`
		TurnOutputTokens int64  `json:"turnOutputTokens"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return Rendered{}
	}
	switch orchestration.ThreadStatus(p.Status) {
	case orchestration.ThreadIdle, orchestration.ThreadStopped:
	default:
		// Includes the empty status a session-set carrying only
		// pendingRequestAdd or resumeCursor decodes to.
		return Rendered{}
	}
	r := Rendered{EndTurn: true}
	// The usage footer, from the numbers that actually exist here. The old
	// one read TurnCompletedPayload.Usage, which is exactly the payload this
	// bridge never receives.
	if p.TurnTokens > 0 {
		r.Notices = []string{EscapeMarkdownV2(fmt.Sprintf("📊 %d token (%d output)", p.TurnTokens, p.TurnOutputTokens))}
	}
	return r
}

// renderMessageSent handles thread.message-sent, whose payload is
// orchestration.TurnStartPayload — the USER's own message. Nothing in the
// codebase dispatches CmdThreadAssistantComplete (see the comment at
// store/agentevent.go:97), so this event type is never the assistant
// speaking; the assistant's words arrive later as activity-appended deltas.
func renderMessageSent(raw json.RawMessage) Rendered {
	var p struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return Rendered{}
	}
	// The echo is separated from the notice because only one of them survives
	// a Telegram-originated turn — see Rendered.Echo. The "⏳" always does:
	// it is the chat's answer to "did it hear me?" during the seconds before
	// the first tool call or token arrives, which on an SSH thread that has
	// to boot a CLI first can be a long and otherwise completely silent wait.
	return Rendered{
		Echo:    "👤 " + EscapeMarkdownV2(p.Text),
		Notices: []string{"⏳ _memproses…_"},
	}
}

// renderActivityAppended handles thread.activity-appended, which is TWO
// different payload shapes depending on how Ingestion produced it:
//
//   - an assistant/reasoning text delta (orchestration.AssistantDeltaPayload
//     on the wire) when it came from CmdThreadAssistantDelta, or
//   - a whole forwarded event.Event when Ingestion had no more specific
//     command for what the provider sent.
//
// The discriminator has to be structural (does the JSON have the delta's
// four fields, in the right types?), not event-type based, because both
// shapes arrive under this one EventType — mirrors eventReducer.ts's
// isActivityAppendedPayload exactly, field for field.
func renderActivityAppended(raw json.RawMessage) Rendered {
	if d, ok := decodeDeltaPayload(raw); ok {
		return renderDelta(d)
	}
	if inner, ok := decodeForwardedEvent(raw); ok {
		return renderForwarded(inner)
	}
	if n, ok := decodeRuntimeNotice(raw); ok {
		return n
	}
	return Rendered{}
}

// decodeRuntimeNotice handles the ONE activity payload that is neither a delta
// nor a forwarded provider event: the reactor's own failure report,
// `{"kind":"runtime.error","message":…}` (workers.go's Reactor.reportError).
//
// It carries no "type" field, so decodeForwardedEvent rejects it and it used
// to fall through to a zero Rendered — invisible. That mattered more than it
// looks: a reactor error is exactly how "the CLI binary is missing", "this SSH
// connection id does not exist" and "the session would not start" reach the
// user. The turn is settled back to idle either way, so in Telegram the
// prompt simply produced nothing at all, with no error and no explanation —
// the same dead end an empty allowlist used to produce, one layer deeper.
func decodeRuntimeNotice(raw json.RawMessage) (Rendered, bool) {
	var p struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return Rendered{}, false
	}
	switch p.Kind {
	case "runtime.error":
		// EndTurn: reportError also settles the thread to idle, so no
		// TurnCompleted is coming to flush the buffered answer later.
		return Rendered{Notices: []string{"⚠️ " + EscapeMarkdownV2(p.Message)}, EndTurn: true}, true
	case "runtime.warning":
		return Rendered{Notices: []string{"⚠️ " + EscapeMarkdownV2(p.Message)}}, true
	}
	return Rendered{}, false
}

// deltaPayload is the on-wire shape of an assistant/reasoning delta —
// {itemId, stream, text, sequence}. Sequence is decoded as float64 because
// that is what encoding/json produces for a JSON number decoded into
// map[string]any; it is only used here to prove the field's type, never
// compared or ordered, so the float64 imprecision that would matter for a
// huge sequence number never comes into play.
type deltaPayload struct {
	ItemID   string
	Stream   string
	Text     string
	Sequence float64
}

// decodeDeltaPayload reports whether raw has all four delta fields present
// with the right JSON types. This is the load-bearing check: a forwarded
// event.Event has a "type" field and no "sequence" field, so the two shapes
// never both match, but a wrong or partial guess here would misroute a
// forwarded event.Event as an (empty) delta instead of falling through to
// decodeForwardedEvent below. Matching isActivityAppendedPayload's ALL-FOUR
// rule keeps that from happening.
func decodeDeltaPayload(raw json.RawMessage) (deltaPayload, bool) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return deltaPayload{}, false
	}
	itemID, ok1 := m["itemId"].(string)
	stream, ok2 := m["stream"].(string)
	text, ok3 := m["text"].(string)
	seq, ok4 := m["sequence"].(float64)
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return deltaPayload{}, false
	}
	return deltaPayload{ItemID: itemID, Stream: stream, Text: text, Sequence: seq}, true
}

// renderDelta renders the two recognized stream kinds. Any other StreamKind
// (StreamStdout/StreamStderr today) has never been observed on an assistant
// delta — deltas only ever carry the model's own text or its reasoning — so
// it renders empty rather than guessing at a prefix for a case that has
// never actually happened.
func renderDelta(d deltaPayload) Rendered {
	switch event.StreamKind(d.Stream) {
	case event.StreamText:
		// Raw and unprefixed: these concatenate into one answer message, and
		// both an icon and an escape pass belong to the whole block rather
		// than to each fragment of a half-finished sentence.
		return Rendered{Text: d.Text}
	case event.StreamReasoning:
		return Rendered{Reasoning: d.Text}
	default:
		return Rendered{}
	}
}

// decodeForwardedEvent reports whether raw is a whole forwarded event.Event
// — mirrors isForwardedProviderEvent's rule ("a forwarded envelope always
// carries the provider event's own `type`; a delta payload never does") by
// probing for a string "type" field before committing to the full decode.
//
// The full decode goes through event.Event's own UnmarshalJSON, which looks
// the event's Type up in event's payload registry and decodes the nested
// "payload" object into the matching concrete struct (e.g.
// *event.RequestOpenedPayload). That registry does not cover every Type —
// notably TurnAborted has no registered payload — in which case Payload
// comes back nil rather than erroring; callers below already treat a nil
// Payload as "nothing more to say" for that reason.
func decodeForwardedEvent(raw json.RawMessage) (event.Event, bool) {
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return event.Event{}, false
	}
	if _, ok := probe["type"].(string); !ok {
		return event.Event{}, false
	}
	var inner event.Event
	if err := json.Unmarshal(raw, &inner); err != nil {
		return event.Event{}, false
	}
	return inner, true
}

// renderForwarded dispatches a forwarded event.Event by its own Type. Only
// the rows in Task 3's table are handled; everything else — including
// RuntimeError/RuntimeWarning/ToolDenied, which eventReducer.ts does render
// on the frontend — is deliberately left to a later task rather than guessed
// at here.
func renderForwarded(inner event.Event) Rendered {
	switch inner.Type {
	case event.RequestOpened:
		return renderRequestOpened(inner)
	case event.UserInputRequested:
		return renderUserInputRequested(inner)
	case event.ItemStarted:
		return renderItemStarted(inner)
	case event.ItemCompleted:
		return renderItemCompleted(inner)
	case event.TurnCompleted, event.TurnAborted:
		return renderTurnEnd(inner)
	default:
		return Rendered{}
	}
}

// requestTypeLabel gives a short Indonesian label for the kind of approval
// being requested, shown as the card's headline since RequestOpenedPayload
// carries no tool name of its own (see the comment on
// TestRenderApprovalRequestBecomesACardWithThreeDecisions for why the plan's
// draft test guessed a ToolName field that does not exist).
func requestTypeLabel(rt event.RequestType) string {
	switch rt {
	case event.ReqCommandExecApproval:
		return "Jalankan perintah"
	case event.ReqFileReadApproval:
		return "Baca file"
	case event.ReqFileChangeApproval:
		return "Ubah file"
	case event.ReqApplyPatchApproval:
		return "Terapkan patch"
	case event.ReqToolUserInput:
		return "Input tool"
	default:
		return "Persetujuan tool"
	}
}

// decisionLabel is the button caption for one event.Decision. The bridge
// reads CardButton.Action (the raw Decision string), never this label, to
// build ApprovalRespondPayload — see CardButton's doc comment.
func decisionLabel(d event.Decision) string {
	switch d {
	case event.DecisionAccept:
		return "✅ Terima"
	case event.DecisionAcceptForSession:
		return "✅ Terima (sesi ini)"
	case event.DecisionDecline:
		return "❌ Tolak"
	case event.DecisionCancel:
		return "🚫 Batalkan"
	default:
		return string(d)
	}
}

// renderRequestOpened turns a blocking approval request into a Card. Buttons
// come straight from Options — filled in by the provider adapter because
// which decisions are offered (e.g. whether acceptForSession is available)
// varies per provider, so this renderer must not invent or drop any of them.
func renderRequestOpened(inner event.Event) Rendered {
	p, ok := inner.Payload.(*event.RequestOpenedPayload)
	if !ok || p == nil {
		return Rendered{}
	}
	text := "🔐 *" + EscapeMarkdownV2(requestTypeLabel(p.RequestType)) + "*"
	if p.Detail != "" {
		// Truncated, not sent whole: Detail is provider text of unbounded
		// length (a pasted heredoc, a long patch summary) and Telegram
		// rejects a message over 4096 characters outright. That rejection is
		// not retryable, and the pump refuses to advance its cursor past
		// anything it could not send — so one oversized approval card would
		// freeze the whole thread's mirror, permanently.
		//
		// A code block, not prose: Detail is a shell command or a patch, and
		// inside a code entity MarkdownV2 only ` and \ need escaping — which
		// keeps a command legible instead of shot through with backslashes.
		text += "\n" + CodeBlockMarkdownV2(truncateForTelegram(p.Detail, cardTextLimit))
	}
	buttons := make([]CardButton, 0, len(p.Options))
	for _, opt := range p.Options {
		buttons = append(buttons, CardButton{Label: decisionLabel(opt), Action: string(opt)})
	}
	return Rendered{Card: &Card{Text: text, Buttons: buttons, RequestID: inner.RequestID}}
}

// userInputQuestion mirrors the normalized question shape
// provider/claude/parse.go's normalizeUserInputQuestions writes into
// UserInputRequestedPayload.Questions (id/header/question/options/multiSelect
// — the same fields frontend/src/features/agent-chat/pendingUserInput.ts's
// UserInputQuestion expects). Redeclared locally rather than imported: that
// struct is unexported in the claude provider package, and this package must
// not depend on a specific provider anyway (the event is provider-agnostic
// by the time it reaches here).
type userInputQuestion struct {
	ID       string `json:"id"`
	Header   string `json:"header"`
	Question string `json:"question"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
	MultiSelect bool `json:"multiSelect"`
}

// renderUserInputRequested turns an AskUserQuestion request into a Card.
// UserInputRespondPayload.Answers is keyed by the FULL QUESTION TEXT (see its
// doc comment in command.go), so CardButton.Action carries the option's own
// label — the bridge, when it later builds the answer map, keys it off this
// event's question text and the tapped button's Action.
//
// AskUserQuestion can carry more than one question, but only the first is
// rendered: the card's buttons answer one question at a time, and nothing in
// this event tells the renderer which of several questions the operator is
// mid-way through — that is turn state, which this pure function does not
// have. Multi-question flows are Task 5's/6's problem, not this one's.
func renderUserInputRequested(inner event.Event) Rendered {
	p, ok := inner.Payload.(*event.UserInputRequestedPayload)
	if !ok || p == nil {
		return Rendered{}
	}
	var questions []userInputQuestion
	if err := json.Unmarshal(p.Questions, &questions); err != nil || len(questions) == 0 {
		return Rendered{}
	}
	q := questions[0]
	text := "❓ " + EscapeMarkdownV2(truncateForTelegram(q.Question, cardTextLimit))
	buttons := make([]CardButton, 0, len(q.Options))
	for _, opt := range q.Options {
		buttons = append(buttons, CardButton{Label: opt.Label, Action: opt.Label})
	}
	return Rendered{Card: &Card{Text: text, Buttons: buttons, RequestID: inner.RequestID}}
}

// cardTextLimit is the character budget for a card's body — an approval's
// Detail, a question's text — counted BEFORE escaping runs. Telegram rejects
// a message over 4096 characters, and MarkdownV2 escaping can double a string
// (every special gains a backslash), so the pre-escape budget stays well
// under half of that. Unlike prose, which the pump splits across messages, a
// card is one indivisible message: it cannot be continued into a second one.
const cardTextLimit = 800

// toolResultTruncateLimit is the character budget for a tool call's
// arguments block before it gets cut off — well under Telegram's 4096
// message cap, since the live message may already carry other turns' worth
// of text by the time this gets appended.
const toolResultTruncateLimit = 800

// renderItemStarted handles item.started for a tool call. ItemStartedPayload
// is the only one of the two item payloads that carries a Title —
// ItemCompletedPayload does not — so this is also the only place a tool's
// name is ever available to render.
func renderItemStarted(inner event.Event) Rendered {
	// Tool calls are correlated across item.started and item.completed by the
	// pump (toolCallNotice) and rendered ONCE, so nothing is emitted here.
	// See ToolCallParts for why neither event can be rendered on its own.
	return Rendered{}
}

// renderItemCompleted handles item.completed, which forwards two unrelated
// things under one Type: a finished tool call (ItemType == ItemToolCall) and
// a reported error (ItemType == ItemError). ItemCompletedPayload has no
// Message field of its own — unlike event.ErrorPayload used by RuntimeError
// — so the error case below can only ever show a generic notice; there is no
// struct field to pull a specific message out of.
func renderItemCompleted(inner event.Event) Rendered {
	p, ok := inner.Payload.(*event.ItemCompletedPayload)
	if !ok || p == nil {
		return Rendered{}
	}
	switch p.ItemType {
	case event.ItemToolCall:
		return Rendered{} // see renderItemStarted
	case event.ItemError:
		return Rendered{Notices: []string{"⚠️ " + EscapeMarkdownV2("Agent melaporkan error.")}}
	default:
		return Rendered{}
	}
}

// ToolCallParts pulls the two halves of a tool call out of one forwarded
// event: the tool's NAME and a one-line summary of what it is acting on.
//
// Neither half is reliably on either event, and that asymmetry is the whole
// reason this is separate from Render:
//
//	claude  item.started   {"title":"Bash","detail":{"name","toolCallId"}}   -> name, no args
//	        item.completed {"detail":{"command":"...","description":"..."}}  -> args, NO name
//	pi      item.started   {"detail":{"toolCallId","name","args"}}           -> name + args
//	        item.completed {"detail":{"toolCallId","name","result"}}         -> result, no args
//
// Rendering each event on its own is what produced two messages per call —
// "tool Bash" and then "tool Tool" with a wall of JSON — which is spam twice
// over. The pump keeps the name from the first event and emits one line when
// the summary arrives.
func ToolCallParts(inner event.Event) (name, summary string, isToolCall bool) {
	switch p := inner.Payload.(type) {
	case *event.ItemStartedPayload:
		if p == nil || p.ItemType != event.ItemToolCall {
			return "", "", false
		}
		return p.Title, toolSummary(toolArgsOf(p.Detail)), true
	case *event.ItemCompletedPayload:
		if p == nil || p.ItemType != event.ItemToolCall {
			return "", "", false
		}
		// item.completed carries no Title on any provider observed; the name
		// comes from the started event the pump remembered.
		return "", toolSummary(toolArgsOf(p.Detail)), true
	}
	return "", "", false
}

// FormatToolCall is the one line a finished tool call becomes:
//
//	OK Write: /Users/kiyora/.../flow-code.md
//
// The argument, not a JSON dump of every argument. A turn that reads eight
// files otherwise sent eight messages of punctuation wrapped around the one
// string worth reading, and on a phone that buries the answer completely.
func FormatToolCall(name, summary string) string {
	if name == "" {
		name = "Tool"
	}
	line := "\u2713 *" + EscapeMarkdownV2(name) + "*"
	if summary != "" {
		line += ": " + EscapeMarkdownV2(summary)
	}
	return line
}

// summaryKeys mirrors SUMMARY_KEYS in frontend/src/features/agent-chat/adapter.ts,
// in the same order, so a call reads identically in the app and in Telegram.
// Read/Edit/Write name a file_path, Bash a command, Grep/Glob a pattern,
// WebFetch a url, Task a description.
//
// One ordered list rather than a per-tool table, for that file's reason: a
// provider can introduce a tool name nothing here has heard of (MCP tools
// especially), and a list of argument NAMES degrades to "something useful"
// where a name-keyed table degrades to nothing.
var summaryKeys = []string{
	"file_path", "path", "command", "pattern", "url", "query", "description", "name", "prompt",
}

// toolSummaryMax caps the line. Generous: Telegram wraps rather than
// truncating, so this only stops a 10,000-character heredoc from becoming the
// message. Matches adapter.ts's SUMMARY_MAX.
const toolSummaryMax = 160

// toolSummary is the Go twin of adapter.ts's toolSummary: the first string
// argument that says what the call is DOING, whitespace-collapsed (a
// multi-line heredoc is still one action) and capped.
func toolSummary(args json.RawMessage) string {
	if len(args) == 0 {
		return ""
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(args, &fields); err != nil || fields == nil {
		return ""
	}
	for _, key := range summaryKeys {
		raw, ok := fields[key]
		if !ok {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			continue // present but not a string
		}
		line := strings.Join(strings.Fields(value), " ")
		if line == "" {
			continue
		}
		return truncateForTelegram(line, toolSummaryMax)
	}
	return ""
}

// toolArgsOf extracts a tool call's arguments out of ItemStartedPayload's or
// ItemCompletedPayload's Detail — mirrors eventReducer.ts's toolDetailParts,
// arguments half only (Task 3 does not render a tool's result, only its
// arguments; see the rules table).
//
// Per the long comment above toolCallIdOf in eventReducer.ts: the two live
// providers disagree about Detail's shape. claude sends the tool's raw
// arguments as the WHOLE Detail object on item.completed, with no envelope.
// pi wraps both sides in one envelope — {toolCallId, name, args} on
// item.started, {toolCallId, name, result} on item.completed — so pi's
// arguments arrive ONLY on item.started. toolCallId's presence (as a string)
// is what tells the two shapes apart: present means "read the "args" key out
// of this envelope, which may itself be absent"; absent means "this whole
// object IS the arguments". A non-object Detail (array, string, number,
// null, or simply missing) never carries arguments and returns nil.
func toolArgsOf(detail json.RawMessage) json.RawMessage {
	if len(detail) == 0 {
		return nil
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(detail, &probe); err != nil || probe == nil {
		return nil
	}
	if rawID, ok := probe["toolCallId"]; ok {
		var id string
		if json.Unmarshal(rawID, &id) == nil && id != "" {
			return probe["args"] // may legitimately be absent (pi's item.completed)
		}
	}
	return detail
}

// truncateForTelegram cuts s to at most limit runes (rune-based so a
// multi-byte character is never split mid-sequence) and appends the
// Indonesian "truncated" marker when it does. Truncation happens on the RAW
// text, BEFORE escaping — cutting afterwards can strand a trailing
// backslash, which MarkdownV2 rejects as an escape with nothing to escape.
func truncateForTelegram(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit]) + "… (dipotong)"
}

// renderTurnEnd handles both TurnCompleted and TurnAborted: both end the
// turn, so both seal the live message. Only TurnCompleted has a registered
// payload (TurnCompletedPayload) — TurnAborted has none in event.go's
// payloadRegistry, so inner.Payload is always nil for it, and the type
// assertion below simply fails and produces no footer. That is correct, not
// a gap: an aborted turn has no usage to report.
func renderTurnEnd(inner event.Event) Rendered {
	r := Rendered{EndTurn: true}
	if p, ok := inner.Payload.(*event.TurnCompletedPayload); ok && p != nil && p.Usage != nil {
		// A Notice, so it lands AFTER the answer the pump flushes on EndTurn
		// rather than being concatenated onto the end of it.
		r.Notices = []string{EscapeMarkdownV2(fmt.Sprintf("📊 %d↑ %d↓ token", p.Usage.InputTokens, p.Usage.OutputTokens))}
	}
	return r
}

// Outbound messages are MarkdownV2, not HTML — see markdown.go for the
// conversion and client.go's SendMessage for the fallback that keeps a
// message Telegram cannot parse from wedging the mirror.
