package telegram

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGetUpdatesParsesMessageAndCallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/bot123:ABC/getUpdates") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":[
			{"update_id":1,"message":{"message_id":9,"from":{"id":42,"username":"kiyora"},
			 "chat":{"id":-100234,"type":"supergroup","is_forum":true},"message_thread_id":17,"text":"halo"}},
			{"update_id":2,"callback_query":{"id":"cb1","from":{"id":42},"data":"cb:abcd1234",
			 "message":{"message_id":10,"chat":{"id":-100234,"type":"supergroup"},"message_thread_id":17}}}
		]}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "123:ABC"}
	ups, err := c.GetUpdates(context.Background(), 0, 0)
	if err != nil {
		t.Fatalf("GetUpdates: %v", err)
	}
	if len(ups) != 2 {
		t.Fatalf("want 2 updates, got %d", len(ups))
	}
	if ups[0].Message == nil || ups[0].Message.Text != "halo" || ups[0].Message.MessageThreadID != 17 {
		t.Fatalf("message parsed wrong: %+v", ups[0].Message)
	}
	if ups[0].Message.From.ID != 42 || !ups[0].Message.Chat.IsForum {
		t.Fatalf("sender/chat parsed wrong: %+v", ups[0].Message)
	}
	if ups[1].CallbackQuery == nil || ups[1].CallbackQuery.Data != "cb:abcd1234" {
		t.Fatalf("callback parsed wrong: %+v", ups[1].CallbackQuery)
	}
}

func TestSendMessageOmitsThreadIDWhenZero(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":77}}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "123:ABC"}
	msg, err := c.SendMessage(context.Background(), SendOptions{ChatID: 5, Text: "hai"})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if msg.MessageID != 77 {
		t.Fatalf("MessageID = %d", msg.MessageID)
	}
	// A DM has no topic. Sending message_thread_id:0 makes Telegram reject the
	// call with "message thread not found", so the field must be absent.
	if _, present := body["message_thread_id"]; present {
		t.Fatalf("message_thread_id must be omitted for a DM, body = %v", body)
	}
	if body["parse_mode"] != parseModeMarkdownV2 {
		t.Fatalf("parse_mode = %v, want %s", body["parse_mode"], parseModeMarkdownV2)
	}
}

// getWebhookInfo is how the bridge learns it can never poll. A registered
// webhook makes Telegram refuse getUpdates outright, so the URL (whose
// integration holds the token) is the one fact worth parsing out of it.
func TestGetWebhookInfoReportsTheRegisteredURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/getWebhookInfo") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"ok":true,"result":{"url":"https://n8n.example/webhook/abc",
			"pending_update_count":4,"last_error_message":"Connection timed out"}}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "123:ABC"}
	info, err := c.GetWebhookInfo(context.Background())
	if err != nil {
		t.Fatalf("GetWebhookInfo: %v", err)
	}
	if info.URL != "https://n8n.example/webhook/abc" || info.PendingUpdateCount != 4 {
		t.Fatalf("info = %+v", info)
	}
}

// The healthy answer is an EMPTY url, not a missing field — that is what
// "no webhook, polling is available" looks like on the wire.
func TestGetWebhookInfoReportsNoWebhookAsEmptyURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true,"result":{"url":"","pending_update_count":0}}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "123:ABC"}
	info, err := c.GetWebhookInfo(context.Background())
	if err != nil {
		t.Fatalf("GetWebhookInfo: %v", err)
	}
	if info.URL != "" {
		t.Fatalf("URL = %q, want empty", info.URL)
	}
}

func TestAPIErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":7}}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "123:ABC"}
	_, err := c.SendMessage(context.Background(), SendOptions{ChatID: 5, Text: "hai"})
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("want *APIError, got %T: %v", err, err)
	}
	if apiErr.Code != 429 || apiErr.RetryAfter != 7*time.Second {
		t.Fatalf("apiErr = %+v", apiErr)
	}
}
