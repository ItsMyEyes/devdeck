package store

import (
	"database/sql"
	"strings"

	_ "modernc.org/sqlite"
)

// schema is executed idempotently on startup. Worktree terminal lines are
// stored as a JSON TEXT column. Foreign keys cascade on delete.
const schema = `
CREATE TABLE IF NOT EXISTS workspaces (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  repo         TEXT NOT NULL DEFAULT '',
  path         TEXT NOT NULL DEFAULT '',
  expanded     INTEGER NOT NULL DEFAULT 1,
  machine_id   TEXT NOT NULL DEFAULT '',
  -- origin distinguishes a runtime-replica row synced from the hub ('hub')
  -- from one created locally while the hub was unreachable ('local'). Only
  -- meaningful on a runtime; the hub itself never reads it. See
  -- docs/superpowers/specs/2026-07-19-hub-runtime-catalog-split-design.md.
  origin       TEXT NOT NULL DEFAULT 'hub',
  -- sync_error is set when this runtime's most recent replay attempt for a
  -- local project failed permanently (its workspace no longer exists on the
  -- hub) — as opposed to merely not-yet-attempted or a transient network
  -- failure, neither of which touch this column. Cleared on a successful
  -- replay. Only meaningful alongside origin='local'.
  sync_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS worktrees (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root       INTEGER NOT NULL DEFAULT 0,
  branch     TEXT NOT NULL DEFAULT '',
  base       TEXT NOT NULL DEFAULT 'main',
  ahead      INTEGER NOT NULL DEFAULT 0,
  behind     INTEGER NOT NULL DEFAULT 0,
  model      TEXT NOT NULL DEFAULT '',
  agent      TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'running',
  task       TEXT NOT NULL DEFAULT '',
  tokens     INTEGER NOT NULL DEFAULT 0,
  elapsed    INTEGER NOT NULL DEFAULT 0,
  added      INTEGER NOT NULL DEFAULT 0,
  removed    INTEGER NOT NULL DEFAULT 0,
  files      INTEGER NOT NULL DEFAULT 0,
  lines      TEXT NOT NULL DEFAULT '[]',
  pending    TEXT,
  path       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);

CREATE TABLE IF NOT EXISTS issues (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo',
  priority    TEXT NOT NULL DEFAULT 'normal',
  assignee    TEXT,
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);

CREATE TABLE IF NOT EXISTS issue_attachments (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL DEFAULT '',
  mime_type  TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_issue_attachments_issue ON issue_attachments(issue_id);

CREATE TABLE IF NOT EXISTS issue_comments (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES issue_comments(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_comments_parent ON issue_comments(parent_id);

CREATE TABLE IF NOT EXISTS issue_events (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT '',
  from_value TEXT,
  to_value   TEXT,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id);

CREATE TABLE IF NOT EXISTS news (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  tag          TEXT NOT NULL DEFAULT '',
  time         TEXT NOT NULL DEFAULT '',
  unread       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_news_ws ON news(workspace_id);

CREATE TABLE IF NOT EXISTS todos (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text         TEXT NOT NULL DEFAULT '',
  done         INTEGER NOT NULL DEFAULT 0,
  priority     TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS idx_todos_ws ON todos(workspace_id);

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  short_address TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS banks (
  id             TEXT PRIMARY KEY,
  bank_name      TEXT NOT NULL DEFAULT '',
  account_name   TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS invoices (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number              TEXT NOT NULL DEFAULT '',
  client              TEXT NOT NULL DEFAULT '',
  company             TEXT NOT NULL DEFAULT '',
  company_name        TEXT NOT NULL DEFAULT '',
  company_address     TEXT NOT NULL DEFAULT '',
  items_json          TEXT NOT NULL DEFAULT '[]',
  amount              REAL NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft',
  due_date            TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT '',
  bank_name           TEXT NOT NULL DEFAULT '',
  bank_account_name   TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_invoices_ws ON invoices(workspace_id);

CREATE TABLE IF NOT EXISTS recurring_templates (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_name        TEXT NOT NULL DEFAULT '',
  company_address     TEXT NOT NULL DEFAULT '',
  items_json          TEXT NOT NULL DEFAULT '[]',
  bank_name           TEXT NOT NULL DEFAULT '',
  bank_account_name   TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  day_of_month        INTEGER NOT NULL DEFAULT 1,
  payment_term_days   INTEGER NOT NULL DEFAULT 14,
  active              INTEGER NOT NULL DEFAULT 1,
  last_generated_ym   TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recurring_templates_ws ON recurring_templates(workspace_id);

CREATE TABLE IF NOT EXISTS machines (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL DEFAULT '',
  url      TEXT NOT NULL DEFAULT '',
  key      TEXT NOT NULL DEFAULT '',
  is_local INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id            TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL DEFAULT '',
  group_name    TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  icon_data_url TEXT NOT NULL DEFAULT ''
);

-- Re-starring a page the operator already saved on the same machine updates
-- that row instead of stacking duplicates; see store.CreateBookmark.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_machine_url ON bookmarks (machine_id, url);

CREATE TABLE IF NOT EXISTS ssh_connections (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL DEFAULT '',
  group_name           TEXT NOT NULL DEFAULT '',
  host                 TEXT NOT NULL DEFAULT '',
  port                 INTEGER NOT NULL DEFAULT 22,
  username             TEXT NOT NULL DEFAULT '',
  auth_type            TEXT NOT NULL DEFAULT 'password',
  jump_connection_id   TEXT,
  executor_machine_id  TEXT,
  host_key_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS ssh_secrets (
  connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  storage_kind  TEXT NOT NULL DEFAULT 'db',
  cipher_text   TEXT NOT NULL DEFAULT '',
  keychain_ref  TEXT,
  PRIMARY KEY (connection_id, kind)
);

-- Saved port-forwarding rules. The hub owns these; the executor holds only
-- the live listeners, in memory. ON DELETE CASCADE mirrors ssh_secrets: a
-- forwarding rule has no meaning without its connection.
CREATE TABLE IF NOT EXISTS ssh_forwards (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL DEFAULT 'local',
  bind_host     TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port     INTEGER NOT NULL DEFAULT 0,
  target_host   TEXT NOT NULL DEFAULT '',
  target_port   INTEGER NOT NULL DEFAULT 0,
  label         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS db_connections (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL DEFAULT '',
  group_name              TEXT NOT NULL DEFAULT '',
  engine                  TEXT NOT NULL DEFAULT 'postgres',
  host                    TEXT NOT NULL DEFAULT '',
  port                    INTEGER NOT NULL DEFAULT 5432,
  username                TEXT NOT NULL DEFAULT '',
  database_name           TEXT NOT NULL DEFAULT '',
  ssl_mode                TEXT NOT NULL DEFAULT 'verify-full',
  executor_machine_id     TEXT,
  tunnel_connection_id    TEXT,
  is_production           INTEGER NOT NULL DEFAULT 0,
  server_cert_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS db_secrets (
  connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  storage_kind  TEXT NOT NULL DEFAULT 'db',
  cipher_text   TEXT NOT NULL DEFAULT '',
  keychain_ref  TEXT,
  PRIMARY KEY (connection_id, kind)
);

CREATE TABLE IF NOT EXISTS db_saved_queries (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  sql_text      TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT ''
);

-- db_query_history records SQL editor executions, successes and failures
-- alike. error holds the already-redacted client-facing message (see
-- domain.DBQueryHistoryEntry); a raw driver error must never land here,
-- because it routinely quotes the connection string it failed to dial.
-- Pruned to the newest store.dbHistoryMaxPerConnection rows per connection on
-- every insert.
CREATE TABLE IF NOT EXISTS db_query_history (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
  sql_text      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'success',
  error         TEXT NOT NULL DEFAULT '',
  elapsed_ms    INTEGER NOT NULL DEFAULT 0,
  row_count     INTEGER NOT NULL DEFAULT 0,
  executed_at   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_db_query_history_conn ON db_query_history(connection_id);

CREATE TABLE IF NOT EXISTS settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  active_workspace_id TEXT,
  default_model       TEXT NOT NULL DEFAULT 'claude-sonnet-5',
  -- bcrypt hash of this process's 6-digit runtime sign-in PIN. Empty means
  -- "not set yet"; a runtime seeds a random one on first boot. Only the hash
  -- is ever stored, and it never leaves the process (domain.Settings has no
  -- field for it) — the API only reports whether one is configured.
  signin_pin_hash     TEXT NOT NULL DEFAULT '',
  -- Persistent SOCKS5 forward-proxy publication for THIS machine. Survives
  -- restart: enabled=1 re-binds on boot. See
  -- docs/superpowers/specs/2026-08-06-published-socks5-design.md
  socks_publish_enabled INTEGER NOT NULL DEFAULT 0,
  socks_publish_port    INTEGER NOT NULL DEFAULT 1080,
  socks_publish_key     TEXT NOT NULL DEFAULT '',
  -- Telegram remote-chat bridge for THIS machine. One bot token per process:
  -- Telegram's getUpdates is exclusive per token, so two processes cannot
  -- share one. See docs/superpowers/plans/2026-08-18-telegram-remote-chat.md
  telegram_enabled      INTEGER NOT NULL DEFAULT 0,
  telegram_token        TEXT NOT NULL DEFAULT '',
  telegram_bot_username TEXT NOT NULL DEFAULT '',
  -- BYOK configuration for AI inline completions. See
  -- docs/superpowers/specs/2026-08-14-lsp-grounded-inline-completions-design.md
  completions_provider  TEXT NOT NULL DEFAULT 'anthropic',
  completions_base_url  TEXT NOT NULL DEFAULT '',
  completions_model     TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
  completions_enabled   INTEGER NOT NULL DEFAULT 0,
  completions_api_key   TEXT NOT NULL DEFAULT '',
  -- Persistent agent memory (Hindsight-backed), hub-only — see
  -- domain.MemoryConfig's doc comment for why a runtime has no copy of this.
  memory_enabled        INTEGER NOT NULL DEFAULT 0,
  memory_base_url       TEXT NOT NULL DEFAULT '',
  memory_bank_id        TEXT NOT NULL DEFAULT 'devdeck',
  -- "manual" (operator-supplied BaseURL) or "local" (hub manages a
  -- container on its own machine — see internal/memoryhost).
  memory_hosting        TEXT NOT NULL DEFAULT 'manual',
  memory_local_port     INTEGER NOT NULL DEFAULT 8888,
  -- Persisted intent, not live state: true means "re-start the local
  -- container on next hub boot", mirroring socks_publish_enabled above.
  memory_local_running  INTEGER NOT NULL DEFAULT 0,
  memory_llm_provider   TEXT NOT NULL DEFAULT 'openai',
  memory_llm_model      TEXT NOT NULL DEFAULT '',
  memory_llm_base_url   TEXT NOT NULL DEFAULT '',
  memory_auto_recall    INTEGER NOT NULL DEFAULT 1,
  memory_auto_retain    INTEGER NOT NULL DEFAULT 1,
  memory_recall_budget  TEXT NOT NULL DEFAULT 'mid',
  memory_max_tokens     INTEGER NOT NULL DEFAULT 1536,
  memory_api_key        TEXT NOT NULL DEFAULT '',
  memory_llm_api_key    TEXT NOT NULL DEFAULT ''
);

-- sync_state tracks the runtime replica's last successful catalog apply.
-- A NULL last_synced_at means "never synced", which the UI must render
-- distinctly from "no projects" (a wrong hub key otherwise looks identical
-- to an empty account).
CREATE TABLE IF NOT EXISTS sync_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  totp_secret_enc    TEXT NOT NULL DEFAULT '',
  totp_enabled       INTEGER NOT NULL DEFAULT 0,
  backup_code_hashes TEXT NOT NULL DEFAULT '[]',
  failed_attempts    INTEGER NOT NULL DEFAULT 0,
  lockout_level      INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  last_failed_at     TEXT,
  created_at         TEXT NOT NULL
);

-- id is the SHA-256 hash of the opaque session token, never the raw token,
-- so a DB dump alone can't be replayed as a valid session.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Short-lived (2 min) token issued after password success, before TOTP is
-- verified, and reused for the mandatory post-registration TOTP enrollment.
CREATE TABLE IF NOT EXISTS pending_logins (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_thread (
  id           TEXT PRIMARY KEY,
  worktree_id  TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_event (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  thread_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload    TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_event_thread_seq
  ON agent_event(thread_id, seq);

CREATE TABLE IF NOT EXISTS agent_command_receipt (
  command_id TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- No REFERENCES agent_thread(id), deliberately — matching agent_event.thread_id
-- and agent_command_receipt.thread_id above. Foreign keys are ON, and a hard
-- FK would reject an upload made before the thread's EvtThreadCreated has
-- committed a row, which C2's "upload immediately, on add" makes a real
-- ordering. See store/agentattachment.go.
CREATE TABLE IF NOT EXISTS agent_attachment (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  mime_type   TEXT NOT NULL DEFAULT '',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_agent_attachment_thread ON agent_attachment(thread_id);

-- telegram_users is the pairing allowlist for THIS machine's bot. Enrolment
-- is always /pair — there is no INSERT path that doesn't go through Pairing.
CREATE TABLE IF NOT EXISTS telegram_users (
  user_id  INTEGER PRIMARY KEY,
  label    TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL DEFAULT 0
);

-- telegram_bindings maps one orchestration thread to one Telegram
-- destination (chat + optional forum topic). One row per thread: publishing
-- a thread again just moves where it points, via SetTelegramBinding.
CREATE TABLE IF NOT EXISTS telegram_bindings (
  thread_id TEXT PRIMARY KEY,
  chat_id   INTEGER NOT NULL,
  topic_id  INTEGER NOT NULL DEFAULT 0,
  model     TEXT NOT NULL DEFAULT '',
  last_seq  INTEGER NOT NULL DEFAULT 0,
  -- Which agent the NEXT session in this destination starts on, "" = the
  -- thread's own. Mirrors telegram_project_bindings.agent for a destination
  -- publishing a single thread (an SSH connection, typically) rather than a
  -- project: a thread's agent is fixed at thread.create, so /agents can only
  -- choose for the session /new creates next.
  agent             TEXT NOT NULL DEFAULT '',
  -- The /init confirmation this bridge pinned in the destination chat, 0 when
  -- nothing is pinned. Stored rather than re-derived because unpinning needs
  -- the exact message id: Telegram's unpinChatMessage with no id removes the
  -- MOST RECENT pin in the chat, which may well be something the operator
  -- pinned themselves.
  pinned_message_id INTEGER NOT NULL DEFAULT 0
);

-- telegram_project_bindings publishes a whole PROJECT to one forum-enabled
-- supergroup: every session in the project gets its own topic in that group,
-- created on demand, and each of those is an ordinary row in
-- telegram_bindings. This table only records the group; the per-session rows
-- are what inbound routing actually reads, so a message still resolves to one
-- thread by a pure (chat_id, topic_id) lookup with no "active session" state
-- anywhere.
--
-- No topic_id column, unlike telegram_bindings: a project owns the WHOLE
-- group, not one topic in it.
CREATE TABLE IF NOT EXISTS telegram_project_bindings (
  project_id        TEXT PRIMARY KEY,
  chat_id           INTEGER NOT NULL,
  -- One project = one TOPIC, not one group. Matching on chat alone made a
  -- published project answer in every topic of the group at once, which is
  -- both noisy and impossible to manage; scoping to the destination the
  -- /init was sent from lets one group hold several projects side by side.
  topic_id          INTEGER NOT NULL DEFAULT 0,
  pinned_message_id INTEGER NOT NULL DEFAULT 0,
  -- Which agent new sessions in this destination start on, "" = the default.
  -- Stored on the PROJECT rather than the session because a session's agent
  -- is fixed at thread.create and there is no command to change it
  -- afterwards, so /agents can only ever choose for the NEXT session.
  agent             TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO settings (id, active_workspace_id, default_model)
VALUES (1, NULL, 'claude-sonnet-5');
`

