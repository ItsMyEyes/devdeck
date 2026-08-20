// Package telegram bridges a DevDeck orchestration.Engine to a Telegram bot.
// One bridge per process: Telegram's getUpdates is exclusive per bot token, so
// two processes polling the same token evict each other with 409 Conflict.
package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const defaultAPIBaseURL = "https://api.telegram.org"

// Client talks to one bot's Bot API. Hand-rolled on net/http, matching
// internal/selfupdate/github.go — this package adds no dependencies.
type Client struct {
	HTTPClient *http.Client
	BaseURL    string // "" means the real API; only tests set it
	Token      string
}

// httpClient returns the client to use for a single call. GetUpdates
// overrides this per-call with a context deadline instead of relying on
// HTTPClient.Timeout, because a client-level timeout would kill a long poll
// mid-flight; every other method is fine with a client that has no deadline
// of its own, since callers pass a ctx.
func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 0}
}

func (c *Client) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return defaultAPIBaseURL
}

type User struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
}

type Chat struct {
	ID      int64  `json:"id"`
	Type    string `json:"type"` // private | group | supergroup | channel
	IsForum bool   `json:"is_forum"`
}

type Message struct {
	MessageID       int64  `json:"message_id"`
	From            *User  `json:"from"`
	Chat            Chat   `json:"chat"`
	MessageThreadID int64  `json:"message_thread_id"`
	Text            string `json:"text"`
}

type CallbackQuery struct {
	ID      string   `json:"id"`
	From    *User    `json:"from"`
	Data    string   `json:"data"`
	Message *Message `json:"message"`
}

type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}

type InlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

// InlineKeyboard is rows of buttons — Telegram's own nesting.
type InlineKeyboard [][]InlineButton

type SendOptions struct {
	ChatID   int64
	TopicID  int64 // 0 = DM or non-forum group; the field is then omitted
	Text     string
	Keyboard InlineKeyboard
}

// APIError is a non-2xx or ok:false answer. RetryAfter is set from
// parameters.retry_after on a 429 and is what the outbound pump sleeps for.
type APIError struct {
	Code       int
	Desc       string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("telegram: %d %s (retry after %s)", e.Code, e.Desc, e.RetryAfter)
	}
	return fmt.Sprintf("telegram: %d %s", e.Code, e.Desc)
}

// apiResponse is the Bot API's uniform envelope: every method answers with
// either {"ok":true,"result":...} or {"ok":false,"error_code":...,"description":...}.
type apiResponse struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	ErrorCode   int             `json:"error_code"`
	Description string          `json:"description"`
	Parameters  struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

// call is the one place every method funnels through: POST a JSON body to
// {BaseURL}/bot{Token}/{method}, decode the uniform envelope, and either
// unmarshal result into out or return a typed *APIError. httpClient is asked
// for per-call rather than cached, so GetUpdates can hand in a client whose
// context carries the long-poll deadline while every other call uses the
// default.
func (c *Client) call(ctx context.Context, hc *http.Client, method string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("telegram: marshal %s request: %w", method, err)
	}
	url := fmt.Sprintf("%s/bot%s/%s", c.baseURL(), c.Token, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(payload)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("telegram: request %s: %w", method, err)
	}
	defer resp.Body.Close()

	var parsed apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return fmt.Errorf("telegram: decode %s response: %w", method, err)
	}
	if !parsed.OK {
		return &APIError{
			Code:       parsed.ErrorCode,
			Desc:       parsed.Description,
			RetryAfter: time.Duration(parsed.Parameters.RetryAfter) * time.Second,
		}
	}
	if out != nil && len(parsed.Result) > 0 {
		if err := json.Unmarshal(parsed.Result, out); err != nil {
			return fmt.Errorf("telegram: decode %s result: %w", method, err)
		}
	}
	return nil
}

// GetMe identifies the bot itself (used to populate TelegramConfig.BotUsername).
func (c *Client) GetMe(ctx context.Context) (User, error) {
	var u User
	err := c.call(ctx, c.httpClient(), "getMe", struct{}{}, &u)
	return u, err
}

