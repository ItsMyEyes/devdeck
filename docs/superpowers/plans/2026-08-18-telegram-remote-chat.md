# Telegram Remote Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator drive any DevDeck agent thread — the SSH DevOps chatbot first — from Telegram, with a full mirror of the transcript, working approval buttons, and the slash commands `/model`, `/skills`, `/new`, `/compact`.

**Architecture:** A new in-process package `internal/telegram` runs one Telegram long-poll loop per DevDeck process. It talks straight to that process's `orchestration.Engine` (`Dispatch` in, `Subscribe` out) — no HTTP, no WebSocket, no cross-process plumbing. Threads are published one at a time (opt-in) by writing a binding row that maps `threadId → (chatId, topicId)`.

**Tech Stack:** Go 1.22+ stdlib only (`net/http`, `encoding/json`) for the Bot API client; SQLite via the existing `port.Store`; React 19 + TanStack Query for the settings UI.

**Spec:** This document. §0 below is the design; Tasks 1-7 implement it. Decisions were settled in the brainstorming session of 2026-08-18 and are recorded verbatim in §0.7.

## Global Constraints

- Module path is `devdeck/backend`; all packages live under `devdeck/backend/internal/`.
- **No new third-party dependencies.** The Bot API client is hand-rolled on `net/http`, following `internal/selfupdate/github.go` as its model.
- All persistence goes through the `port.Store` interface — never touch `*sql.DB` outside `internal/store`.
- Go handlers return void and write via `writeJSON()` / `writeErr()`; store errors go through `handleStoreErr(w, err)`.
- All API error responses use the `{"error":"message"}` envelope. Never change that shape.
- Frontend imports use the `@/*` alias, never relative paths into `src/`. `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Domain types in `frontend/src/store/types.ts` and `backend/internal/domain/models.go` must stay in sync.
- **Subagents must NOT run `git commit`.** The repo's pre-commit hook runs an unscoped full-project typecheck that fails on a partially-built feature, which would block every task. Verification per task is the test command named in that task. The orchestrator commits once at the end.
- Secrets never appear in a JSON response. The bot token follows the `MemoryAPIKey` / `SignInPINHash` precedent: a separate store accessor, never a field on the config struct.
- Run `go vet ./...` before declaring a Go task done.

---

## §0 Design

### §0.1 Why the bridge is in-process

Each DevDeck process owns its own `orchestration.Engine`, its own event log, and its own SQLite file (`cmd/server/main.go:451` — *"Agent chat harness. Runs on every role, but only a runtime ever has worktrees to chat about; the hub simply proxies the WebSocket"*). There is no single engine that sees every thread:

```
HUB      (--role hub)     engine ─► thread ssh:<connectionId>[::chat-N]
RUNTIME  (--role runtime)  engine ─► thread w-<hex>[::chat-N]
```

`/api/ssh/connections` is registered inside `if !isRuntime` (`main.go:942`→`992`), so the SSH connection *records* are hub-owned. `/ws/agent` is registered on every role (`main.go:1158`) because worktrees are runtime-owned.

> **Correction (2026-08-19).** This section originally concluded "SSH threads therefore exist only in the hub's engine". That was true when it was written and is **no longer true**: concurrent work moved SSH chat hosting to the connection's *executor runtime*. See `handler.CapSSHChat` — a process advertising it "HOSTs an SSH DevOps chat thread: spawns the agent locally, serves `/api/agent-tools/ssh/*` from its own token store, and dials the host itself using credentials fetched from the hub", and `sshChatAvailability.ts` resolves the socket target to `connection.executorMachineId`.
>
> The consequence for this feature is operational, not architectural — the rule below still holds exactly as stated, only the *answer* for `ssh:` threads changed:
>
> **The bot token must be set on the machine that HOSTS the thread.** For a worktree thread that is the runtime owning the worktree; for an SSH thread it is the connection's executor runtime, which is routinely NOT the machine the operator is looking at. A live install had three connections executing on `home-laptop` while the token was configured on the hub — publishing succeeded and then nothing happened, because the binding was written to a process with no bridge running.
>
> `TelegramPublishButton` addresses the executor (`availability.machine`), which is correct, and its blocked states name that machine outright rather than saying "this machine".

The browser hides this by opening sockets to different processes. The Telegram bridge does not need to: it runs *inside* each process and reaches only that process's engine. Consequence, accepted deliberately: **one bot token per process**. Telegram's `getUpdates` is exclusive per token — two pollers on one token kill each other with `409 Conflict: terminated by other getUpdates request` — so sharing a token across processes is not an option. A `--role both` deployment has exactly one process and therefore exactly one bot.

### §0.2 Binding model

One rule: **one binding = one destination.** A binding names a chat, and optionally a forum topic inside it. DM and topic collapse into the same code path because `sendMessage` takes `message_thread_id` as an optional field.

```
threadId              chatId        topicId
──────────────────────────────────────────────
ssh:c-a1b2            -1002345678   17
ssh:c-a1b2::chat-2    -1002345678   42
w-9f3c                 587442310    0      (DM)
```

Inbound routing is a pure lookup on `(chat.id, message_thread_id)`. The bot holds no "active thread" state, so there is no `/switch` and no way to send `y` to the wrong server.

#### §2a How a binding gets created: `/init <threadId>`

The first cut of this asked the operator to type `chatId` and `topicId` into a dialog. That was unusable: Telegram's UI never shows those numbers, so there was no way to fill the form in.

The destination now identifies itself by **being the place the message was sent**:

1. The operator clicks *Publish ke Telegram* on the chat header. The dialog shows a command to copy — `/init ssh:c-a1b2` — and nothing to fill in.
2. They send that message in the Telegram chat or forum topic they want it published to.
3. The bridge reads `chat.id` and `message_thread_id` off that very message and writes the binding.
4. The dialog polls while open and flips to a confirmed state the moment the binding lands.

`/init` is handled after the allowlist check but before the `(chat, topic)` lookup — the target chat is by definition not yet bound. It is **not** a pre-auth command like `/pair`: it points a shell-capable agent at a destination, so only allowlisted senders may run it. Destination uniqueness is enforced exactly as `PutBinding` enforces it — a destination another thread already owns is refused, or this flow would quietly reopen the "`y` on the wrong production server" hole this section claims is closed.

A **new** binding starts at the thread's current head sequence, not 0, so `/init` means "mirror from here on". Under the old dialog a zero cursor was merely awkward; under this flow it is a hazard — publishing a long-running SSH thread would dump its entire history into Telegram and sit in rate-limit backoff for a long time. An existing binding keeps its cursor, since `SetTelegramBinding`'s upsert deliberately does not touch `last_seq`.

Stopping is `/unpublish` in Telegram, or the unpublish action in the same dialog.

### §0.3 The subscription is a doorbell, not a data source

`Engine.publish` drops batches for slow subscribers by design; the browser recovers by reconnecting with `sinceSeq` (`agent_ws.go:96-105`). For a **full mirror** a dropped batch is silently missing transcript, which is unacceptable.

So: `Engine.Subscribe(256)` is used only as a wakeup. When it fires (or on a 2s backstop ticker), the bridge reads `store.AgentEventsSince(threadID, binding.LastSeq)` — the exact replay path the WebSocket uses — renders what came back, and persists the new `LastSeq` only after Telegram accepted the send. A restart resumes from the same cursor.

### §0.4 Outbound: the live message

Full mirror at one Telegram message per event would hit `429 Too Many Requests` (~20 messages/minute per group) and fall permanently behind. Instead each turn owns **one live message**:

- Rendered text is appended to an in-memory buffer.
- A 1s ticker flushes: first flush `sendMessage`, later flushes `editMessageText` on the same `message_id`.
- At >3500 characters the message is *sealed* (no more edits) and the next flush starts a fresh one. Telegram's hard limit is 4096.
- On `429`, honor `retry_after` and retry. Never drop content — the buffer is the queue.

**Approval and question cards are separate messages**, sent immediately, never folded into the live message: they carry inline keyboards, and the live message is rewritten constantly.

### §0.5 Callback tokens

Telegram caps `callback_data` at 64 bytes. Answers to `AskUserQuestion` are keyed by the **full question text** (`orchestration.UserInputRespondPayload`'s doc comment: *"that is the key the claude CLI looks answers up by, verified against captured traffic. Re-keying this map reaches the agent as no answer at all"*), which does not fit.

So `callback_data` carries an opaque `cb:<8 hex>` token. The bridge keeps a map from token to the real `(threadID, requestID, kind, decision | questionText+answer)`. The token's `kind` is explicit — never inferred from which field happens to be non-empty, because a question's text may legitimately be empty and an empty-text question token would then be actioned as an approval.

> **Correction (post-implementation review).** An earlier draft of this section claimed the token map "is rebuilt naturally after a restart, because §0.3's replay re-renders any still-pending request from the event log". **That is false.** `LastSeq` has already advanced past the request event by the time the card was sent, so replay never revisits it. After any bridge restart — including every Settings save, which restarts the bridge — buttons on already-sent cards answer "sudah kedaluwarsa".
>
> The failure is safe rather than dangerous: a dead button, and the operator falls back to the browser. Fixing it properly means re-minting tokens from `Thread.PendingRequests` at startup and re-sending those cards, which is a feature-sized change to the pump. Tracked in "Known follow-ups" below, deliberately not done here.

### §0.6 Authorization

- The allowlist is a table of Telegram user IDs. Enrolment is `/pair <6-digit code>`; the code is generated by `POST /api/telegram/pair`, lives in memory, and expires after 5 minutes.
- Every inbound update except `/pair` requires `from.id` to be in the allowlist.
- A non-allowlisted sender gets **no reply at all** — not an error message. The bot must not confirm its own existence to strangers.

### §0.7 Decisions taken during brainstorming (do not relitigate)

| # | Decision |
|---|---|
| 1 | Scope: all thread kinds, **opt-in per thread** (not automatic, not SSH-only). |
| 2 | Topology: one binding = one destination; DM and forum topic share one code path. |
| 3 | Placement: bridge runs in **every process**, each with its own bot token. |
| 4 | Verbosity: **full mirror** — reasoning, tool arguments, tool output, errors. |
| 5 | Authorization: **pairing code**, silent ignore for everyone else. |

### §0.8 Known gap: `/compact`

`provider.Adapter` (`provider/provider.go:258`) has no compact method. What exists is `--autocompact <window>` (`claude/adapter.go:262`, automatic) and `event.ItemContextCompact` (an *observed* event). There is no seam to call.

**Decision:** `/compact` dispatches a normal `CmdThreadTurnStart` whose text is the literal string `/compact`, and replies *"diteruskan ke agent — dukungan tergantung provider"*. This is honest and cannot crash anything: a provider that does not interpret it simply answers as if asked about compaction. Adding a real `Adapter.Compact` method is explicitly **out of scope** for this plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/internal/domain/models.go` | + `TelegramConfig`, `TelegramUser`, `TelegramBinding` (modify) |
| `backend/internal/port/store.go` | + 11 Telegram store methods (modify) |
| `backend/internal/store/db.go` | + settings columns, 2 tables, 1 migration fn (modify) |
| `backend/internal/store/telegram.go` | Store implementation for all Telegram rows (create) |
| `backend/internal/telegram/client.go` | Bot API over `net/http`: getMe, getUpdates, sendMessage, editMessageText, answerCallbackQuery, createForumTopic (create) |
| `backend/internal/telegram/render.go` | `orchestration.Event` → Telegram text / card (create) |
| `backend/internal/telegram/pairing.go` | 6-digit codes with TTL + allowlist check (create) |
| `backend/internal/telegram/commands.go` | slash-command parsing and handling (create) |
| `backend/internal/telegram/bridge.go` | long-poll loop, inbound routing, outbound pump (create) |
| `backend/internal/handler/telegram.go` | REST surface for config / pairing / users / bindings (create) |
| `backend/cmd/server/main.go` | wiring + routes (modify) |
| `frontend/src/store/types.ts` | mirror the three domain types (modify) |
| `frontend/src/lib/telegramApi.ts` | typed fetch wrappers (create) |
| `frontend/src/features/overlays/TelegramSection.tsx` | settings panel beside `SocksPublishSection` (create) |
| `frontend/src/features/agent-chat/TelegramPublishButton.tsx` | header button + bind dialog (create) |

**Convergence files — never edited by two agents at once:** `domain/models.go`, `port/store.go`, `cmd/server/main.go`, `frontend/src/store/types.ts`. Tasks 1, 6 and 7 own them and run alone.

**Execution order:** T1 → (T2 ∥ T3) → T4 → T5 → T6 → T7.

---

### Task 1: Store and domain foundation

**Files:**
- Modify: `backend/internal/domain/models.go` (append at end)
- Modify: `backend/internal/port/store.go` (add to the `Store` interface)
- Modify: `backend/internal/store/db.go` (schema + migration)
- Create: `backend/internal/store/telegram.go`
- Test: `backend/internal/store/telegram_test.go`

**Interfaces:**
- Consumes: `store.New` test helper in `backend/internal/store/testing.go`; the `settings` singleton row pattern in `backend/internal/store/settings.go:61-80`.
- Produces: the three `domain` types and the 11 `port.Store` methods listed below. Every later task depends on these exact names.

**Read first:** `backend/internal/store/settings.go:61-80` (the `PublishedSOCKS` accessor pair this mirrors) and `backend/internal/store/db.go:505-525` (`migrateSettingsPublishedSOCKS`, the ALTER-TABLE-ignoring-duplicates migration idiom).

- [ ] **Step 1: Write the failing test**

Create `backend/internal/store/telegram_test.go`:

```go
package store

import "testing"

func TestTelegramConfigRoundTrips(t *testing.T) {
	s := newTestStore(t)
	cfg, err := s.TelegramConfig()
	if err != nil {
		t.Fatalf("TelegramConfig: %v", err)
	}
	if cfg.Enabled || cfg.HasToken {
		t.Fatalf("fresh db should be disabled and tokenless, got %+v", cfg)
	}
	if err := s.SetTelegramBotToken("123456:AAH"); err != nil {
		t.Fatalf("SetTelegramBotToken: %v", err)
	}
	if err := s.SetTelegramConfig(domain.TelegramConfig{Enabled: true, BotUsername: "devdeck_bot"}); err != nil {
		t.Fatalf("SetTelegramConfig: %v", err)
	}
	cfg, err = s.TelegramConfig()
	if err != nil {
		t.Fatalf("TelegramConfig: %v", err)
	}
	// HasToken is DERIVED from the stored token, never written by the caller:
	// SetTelegramConfig must not be able to lie about it.
	if !cfg.Enabled || !cfg.HasToken || cfg.BotUsername != "devdeck_bot" {
		t.Fatalf("round trip lost data: %+v", cfg)
	}
	tok, err := s.TelegramBotToken()
	if err != nil || tok != "123456:AAH" {
		t.Fatalf("TelegramBotToken = %q, %v", tok, err)
	}
}

func TestTelegramBindingSeqAdvancesWithoutRewritingTheRow(t *testing.T) {
	s := newTestStore(t)
	b := domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: -100234, TopicID: 17, Model: "claude-sonnet-5"}
	if err := s.SetTelegramBinding(b); err != nil {
		t.Fatalf("SetTelegramBinding: %v", err)
	}
	if err := s.SetTelegramBindingSeq("ssh:c-a1b2", 42); err != nil {
		t.Fatalf("SetTelegramBindingSeq: %v", err)
	}
	got, err := s.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("TelegramBindingByThread: %v", err)
	}
	if got.LastSeq != 42 || got.ChatID != -100234 || got.TopicID != 17 || got.Model != "claude-sonnet-5" {
		t.Fatalf("seq update clobbered the row: %+v", got)
	}
}

func TestTelegramUsersAddAndDelete(t *testing.T) {
	s := newTestStore(t)
	if err := s.AddTelegramUser(domain.TelegramUser{UserID: 587442310, Label: "@kiyora", AddedAt: 1000}); err != nil {
		t.Fatalf("AddTelegramUser: %v", err)
	}
	// Re-pairing the same account must update, not duplicate.
	if err := s.AddTelegramUser(domain.TelegramUser{UserID: 587442310, Label: "@kiyora2", AddedAt: 2000}); err != nil {
		t.Fatalf("AddTelegramUser (repeat): %v", err)
	}
	users, err := s.TelegramUsers()
	if err != nil || len(users) != 1 || users[0].Label != "@kiyora2" {
		t.Fatalf("users = %+v, %v", users, err)
	}
	if err := s.DeleteTelegramUser(587442310); err != nil {
		t.Fatalf("DeleteTelegramUser: %v", err)
	}
	users, _ = s.TelegramUsers()
	if len(users) != 0 {
		t.Fatalf("delete left %d users", len(users))
	}
}
```

Add the `domain` import. If `newTestStore` is not the helper name in `backend/internal/store/testing.go`, use whatever that file exports — read it first and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run TestTelegram -v`
Expected: compile failure — `s.TelegramConfig undefined`.

- [ ] **Step 3: Add the domain types**

Append to `backend/internal/domain/models.go`:

```go
// TelegramConfig is one machine's Telegram bridge state. Like
// PublishedSOCKSConfig it lives on that machine's own settings singleton, and
// like CompletionsConfig it excludes its secret: the bot token is reached
// through port.Store.TelegramBotToken and never rides along in JSON.
//
// HasToken is derived at read time from whether a token is stored — a caller
// cannot set it, so the UI can never be told a token exists when it does not.
type TelegramConfig struct {
	Enabled     bool   `json:"enabled"`
	HasToken    bool   `json:"hasToken"`
	BotUsername string `json:"botUsername"` // from getMe, display only
}

// TelegramUser is one entry on the allowlist. Enrolment is always /pair —
// there is no way to add a row without proving possession of a live code.
type TelegramUser struct {
	UserID  int64  `json:"userId"`
	Label   string `json:"label"` // @username at pairing time, display only
	AddedAt int64  `json:"addedAt"`
}

// TelegramBinding publishes one thread to one Telegram destination. TopicID 0
// means the destination is a DM or a non-forum group, in which case
// sendMessage simply omits message_thread_id.
//
// LastSeq is the replay cursor: the bridge re-reads AgentEventsSince(threadID,
// LastSeq) rather than trusting the engine subscription, which drops batches
// for slow subscribers by design.
type TelegramBinding struct {
	ThreadID string `json:"threadId"`
	ChatID   int64  `json:"chatId"`
	TopicID  int64  `json:"topicId,omitempty"`
	Model    string `json:"model,omitempty"` // last /model choice; "" = provider default
	LastSeq  uint64 `json:"lastSeq"`
}
```

- [ ] **Step 4: Add the store methods to the port interface**

In `backend/internal/port/store.go`, add to the `Store` interface (near the `PublishedSOCKS` pair at line 25):

```go
	TelegramConfig() (domain.TelegramConfig, error)
	SetTelegramConfig(cfg domain.TelegramConfig) error
	TelegramBotToken() (string, error)
	SetTelegramBotToken(token string) error
	TelegramUsers() ([]domain.TelegramUser, error)
	AddTelegramUser(u domain.TelegramUser) error
	DeleteTelegramUser(userID int64) error
	TelegramBindings() ([]domain.TelegramBinding, error)
	TelegramBindingByThread(threadID string) (domain.TelegramBinding, error)
	SetTelegramBinding(b domain.TelegramBinding) error
	SetTelegramBindingSeq(threadID string, seq uint64) error
	DeleteTelegramBinding(threadID string) error
```

- [ ] **Step 5: Add schema and migration**

In `backend/internal/store/db.go`, add to the `settings` CREATE TABLE (after the socks columns):

```sql
  -- Telegram remote-chat bridge for THIS machine. One bot token per process:
  -- Telegram's getUpdates is exclusive per token, so two processes cannot
  -- share one. See docs/superpowers/plans/2026-08-18-telegram-remote-chat.md
  telegram_enabled      INTEGER NOT NULL DEFAULT 0,
  telegram_token        TEXT NOT NULL DEFAULT '',
  telegram_bot_username TEXT NOT NULL DEFAULT '',
```

Add two tables alongside the other CREATE TABLE statements:

```sql
CREATE TABLE IF NOT EXISTS telegram_users (
  user_id  INTEGER PRIMARY KEY,
  label    TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telegram_bindings (
  thread_id TEXT PRIMARY KEY,
  chat_id   INTEGER NOT NULL,
  topic_id  INTEGER NOT NULL DEFAULT 0,
  model     TEXT NOT NULL DEFAULT '',
  last_seq  INTEGER NOT NULL DEFAULT 0
);
```

Add the migration next to `migrateSettingsPublishedSOCKS`, and call it from the same place that one is called (`db.go:475`):

```go
// migrateSettingsTelegram adds the Telegram bridge columns to pre-existing
// databases. Same duplicate-column-tolerant idiom as the SOCKS migration
// above: SQLite has no ADD COLUMN IF NOT EXISTS.
func migrateSettingsTelegram(db *sql.DB) error {
	cols := []string{
		"telegram_enabled INTEGER NOT NULL DEFAULT 0",
		"telegram_token TEXT NOT NULL DEFAULT ''",
		"telegram_bot_username TEXT NOT NULL DEFAULT ''",
	}
	for _, col := range cols {
		if _, err := db.Exec("ALTER TABLE settings ADD COLUMN " + col); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	return nil
}
```

- [ ] **Step 6: Implement the store**

Create `backend/internal/store/telegram.go`:

```go
package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
)

// TelegramConfig returns this machine's bridge state. HasToken is derived
// here rather than stored, so it can never disagree with the token column.
func (s *Store) TelegramConfig() (domain.TelegramConfig, error) {
	var cfg domain.TelegramConfig
	var token string
	err := s.db.QueryRow(
		`SELECT telegram_enabled, telegram_token, telegram_bot_username FROM settings WHERE id = 1`,
	).Scan(&cfg.Enabled, &token, &cfg.BotUsername)
	cfg.HasToken = token != ""
	return cfg, err
}

// SetTelegramConfig writes everything except the token — see
// SetTelegramBotToken. HasToken on the incoming value is ignored.
func (s *Store) SetTelegramConfig(cfg domain.TelegramConfig) error {
	_, err := s.db.Exec(
		`UPDATE settings SET telegram_enabled = ?, telegram_bot_username = ? WHERE id = 1`,
		cfg.Enabled, cfg.BotUsername,
	)
	return err
}

// TelegramBotToken returns the stored bot token, "" when unset. Deliberately
// separate from TelegramConfig for the same reason SignInPINHash is separate
// from Settings: the secret must never ride along in served JSON.
func (s *Store) TelegramBotToken() (string, error) {
	var token string
	err := s.db.QueryRow(`SELECT telegram_token FROM settings WHERE id = 1`).Scan(&token)
	return token, err
}

func (s *Store) SetTelegramBotToken(token string) error {
	_, err := s.db.Exec(`UPDATE settings SET telegram_token = ? WHERE id = 1`, token)
	return err
}

func (s *Store) TelegramUsers() ([]domain.TelegramUser, error) {
	rows, err := s.db.Query(`SELECT user_id, label, added_at FROM telegram_users ORDER BY added_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []domain.TelegramUser{}
	for rows.Next() {
		var u domain.TelegramUser
		if err := rows.Scan(&u.UserID, &u.Label, &u.AddedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// AddTelegramUser upserts: re-pairing an account already on the list refreshes
// its label instead of creating a second row for the same id.
func (s *Store) AddTelegramUser(u domain.TelegramUser) error {
	_, err := s.db.Exec(
		`INSERT INTO telegram_users (user_id, label, added_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET label = excluded.label, added_at = excluded.added_at`,
		u.UserID, u.Label, u.AddedAt,
	)
	return err
}

func (s *Store) DeleteTelegramUser(userID int64) error {
	_, err := s.db.Exec(`DELETE FROM telegram_users WHERE user_id = ?`, userID)
	return err
}

func (s *Store) TelegramBindings() ([]domain.TelegramBinding, error) {
	rows, err := s.db.Query(`SELECT thread_id, chat_id, topic_id, model, last_seq FROM telegram_bindings ORDER BY thread_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := []domain.TelegramBinding{}
	for rows.Next() {
		var b domain.TelegramBinding
		if err := rows.Scan(&b.ThreadID, &b.ChatID, &b.TopicID, &b.Model, &b.LastSeq); err != nil {
			return nil, err
		}
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// TelegramBindingByThread returns sql.ErrNoRows when the thread is not
// published — callers treat that as "not published", not as a failure.
func (s *Store) TelegramBindingByThread(threadID string) (domain.TelegramBinding, error) {
	var b domain.TelegramBinding
	err := s.db.QueryRow(
		`SELECT thread_id, chat_id, topic_id, model, last_seq FROM telegram_bindings WHERE thread_id = ?`,
		threadID,
	).Scan(&b.ThreadID, &b.ChatID, &b.TopicID, &b.Model, &b.LastSeq)
	return b, err
}

// SetTelegramBinding upserts the whole row EXCEPT last_seq, which only
// SetTelegramBindingSeq moves. Rebinding a thread to a different chat must not
// silently rewind its replay cursor and re-mirror the entire transcript.
func (s *Store) SetTelegramBinding(b domain.TelegramBinding) error {
	_, err := s.db.Exec(
		`INSERT INTO telegram_bindings (thread_id, chat_id, topic_id, model, last_seq) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(thread_id) DO UPDATE SET chat_id = excluded.chat_id, topic_id = excluded.topic_id, model = excluded.model`,
		b.ThreadID, b.ChatID, b.TopicID, b.Model, b.LastSeq,
	)
	return err
}

func (s *Store) SetTelegramBindingSeq(threadID string, seq uint64) error {
	_, err := s.db.Exec(`UPDATE telegram_bindings SET last_seq = ? WHERE thread_id = ?`, seq, threadID)
	return err
}

func (s *Store) DeleteTelegramBinding(threadID string) error {
	_, err := s.db.Exec(`DELETE FROM telegram_bindings WHERE thread_id = ?`, threadID)
	return err
}

var _ = sql.ErrNoRows // documented above; keeps the import honest if unused
```

Delete that last line if `sql` ends up genuinely unused.

- [ ] **Step 7: Run the tests**

Run: `cd backend && go test ./internal/store/ -run TestTelegram -v && go build ./...`
Expected: three PASS, and the build succeeds — meaning every other `port.Store` implementer (check `backend/internal/store/testing.go` and any fake in `internal/handler`) still satisfies the widened interface. **If the build fails because a test fake no longer implements `port.Store`, add the twelve methods to that fake too.**

---

### Task 2: Telegram Bot API client

**Files:**
- Create: `backend/internal/telegram/client.go`
- Test: `backend/internal/telegram/client_test.go`

**Interfaces:**
- Consumes: nothing from other tasks. Pure stdlib.
- Produces: the `Client` type and the `Update`/`Message`/`User`/`Chat`/`CallbackQuery`/`InlineKeyboard`/`InlineButton`/`SendOptions`/`APIError` types, used by Tasks 4, 5 and 6.

**Read first:** `backend/internal/selfupdate/github.go` — the same hand-rolled-client shape (BaseURL override for tests, typed error helper, `setHeaders`).

- [ ] **Step 1: Write the failing test**

Create `backend/internal/telegram/client_test.go`:

```go
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
	if body["parse_mode"] != "HTML" {
		t.Fatalf("parse_mode = %v, want HTML", body["parse_mode"])
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/telegram/ -v`
Expected: `no Go files` or undefined-symbol compile errors.

- [ ] **Step 3: Implement the client**

Create `backend/internal/telegram/client.go`. Required shape:

```go
// Package telegram bridges a DevDeck orchestration.Engine to a Telegram bot.
// One bridge per process: Telegram's getUpdates is exclusive per bot token, so
// two processes polling the same token evict each other with 409 Conflict.
package telegram

const defaultAPIBaseURL = "https://api.telegram.org"

// Client talks to one bot's Bot API. Hand-rolled on net/http, matching
// internal/selfupdate/github.go — this package adds no dependencies.
type Client struct {
	HTTPClient *http.Client
	BaseURL    string // "" means the real API; only tests set it
	Token      string
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

func (e *APIError) Error() string

func (c *Client) GetMe(ctx context.Context) (User, error)
func (c *Client) GetUpdates(ctx context.Context, offset int64, timeoutSec int) ([]Update, error)
func (c *Client) SendMessage(ctx context.Context, o SendOptions) (Message, error)
func (c *Client) EditMessageText(ctx context.Context, chatID, messageID int64, text string, kb InlineKeyboard) error
func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error
func (c *Client) CreateForumTopic(ctx context.Context, chatID int64, name string) (int64, error)
```

Implementation requirements, all load-bearing:

1. One private `call(ctx, method string, body any, out any) error` doing `POST {BaseURL}/bot{Token}/{method}` with a JSON body, decoding `{"ok":bool,"result":…,"error_code":int,"description":string,"parameters":{"retry_after":int}}`.
2. `parse_mode: "HTML"` on every `sendMessage` and `editMessageText`.
3. Omit `message_thread_id` entirely when `TopicID == 0` — build the request body as a `map[string]any` and only set the key when non-zero. Sending `0` makes Telegram answer `Bad Request: message thread not found`.
4. Omit `reply_markup` when `Keyboard` is empty.
5. `GetUpdates` must use a per-call context deadline of `timeoutSec + 10s`, and pass `timeout` as the long-poll parameter. `c.HTTPClient` defaults to `&http.Client{Timeout: 0}` — a client-level timeout would kill long polls.
6. `EditMessageText` treats the description `message is not modified` as success (nil): the pump re-flushes identical text whenever nothing new arrived.
7. `CreateForumTopic` returns `result.message_thread_id`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && go test ./internal/telegram/ -v`
Expected: three PASS.

---

### Task 3: Event renderer

**Files:**
- Create: `backend/internal/telegram/render.go`
- Test: `backend/internal/telegram/render_test.go`

**Interfaces:**
- Consumes: `orchestration.Event`, `event.Event` and its payload types. Nothing from Tasks 1 or 2.
- Produces: `Rendered`, `Card`, `CardButton`, `Render(ev orchestration.Event) Rendered`, `EscapeHTML(string) string`. Task 5 calls `Render` for every replayed event.

**Read first, carefully:** `frontend/src/features/agent-chat/eventReducer.ts`. It is the authoritative interpretation of this same event log, and this renderer must agree with it. Note especially:
- `thread.message-sent` carries `TurnStartPayload` — the **user's** message. Nothing dispatches `CmdThreadAssistantComplete` (`store/agentevent.go:97`), so this event type is never the assistant.
- `thread.activity-appended` is **two different shapes**: an `AssistantDeltaPayload` (`{itemId, stream, text, sequence}` — assistant/reasoning text) when it came from `CmdThreadAssistantDelta`, or a whole forwarded `event.Event` otherwise. Discriminate exactly the way `isActivityAppendedPayload` does: it is a delta iff `itemId`, `stream`, `text` and `sequence` are all present with the right types.
- Tool detail shapes differ per provider — read `eventReducer.ts`'s long comment on `toolCallIdOf`. `toolCallId` present means "read `args`/`result` out of this envelope"; absent means "this whole object IS the arguments".

- [ ] **Step 1: Write the failing test**

Create `backend/internal/telegram/render_test.go` with these cases, building `orchestration.Event` values by hand:

```go
package telegram

import (
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func TestRenderUserMessage(t *testing.T) {
	got := Render(orchestration.Event{
		Type:    orchestration.EvtThreadMessageSent,
		Payload: mustJSON(t, map[string]any{"text": "restart api <b>now</b>"}),
	})
	if got.Card != nil {
		t.Fatalf("a user message is not a card")
	}
	// Raw user text must be escaped or parse_mode=HTML will reject the whole
	// message and the transcript silently stops.
	if !strings.Contains(got.Text, "&lt;b&gt;now&lt;/b&gt;") {
		t.Fatalf("user text not escaped: %q", got.Text)
	}
}

func TestRenderAssistantDeltaAndReasoningAreDistinguished(t *testing.T) {
	text := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, map[string]any{"itemId": "i1", "stream": string(event.StreamText), "text": "sudah aktif", "sequence": 1}),
	})
	if text.Text == "" || text.Card != nil {
		t.Fatalf("assistant delta should append text, got %+v", text)
	}
	reason := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, map[string]any{"itemId": "i2", "stream": string(event.StreamReasoning), "text": "perlu cek dulu", "sequence": 1}),
	})
	if reason.Text == text.Text {
		t.Fatalf("reasoning and assistant text must render differently")
	}
}

func TestRenderApprovalRequestBecomesACardWithThreeDecisions(t *testing.T) {
	inner := event.Event{
		Type:      event.RequestOpened,
		RequestID: "req-1",
		Payload: &event.RequestOpenedPayload{
			ToolName: "Bash",
			Options:  []event.Decision{event.DecisionAccept, event.DecisionAcceptForSession, event.DecisionDecline},
		},
	}
	got := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, inner),
	})
	if got.Card == nil {
		t.Fatalf("an opened request must render as a card, got %+v", got)
	}
	if got.Card.RequestID != "req-1" {
		t.Fatalf("card lost the requestId: %+v", got.Card)
	}
	if len(got.Card.Buttons) != 3 {
		t.Fatalf("want 3 decision buttons, got %d", len(got.Card.Buttons))
	}
}

func TestRenderTurnCompletedSealsTheLiveMessage(t *testing.T) {
	got := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, event.Event{Type: event.TurnCompleted}),
	})
	if !got.SealLive {
		t.Fatalf("TurnCompleted must seal the live message")
	}
}

func TestRenderIgnoresBookkeeping(t *testing.T) {
	got := Render(orchestration.Event{Type: orchestration.EvtThreadSessionSet, Payload: mustJSON(t, map[string]any{"status": "running"})})
	if got.Text != "" || got.Card != nil {
		t.Fatalf("session bookkeeping must render nothing, got %+v", got)
	}
}
```

Before writing these, open `backend/internal/agentcore/event/event.go` and use the **real** payload struct names and field names (`RequestOpenedPayload`, `StreamText`, `StreamReasoning`, etc.). If a name in the test above does not exist, use the real one — the test's intent, not its spelling, is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/telegram/ -run TestRender -v`
Expected: `undefined: Render`.

- [ ] **Step 3: Implement the renderer**

Create `backend/internal/telegram/render.go`:

```go
// Rendered is what one orchestration.Event becomes on Telegram.
//
// Text and Card are deliberately separate sinks. Text is appended to the
// turn's LIVE message, which the pump rewrites about once a second; a card is
// its own standalone message because it carries an inline keyboard, and a
// keyboard on a message that is still being edited is a moving target for the
// person trying to tap it.
type Rendered struct {
	Text     string
	Card     *Card
	SealLive bool // the turn ended: stop editing the live message
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

func Render(ev orchestration.Event) Rendered
func EscapeHTML(s string) string
```

Rules:

| Event | Render |
|---|---|
| `EvtThreadMessageSent` | `👤 <escaped text>` |
| `EvtThreadActivityAppended`, delta shape, `stream == StreamText` | the escaped text, appended raw (no prefix — deltas concatenate into one paragraph) |
| `EvtThreadActivityAppended`, delta shape, `stream == StreamReasoning` | escaped text wrapped in `<i>…</i>` |
| forwarded `event.RequestOpened` / `event.UserInputRequested` | a `Card`; buttons from `Options` for an approval, from the question's own options for a user-input request |
| forwarded `event.ItemStarted`/`ItemCompleted` with `ItemType == ItemToolCall` | `⚙️ <name>` then the arguments in `<pre>…</pre>`, truncated at 800 chars with `… (dipotong)` |
| forwarded `event.TurnCompleted` / `TurnAborted` | `SealLive: true`, plus a one-line footer with the turn's token usage when present |
| forwarded `event.ItemCompleted` with `ItemType == ItemError` | `⚠️ <escaped message>` |
| `EvtThreadSessionSet`, `EvtThreadCreated`, `EvtThreadSettled`, anything else | zero `Rendered` |

`EscapeHTML` replaces `&`, `<`, `>` in that order — Telegram's HTML parse mode needs nothing else escaped.

- [ ] **Step 4: Run the tests**

Run: `cd backend && go test ./internal/telegram/ -run TestRender -v`
Expected: five PASS.

---

### Task 4: Pairing, allowlist, and slash commands

**Files:**
- Create: `backend/internal/telegram/pairing.go`
- Create: `backend/internal/telegram/commands.go`
- Test: `backend/internal/telegram/pairing_test.go`
- Test: `backend/internal/telegram/commands_test.go`

**Interfaces:**
- Consumes: `domain.TelegramUser` (Task 1); `Client`, `InlineKeyboard` (Task 2).
- Produces:
  ```go
  type Pairing struct{ TTL time.Duration; Now func() time.Time }
  func (p *Pairing) Issue() string                 // 6 digits, replaces any live code
  func (p *Pairing) Redeem(code string) bool       // true once; a used code is dead
  func (p *Pairing) Current() (code string, expiresAt time.Time, ok bool)

  type ParsedCommand struct {
      Name string   // "pair", "new", "model", "skills", "compact", "stop", "status", "unpublish"
      Args []string
  }
  func ParseCommand(text string) (ParsedCommand, bool)
  func NextChatSuffix(existing []string, base string) string
  ```
  Task 5 calls all of these.

- [ ] **Step 1: Write the failing tests**

`backend/internal/telegram/pairing_test.go`:

```go
package telegram

import (
	"testing"
	"time"
)

func TestPairingCodeIsSixDigitsAndSingleUse(t *testing.T) {
	now := time.Unix(1000, 0)
	p := &Pairing{TTL: 5 * time.Minute, Now: func() time.Time { return now }}
	code := p.Issue()
	if len(code) != 6 {
		t.Fatalf("code = %q, want 6 digits", code)
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			t.Fatalf("code = %q, want digits only", code)
		}
	}
	if !p.Redeem(code) {
		t.Fatalf("first redeem must succeed")
	}
	// Single use: a code shared in a group chat must not enrol everyone who
	// scrolled up and read it.
	if p.Redeem(code) {
		t.Fatalf("second redeem must fail")
	}
}

func TestPairingCodeExpires(t *testing.T) {
	now := time.Unix(1000, 0)
	p := &Pairing{TTL: 5 * time.Minute, Now: func() time.Time { return now }}
	code := p.Issue()
	now = now.Add(6 * time.Minute)
	if p.Redeem(code) {
		t.Fatalf("expired code must not redeem")
	}
}

func TestIssueInvalidatesThePreviousCode(t *testing.T) {
	now := time.Unix(1000, 0)
	p := &Pairing{TTL: 5 * time.Minute, Now: func() time.Time { return now }}
	first := p.Issue()
	second := p.Issue()
	if first == second {
		t.Fatalf("a reissue must produce a different code")
	}
	if p.Redeem(first) {
		t.Fatalf("the superseded code must be dead")
	}
	if !p.Redeem(second) {
		t.Fatalf("the current code must redeem")
	}
}

func TestRedeemRejectsEmptyAndUnissuedCodes(t *testing.T) {
	p := &Pairing{TTL: 5 * time.Minute, Now: time.Now}
	code := p.Issue()
	if p.Redeem("") {
		t.Fatalf("an empty code must never redeem")
	}
	// A wrong guess must not consume the live code either.
	wrong := "000000"
	if wrong == code {
		wrong = "111111"
	}
	if p.Redeem(wrong) {
		t.Fatalf("a wrong code must not redeem")
	}
	if !p.Redeem(code) {
		t.Fatalf("a failed guess must not have burned the real code")
	}
}
```

`backend/internal/telegram/commands_test.go`:

```go
package telegram

import "testing"

func TestParseCommand(t *testing.T) {
	cases := []struct {
		in       string
		wantName string
		wantArgs int
		wantOK   bool
	}{
		{"/pair 482913", "pair", 1, true},
		{"/model", "model", 0, true},
		// Telegram appends @botname when several bots share a group.
		{"/new@devdeck_bot", "new", 0, true},
		{"restart the api", "", 0, false},
		{"  /skills  ", "skills", 0, true},
		{"tolong jalankan /compact nanti", "", 0, false},
	}
	for _, c := range cases {
		got, ok := ParseCommand(c.in)
		if ok != c.wantOK {
			t.Fatalf("ParseCommand(%q) ok = %v, want %v", c.in, ok, c.wantOK)
		}
		if ok && (got.Name != c.wantName || len(got.Args) != c.wantArgs) {
			t.Fatalf("ParseCommand(%q) = %+v, want %s/%d args", c.in, got, c.wantName, c.wantArgs)
		}
	}
}

func TestNextChatSuffix(t *testing.T) {
	// ::chat-N is allocated client-side today (frontend paneTree.ts:257), so
	// the bridge has to allocate its own. Gaps are not reused: a deleted
	// chat-2 must not have its transcript resurrected under a new binding.
	got := NextChatSuffix([]string{"ssh:c-a1", "ssh:c-a1::chat-2", "other"}, "ssh:c-a1")
	if got != "ssh:c-a1::chat-3" {
		t.Fatalf("NextChatSuffix = %q", got)
	}
	if first := NextChatSuffix([]string{"ssh:c-a1"}, "ssh:c-a1"); first != "ssh:c-a1::chat-2" {
		t.Fatalf("first extra chat = %q, want ::chat-2", first)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/telegram/ -run 'TestPairing|TestIssue|TestRedeem|TestParseCommand|TestNextChatSuffix' -v`
Expected: `undefined: Pairing`, `undefined: ParseCommand`.

- [ ] **Step 3: Implement**

`pairing.go`: a mutex-guarded struct holding `code string` and `expiresAt time.Time`. `Issue` generates 6 digits with `crypto/rand` (loop until it differs from the current code), overwrites both fields, returns the code. `Redeem` compares under lock, checks `Now().Before(expiresAt)`, and **clears the code on success** so it cannot be reused. An empty stored code never matches, so an empty argument can never redeem.

`commands.go`:
- `ParseCommand` trims space, requires a leading `/`, splits on whitespace, strips anything from `@` onward in the first token, lowercases the name, returns the rest as `Args`.
- `NextChatSuffix(existing []string, base string) string` scans `existing` for `base + "::chat-" + N`, takes the maximum N seen (treating the bare `base` as N=1), and returns `base + "::chat-" + (max+1)`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && go test ./internal/telegram/ -v`
Expected: all PASS (Tasks 2, 3 and 4 tests together).

---

### Task 5: The bridge

**Files:**
- Create: `backend/internal/telegram/bridge.go`
- Test: `backend/internal/telegram/bridge_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1-4, plus `orchestration.Engine`, `orchestration.Command`, `port.Store`.
- Produces:
  ```go
  type Deps struct {
      Store      port.Store
      Engine     *orchestration.Engine
      Client     *Client            // nil = built from the stored token
      Pairing    *Pairing
      NewID      func() string      // command ids; main.go passes the "ae-"+hex generator
      ListSkills func() ([]string, error) // injected so this package never imports internal/service
      Models     func(threadID string) ([]string, error)
      Now        func() time.Time
  }
  type Bridge struct{ /* unexported */ }
  func New(d Deps) *Bridge
  func (b *Bridge) Run(ctx context.Context)   // blocks until ctx is done
  ```
  Task 6 calls `New` and `Run`.

**Read first:** `backend/internal/handler/agent_ws.go` in full — the bridge is the same client, over a different transport. Note `handleCommand`'s `orchestration.ClientDispatchable` gate: the bridge must respect the same allowlist and never dispatch a server-only command.

**Corrections discovered while building Task 3 — the payload structs are not what earlier drafts of this plan assumed:**

- `event.RequestOpenedPayload` is `{RequestType, Detail, Args, Options}`. **There is no `ToolName` field**; an approval card's label comes from `RequestType` plus `Detail`.
- `event.ItemCompletedPayload` is `{ItemType, Status, Detail}` — no title, no message. A tool's *name* exists only on `ItemStartedPayload.Title`, and an `ItemError` completion carries no message text at all.
- `event.TurnAborted` has no registered payload, so a forwarded one always decodes with `Payload == nil`. That is by design in `event.go`, not a bug.

#### §5a User-input requests must be answered whole, never piecemeal

`event.UserInputRequestedPayload.Questions` is an opaque `json.RawMessage`. Decode it in the bridge (Task 3's `Render` deliberately renders only the first question — a pure function has no place to hold partial state). Its real shape, confirmed against `frontend/src/features/agent-chat/ComposerPendingUserInputPanel.tsx`:

```go
type inputQuestion struct {
	ID          string `json:"id"`
	Header      string `json:"header"`
	Question    string `json:"question"`
	MultiSelect bool   `json:"multiSelect"`
	Options     []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}
