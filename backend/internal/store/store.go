package store

import "database/sql"

// Store implements port.Store backed by SQLite.
type Store struct {
	db *sql.DB
}

// New creates a Store backed by the given database connection.
func New(db *sql.DB) *Store { return &Store{db: db} }
