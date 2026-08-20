package handler

import (
	"net/http"
	"strconv"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/telegram"
)

// TelegramHandler exposes this machine's Telegram bridge configuration over
// HTTP: enable/disable + token, pairing codes, the allowlist, and thread
// bindings. Registered on every role, exactly like PublishedSOCKSHandler
// (proxy.go) — which threads a process can publish to Telegram is decided
// by which threads its own orchestration.Engine holds, not by role. A hub
// publishes ssh:* threads; a runtime publishes its own worktree chats.
type TelegramHandler struct {
	store   port.Store
	pairing *telegram.Pairing
	health  *telegram.Health // live bridge state; never nil (see the constructor)
	restart func()           // re-reads config and (re)starts or stops the bridge
	// unpin removes the pinned /init confirmation for a binding being
	// deleted. A closure rather than a *telegram.Bridge because restarting
	// the bridge replaces that pointer — main.go resolves the CURRENT one on
	// each call. nil when no bridge is wired (tests), and a no-op then.
	unpin func(*http.Request, domain.TelegramBinding)
}

func NewTelegramHandler(
	store port.Store,
	pairing *telegram.Pairing,
	health *telegram.Health,
	restart func(),
	unpin func(*http.Request, domain.TelegramBinding),
) *TelegramHandler {
	// Never nil, so withHealth needs no branch: a zero Health reads as
	// HealthOff, which is the honest answer for a process wired without one.
	if health == nil {
		health = &telegram.Health{}
	}
	return &TelegramHandler{store: store, pairing: pairing, health: health, restart: restart, unpin: unpin}
}

// withHealth overlays the RUNNING bridge's state onto the stored config. The
// two come from different places on purpose: enabled/token/username are what
// the operator configured, health is what that configuration is actually
// doing right now, and the whole point of the field is that those two can
// disagree (see domain.TelegramConfig.Health).
func (h *TelegramHandler) withHealth(cfg domain.TelegramConfig) domain.TelegramConfig {
	state, detail := h.health.Snapshot()
	cfg.Health = string(state)
	cfg.HealthDetail = detail
	return cfg
}

// GetConfig reports this machine's bridge state. domain.TelegramConfig has
// no token field by design (see its doc comment) — the bot token never
// rides along in this response.
func (h *TelegramHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.store.TelegramConfig()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withHealth(cfg))
}

type telegramConfigPutBody struct {
	Enabled bool   `json:"enabled"`
	Token   string `json:"token"`
}

// PutConfig writes the enable flag and, only when a non-empty token is
// supplied, rotates the stored bot token. An empty token means "keep the
// stored one" — the settings UI re-submits this form without re-typing the
// secret every time the enable switch is toggled, and erasing the token on
// an empty field would silently kill the bridge on every such submit.
func (h *TelegramHandler) PutConfig(w http.ResponseWriter, r *http.Request) {
	var body telegramConfigPutBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// BotUsername is display-only (populated elsewhere, from getMe) and is
	// not part of this request body — read-modify-write it through rather
	// than letting a config PUT silently blank it out.
	cur, err := h.store.TelegramConfig()
	if handleStoreErr(w, err) {
		return
	}
	if err := h.store.SetTelegramConfig(domain.TelegramConfig{
		Enabled:     body.Enabled,
		BotUsername: cur.BotUsername,
	}); handleStoreErr(w, err) {
		return
	}
	if body.Token != "" {
		if err := h.store.SetTelegramBotToken(body.Token); handleStoreErr(w, err) {
			return
		}
	}

	if h.restart != nil {
		h.restart()
	}

	fresh, err := h.store.TelegramConfig()
	if handleStoreErr(w, err) {
		return
	}
	// Read AFTER restart, so saving a token answers with what the new bridge
	// is doing rather than what the old one was.
	writeJSON(w, http.StatusOK, h.withHealth(fresh))
}

type telegramPairResponse struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// PostPair issues a fresh 6-digit pairing code (Pairing.Issue invalidates
// whatever code was live before it). Enrolment itself happens on the
// Telegram side, entirely inside internal/telegram — this route only mints
// the code an operator types into /pair.
func (h *TelegramHandler) PostPair(w http.ResponseWriter, r *http.Request) {
	code := h.pairing.Issue()
	_, expiresAt, _ := h.pairing.Current()
	writeJSON(w, http.StatusOK, telegramPairResponse{Code: code, ExpiresAt: expiresAt})
}

// GetUsers lists the allowlist — accounts enrolled via a successful /pair.
func (h *TelegramHandler) GetUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.store.TelegramUsers()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, users)
}

// DeleteUser removes one allowlist entry. 204 whether or not the id was
// present — the settings UI deletes optimistically (see DeleteBinding).
func (h *TelegramHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	userID, err := strconv.ParseInt(r.PathValue("userId"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid userId")
		return
	}
	if handleStoreErr(w, h.store.DeleteTelegramUser(userID)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetBindings lists every thread this machine currently publishes.
func (h *TelegramHandler) GetBindings(w http.ResponseWriter, r *http.Request) {
	bindings, err := h.store.TelegramBindings()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, bindings)
}

type telegramBindingPutBody struct {
	ChatID  int64 `json:"chatId"`
	TopicID int64 `json:"topicId"`
}

// PutBinding publishes (or repoints) one thread to one Telegram destination.
//
// The destination must be free. Inbound routing is a pure lookup on
// (chatId, topicId) — that is the whole of §0.2's "one binding = one
// destination", and what makes a /switch command unnecessary — so two threads
// sharing one destination silently sends every message and every tapped
// approval to whichever of them the lookup happens to find first. These
// threads run shell commands on production servers: that is a "y" answered at
// the wrong machine, so it is refused rather than merely discouraged in the
// UI.
func (h *TelegramHandler) PutBinding(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	var body telegramBindingPutBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// Telegram never issues chat id 0, so a zero here is a missing field.
	// Stored, it would be a binding nothing can ever be sent to and that any
	// update with no chat could match.
	if body.ChatID == 0 {
		writeErr(w, http.StatusBadRequest, "chatId is required")
		return
	}
	existing, err := h.store.TelegramBindings()
	if handleStoreErr(w, err) {
		return
	}
	for _, b := range existing {
		if b.ThreadID != threadID && b.ChatID == body.ChatID && b.TopicID == body.TopicID {
			writeErr(w, http.StatusConflict, "this chat is already bound to thread "+b.ThreadID)
			return
		}
	}
	if err := h.store.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: threadID, ChatID: body.ChatID, TopicID: body.TopicID,
	}); handleStoreErr(w, err) {
		return
	}
	got, err := h.store.TelegramBindingByThread(threadID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, got)
}

// DeleteBinding un-publishes a thread. 204 even when the thread was never
// published — the UI deletes optimistically and must not be shown an error
// for a row it no longer believes exists.
//
// The binding is READ BEFORE it is deleted, because the row is the only place
// that records which message this bridge pinned in the destination chat.
// Unpublishing from Settings has to leave the chat in the same state as
// /unpublish does: a pin left behind keeps advertising a thread that chat no
// longer receives anything from.
func (h *TelegramHandler) DeleteBinding(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	// A miss is fine and expected (the optimistic-delete case above) — there
	// is simply nothing to unpin.
	binding, lookupErr := h.store.TelegramBindingByThread(threadID)
	if handleStoreErr(w, h.store.DeleteTelegramBinding(threadID)) {
		return
	}
	if lookupErr == nil && h.unpin != nil {
		h.unpin(r, binding)
	}
	w.WriteHeader(http.StatusNoContent)
}