```

A prompt may carry up to four questions. `orchestration.UserInputRespondPayload.Answers` is keyed by the **full question text** — its own doc comment records that this was verified against captured CLI traffic, and that re-keying the map "reaches the agent as no answer at all". A map missing one question reaches the agent the same way.

So the bridge must:

1. Send **one card per question**, each button's callback token carrying `(requestID, questionText, optionLabel)`.
2. Accumulate answers in memory, keyed by `requestID`, as taps arrive. Edit each answered card in place to show the chosen option so the operator can see their own progress.
3. Dispatch `CmdThreadUserInputRespond` **once, only when every question has an answer**, with the complete map.

This mirrors what the browser panel already does (`derivePendingUserInputProgress` walks the questions and submits at the end). Approvals are the opposite and much simpler: a single `RequestOpened` card dispatches `CmdThreadApprovalRespond` on the first tap.

Add a test for this:

```go
func TestMultiQuestionInputDispatchesOnlyWhenEveryQuestionIsAnswered(t *testing.T)
// Two questions. After the first tap: no dispatch. After the second: exactly
// one CmdThreadUserInputRespond whose Answers map has BOTH question texts as
// keys. A partial map reaches the agent as no answer at all.
```

- [ ] **Step 1: Write the failing test**

Create `backend/internal/telegram/bridge_test.go`. Build a real `orchestration.Engine` over the in-memory store (`orchestration.NewMemStore()` in `orchestration/memstore.go` — read it for the exact constructor name) and a fake Telegram transport. The tests that must exist:

```go
func TestUnknownSenderIsIgnoredSilently(t *testing.T)
// An update from a user id NOT on the allowlist must produce ZERO outbound
// calls — not an error reply. The bot must not confirm it exists to strangers.

