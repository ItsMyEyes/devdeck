package telegram

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
)

// startTurn puts a thread into the state an operator publishes from: a
// question asked, the turn running, nothing finished.
func startTurn(t *testing.T, engine *orchestration.Engine, threadID, commandID, text string) {
	t.Helper()
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: commandID, Type: orchestration.CmdThreadTurnStart, ThreadID: threadID,
		Payload: mustJSON(t, orchestration.TurnStartPayload{Text: text}),
	}); err != nil {
		t.Fatalf("turn start %s: %v", commandID, err)
	}
}

// endTurn is how production ends one: Ingestion consumes the provider's
// TurnCompleted and dispatches a session-set. See renderSessionSet.
func endTurn(t *testing.T, engine *orchestration.Engine, threadID, commandID string) {
	t.Helper()
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: commandID, Type: orchestration.CmdThreadSessionSet, ThreadID: threadID,
		Payload: mustJSON(t, map[string]any{"status": string(orchestration.ThreadIdle)}),
	}); err != nil {
		t.Fatalf("turn end %s: %v", commandID, err)
	}
}

func sentTexts(transport *fakeTransport, from int) string {
	parts := make([]string, 0, len(transport.sent))
	for _, m := range transport.sent[from:] {
		parts = append(parts, m.Text)
	}
	return strings.Join(parts, " || ")
}

// Publishing DURING a run must mirror the run.
//
// /init means "mirror from here on", and a new binding therefore starts at the
// thread's head — but taken literally that put the cursor in the MIDDLE of a
// turn already in flight, whose question and prose so far were all behind it.
// The chat then showed nothing whatsoever for that turn and the first thing to
// arrive was the next one, which is the reported "publish saat agent jalan,
// turn yang sedang jalan tidak pernah muncul". A turn that will run for
// minutes is the exact reason an operator reaches for their phone, so "from
// here on" has to include what is happening right now.
func TestInitDuringARunningTurnMirrorsThatTurnFromItsStart(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	startTurn(t, engine, "w-abc", "turn-1", "kenapa deploy gagal?")
	seedDelta(t, engine, "w-abc", "d1", "SEBELUM-BIND ", 1)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init w-abc",
	}})
	afterInit := len(transport.sent)

	seedDelta(t, engine, "w-abc", "d2", "SESUDAH-BIND", 2)
	endTurn(t, engine, "w-abc", "end-1")
	b.sweep(context.Background())

	got := sentTexts(transport, afterInit)
	// The question, or the answer arrives with nothing to answer.
	if !strings.Contains(got, "kenapa deploy gagal") {
		t.Fatalf("the running turn's question never reached Telegram: %s", got)
	}
	// Prose from BEFORE the bind is part of this turn and must come too.
	if !strings.Contains(got, "SEBELUM") || !strings.Contains(got, "SESUDAH") {
		t.Fatalf("the in-flight turn was not mirrored in full: %s", got)
	}
}

// The rewind is bounded by ONE turn, never the whole log. A thread with
// thousands of historical events published mid-run must not dump its history
// into Telegram — that is the 429 storm the head-not-zero rule exists to
// prevent, and it is still prevented.
func TestInitDuringARunningTurnDoesNotReplayEarlierTurns(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	startTurn(t, engine, "w-abc", "turn-old", "PERTANYAAN-LAMA")
	seedDelta(t, engine, "w-abc", "old1", "JAWABAN-LAMA", 1)
	endTurn(t, engine, "w-abc", "end-old")

	startTurn(t, engine, "w-abc", "turn-new", "PERTANYAAN-BARU")
	seedDelta(t, engine, "w-abc", "new1", "JAWABAN-BARU", 1)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init w-abc",
	}})
	afterInit := len(transport.sent)

	endTurn(t, engine, "w-abc", "end-new")
	b.sweep(context.Background())

	got := sentTexts(transport, afterInit)
	if strings.Contains(got, "LAMA") {
		t.Fatalf("the previous turn was replayed into Telegram: %s", got)
	}
	if !strings.Contains(got, "BARU") {
		t.Fatalf("the running turn was not mirrored: %s", got)
	}
}

// An IDLE thread keeps the original rule exactly: bind at head, mirror
// nothing historical. Only a turn in flight earns the rewind.
func TestInitOnAnIdleThreadStillBindsAtHead(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	startTurn(t, engine, "w-abc", "turn-1", "PERTANYAAN-LAMA")
	seedDelta(t, engine, "w-abc", "d1", "JAWABAN-LAMA", 1)
	endTurn(t, engine, "w-abc", "end-1")

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init w-abc",
	}})
	afterInit := len(transport.sent)

	b.sweep(context.Background())
	if got := sentTexts(transport, afterInit); got != "" {
		t.Fatalf("an idle-thread bind replayed history: %s", got)
	}
}