// WebhookInfo is getWebhookInfo's answer, narrowed to what decides whether
// this bridge can poll at all. A non-empty URL means Telegram is DELIVERING
// updates to that URL and will refuse getUpdates with 409 for as long as it
// stays registered — the two modes are mutually exclusive per token, so a
// webhook belonging to some unrelated integration silently makes this bridge
// unable to ever receive a message.
type WebhookInfo struct {
	URL                string `json:"url"`
	PendingUpdateCount int    `json:"pending_update_count"`
	LastErrorMessage   string `json:"last_error_message"`
}

// GetWebhookInfo reports whether a webhook holds this token. Read-only: it
// never registers or deletes anything, because a webhook this process did not
// set belongs to whoever did, and silently deleting it would take down their
// integration to fix ours.
func (c *Client) GetWebhookInfo(ctx context.Context) (WebhookInfo, error) {
	var info WebhookInfo
	err := c.call(ctx, c.httpClient(), "getWebhookInfo", struct{}{}, &info)
	return info, err
}

// GetUpdates long-polls for new updates. The Bot API holds the connection
// open for up to timeoutSec seconds waiting for something to arrive, so the
// request needs a deadline longer than that — not the client's own Timeout,
// which defaults to 0 (none) precisely so a long poll is never cut short by
// something other than this explicit per-call deadline.
func (c *Client) GetUpdates(ctx context.Context, offset int64, timeoutSec int) ([]Update, error) {
	deadline := time.Duration(timeoutSec)*time.Second + 10*time.Second
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()

	body := map[string]any{
		"timeout": timeoutSec,
	}
	if offset != 0 {
		body["offset"] = offset
	}

	var updates []Update
	err := c.call(ctx, c.httpClient(), "getUpdates", body, &updates)
	return updates, err
}

// parseModeMarkdownV2 is the dialect every outbound message is formatted in.
// See markdown.go for why the text has to be converted rather than passed
// through, and sendMessageBody below for what happens when it still fails.
const parseModeMarkdownV2 = "MarkdownV2"

// SendMessage posts a new message and returns it (the MessageID is what a
// tapped card is later edited by).
//
// The retry is the load-bearing part. MarkdownV2 rejects a message whose
// entities do not balance, with 400 "can't parse entities" — and the pump
// never advances its cursor past a message it could not send, so a single
// unparseable message would freeze that thread's mirror permanently. Rather
// than trust the converter to be perfect on every input an agent can produce,
// a parse failure falls back to sending the SAME text with no parse_mode at
// all: formatting is lost for that one message, delivery is not. A malformed
// message is a cosmetic problem; a wedged mirror is a silent outage.
func (c *Client) SendMessage(ctx context.Context, o SendOptions) (Message, error) {
	var msg Message
	err := c.call(ctx, c.httpClient(), "sendMessage", sendMessageBody(o, true), &msg)
	if isParseEntitiesError(err) {
		return msg, c.call(ctx, c.httpClient(), "sendMessage", sendMessageBody(o, false), &msg)
	}
	return msg, err
}

func sendMessageBody(o SendOptions, formatted bool) map[string]any {
	text := o.Text
	body := map[string]any{"chat_id": o.ChatID}
	if formatted {
		body["parse_mode"] = parseModeMarkdownV2
	} else {
		// Without a parse mode the backslashes the converter inserted are no
		// longer markup — they are literal characters — so they have to come
		// back out or the fallback reads like source code.
		text = StripMarkdownV2Escapes(text)
	}
	body["text"] = text
	if o.TopicID != 0 {
		body["message_thread_id"] = o.TopicID
	}
	if len(o.Keyboard) > 0 {
		body["reply_markup"] = map[string]any{"inline_keyboard": o.Keyboard}
	}
	return body
}

// isParseEntitiesError picks out the one failure worth retrying unformatted.
// Any other 400 (chat not found, bot blocked, message too long) is a real
// error the caller must see: retrying those in plain text would just fail
// again while hiding the reason.
func isParseEntitiesError(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Code == 400 && strings.Contains(strings.ToLower(apiErr.Desc), "can't parse entities")
}