func TestPairEnrolsTheSenderAndConfirms(t *testing.T)
// "/pair <live code>" from an unknown sender adds a domain.TelegramUser and
// replies. This is the ONLY command an unlisted sender may run.

func TestPlainTextFromBoundChatStartsATurn(t *testing.T)
// A message in a bound (chatId, topicId) dispatches CmdThreadTurnStart with
// that text, against the bound threadId — and no other thread.

func TestMessageFromAnUnboundChatStartsNothing(t *testing.T)
// Allowlisted sender, but no binding for (chatId, topicId): no dispatch.

func TestCallbackAnswersTheApproval(t *testing.T)
// A callback whose data is a token the bridge minted dispatches
// CmdThreadApprovalRespond with the right requestId and decision.

func TestStaleCallbackTokenIsRejectedNotGuessed(t *testing.T)
// An unknown cb: token must answer the callback query with an error toast and
// dispatch NOTHING. Guessing a requestId here would approve a command the
// operator never saw.

func TestOutboundReplaysFromLastSeqNotFromTheSubscription(t *testing.T)
// Commit events to the engine while the bridge's subscription is deliberately
// starved, then let the pump run: every event must still reach Telegram,
// because the pump reads AgentEventsSince(threadID, binding.LastSeq).

func TestLastSeqAdvancesOnlyAfterASuccessfulSend(t *testing.T)
// Make the fake transport fail once. binding.LastSeq must NOT move, and the
// same events must be re-sent on the next tick.
```

Write real assertions for each — read `backend/internal/agentcore/orchestration/engine_test.go` for how to drive an engine in a test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/telegram/ -run TestBridge -v` (or the names above)
Expected: `undefined: New`.