// A turn parked on an approval is the single most valuable thing to publish
// mid-run: the operator reaches for their phone precisely because something is
// waiting for a tap. The engine records that state as WAITING, not running
// (pendingRequestAdd), so a rewind gated on "running" alone bound at head and
// the pending card — already in the log, behind the cursor — was never
// mirrored. The chat then showed nothing at all and the request sat unanswered.
func TestInitDuringATurnWaitingOnAnApprovalMirrorsTheCard(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	startTurn(t, engine, "w-abc", "turn-1", "hapus build lama")
	seedRequestOpened(t, engine, "w-abc", "req-1", []event.Decision{event.DecisionAccept, event.DecisionDecline})

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init w-abc",
	}})
	afterInit := len(transport.sent)

	b.sweep(context.Background())

	var carded bool
	for _, m := range transport.sent[afterInit:] {
		if len(m.Keyboard) > 0 {
			carded = true
		}
	}
	if !carded {
		t.Fatalf("the pending approval card was never mirrored: %s", sentTexts(transport, afterInit))
	}
}

// A long answer with no tool calls used to be invisible in Telegram for the
// whole turn: prose was flushed only behind a notice, a card, or the terminal
// session-set. On a turn that runs for minutes that is indistinguishable from
// a bridge that has stopped working.
func TestLongProseIsFlushedWhileTheTurnIsStillRunning(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init w-abc",
	}})
	afterInit := len(transport.sent)

	startTurn(t, engine, "w-abc", "turn-1", "tulis laporan panjang")
	// One event per token is what the durable log actually holds, so this is
	// the real shape: many small deltas, no tool call, no end of turn.
	chunk := strings.Repeat("a", 100) + " "
	for i := 0; i < 20; i++ {
		seedDelta(t, engine, "w-abc", "d"+string(rune('a'+i)), chunk, uint64(i+1))
	}
	b.sweep(context.Background())

	got := sentTexts(transport, afterInit)
	if !strings.Contains(got, strings.Repeat("a", 100)) {
		t.Fatalf("nothing was mirrored during a long running turn: %q", got)
	}
}

// countSent is how many of the messages that reached "Telegram" contain marker.
func countSent(transport *fakeTransport, marker string) int {
	n := 0
	for _, m := range transport.sent {
		if strings.Contains(m.Text, marker) {
			n++
		}
	}
	return n
}

// A sweep that fails PARTWAY must not re-send what it already delivered.
//
// The all-or-nothing cursor rule was written when a sweep sent at most one
// message per turn boundary; the progressive mid-turn flush made one sweep send
// many. emittedSeq is by construction "everything up to here is on Telegram
// already", so abandoning it on a later failure re-sends every earlier chunk —
// on a long turn, the same paragraphs over and over, which is also the fastest
// way into a 429.
func TestAnEarlierFlushIsNotResentWhenALaterSendFails(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	// Drain the thread.created bookkeeping so the cursor below moves only for
	// what this test seeds.
	b.sweep(context.Background())

	startTurn(t, engine, "w-abc", "turn-1", "bersihkan build lama")
	// Enough prose to cross streamFlushChars mid-sweep, so the sweep sends a
	// chunk and THEN keeps going.
	seedDelta(t, engine, "w-abc", "d1", "PENANDASATU "+strings.Repeat("a", 400), 1)
	seedDelta(t, engine, "w-abc", "d2", strings.Repeat("b", 400), 2)
	seedDelta(t, engine, "w-abc", "d3", strings.Repeat("c", 400), 3)
	seedDelta(t, engine, "w-abc", "d4", "PENANDADUA "+strings.Repeat("d", 40), 4)
	// The card is the send that fails — after the chunk above is already out.
	seedRequestOpened(t, engine, "w-abc", "req-1", []event.Decision{event.DecisionAccept})

	transport.mu.Lock()
	transport.failSendMatching = "rm -rf"
	transport.mu.Unlock()
	b.sweep(context.Background())

	if countSent(transport, "PENANDASATU") != 1 {
		t.Fatalf("the mid-sweep flush did not go out exactly once: %s", sentTexts(transport, 0))
	}

	transport.mu.Lock()
	transport.failSendMatching = ""
	transport.mu.Unlock()
	b.sweep(context.Background())

	if n := countSent(transport, "PENANDASATU"); n != 1 {
		t.Fatalf("an already-delivered chunk was sent %d times after a later send failed", n)
	}
}

