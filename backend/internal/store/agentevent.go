package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
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
	// touched tracks, per thread, the latest CreatedAt seen in this batch —
	// used below to bump agent_thread.updated_at once per thread rather than
	// once per event.
	touched := make(map[string]int64, len(evts))
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

		if e.CreatedAt > touched[e.ThreadID] {
			touched[e.ThreadID] = e.CreatedAt
		}

		// A projection into a read table, in the same transaction as the
		// append (spec 1's atomicity contract): the sessions sidebar can
		// list a thread without replaying its whole event log. INSERT OR
		// IGNORE makes this idempotent — a reconnect that resends the same
		// derived CommandID must not fail on a duplicate row.
		if e.Type == orchestration.EvtThreadCreated {
			instanceID := threadCreatedInstanceID(e.Payload)
			if _, err := tx.Exec(
				`INSERT OR IGNORE INTO agent_thread
					(id, worktree_id, instance_id, title, agent_id, model, status, created_at, updated_at)
				 VALUES (?, ?, ?, '', ?, '', ?, ?, ?)`,
				e.ThreadID, worktreeIDFromThreadID(e.ThreadID), instanceID,
				agentIDFromInstanceID(instanceID), string(orchestration.ThreadIdle),
				e.CreatedAt, e.CreatedAt,
			); err != nil {
				return nil, fmt.Errorf("insert agent thread %s: %w", e.ThreadID, err)
			}
		}

		// The thread's name, projected from the LATEST thing the user actually
		// said. `EvtThreadCreated` has nothing to name a thread WITH — it
		// carries only an instance id, and it is committed on the WebSocket's
		// hello, before any message exists — so every row was inserted with
		// title '' and stayed that way, which is why the sidebar read
		// "Untitled session" forever.
		//
		// ── Latest, not first ──
		// This used to carry `AND title = ''`, which pinned the name to the
		// opening message for the thread's whole life. That reads well in the
		// cases people design for and badly in the ones that actually happen: a
		// session opened with "coba kasih pertanyaan lagi" or "hi" wore that
		// name permanently, however far the conversation later travelled, and
		// the sidebar became a list of throat-clearing. Retitling on every turn
		// costs one indexed UPDATE per message and keeps the row describing
		// what the thread is about NOW.
		//
		// ── Why this hangs off turn-start and not message-sent ──
		// `EvtThreadMessageSent` is emitted from TWO places in `Decide`:
		// `CmdThreadTurnStart` (the user's message) and
		// `CmdThreadAssistantComplete` (the agent's). Nothing dispatches the
		// second one today, so keying off it happens to work — but it is a live
		// branch, and the moment anything does, `summarizeThreadTitle` would
		// start naming threads after the AGENT's last reply. Under the old
		// `title = ''` guard that was almost harmless (only the first event
		// ever won); retitling every turn makes it a real hazard.
		// `EvtThreadTurnStartRequested` has exactly one emitter, always
		// alongside the same `TurnStartPayload`, so it cannot pick up agent
		// text no matter what is wired up later.
		if e.Type == orchestration.EvtThreadTurnStartRequested {
			if title := summarizeThreadTitle(e.Payload); title != "" {
				if _, err := tx.Exec(
					`UPDATE agent_thread SET title = ? WHERE id = ?`,
					title, e.ThreadID,
				); err != nil {
					return nil, fmt.Errorf("title agent thread %s: %w", e.ThreadID, err)
				}
			}
		}
	}

	for threadID, ts := range touched {
		if _, err := tx.Exec(
			`UPDATE agent_thread SET updated_at = ? WHERE id = ?`, ts, threadID,
		); err != nil {
			return nil, fmt.Errorf("touch agent thread %s: %w", threadID, err)
		}
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

// threadCreatedInstanceID extracts instanceId from an EvtThreadCreated
// payload. Best-effort: an unparseable payload yields "" rather than failing
// the commit — the event itself is still durable and correct either way,
// this only feeds the read-model projection.
func threadCreatedInstanceID(payload json.RawMessage) string {
	var p struct {
		InstanceID string `json:"instanceId"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.InstanceID
}

// worktreeIDFromThreadID mirrors handler.AgentWSHandler.resolveInstanceID and
// main.go's Reactor.InstanceFor: a threadID is either a bare worktree id or
// "<worktreeId>::chat-N" for extra split chat panes, both naming the same
// worktree.
func worktreeIDFromThreadID(threadID string) string {
	if i := strings.Index(threadID, "::"); i >= 0 {
		return threadID[:i]
	}
	return threadID
}

// agentIDFromInstanceID recovers the agent id from an InstanceID of the form
// "<agent>:default" (see provider.InstanceID / Reactor.InstanceFor). Best
// effort, same reasoning as threadCreatedInstanceID.
func agentIDFromInstanceID(instanceID string) string {
	agentID, _, _ := strings.Cut(instanceID, ":")
	return agentID
}

// threadTitleMaxRunes bounds a projected title. Runes, not bytes: the sidebar
// truncates on width and a byte cap would split a multi-byte character.
const threadTitleMaxRunes = 60

// summarizeThreadTitle derives a thread's name from the user's first message.
// Best-effort in the same sense as threadCreatedInstanceID: an unparseable or
// empty payload yields "", the UPDATE is skipped, and the row keeps its blank
// title rather than failing a commit over a cosmetic projection.
//
// The summary is the message's first non-blank line with its inner whitespace
// collapsed — a pasted stack trace or a Shift+Enter multi-line prompt has to
// become one short label, not a wall of text in a 240px sidebar.
func summarizeThreadTitle(payload json.RawMessage) string {
	var p struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return ""
	}
	for _, line := range strings.Split(p.Text, "\n") {
		if title := strings.Join(strings.Fields(line), " "); title != "" {
			r := []rune(title)
			if len(r) > threadTitleMaxRunes {
				return strings.TrimRight(string(r[:threadTitleMaxRunes]), " ") + "…"
			}
			return title
		}
	}
	return ""
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

// AllAgentEvents returns every thread's events, in global Seq order — the
// input to rebuilding the engine's in-memory read model at startup.
//
// This exists because the engine's State is derived, not stored: without
// replaying the log into it on boot, a restarted process serves a thread whose
// events are all still on disk but which the decider has never heard of, and
// every command against it fails "thread X does not exist" — permanently, since
// the auto-create command's receipt is durable and absorbs the retry.
//
// One query, no pagination, deliberately: Apply must see the log from the
// beginning or the state it produces is not the state the log describes. If
// this ever grows past comfort the fix is log compaction (a snapshot event to
// replay from), not a LIMIT here.
func (s *Store) AllAgentEvents() ([]orchestration.Event, error) {
	rows, err := s.db.Query(
		`SELECT seq, event_id, thread_id, type, command_id, created_at, payload
		 FROM agent_event ORDER BY seq`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAgentEvents(rows)
}

// DeleteAgentThread erases a thread: its sidebar row, its event log, the
// command receipts that log was written under, and any attachments uploaded
// against it — one transaction, all four.
//
// A tombstone would be the event-sourced reflex, and it is the wrong call
// here. Thread ids are addresses, not surrogates: the primary chat pane IS the
// bare worktree id (see paneTree.ts's createAgentChatPane), so a soft delete
// would leave that id permanently poisoned — the decider rejects a deleted
// thread, and the pane for it can never work again. Deleting the receipts
// matters for the same reason: leave them and the auto-create command for that
// id is "already seen" forever, so the thread can never be recreated.
//
// Deleting a session is a user asking to erase a conversation. Erasing it is
// the honest implementation, and it leaves the id reusable.
func (s *Store) DeleteAgentThread(threadID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM agent_command_receipt WHERE thread_id = ?`, threadID); err != nil {
		return fmt.Errorf("delete agent receipts %s: %w", threadID, err)
	}
	if _, err := tx.Exec(`DELETE FROM agent_event WHERE thread_id = ?`, threadID); err != nil {
		return fmt.Errorf("delete agent events %s: %w", threadID, err)
	}
	if _, err := tx.Exec(`DELETE FROM agent_attachment WHERE thread_id = ?`, threadID); err != nil {
		return fmt.Errorf("delete agent attachments %s: %w", threadID, err)
	}
	if _, err := tx.Exec(`DELETE FROM agent_thread WHERE id = ?`, threadID); err != nil {
		return fmt.Errorf("delete agent thread %s: %w", threadID, err)
	}
	return tx.Commit()
}

// AgentThreads lists a worktree's chat threads for the sessions sidebar,
// newest-touched first. A thread with no events beyond its own creation still
// appears — the row is written on EvtThreadCreated, not on first message.
func (s *Store) AgentThreads(worktreeID string) ([]domain.AgentThread, error) {
	rows, err := s.db.Query(
		`SELECT id, worktree_id, instance_id, title, agent_id, model, status, created_at, updated_at
		 FROM agent_thread WHERE worktree_id = ? ORDER BY updated_at DESC`, worktreeID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.AgentThread
	for rows.Next() {
		var t domain.AgentThread
		if err := rows.Scan(
			&t.ID, &t.WorktreeID, &t.InstanceID, &t.Title, &t.AgentID, &t.Model,
			&t.Status, &t.CreatedAt, &t.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, t)
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
