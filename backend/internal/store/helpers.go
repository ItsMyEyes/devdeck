package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"

	"loom/backend/internal/domain"
)

// mapNotFound converts sql.ErrNoRows to ErrNotFound.
func mapNotFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// ErrNotFound is returned when a requested row does not exist (maps to 404).
var ErrNotFound = errors.New("not found")

const maxLines = 240

// idGen generates a type-prefixed id with 8 hex characters from crypto/rand,
// e.g. "w-1a2b3c4d".
func idGen(prefix string) string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return prefix + "00000000"
	}
	return prefix + hex.EncodeToString(b)
}

// scanner is satisfied by both *sql.Row and *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanWorktree(sc scanner) (domain.Worktree, error) {
	var w domain.Worktree
	var linesJSON string
	var pending sql.NullString
	err := sc.Scan(&w.ID, &w.ProjectID, &w.Root, &w.Branch, &w.Base, &w.Ahead, &w.Behind, &w.Model, &w.Agent,
		&w.State, &w.Task, &w.Tokens, &w.Elapsed, &w.Added, &w.Removed, &w.Files,
		&linesJSON, &pending)
	if err != nil {
		return w, err
	}
	if linesJSON == "" {
		w.Lines = []domain.TermLine{}
	} else if err := json.Unmarshal([]byte(linesJSON), &w.Lines); err != nil {
		return w, err
	}
	if w.Lines == nil {
		w.Lines = []domain.TermLine{}
	}
	if pending.Valid {
		p := pending.String
		w.Pending = &p
	}
	return w, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// firstErr returns the first non-nil error from its arguments.
func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// setStr applies an optional scalar string update to a column.
func setStr(db *sql.DB, table, col, id string, v *string) error {
	if v == nil {
		return nil
	}
	_, err := db.Exec("UPDATE "+table+" SET "+col+" = ? WHERE id = ?", *v, id)
	return err
}

// setInt applies an optional scalar int update to a column.
func setInt(db *sql.DB, table, col, id string, v *int) error {
	if v == nil {
		return nil
	}
	_, err := db.Exec("UPDATE "+table+" SET "+col+" = ? WHERE id = ?", *v, id)
	return err
}

// setBool applies an optional scalar bool update to a column.
func setBool(db *sql.DB, table, col, id string, v *bool) error {
	if v == nil {
		return nil
	}
	_, err := db.Exec("UPDATE "+table+" SET "+col+" = ? WHERE id = ?", boolInt(*v), id)
	return err
}

// setJSONStrSlice applies an optional JSON-encoded []string update to a column.
func setJSONStrSlice(db *sql.DB, table, col, id string, v *[]string) error {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(*v)
	if err != nil {
		return err
	}
	_, err = db.Exec("UPDATE "+table+" SET "+col+" = ? WHERE id = ?", string(b), id)
	return err
}
