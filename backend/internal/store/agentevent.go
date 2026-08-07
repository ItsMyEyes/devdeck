package store

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"devdeck/backend/internal/agentcore/orchestration"
)

// CommitAgentEvents appends events, assigns each a global Seq, and writes the
// command receipt — all in ONE transaction. Splitting these apart would let a
// crash leave the read model permanently disagreeing with the event log, with
// no way to detect it afterwards.
func (s *Store) CommitAgentEvents(commandID string, evts []orchestration.Event) ([]orchestration.Event, error) {
	if len(evts) == 0 {
		return nil, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	out := make([]orchestration.Event, len(evts))
	for i, e := range evts {
		payload := string(e.Payload)
		if payload == "" {
			payload = "null"
		}
		res, err := tx.Exec(
			`INSERT INTO agent_event (event_id, thread_id, type, command_id, created_at, payload)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			e.EventID, e.ThreadID, string(e.Type), commandID, e.CreatedAt, payload,
		)
		if err != nil {
			return nil, fmt.Errorf("append agent event %s: %w", e.EventID, err)
		}
		seq, err := res.LastInsertId()
		if err != nil {
			return nil, err
		}
		e.Seq = uint64(seq)
		e.CommandID = commandID
		out[i] = e
	}

	if _, err := tx.Exec(
		`INSERT INTO agent_command_receipt (command_id, thread_id, created_at) VALUES (?, ?, ?)`,
		commandID, evts[0].ThreadID, evts[0].CreatedAt,
	); err != nil {
		return nil, fmt.Errorf("write receipt %s: %w", commandID, err)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// SeenAgentCommand reports whether this command was already processed and, if
// so, returns the events it produced. Checked before Decide so a client that
// reconnects and resends gets the original events instead of a second turn.
func (s *Store) SeenAgentCommand(commandID string) ([]orchestration.Event, bool, error) {
	var exists int
	err := s.db.QueryRow(
		`SELECT 1 FROM agent_command_receipt WHERE command_id = ?`, commandID,
	).Scan(&exists)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}

	rows, err := s.db.Query(
		`SELECT seq, event_id, thread_id, type, command_id, created_at, payload
		 FROM agent_event WHERE command_id = ? ORDER BY seq`, commandID,
	)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	evts, err := scanAgentEvents(rows)
	if err != nil {
		return nil, false, err
	}
	return evts, true, nil
}

// AgentEventsSince returns a thread's events after seq, in order. This is what
// makes reattach exact rather than best-effort: a client reports the last Seq
// it saw and receives precisely what it missed.
func (s *Store) AgentEventsSince(threadID string, seq uint64) ([]orchestration.Event, error) {
	rows, err := s.db.Query(
		`SELECT seq, event_id, thread_id, type, command_id, created_at, payload
		 FROM agent_event WHERE thread_id = ? AND seq > ? ORDER BY seq`,
		threadID, seq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAgentEvents(rows)
}

// AgentThreadIDs lists the threads belonging to a worktree.
func (s *Store) AgentThreadIDs(worktreeID string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT id FROM agent_thread WHERE worktree_id = ? ORDER BY created_at`, worktreeID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func scanAgentEvents(rows *sql.Rows) ([]orchestration.Event, error) {
	var out []orchestration.Event
	for rows.Next() {
		var (
			e       orchestration.Event
			typ     string
			payload sql.NullString
		)
		if err := rows.Scan(&e.Seq, &e.EventID, &e.ThreadID, &typ, &e.CommandID, &e.CreatedAt, &payload); err != nil {
			return nil, err
		}
		e.Type = orchestration.EventType(typ)
		if payload.Valid && payload.String != "null" {
			e.Payload = json.RawMessage(payload.String)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
