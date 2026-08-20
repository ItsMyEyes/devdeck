package telegram

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// HealthState is what the Settings panel shows about this machine's bridge.
// It exists because every failure this bridge can hit looks IDENTICAL from
// Telegram's side — the operator sends a message and nothing happens — and
// identical from the Settings panel's side too, which until now showed only
// the @username getMe returned. getMe succeeds against a token whose
// getUpdates is refused outright, so a completely dead bridge rendered as a
// healthy one.
type HealthState string

const (
	// HealthOff — the bridge is not running: disabled, or no token stored.
	HealthOff HealthState = "off"
	// HealthConnecting — started, but no poll has come back yet. Normal for
	// the first second or two; sticky means Telegram is unreachable.
	HealthConnecting HealthState = "connecting"
	// HealthOK — getUpdates returned successfully, so inbound messages are
	// actually arriving.
	HealthOK HealthState = "ok"
	// HealthError — the last poll failed. Detail says why, in Telegram's own
	// words where there are any.
	HealthError HealthState = "error"
)

// Health is the live connection state of one process's bridge, shared by
// pointer between the bridge that writes it and the settings handler that
// reads it — the same wiring Pairing already uses (created in main.go, handed
// to both telegram.New and handler.NewTelegramHandler).
//
// Deliberately in memory rather than a settings column: this is the state of
// a running poll loop, and a persisted "ok" surviving into a process whose
// bridge never started would be the exact lie this type exists to prevent.
// The zero value is a valid HealthOff.
type Health struct {
	mu     sync.Mutex
	state  HealthState
	detail string
}

// Set records a transition. detail is the operator-facing reason and should
// be empty for anything other than HealthError.
func (h *Health) Set(state HealthState, detail string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.state = state
	h.detail = detail
}

// Snapshot reads the current state. The zero value reads as HealthOff, so a
// handler holding a Health nothing has written to yet reports "not running"
// rather than an empty string the UI would have to special-case.
func (h *Health) Snapshot() (HealthState, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state == "" {
		return HealthOff, ""
	}
	return h.state, h.detail
}

// PollErrorDetail renders a getUpdates failure as the one sentence an
// operator can act on.
//
// Telegram's own description is preferred over anything this package could
// infer, because a 409 has two completely different causes that only the
// description tells apart: a second process polling the same token, and a
// WEBHOOK registered on it (which makes Telegram refuse getUpdates outright,
// forever, no matter how healthy this process is). This package used to
// assume the first, which sent the operator hunting for a duplicate DevDeck
// that did not exist while an unrelated integration quietly held the token.
func PollErrorDetail(err error) string {
	if err == nil {
		return ""
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return err.Error()
	}
	switch {
	case apiErr.Code == 409 && mentionsWebhook(apiErr.Desc):
		return apiErr.Desc + " — token ini sudah dipakai integrasi lain; pakai bot terpisah untuk DevDeck, atau hapus webhook-nya"
	case apiErr.Code == 409:
		return apiErr.Desc + " — ada proses lain yang polling token bot yang sama"
	case apiErr.Code == 401:
		return apiErr.Desc + " — bot token tidak berlaku"
	default:
		return apiErr.Error()
	}
}

// WebhookConflictDetail is the startup probe's counterpart to
// PollErrorDetail. The poll loop's 409 says a webhook exists; only
// getWebhookInfo says WHOSE — and the URL is the single fact that turns
// "something has this token" into a problem the operator can actually go and
// fix, so it is quoted verbatim.
func WebhookConflictDetail(info WebhookInfo) string {
	detail := fmt.Sprintf("webhook aktif di %s — Telegram menolak getUpdates selama webhook terpasang, jadi bridge ini tidak akan pernah menerima pesan", info.URL)
	if info.PendingUpdateCount > 0 {
		detail += fmt.Sprintf(" (%d pesan mengantri di webhook itu)", info.PendingUpdateCount)
	}
	return detail + ". Pakai bot terpisah untuk DevDeck, atau hapus webhook-nya."
}

func mentionsWebhook(desc string) bool {
	return strings.Contains(strings.ToLower(desc), "webhook")
}