- [ ] **Step 3: Implement the bridge**

`bridge.go` has three concerns; keep them in three clearly separated method groups.

**(a) Inbound loop.** `Run` starts `pollLoop` and `pumpLoop` as goroutines and blocks on `ctx.Done()`.

`pollLoop`: `GetUpdates(ctx, offset, 30)`, advance `offset = update.UpdateID + 1` after handling each. On error, log and sleep 5s (on `*APIError` with `RetryAfter`, sleep that instead). A `409` is fatal-worthy — log it loudly as *"another process is polling this bot token"* and keep retrying with backoff.

`handleUpdate`:
1. Extract `from.ID`. If the update is `/pair <code>`, handle it and return.
2. If `from.ID` is not in `store.TelegramUsers()`, **return with no reply**.
3. For a `callback_query`, look up the token; unknown → `AnswerCallbackQuery(id, "permintaan ini sudah kedaluwarsa")` and return.
4. For a text message, look up the binding by `(chat.ID, message_thread_id)`. No binding → return silently unless the text is a command, in which case reply that the chat is unbound.
5. A command goes to `handleCommand`; anything else dispatches `CmdThreadTurnStart`.

**(b) Commands.** Each replies in Indonesian, matching the rest of the bot's copy.

| Command | Behaviour |
|---|---|
| `/pair <code>` | `Pairing.Redeem`; on success `AddTelegramUser{UserID, Label: "@"+username, AddedAt: Now().UnixMilli()}` and reply `✅ terhubung`. On failure reply `kode tidak berlaku`. |
| `/init <threadId>` | Bind this chat/topic to the named thread — see §2a. Allowlisted senders only, handled before the binding lookup, destination uniqueness enforced, new bindings start at the thread's head sequence. |
| `/new` | `NextChatSuffix` over `engine.State().Threads` keys; if the chat is a forum, `CreateForumTopic(chatID, newThreadID)` and bind to the new topic; if it is a DM, reply that a new chat needs a forum topic. |
| `/model` | `Deps.Models(threadID)` → inline keyboard, one button per model; the callback writes `binding.Model` via `SetTelegramBinding`. Every later `CmdThreadTurnStart` carries `provider.ModelSelection{Model: binding.Model}`. |
| `/skills` | `Deps.ListSkills()` → a plain list, truncated to 4000 characters. |
| `/compact` | Dispatch `CmdThreadTurnStart` with `Text: "/compact"`, reply `diteruskan ke agent — dukungan tergantung provider`. See §0.8; there is no adapter seam. |
| `/stop` | `CmdThreadSessionStop`. |
| `/status` | thread status, current model, and count of pending requests, read from `engine.State().Thread(threadID)`. |
| `/unpublish` | `DeleteTelegramBinding` and confirm. |

