package dbdriver

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"devdeck/backend/internal/port"
)

// ExecTxOnDB runs every statement in stmts inside one transaction, in order,
// and rolls back the whole batch on the first failure — including an
// ExpectRowsAffected mismatch, which is not a driver error but a stale-read
// conflict: another session changed or removed the row between when the grid
// loaded it and when this commit ran.
//
// Shared by every SQL driver's RowWriter.CommitEdits (Task 4) and
// DDLWriter.Apply (Task 9), so the rollback-on-mismatch guarantee is
// implemented once rather than once per engine.
func ExecTxOnDB(ctx context.Context, db *sql.DB, stmts []port.Statement) (port.CommitResult, error) {
	start := time.Now()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return port.CommitResult{}, err
	}

	results := make([]port.ExecResult, 0, len(stmts))
	for _, s := range stmts {
		stmtStart := time.Now()
		res, err := tx.ExecContext(ctx, s.SQL, s.Args...)
		if err != nil {
			_ = tx.Rollback()
			return port.CommitResult{}, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			// Some statements report no affected-row count; that alone is not
			// a failure, it just means ExpectRowsAffected cannot be checked.
			n = 0
		}
		if s.ExpectRowsAffected != nil && n != *s.ExpectRowsAffected {
			_ = tx.Rollback()
			return port.CommitResult{}, fmt.Errorf(
				"statement affected %d rows, expected %d: %w", n, *s.ExpectRowsAffected, port.ErrRowsAffectedMismatch)
		}
		results = append(results, port.ExecResult{RowsAffected: n, ElapsedMS: time.Since(stmtStart).Milliseconds()})
	}

	if err := tx.Commit(); err != nil {
		return port.CommitResult{}, err
	}
	return port.CommitResult{Results: results, ElapsedMS: time.Since(start).Milliseconds()}, nil
}