// Open opens the SQLite database at dbPath (creating it if missing), enables
// the required pragmas, and runs the migrations.
func Open(dbPath string) (*sql.DB, error) {
	dsn := "file:" + dbPath + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateInvoiceColumns(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateWorktreeColumns(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateWorktreeIndependence(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateInvoiceItemsColumns(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateProjectColumns(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateMachineColumns(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSSHConnectionColumns(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateProjectOrigin(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateProjectSyncError(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSettingsSignInPIN(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSettingsPublishedSOCKS(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSettingsCompletions(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSettingsMemory(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSettingsTelegram(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateTelegramBindingPin(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateAgentThreadColumns(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// migrateSettingsSignInPIN adds signin_pin_hash (introduced when the runtime
// sign-in page replaced the pasted runtime key with a 6-digit PIN) to
// pre-existing databases. Existing rows default to the empty string, meaning
// no PIN set, which a runtime turns into a freshly generated one on its next
// boot.
func migrateSettingsSignInPIN(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE settings ADD COLUMN signin_pin_hash TEXT NOT NULL DEFAULT ''"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateSettingsPublishedSOCKS adds the published-SOCKS5 columns
// (introduced when the proxy became toggleable from Settings) to
// pre-existing databases.
func migrateSettingsPublishedSOCKS(db *sql.DB) error {
	cols := []string{
		"socks_publish_enabled INTEGER NOT NULL DEFAULT 0",
		"socks_publish_port INTEGER NOT NULL DEFAULT 1080",
		"socks_publish_key TEXT NOT NULL DEFAULT ''",
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

// migrateSettingsCompletions adds the BYOK inline-completions columns
// (introduced with LSP-grounded AI inline completions) to pre-existing
// databases.
func migrateSettingsCompletions(db *sql.DB) error {
	cols := []string{
		"completions_provider TEXT NOT NULL DEFAULT 'anthropic'",
		"completions_base_url TEXT NOT NULL DEFAULT ''",
		"completions_model TEXT NOT NULL DEFAULT 'claude-haiku-4-5'",
		"completions_enabled INTEGER NOT NULL DEFAULT 0",
		"completions_api_key TEXT NOT NULL DEFAULT ''",
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

// migrateSettingsMemory adds the persistent agent-memory columns (introduced
// when DevDeck gained one shared Hindsight-backed memory across every
// provider and every runtime) to pre-existing databases.
func migrateSettingsMemory(db *sql.DB) error {
	cols := []string{
		"memory_enabled INTEGER NOT NULL DEFAULT 0",
		"memory_base_url TEXT NOT NULL DEFAULT ''",
		"memory_bank_id TEXT NOT NULL DEFAULT 'devdeck'",
		"memory_hosting TEXT NOT NULL DEFAULT 'manual'",
		"memory_local_port INTEGER NOT NULL DEFAULT 8888",
		"memory_local_running INTEGER NOT NULL DEFAULT 0",
		"memory_llm_provider TEXT NOT NULL DEFAULT 'openai'",
		"memory_llm_model TEXT NOT NULL DEFAULT ''",
		"memory_llm_base_url TEXT NOT NULL DEFAULT ''",
		"memory_auto_recall INTEGER NOT NULL DEFAULT 1",
		"memory_auto_retain INTEGER NOT NULL DEFAULT 1",
		"memory_recall_budget TEXT NOT NULL DEFAULT 'mid'",
		"memory_max_tokens INTEGER NOT NULL DEFAULT 1536",
		"memory_api_key TEXT NOT NULL DEFAULT ''",
		"memory_llm_api_key TEXT NOT NULL DEFAULT ''",
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

// migrateTelegramBindingPin adds pinned_message_id to pre-existing databases.
// Bindings written before this migration read back as 0 — "nothing pinned" —
// which is exactly right: this bridge did not pin anything for them, so
// unpublishing them must not go looking for a pin to remove.
func migrateTelegramBindingPin(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE telegram_bindings ADD COLUMN pinned_message_id INTEGER NOT NULL DEFAULT 0"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	// telegram_project_bindings is created by the schema above with both
	// columns, so these only matter for a database that ran one of the early
	// builds where the table existed without them.
	for _, col := range []string{
		"agent TEXT NOT NULL DEFAULT ''",
		"topic_id INTEGER NOT NULL DEFAULT 0",
	} {
		if _, err := db.Exec("ALTER TABLE telegram_project_bindings ADD COLUMN " + col); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	if _, err := db.Exec("ALTER TABLE telegram_bindings ADD COLUMN agent TEXT NOT NULL DEFAULT ''"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateAgentThreadColumns adds title, agent_id, model, updated_at, and
// status (introduced when the sessions sidebar needed to render a thread
// without replaying its whole event log) to pre-existing databases.
// updated_at backfills to created_at so rows written before this migration
// still sort sensibly by recency instead of all tying at zero.
func migrateAgentThreadColumns(db *sql.DB) error {
	cols := []string{
		"title TEXT NOT NULL DEFAULT ''",
		"agent_id TEXT NOT NULL DEFAULT ''",
		"model TEXT NOT NULL DEFAULT ''",
		"updated_at INTEGER NOT NULL DEFAULT 0",
		"status TEXT NOT NULL DEFAULT ''",
	}
	for _, col := range cols {
		if _, err := db.Exec("ALTER TABLE agent_thread ADD COLUMN " + col); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	if _, err := db.Exec("UPDATE agent_thread SET updated_at = created_at WHERE updated_at = 0"); err != nil {
		return err
	}
	return nil
}

// migrateInvoiceColumns adds columns introduced after the initial invoices
// table (company, due_date, created_at, bank_*) to any pre-existing local
// database. CREATE TABLE IF NOT EXISTS above only helps fresh databases, so
// this fills the gap for dbs created before these columns existed. Errors
// from a column that's already present are expected and ignored.
func migrateInvoiceColumns(db *sql.DB) error {
	cols := []string{
		"company TEXT NOT NULL DEFAULT ''",
		"due_date TEXT NOT NULL DEFAULT ''",
		"created_at TEXT NOT NULL DEFAULT ''",
		"bank_name TEXT NOT NULL DEFAULT ''",
		"bank_account_name TEXT NOT NULL DEFAULT ''",
		"bank_account_number TEXT NOT NULL DEFAULT ''",
	}
	for _, col := range cols {
		if _, err := db.Exec("ALTER TABLE invoices ADD COLUMN " + col); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	return nil
}

// migrateInvoiceItemsColumns adds columns introduced when invoices moved from
// a flat client/company/amount shape to a company snapshot + items table
// (company_name, company_address, items_json) to any pre-existing local
// database. Errors from a column that's already present are expected and
// ignored.
func migrateInvoiceItemsColumns(db *sql.DB) error {
	cols := []string{
		"company_name TEXT NOT NULL DEFAULT ''",
		"company_address TEXT NOT NULL DEFAULT ''",
		"items_json TEXT NOT NULL DEFAULT '[]'",
	}
	for _, col := range cols {
		if _, err := db.Exec("ALTER TABLE invoices ADD COLUMN " + col); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	return nil
}

// migrateWorktreeColumns adds the "agent" column (introduced after the
// initial worktrees table) to any pre-existing local database. Without this,
// a worktree row from before this column existed would read back with an
// empty Agent, and resolveCommand would silently fall back to a plain shell
// instead of launching the chosen agent CLI.
func migrateWorktreeColumns(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE worktrees ADD COLUMN agent TEXT NOT NULL DEFAULT ''"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateProjectColumns adds machine_id (introduced with the hub/runtime
// split) to pre-existing databases. Existing projects default to ” =
// local/unassigned.
func migrateProjectColumns(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE projects ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateMachineColumns adds is_local (introduced with the Tauri desktop
// shell's self-registered runtime) to pre-existing databases. Existing rows
// default to 0 = not the local desktop machine.
func migrateMachineColumns(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE machines ADD COLUMN is_local INTEGER NOT NULL DEFAULT 0"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateSSHConnectionColumns adds group_name (introduced when the SSH page
// gained host grouping) to pre-existing databases.
func migrateSSHConnectionColumns(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE ssh_connections ADD COLUMN group_name TEXT NOT NULL DEFAULT ''"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateProjectOrigin adds the origin column to pre-existing databases.
// 'hub' means the row came from a catalog snapshot and is replaceable;
// 'local' means it was created on this runtime while the hub was
// unreachable and must survive snapshot overwrites until it is replayed.
func migrateProjectOrigin(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'hub'"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateProjectSyncError adds the sync_error column to pre-existing
// databases. Errors from a column that's already present are expected and
// ignored.
func migrateProjectSyncError(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE projects ADD COLUMN sync_error TEXT"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

// migrateWorktreeIndependence adds worktrees.path (backfilling it from the
// owning project's path where one still exists locally) and rebuilds the
// worktrees table without the project_id foreign key, so a runtime can hold
// worktree rows whose project lives only on the hub. SQLite can't ALTER a
// column's constraints in place, hence the rename-recreate-copy-drop dance.
// Idempotent: skipped if the table's stored SQL no longer references
// projects(id).
func migrateWorktreeIndependence(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE worktrees ADD COLUMN path TEXT NOT NULL DEFAULT ''"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}

	var createSQL string
	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'`).Scan(&createSQL)
	if err != nil {
		return err
	}
	if !strings.Contains(createSQL, "REFERENCES projects") {
		return nil // already migrated
	}

	// Backfill path from the still-locally-joinable project, for any
	// pre-existing worktree row that predates this migration.
	if _, err := db.Exec(`
		UPDATE worktrees SET path = (SELECT path FROM projects WHERE projects.id = worktrees.project_id)
		WHERE path = '' AND EXISTS (SELECT 1 FROM projects WHERE projects.id = worktrees.project_id)
	`); err != nil {
		return err
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	if _, err := tx.Exec(`ALTER TABLE worktrees RENAME TO worktrees_old_fk`); err != nil {
		return err
	}
	if _, err := tx.Exec(`
		CREATE TABLE worktrees (
		  id         TEXT PRIMARY KEY,
		  project_id TEXT NOT NULL,
		  root       INTEGER NOT NULL DEFAULT 0,
		  branch     TEXT NOT NULL DEFAULT '',
		  base       TEXT NOT NULL DEFAULT 'main',
		  ahead      INTEGER NOT NULL DEFAULT 0,
		  behind     INTEGER NOT NULL DEFAULT 0,
		  model      TEXT NOT NULL DEFAULT '',
		  agent      TEXT NOT NULL DEFAULT '',
		  state      TEXT NOT NULL DEFAULT 'running',
		  task       TEXT NOT NULL DEFAULT '',
		  tokens     INTEGER NOT NULL DEFAULT 0,
		  elapsed    INTEGER NOT NULL DEFAULT 0,
		  added      INTEGER NOT NULL DEFAULT 0,
		  removed    INTEGER NOT NULL DEFAULT 0,
		  files      INTEGER NOT NULL DEFAULT 0,
		  lines      TEXT NOT NULL DEFAULT '[]',
		  pending    TEXT,
		  path       TEXT NOT NULL DEFAULT ''
		)
	`); err != nil {
		return err
	}
	if _, err := tx.Exec(`
		INSERT INTO worktrees (id, project_id, root, branch, base, ahead, behind, model, agent,
		                        state, task, tokens, elapsed, added, removed, files, lines, pending, path)
		SELECT id, project_id, root, branch, base, ahead, behind, model, agent,
		       state, task, tokens, elapsed, added, removed, files, lines, pending, path
		FROM worktrees_old_fk
	`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP TABLE worktrees_old_fk`); err != nil {
		return err
	}
	if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id)`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	_, err = db.Exec(`PRAGMA foreign_keys = ON`)
	return err
}