Every dispatch sets `CommandID: d.NewID()` and goes through `Engine.Dispatch`. Check `orchestration.ClientDispatchable[cmd.Type]` before dispatching, exactly as `agent_ws.go:224` does.

**(c) Outbound pump.** One `chatState` per binding: `liveMessageID int64`, `liveLen int`, `buf strings.Builder`.

```
subscription fires (or 2s backstop ticker)
  └─ for each binding:
       evts, _ := store.AgentEventsSince(binding.ThreadID, binding.LastSeq)
       for each ev:
           r := Render(ev)
           r.Card != nil  → mint a cb: token per button, SendMessage immediately
           r.Text != ""   → append to buf
           r.SealLive     → flush, then liveMessageID = 0
       flush()
       on success only: SetTelegramBindingSeq(threadID, lastEv.Seq)
```

`flush()`: nothing buffered → return. `liveMessageID == 0` → `SendMessage` and record the id. Otherwise `EditMessageText` with the accumulated text. When accumulated length would exceed 3500, seal (`liveMessageID = 0`) and start a fresh message with the remainder. On `*APIError` with `RetryAfter`, sleep and retry — never discard the buffer, and never advance `LastSeq`.

Token minting: `cb:` + 8 hex from `crypto/rand`, stored in a mutex-guarded `map[string]callbackTarget` where

