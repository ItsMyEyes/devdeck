package telegram

import (
	"context"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
)

func mustJSONRaw(s string) []byte { return []byte(s) }

// seedToolCall commits the item.started / item.completed pair exactly as a
// provider emits it, so these tests exercise the real asymmetry rather than a
// tidied-up version of it.
func seedToolCall(t *testing.T, engine *orchestration.Engine, threadID, itemID string, started, completed event.Event) {
	t.Helper()
	for i, ev := range []event.Event{started, completed} {
		ev.ThreadID = threadID
		ev.ItemID = itemID
		if _, err := engine.Dispatch(context.Background(), orchestration.Command{
			CommandID: itemID + "-" + string(rune('a'+i)), Type: orchestration.CmdThreadActivityAppend,
			ThreadID: threadID, Payload: mustJSON(t, ev),
		}); err != nil {
			t.Fatalf("seed tool event: %v", err)
		}
	}
}

// The reported spam: every tool call sent TWO messages, the second of them a
// code block of raw JSON headed "Tool". One line per call, naming what it
// acted on, is what the app's transcript shows.
func TestToolCallIsOneCompactLine(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	b.sweep(context.Background())

	// Claude's real shape: the NAME on started, the ARGS on completed.
	seedToolCall(t, engine, "w-abc", "item-1",
		event.Event{Type: event.ItemStarted, Payload: &event.ItemStartedPayload{
			ItemType: event.ItemToolCall, Title: "Write",
			Detail: mustJSON(t, map[string]any{"name": "Write", "toolCallId": "toolu_1"}),
		}},
		event.Event{Type: event.ItemCompleted, Payload: &event.ItemCompletedPayload{
			ItemType: event.ItemToolCall,
			Detail: mustJSON(t, map[string]any{
				"file_path": "/Users/kiyora/Documents/freelance/mabes/superapps/core/.claude/rules/common/flow-code.md",
				"content":   "a very long body that must never reach Telegram",
			}),
		}},
	)
	b.sweep(context.Background())

	var lines []string
	for _, sent := range transport.sent {
		lines = append(lines, sent.Text)
	}
	if len(lines) != 1 {
		t.Fatalf("want exactly one message per tool call, got %d: %+v", len(lines), lines)
	}
	line := lines[0]
	if !strings.Contains(line, "Write") {
		t.Fatalf("the tool name is missing: %q", line)
	}
	// Escaped, because "-" and "." are MarkdownV2 specials.
	if !strings.Contains(line, `flow\-code\.md`) {
		t.Fatalf("the file it acted on is missing: %q", line)
	}
	// The whole point: no JSON dump, and no second "Tool" message.
	if strings.Contains(line, "```") || strings.Contains(line, "content") {
		t.Fatalf("the arguments were dumped instead of summarised: %q", line)
	}
	if strings.Contains(line, "Tool\\") || strings.Count(line, "\n") > 0 {
		t.Fatalf("want a single line, got %q", line)
	}
}

// pi puts the arguments on item.started and only a result on item.completed.
// The same one-line-per-call rule has to hold.
func TestToolCallSummaryFromTheStartedEvent(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	b.sweep(context.Background())

	seedToolCall(t, engine, "w-abc", "item-2",
		event.Event{Type: event.ItemStarted, Payload: &event.ItemStartedPayload{
			ItemType: event.ItemToolCall, Title: "Bash",
			Detail: mustJSON(t, map[string]any{
				"toolCallId": "call_2", "name": "Bash",
				"args": map[string]any{"command": "go test ./..."},
			}),
		}},
		event.Event{Type: event.ItemCompleted, Payload: &event.ItemCompletedPayload{
			ItemType: event.ItemToolCall,
			Detail:   mustJSON(t, map[string]any{"toolCallId": "call_2", "name": "Bash", "result": "ok"}),
		}},
	)
	b.sweep(context.Background())

	if len(transport.sent) != 1 {
		t.Fatalf("want one message, got %+v", transport.sent)
	}
	if !strings.Contains(transport.sent[0].Text, "go test") {
		t.Fatalf("the command is missing: %q", transport.sent[0].Text)
	}
}

// A multi-line heredoc is still ONE action and gets one line.
func TestToolSummaryCollapsesAndCaps(t *testing.T) {
	got := toolSummary(mustJSONRaw(`{"command":"cat <<EOF\nline one\nline two\nEOF"}`))
	if strings.Contains(got, "\n") {
		t.Fatalf("newlines survived: %q", got)
	}
	if !strings.Contains(got, "line one line two") {
		t.Fatalf("collapsed wrong: %q", got)
	}

	long := strings.Repeat("x", 400)
	capped := toolSummary(mustJSONRaw(`{"path":"` + long + `"}`))
	if len([]rune(capped)) > toolSummaryMax+len(" … (dipotong)") {
		t.Fatalf("summary not capped: %d runes", len([]rune(capped)))
	}
}

// The key order decides which argument is shown; it must match the app's, or
// the same call reads differently in the two places.
func TestToolSummaryPrefersTheFileOverOtherArguments(t *testing.T) {
	got := toolSummary(mustJSONRaw(`{"description":"tidy up","file_path":"/tmp/a.go"}`))
	if got != "/tmp/a.go" {
		t.Fatalf("summary = %q, want the file_path", got)
	}
}
