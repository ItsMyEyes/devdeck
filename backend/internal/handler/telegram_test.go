package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/store"
	"devdeck/backend/internal/telegram"
)

func newTestTelegramHandler(t *testing.T) *TelegramHandler {
	t.Helper()
	h, _ := newTestTelegramHandlerWithUnpins(t)
	return h
}

// newTestTelegramHandlerWithUnpins also returns a pointer to the bindings the
// handler asked to unpin, so a test can assert the Settings unpublish path
// cleans up the pinned confirmation the way /unpublish does.
func newTestTelegramHandlerWithUnpins(t *testing.T) (*TelegramHandler, *[]domain.TelegramBinding) {
	t.Helper()
	st := store.NewTestStore(t)
	pairing := &telegram.Pairing{TTL: 5 * time.Minute, Now: time.Now}
	unpinned := &[]domain.TelegramBinding{}
	h := NewTelegramHandler(st, pairing, &telegram.Health{}, func() {}, func(_ *http.Request, b domain.TelegramBinding) {
		*unpinned = append(*unpinned, b)
	})
	return h, unpinned
}

func TestGetTelegramConfigNeverLeaksTheToken(t *testing.T) {
	h := newTestTelegramHandler(t)

	putBody, _ := json.Marshal(map[string]any{"enabled": true, "token": "123456:AA-super-secret"})
	putReq := httptest.NewRequest(http.MethodPut, "/api/telegram/config", bytes.NewReader(putBody))
	putRec := httptest.NewRecorder()
	h.PutConfig(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("PutConfig status = %d, want 200 (body: %s)", putRec.Code, putRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/telegram/config", nil)
	getRec := httptest.NewRecorder()
	h.GetConfig(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GetConfig status = %d, want 200 (body: %s)", getRec.Code, getRec.Body.String())
	}

	// The raw body must never contain the token, anywhere.
	if bytes.Contains(getRec.Body.Bytes(), []byte("123456:AA-super-secret")) {
		t.Fatalf("response leaked the bot token: %s", getRec.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(getRec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["hasToken"] != true {
		t.Fatalf("hasToken = %v, want true", body["hasToken"])
	}
	if _, present := body["token"]; present {
		t.Fatalf("response has a token field at all: %+v", body)
	}
}

func TestPutTelegramConfigWithEmptyTokenKeepsTheStoredOne(t *testing.T) {
	h := newTestTelegramHandler(t)

	first, _ := json.Marshal(map[string]any{"enabled": true, "token": "123456:AA-real-token"})
	req1 := httptest.NewRequest(http.MethodPut, "/api/telegram/config", bytes.NewReader(first))
	rec1 := httptest.NewRecorder()
	h.PutConfig(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first PutConfig status = %d, want 200 (body: %s)", rec1.Code, rec1.Body.String())
	}

	// The settings UI re-submits the form without re-typing the secret when
	// only the enable switch is toggled: an empty token field must mean
	// "unchanged", never "erase".
	second, _ := json.Marshal(map[string]any{"enabled": false, "token": ""})
	req2 := httptest.NewRequest(http.MethodPut, "/api/telegram/config", bytes.NewReader(second))
	rec2 := httptest.NewRecorder()
	h.PutConfig(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("second PutConfig status = %d, want 200 (body: %s)", rec2.Code, rec2.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(rec2.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["enabled"] != false {
		t.Fatalf("enabled = %v, want false (the second PUT's own value)", body["enabled"])
	}
	if body["hasToken"] != true {
		t.Fatalf("hasToken = %v, want true — an empty token must not erase the stored one", body["hasToken"])
	}

	tok, err := h.store.TelegramBotToken()
	if err != nil || tok != "123456:AA-real-token" {
		t.Fatalf("TelegramBotToken = %q, %v, want the original token untouched", tok, err)
	}
}

func TestPairReturnsASixDigitCode(t *testing.T) {
	h := newTestTelegramHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/telegram/pair", nil)
	rec := httptest.NewRecorder()
	h.PostPair(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PostPair status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Code      string    `json:"code"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(body.Code) != 6 {
		t.Fatalf("code = %q, want 6 digits", body.Code)
	}
	for _, r := range body.Code {
		if r < '0' || r > '9' {
			t.Fatalf("code = %q, want digits only", body.Code)
		}
	}
	if !body.ExpiresAt.After(time.Now()) {
		t.Fatalf("expiresAt = %v, want a time in the future", body.ExpiresAt)
	}
}

func TestDeleteBindingIsIdempotent(t *testing.T) {
	h := newTestTelegramHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/telegram/bindings/ssh:c-does-not-exist", nil)
	req.SetPathValue("threadId", "ssh:c-does-not-exist")
	rec := httptest.NewRecorder()
	h.DeleteBinding(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DeleteBinding status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
	}

	// A second delete of the same, still-nonexistent thread must behave
	// identically — the UI deletes optimistically and may retry.
	req2 := httptest.NewRequest(http.MethodDelete, "/api/telegram/bindings/ssh:c-does-not-exist", nil)
	req2.SetPathValue("threadId", "ssh:c-does-not-exist")
	rec2 := httptest.NewRecorder()
	h.DeleteBinding(rec2, req2)
	if rec2.Code != http.StatusNoContent {
		t.Fatalf("second DeleteBinding status = %d, want 204 (body: %s)", rec2.Code, rec2.Body.String())
	}

	// Also idempotent for a user id that was never added.
	req3 := httptest.NewRequest(http.MethodDelete, "/api/telegram/users/9999999", nil)
	req3.SetPathValue("userId", "9999999")
	rec3 := httptest.NewRecorder()
	h.DeleteUser(rec3, req3)
	if rec3.Code != http.StatusNoContent {
		t.Fatalf("DeleteUser status = %d, want 204 (body: %s)", rec3.Code, rec3.Body.String())
	}
}

func putBinding(t *testing.T, h *TelegramHandler, threadID string, chatID, topicID int64) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"chatId": chatID, "topicId": topicID})
	req := httptest.NewRequest(http.MethodPut, "/api/telegram/bindings/"+threadID, bytes.NewReader(body))
	req.SetPathValue("threadId", threadID)
	rec := httptest.NewRecorder()
	h.PutBinding(rec, req)
	return rec
}

// Inbound routing is a pure (chatId, topicId) lookup — the bridge holds no
// "active thread" state, which is what makes it impossible to answer the
// wrong server. Two threads on ONE destination breaks exactly that: every
// message and every tapped approval lands on whichever thread the lookup sees
// first. These threads run shell commands on production hosts, so the second
// binding is refused, not merely warned about.
func TestPutBindingRefusesADestinationAnotherThreadAlreadyOwns(t *testing.T) {
	h := newTestTelegramHandler(t)

	if rec := putBinding(t, h, "ssh:c-prod", -100234, 0); rec.Code != http.StatusOK {
		t.Fatalf("first bind status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	rec := putBinding(t, h, "ssh:c-staging", -100234, 0)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second bind to the same chat = %d, want 409 (body: %s)", rec.Code, rec.Body.String())
	}
	var errBody map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if errBody["error"] == "" {
		t.Fatalf("conflict response must use the {\"error\":...} envelope, got %s", rec.Body.String())
	}
	bindings, err := h.store.TelegramBindings()
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].ThreadID != "ssh:c-prod" {
		t.Fatalf("the refused bind was stored anyway: %+v", bindings)
	}

	// A different topic in the same chat is a different destination, and
	// re-binding the SAME thread to where it already points is not a conflict.
	if rec := putBinding(t, h, "ssh:c-staging", -100234, 17); rec.Code != http.StatusOK {
		t.Fatalf("bind to another topic = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if rec := putBinding(t, h, "ssh:c-prod", -100234, 0); rec.Code != http.StatusOK {
		t.Fatalf("re-binding a thread to its own destination = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
}

// chatId 0 is not a chat Telegram can ever name: stored, it is a binding
// nothing can be sent to.
func TestPutBindingRequiresAChatID(t *testing.T) {
	h := newTestTelegramHandler(t)
	rec := putBinding(t, h, "ssh:c-prod", 0, 0)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	bindings, err := h.store.TelegramBindings()
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(bindings) != 0 {
		t.Fatalf("stored a chatless binding: %+v", bindings)
	}
}

// Unpublishing from Settings has to leave the Telegram chat in the same state
// /unpublish does. A pin left behind keeps advertising a thread that chat no
// longer receives anything from — and the binding row is the ONLY record of
// which message to unpin, so it has to be read before the delete.
func TestDeleteBindingUnpinsTheConfirmation(t *testing.T) {
	h, unpinned := newTestTelegramHandlerWithUnpins(t)

	if rec := putBinding(t, h, "ssh:c-prod", -100234, 0); rec.Code != http.StatusOK {
		t.Fatalf("bind status = %d (body: %s)", rec.Code, rec.Body.String())
	}
	if err := h.store.SetTelegramBindingPin("ssh:c-prod", 4242); err != nil {
		t.Fatalf("record pin: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/telegram/bindings/ssh:c-prod", nil)
	req.SetPathValue("threadId", "ssh:c-prod")
	rec := httptest.NewRecorder()
	h.DeleteBinding(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DeleteBinding status = %d, want 204", rec.Code)
	}

	if len(*unpinned) != 1 {
		t.Fatalf("want exactly one unpin, got %+v", *unpinned)
	}
	if (*unpinned)[0].PinnedMessageID != 4242 || (*unpinned)[0].ChatID != -100234 {
		t.Fatalf("unpinned the wrong message: %+v", (*unpinned)[0])
	}
}

// Deleting a binding that does not exist must not ask to unpin anything —
// there is no message id, and Telegram's unpin-with-no-id removes whatever
// the operator most recently pinned themselves.
func TestDeleteBindingDoesNotUnpinWhenThereIsNoBinding(t *testing.T) {
	h, unpinned := newTestTelegramHandlerWithUnpins(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/telegram/bindings/ssh:c-nope", nil)
	req.SetPathValue("threadId", "ssh:c-nope")
	rec := httptest.NewRecorder()
	h.DeleteBinding(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if len(*unpinned) != 0 {
		t.Fatalf("asked to unpin for a binding that never existed: %+v", *unpinned)
	}
}