```go
type callbackTarget struct {
	ThreadID  string
	RequestID string
	Decision  event.Decision // set for approvals
	Question  string         // set for user-input answers
	Answer    string
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && go test ./internal/telegram/ -v && go vet ./internal/telegram/`
Expected: all PASS, vet clean.

---

### Task 6: HTTP surface and wiring

**Files:**
- Create: `backend/internal/handler/telegram.go`
- Test: `backend/internal/handler/telegram_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: Task 1's store methods, Task 5's `telegram.New` / `Bridge.Run` / `Pairing`.
- Produces: the REST routes the frontend (Task 7) calls.

**Read first:** `backend/internal/handler/proxy.go:34-90` — `PublishedSOCKSHandler` is the shape to copy, including its comment about deliberately not gating on role.

- [ ] **Step 1: Write the failing test**

`backend/internal/handler/telegram_test.go` must assert:

```go
func TestGetTelegramConfigNeverLeaksTheToken(t *testing.T)
// PUT a token, GET the config, assert the raw response body does not contain
// the token string anywhere and that hasToken is true.

func TestPutTelegramConfigWithEmptyTokenKeepsTheStoredOne(t *testing.T)
// The UI re-submits the form without re-typing the secret. An empty token
// field means "unchanged", not "erase".

func TestPairReturnsASixDigitCode(t *testing.T)

