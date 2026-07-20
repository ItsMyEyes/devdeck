package dbdriver

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"devdeck/backend/internal/port"

	_ "modernc.org/sqlite"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)"); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.Exec("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b')"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return db
}

func TestExecTxOnDBCommitsAllStatements(t *testing.T) {
	db := openTestDB(t)
	one := int64(1)
	_, err := ExecTxOnDB(context.Background(), db, []port.Statement{
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"aa", 1}, ExpectRowsAffected: &one},
		{SQL: "DELETE FROM t WHERE id = ?", Args: []any{2}, ExpectRowsAffected: &one},
	})
	if err != nil {
		t.Fatalf("ExecTxOnDB: %v", err)
	}
	var name string
	if err := db.QueryRow("SELECT name FROM t WHERE id = 1").Scan(&name); err != nil || name != "aa" {
		t.Fatalf("update did not commit: name=%q err=%v", name, err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM t").Scan(&count); err != nil || count != 1 {
		t.Fatalf("delete did not commit: count=%d err=%v", count, err)
	}
}

func TestExecTxOnDBRollsBackOnRowsAffectedMismatch(t *testing.T) {
	db := openTestDB(t)
	one := int64(1)
	_, err := ExecTxOnDB(context.Background(), db, []port.Statement{
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"aa", 1}, ExpectRowsAffected: &one},
		// id 999 matches nothing: 0 rows affected, expected 1.
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"zz", 999}, ExpectRowsAffected: &one},
	})
	if !errors.Is(err, port.ErrRowsAffectedMismatch) {
		t.Fatalf("err = %v, want ErrRowsAffectedMismatch", err)
	}
	var name string
	if err := db.QueryRow("SELECT name FROM t WHERE id = 1").Scan(&name); err != nil || name != "a" {
		t.Fatalf("first statement was not rolled back: name=%q err=%v", name, err)
	}
}

func TestExecTxOnDBRollsBackOnStatementError(t *testing.T) {
	db := openTestDB(t)
	_, err := ExecTxOnDB(context.Background(), db, []port.Statement{
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"aa", 1}},
		{SQL: "INSERT INTO no_such_table (id) VALUES (1)"},
	})
	if err == nil {
		t.Fatal("expected an error from the invalid statement")
	}
	var name string
	if err := db.QueryRow("SELECT name FROM t WHERE id = 1").Scan(&name); err != nil || name != "a" {
		t.Fatalf("first statement was not rolled back: name=%q err=%v", name, err)
	}
}