// EditMessageText rewrites the live message in place. "message is not
// modified" is treated as success rather than an error: the 1s pump flushes
// on a ticker regardless of whether new text actually arrived since the last
// flush, and Telegram rejects a no-op edit — that rejection is not a failure
// the caller should retry or surface.
func (c *Client) EditMessageText(ctx context.Context, chatID, messageID int64, text string, kb InlineKeyboard) error {
	body := map[string]any{
		"chat_id":    chatID,
		"message_id": messageID,
		"text":       text,
		"parse_mode": parseModeMarkdownV2,
	}
	if len(kb) > 0 {
		body["reply_markup"] = map[string]any{"inline_keyboard": kb}
	}

	err := c.call(ctx, c.httpClient(), "editMessageText", body, nil)
	if apiErr, ok := err.(*APIError); ok && strings.Contains(apiErr.Desc, "message is not modified") {
		return nil
	}
	return err
}

// AnswerCallbackQuery dismisses the loading spinner on a tapped inline
// button. text, when non-empty, shows as a toast — used to tell the sender a
// stale/unknown token was tapped instead of silently doing nothing.
func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error {
	body := map[string]any{
		"callback_query_id": id,
	}
	if text != "" {
		body["text"] = text
	}
	return c.call(ctx, c.httpClient(), "answerCallbackQuery", body, nil)
}

// SendChatAction shows the "…is typing" hint in the destination. Telegram
// clears it after ~5 seconds or when the bot next sends a message, so it has
// to be re-sent while work continues — see keepTyping.
//
// It is the ONLY progress primitive Telegram offers a bot. There is no
// streaming: text cannot be appended to a message, only replaced wholesale
// with editMessageText, which this bridge deliberately does not do (see
// Rendered's doc comment).
func (c *Client) SendChatAction(ctx context.Context, chatID, topicID int64, action string) error {
	body := map[string]any{"chat_id": chatID, "action": action}
	if topicID != 0 {
		body["message_thread_id"] = topicID
	}
	return c.call(ctx, c.httpClient(), "sendChatAction", body, nil)
}

// PinChatMessage pins a message so it stays reachable from the chat header.
// Used for the one message per destination worth keeping in reach — the
// "which thread is this chat wired to" confirmation /init sends.
//
// disable_notification because a pin normally pings every member of a group,
// and this pin is a bookmark for the operator, not an announcement.
//
// A pin can legitimately fail: in a group the bot needs can_pin_messages, and
// it usually is not an admin. Callers treat failure as cosmetic — the binding
// is already saved and the confirmation was already delivered.
func (c *Client) PinChatMessage(ctx context.Context, chatID, messageID int64) error {
	return c.call(ctx, c.httpClient(), "pinChatMessage", map[string]any{
		"chat_id":              chatID,
		"message_id":           messageID,
		"disable_notification": true,
	}, nil)
}

// UnpinChatMessage removes one specific pin, undoing PinChatMessage when a
// thread stops being published.
//
// messageID is always passed explicitly and is never allowed to be 0:
// Telegram treats an omitted message_id as "unpin the most recently pinned
// message in this chat", which in an operator's own group is quite likely to
// be something they pinned themselves and have nothing to do with DevDeck.
func (c *Client) UnpinChatMessage(ctx context.Context, chatID, messageID int64) error {
	if messageID == 0 {
		return nil
	}
	return c.call(ctx, c.httpClient(), "unpinChatMessage", map[string]any{
		"chat_id":    chatID,
		"message_id": messageID,
	}, nil)
}

// CreateForumTopic makes a new topic in a forum-enabled supergroup, used when
// binding a thread that wants a fresh destination rather than an existing
// chat/topic. Returns the topic's message_thread_id, which becomes the
// binding's TopicID.
func (c *Client) CreateForumTopic(ctx context.Context, chatID int64, name string) (int64, error) {
	body := map[string]any{
		"chat_id": chatID,
		"name":    name,
	}
	var result struct {
		MessageThreadID int64 `json:"message_thread_id"`
	}
	err := c.call(ctx, c.httpClient(), "createForumTopic", body, &result)
	return result.MessageThreadID, err
}
