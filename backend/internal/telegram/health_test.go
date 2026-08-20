package telegram

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// webhookConflictDesc is Telegram's verbatim answer to getUpdates on a token
// that has a webhook registered. Copied from a live 409 rather than
// paraphrased: every assertion below is about surfacing THIS text, and a
// paraphrase would let the code that reads it drift without a test noticing.
const webhookConflictDesc = "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"

// pollTransport drives pollLoop through a scripted sequence of getUpdates
// answers, then blocks like a real long poll — fakeTransport's own GetUpdates
// blocks immediately, which is right for the ~40 tests that never run the
// loop and useless for the three here that do.
type pollTransport struct {
	*fakeTransport
	mu    sync.Mutex
	queue []pollResult
	calls int
}

type pollResult struct {
	updates []Update
	err     error
}

func (p *pollTransport) GetUpdates(ctx context.Context, _ int64, _ int) ([]Update, error) {
	p.mu.Lock()
	p.calls++
	if len(p.queue) > 0 {
		next := p.queue[0]
		p.queue = p.queue[1:]
		p.mu.Unlock()
		return next.updates, next.err
	}
	p.mu.Unlock()
	<-ctx.Done()
	return nil, ctx.Err()
}

func newPollTransport(results ...pollResult) *pollTransport {
	return &pollTransport{fakeTransport: &fakeTransport{}, queue: results}
}

// waitForHealth polls the shared state until it reaches want, so the test
// never guesses at how long a goroutine needs.
func waitForHealth(t *testing.T, h *Health, want HealthState) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state, detail := h.Snapshot(); state == want {
			return detail
		}
		time.Sleep(5 * time.Millisecond)
	}
	state, detail := h.Snapshot()
	t.Fatalf("health never reached %q; stuck at %q (%s)", want, state, detail)
	return ""
}

func TestZeroHealthReadsAsOff(t *testing.T) {
	var h Health
	state, detail := h.Snapshot()
	if state != HealthOff || detail != "" {
		t.Fatalf("zero Health = (%q, %q), want (off, \"\")", state, detail)
	}
}

// The regression this whole type exists for: a bot token with a webhook on it
// makes Telegram refuse getUpdates forever, and before this the operator saw
// nothing anywhere — not in Telegram (the bot simply never answers), and not
// in Settings, which showed the @username getMe had happily returned.
func TestPollLoopSurfacesTheWebhookConflict(t *testing.T) {
	transport := newPollTransport(pollResult{err: &APIError{Code: 409, Desc: webhookConflictDesc}})
	b, _, _ := newTestBridge(t, transport.fakeTransport)
	health := &Health{}
	b.health = health
	b.client = transport

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.pollLoop(ctx)

	detail := waitForHealth(t, health, HealthError)
	// Telegram's own words, not this package's guess at what a 409 means.
	if !strings.Contains(detail, "webhook is active") {
		t.Fatalf("detail does not quote Telegram's reason: %q", detail)
	}
	// And the operator is told what to DO, which the raw API text never says.
	if !strings.Contains(detail, "bot terpisah") {
		t.Fatalf("detail gives no remedy: %q", detail)
	}
}

func TestPollLoopReportsOKAfterASuccessfulPoll(t *testing.T) {
	// An EMPTY update list still proves inbound works — health must not wait
	// for someone to actually message the bot before it stops saying
	// "connecting".
	transport := newPollTransport(pollResult{updates: nil})
	b, _, _ := newTestBridge(t, transport.fakeTransport)
	health := &Health{}
	b.health = health
	b.client = transport

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.pollLoop(ctx)

	waitForHealth(t, health, HealthOK)
}

// A cancelled bridge (every config save calls restartTelegram, which cancels
// the old one) must not leave a spurious error behind: the context error is
// this process shutting the loop down on purpose, not Telegram failing.
func TestPollLoopDoesNotReportErrorOnShutdown(t *testing.T) {
	transport := newPollTransport()
	b, _, _ := newTestBridge(t, transport.fakeTransport)
	health := &Health{}
	health.Set(HealthOK, "")
	b.health = health
	b.client = transport

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); b.pollLoop(ctx) }()

	// Let the loop actually reach GetUpdates before cancelling, so this
	// exercises the in-flight-poll path rather than the pre-loop ctx check.
	deadline := time.Now().Add(2 * time.Second)
	for {
		transport.mu.Lock()
		started := transport.calls > 0
		transport.mu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("poll loop never called GetUpdates")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done

	if state, detail := health.Snapshot(); state != HealthOK {
		t.Fatalf("shutdown left health at %q (%s), want it untouched at ok", state, detail)
	}
}

// probeWebhook is the only source of the webhook URL — the poll loop's 409
// says a webhook exists, never whose. That URL is the fact that makes the
// problem actionable, so it must reach the detail verbatim.
func TestProbeWebhookNamesTheURLHoldingTheToken(t *testing.T) {
	transport := &fakeTransport{webhook: WebhookInfo{
		URL:                "https://ai.kiyora.dev/webhook/abc/webhook",
		PendingUpdateCount: 4,
	}}
	b, _, _ := newTestBridge(t, transport)
	health := &Health{}
	b.health = health

	b.probeWebhook(context.Background())

	state, detail := health.Snapshot()
	if state != HealthError {
		t.Fatalf("state = %q, want error", state)
	}
	if !strings.Contains(detail, "https://ai.kiyora.dev/webhook/abc/webhook") {
		t.Fatalf("detail omits the webhook URL: %q", detail)
	}
	if !strings.Contains(detail, "4 pesan") {
		t.Fatalf("detail omits the queued-update count: %q", detail)
	}
}

// No webhook is the normal case and must leave health exactly as the poll
// loop set it — a probe that overwrote a healthy state with "connecting"
// would flap the panel on every restart.
func TestProbeWebhookIsSilentWhenNoneIsRegistered(t *testing.T) {
	b, _, _ := newTestBridge(t, &fakeTransport{})
	health := &Health{}
	health.Set(HealthOK, "")
	b.health = health

	b.probeWebhook(context.Background())

	if state, _ := health.Snapshot(); state != HealthOK {
		t.Fatalf("state = %q, want the untouched ok", state)
	}
}

func TestPollErrorDetailDistinguishesTheTwo409s(t *testing.T) {
	webhook := PollErrorDetail(&APIError{Code: 409, Desc: webhookConflictDesc})
	if !strings.Contains(webhook, "bot terpisah") || strings.Contains(webhook, "proses lain") {
		t.Fatalf("webhook 409 read as a duplicate-poller: %q", webhook)
	}

	// The other 409: a genuine second poller. Telegram's description for it
	// does not mention a webhook, which is the only thing telling them apart.
	duplicate := PollErrorDetail(&APIError{
		Code: 409,
		Desc: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
	})
	if !strings.Contains(duplicate, "proses lain") {
		t.Fatalf("duplicate-poller 409 lost its remedy: %q", duplicate)
	}
	if strings.Contains(duplicate, "bot terpisah") {
		t.Fatalf("duplicate-poller 409 read as a webhook conflict: %q", duplicate)
	}
}