func TestDeleteBindingIsIdempotent(t *testing.T)
// Deleting a binding that is not there answers 204, not 500.
```

Follow the existing handler-test idiom in `backend/internal/handler/` (look at any `*_test.go` there for how a store fake and `httptest` request are built).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestTelegram -v`
Expected: undefined symbols.

- [ ] **Step 3: Implement the handler**

```go
// TelegramHandler exposes this machine's Telegram bridge configuration.
// Registered on every role, like PublishedSOCKSHandler: a runtime publishing
// its worktree chats is as valid as a hub publishing its SSH chats.
type TelegramHandler struct {
	store   port.Store
	pairing *telegram.Pairing
	restart func() // re-reads config and (re)starts or stops the bridge
}
```

Routes and behaviour:

| Route | Behaviour |
|---|---|
| `GET /api/telegram/config` | `store.TelegramConfig()` |
| `PUT /api/telegram/config` | body `{enabled bool, token string}`. **Empty `token` means "keep the stored one".** Write config, write token if non-empty, call `restart()`, return the fresh config. |
| `POST /api/telegram/pair` | `{"code": pairing.Issue(), "expiresAt": …}` |
| `GET /api/telegram/users` | `store.TelegramUsers()` |
| `DELETE /api/telegram/users/{userId}` | parse int64, `DeleteTelegramUser`, 204 |
| `GET /api/telegram/bindings` | `store.TelegramBindings()` |
| `PUT /api/telegram/bindings/{threadId}` | body `{chatId int64, topicId int64}`, `SetTelegramBinding` |
| `DELETE /api/telegram/bindings/{threadId}` | `DeleteTelegramBinding`, 204 even when absent |

Use `handleStoreErr` for store failures and the `{"error":…}` envelope for everything else.

- [ ] **Step 4: Wire it in main.go**

Register the routes **outside** any `if !isRuntime` block, next to the `publishedSOCKSH` registrations at `main.go:1154`:

```go
mux.HandleFunc("GET /api/telegram/config", telegramH.GetConfig)
mux.HandleFunc("PUT /api/telegram/config", telegramH.PutConfig)
mux.HandleFunc("POST /api/telegram/pair", telegramH.PostPair)
mux.HandleFunc("GET /api/telegram/users", telegramH.GetUsers)
mux.HandleFunc("DELETE /api/telegram/users/{userId}", telegramH.DeleteUser)
mux.HandleFunc("GET /api/telegram/bindings", telegramH.GetBindings)
mux.HandleFunc("PUT /api/telegram/bindings/{threadId}", telegramH.PutBinding)
mux.HandleFunc("DELETE /api/telegram/bindings/{threadId}", telegramH.DeleteBinding)
```

