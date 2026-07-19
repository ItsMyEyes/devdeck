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
  machine_id   TEXT NOT NULL DEFAULT ''
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

CREATE TABLE IF NOT EXISTS settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  active_workspace_id TEXT,
  default_model       TEXT NOT NULL DEFAULT 'claude-sonnet-5'
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
	return db, nil
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