// One sweep must not fire a whole backlog at Telegram in a tight loop.
//
// The /init mid-run rewind and the char-threshold flush compose badly: a turn
// that has been running for minutes is tens of thousands of characters, which
// the catch-up sweep turns into ~one sendMessage per streamFlushChars, back to
// back. Telegram answers that with 429, and callWithRetry then sleeps out the
// retry_after while holding this binding's lock — so the punishment for
// publishing a long run is that the mirror stalls. The backlog is not urgent:
// the next tick is 2s away, and the cursor rule makes continuing exact.
func TestACatchUpSweepIsBudgetedAndStillDeliversEverythingOnce(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	startTurn(t, engine, "w-abc", "turn-1", "tulis laporan panjang")
	const deltas = 60
	for i := 0; i < deltas; i++ {
		seedDelta(t, engine, "w-abc", fmt.Sprintf("d%d", i),
			fmt.Sprintf("M%02dM ", i)+strings.Repeat("x", 1000), uint64(i+1))
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init w-abc",
	}})
	afterInit := len(transport.sent)

	b.sweep(context.Background())
	if n := len(transport.sent) - afterInit; n > sweepMessageBudget {
		t.Fatalf("one catch-up sweep put %d messages on the wire, budget is %d", n, sweepMessageBudget)
	}

	// ...and the rest arrives on the following ticks, each chunk exactly once.
	for i := 0; i < 50; i++ {
		before := len(transport.sent)
		b.sweep(context.Background())
		if len(transport.sent) == before {
			break
		}
	}
	for i := 0; i < deltas; i++ {
		marker := fmt.Sprintf("M%02dM", i)
		if n := countSent(transport, marker); n != 1 {
			t.Fatalf("delta %s reached Telegram %d time(s), want exactly 1", marker, n)
		}
	}
}

// The progressive flush must not cut a fenced code block in half.
//
// ToMarkdownV2 tracks fence parity per MESSAGE, so a second chunk that starts
// inside a block starts with the parity inverted: the code renders as prose
// (escaped to pieces) and the prose that follows the closing fence renders as
// code. A patch or a shell snippet arriving like that is not just ugly, it is
// unusable — the operator cannot copy it.
//
// Asserted on the ESCAPING, not on counting "```" in the output: ToMarkdownV2
// closes an unterminated fence on its way out, so every message it produces has
// balanced fences whether or not the split was legal. What gives the inversion
// away is that a code line came out prose-escaped.
func TestAFencedCodeBlockIsNeverFlushedInHalf(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	seedDelta(t, engine, "w-abc", "d-open", "Ini:\n\n```go\n", 1)
	const lines = 150 // well past streamFlushChars once multiplied out
	for i := 0; i < lines; i++ {
		seedDelta(t, engine, "w-abc", fmt.Sprintf("d%d", i), "x := a * b\n", uint64(i+2))
	}
	seedDelta(t, engine, "w-abc", "d-close", "```\n\nSelesai.", uint64(lines+2))
	seedTurnEnd(t, engine, "w-abc", "end-1")

	b.sweep(context.Background())

	for _, m := range transport.sent {
		if strings.Contains(m.Text, `x :\= a \* b`) {
			t.Fatalf("a code line was rendered as prose — the flush cut the fence in half: %q", m.Text)
		}
	}
	if countSent(transport, "x := a * b") == 0 {
		t.Fatalf("the code block never arrived verbatim: %s", sentTexts(transport, 0))
	}
	if countSent(transport, `Selesai\.`) == 0 {
		t.Fatalf("the prose after the closing fence was rendered as code: %s", sentTexts(transport, 0))
	}
}

// The other half: text that never reaches the size threshold must not sit
// buffered forever either. Holding a couple of sentences for six minutes is
// the same silence by a different route.
func TestBufferedProseIsFlushedAfterTheStreamInterval(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	now := time.Now()
	b.now = func() time.Time { return now }

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init w-abc",
	}})
	afterInit := len(transport.sent)

	startTurn(t, engine, "w-abc", "turn-1", "sebentar")
	seedDelta(t, engine, "w-abc", "d1", "SATU KALIMAT PENDEK", 1)

	b.sweep(context.Background())
	if got := sentTexts(transport, afterInit); strings.Contains(got, "SATU KALIMAT") {
		t.Fatalf("a fresh sweep dribbled prose out immediately instead of coalescing: %s", got)
	}

	now = now.Add(streamFlushInterval + time.Second)
	b.sweep(context.Background())
	if got := sentTexts(transport, afterInit); !strings.Contains(got, "SATU KALIMAT") {
		t.Fatalf("prose stayed buffered past the flush interval: %s", got)
	}

	// And the cursor moved with it — everything sent, nothing to re-send.
	binding, err := st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	before := len(transport.sent)
	b.sweep(context.Background())
	if len(transport.sent) != before {
		t.Fatalf("already-delivered prose was sent again: %+v", transport.sent[before:])
	}
	events, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	if binding.LastSeq != events[len(events)-1].Seq {
		t.Fatalf("cursor at %d, want the head %d after a successful flush", binding.LastSeq, events[len(events)-1].Seq)
	}
}