Construct the bridge after `agentEngine` exists (`main.go:479`) and after `agentChatSvc` (`main.go:482`). Supervisor shape:

```go
// The Telegram bridge runs on every role for the same reason the published
// SOCKS proxy does: which threads a process can publish is decided by which
// threads its own engine holds, not by its role. A hub publishes ssh:*
// threads; a runtime publishes its own worktree chats. One bot token per
// process is a hard requirement, not a style choice — Telegram's getUpdates
// is exclusive per token.
telegramPairing := &telegram.Pairing{TTL: 5 * time.Minute, Now: time.Now}
var telegramCancel context.CancelFunc
var telegramMu sync.Mutex
restartTelegram := func() {
	telegramMu.Lock()
	defer telegramMu.Unlock()
	if telegramCancel != nil {
		telegramCancel()
		telegramCancel = nil
	}
	cfg, err := st.TelegramConfig()
	if err != nil || !cfg.Enabled || !cfg.HasToken {
		return
	}
	token, err := st.TelegramBotToken()
	if err != nil || token == "" {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	telegramCancel = cancel
	b := telegram.New(telegram.Deps{
		Store:   st,
		Engine:  agentEngine,
		Client:  &telegram.Client{Token: token},
		Pairing: telegramPairing,
		NewID:   func() string { return "tg-" + randomHex(8) },
		ListSkills: func() ([]string, error) {
			skills, err := agentSvc.ListSkills(orchestration.DefaultAgent)
			if err != nil {
				return nil, err
			}
			names := make([]string, 0, len(skills))
			for _, s := range skills {
				names = append(names, s.Name)
			}
			return names, nil
		},
		Models: func(threadID string) ([]string, error) {
			// The agent id is the InstanceID's prefix before ':' — the same
			// decomposition resolveScope does at main.go:555. Falls back to
			// DefaultAgent for a thread the engine has not seen yet.
			agentID := orchestration.DefaultAgent
			if th, ok := agentEngine.State().Thread(threadID); ok {
				if i := strings.IndexByte(string(th.InstanceID), ':'); i > 0 {
					agentID = string(th.InstanceID)[:i]
				}
			}
			models, err := agentSvc.ListModels(agentID)
			if err != nil {
				return nil, err
			}
			ids := make([]string, 0, len(models))
			for _, m := range models {
				ids = append(ids, m.ID)
			}
			return ids, nil
		},
		Now: time.Now,
	})
	go b.Run(ctx)
	log.Printf("telegram: bridge started")
}
restartTelegram()
```

Call `restartTelegram` once at boot and pass it to the handler as `restart`.

- [ ] **Step 5: Verify**

Run: `cd backend && go build ./... && go vet ./... && go test ./internal/handler/ -run TestTelegram -v`
Expected: build clean, vet clean, handler tests PASS.

---

### Task 7: Frontend — settings panel and publish button

**Files:**
- Modify: `frontend/src/store/types.ts` (add three interfaces)
- Create: `frontend/src/lib/telegramApi.ts`
- Create: `frontend/src/features/overlays/TelegramSection.tsx`
- Create: `frontend/src/features/overlays/TelegramSection.test.tsx`
- Create: `frontend/src/features/agent-chat/TelegramPublishButton.tsx`
- Create: `frontend/src/features/agent-chat/TelegramPublishButton.test.tsx`
- Modify: `frontend/src/features/agent-chat/ChatHeader.tsx` (render the button)

**Interfaces:**
- Consumes: Task 6's REST routes.
- Produces: UI only.

**Read first:** `frontend/src/features/overlays/SocksPublishSection.tsx` and its test — this section sits beside it and must match its structure, its use of TanStack Query, and its visual language. Also `frontend/src/lib/machineApi.ts` for how a per-machine request is addressed (direct-or-proxy), since a runtime's Telegram config is edited through the same path.

- [ ] **Step 1: Write the failing tests**

`TelegramSection.test.tsx` must assert:
- The token input renders as a password field and shows a "tersimpan" state (not the value) when `hasToken` is true.
- Submitting with the token field untouched sends `token: ""` — the "keep the stored one" contract from Task 6.
- Clicking "Buat kode pairing" renders the returned 6-digit code.

`TelegramPublishButton.test.tsx` must assert:
- With no binding, the button reads "Publish ke Telegram" and opens the dialog.
- With a binding, it reads "Terpublish" and the menu offers unpublish.

Run tests with `node_modules/.bin/vitest run <path>` — `npx vitest` can lose the `@` alias in this repo.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/features/overlays/TelegramSection.test.tsx`
Expected: module not found.

- [ ] **Step 3: Add the types**

In `frontend/src/store/types.ts`, mirroring `domain/models.go` field for field:

```ts
export interface TelegramConfig {
  enabled: boolean
  hasToken: boolean
  botUsername: string
}

export interface TelegramUser {
  userId: number
  label: string
  addedAt: number
}

export interface TelegramBinding {
  threadId: string
  chatId: number
  topicId?: number
  model?: string
  lastSeq: number
}
```

- [ ] **Step 4: Implement the API wrappers and components**

`telegramApi.ts` exports `getTelegramConfig`, `putTelegramConfig`, `createPairingCode`, `listTelegramUsers`, `deleteTelegramUser`, `listTelegramBindings`, `putTelegramBinding`, `deleteTelegramBinding` — each addressed to a machine the same way `machineApi.ts` addresses its calls.

`TelegramSection.tsx`: enable toggle, password token field, bot username display, "Buat kode pairing" button showing the code and its countdown, and the allowlist with a remove action per row.

`TelegramPublishButton.tsx`: a header button; the dialog takes a chat id and an optional topic id and calls `putTelegramBinding`.

Wire the button into `ChatHeader.tsx` beside the existing header actions.

- [ ] **Step 5: Verify**

Run: `cd frontend && node_modules/.bin/vitest run src/features/overlays/TelegramSection.test.tsx src/features/agent-chat/TelegramPublishButton.test.tsx && npm run typecheck`
Expected: tests PASS; typecheck reports no NEW errors (this repo has known pre-existing ones — compare against the baseline before your change).

---

## Known follow-ups (found during review, deliberately out of scope)

These were found by the post-implementation review, judged real, and left undone on purpose. None is a defect in what shipped; each is a decision or a feature-sized change the plan never took.

1. **Approval buttons die across a bridge restart.** See the correction in §0.5. Needs re-minting from `Thread.PendingRequests` at startup plus re-sending the cards. Safe failure today (dead button; the browser still works).
2. ~~**Unpublish → republish re-mirrors the whole transcript.**~~ **Resolved** by §2a: a new binding now starts at the thread's head sequence, so publishing — first time or after an unpublish — mirrors from that moment forward. The head seq is derived from `AgentEventsSince(threadID, 0)` at bind time rather than by widening `port.Store`, which carries unrelated in-progress work.
3. **Multi-select questions send a single string** where the browser sends `string[]`. Fixing this by guessing is exactly the trap `UserInputRespondPayload`'s doc comment warns about — it needs a live capture of what the CLI actually accepts before anything changes.
4. **`/pair` answers unknown senders with "kode tidak berlaku"**, which confirms the bot exists, and nothing rate-limits guesses against the 6-digit code. This is what Task 5's table specifies; the code is single-use and expires in 5 minutes. Revisit if the bot is ever reachable by strangers in practice.
5. **`Adapter.Compact` does not exist**, so `/compact` is forwarded as prompt text (§0.8). Adding a real compact seam across providers is its own piece of work.

## Final verification (orchestrator, not a subagent)

```bash
cd backend && go build ./... && go vet ./... && go test ./...
cd frontend && npm run typecheck && node_modules/.bin/vitest run
```

`npm test` shows one known pre-existing Monaco guard failure — that is not a regression from this work.
