package store

import (
	"database/sql"
	"encoding/json"
	"strings"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

// ── Child queries ──────────────────────────────────────────────────────────

func (s *Store) worktreesOf(projectID string) ([]domain.Worktree, error) {
	rows, err := s.db.Query(`
		SELECT id, project_id, root, branch, base, ahead, behind, model, agent, state, task,
		       tokens, elapsed, added, removed, files, lines, pending
		FROM worktrees WHERE project_id = ? ORDER BY rowid ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Worktree{}
	for rows.Next() {
		w, err := scanWorktree(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) WorktreeByID(id string) (domain.Worktree, error) {
	row := s.db.QueryRow(`
		SELECT id, project_id, root, branch, base, ahead, behind, model, agent, state, task,
		       tokens, elapsed, added, removed, files, lines, pending
		FROM worktrees WHERE id = ?`, id)
	w, err := scanWorktree(row)
	if err == sql.ErrNoRows {
		return w, ErrNotFound
	}
	return w, err
}

// ── Helpers ────────────────────────────────────────────────────────────────

func (s *Store) insertWorktree(w domain.Worktree, projectID string) (domain.Worktree, error) {
	linesJSON, err := json.Marshal(w.Lines)
	if err != nil {
		return domain.Worktree{}, err
	}
	_, err = s.db.Exec(`
		INSERT INTO worktrees
			(id, project_id, root, branch, base, ahead, behind, model, agent, state, task,
			 tokens, elapsed, added, removed, files, lines, pending)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		w.ID, projectID, boolInt(w.Root), w.Branch, w.Base, w.Ahead, w.Behind, w.Model, w.Agent,
		w.State, w.Task, w.Tokens, w.Elapsed, w.Added, w.Removed, w.Files, string(linesJSON), w.Pending)
	if err != nil {
		return domain.Worktree{}, err
	}
	return s.WorktreeByID(w.ID)
}

// ── CRUD ───────────────────────────────────────────────────────────────────

// CreateWorktree creates a worktree entry. mode must be "branch" or "root".
func (s *Store) CreateWorktree(projectID, mode, branch, base, model, agent, task string) (domain.Worktree, error) {
	p, err := s.ProjectByID(projectID)
	if err != nil {
		return domain.Worktree{}, err
	}
	id := idGen("w-")
	task = strings.TrimSpace(task)
	w := domain.Worktree{
		ID: id, Model: model, Agent: agent, State: "running", Task: task, Base: "main",
	}
	if mode == "root" {
		w.Root = true
		w.Branch = ""
		w.Base = "main"
		w.Lines = []domain.TermLine{
			{K: "cmd", T: "$ cd " + p.Path},
			{K: "ok", T: "✓ terminal attached · " + p.Path + " (no worktree)"},
			{K: "sys", T: "✓ shell ready"},
		}
	} else {
		b := strings.TrimSpace(branch)
		if b == "" {
			b = "feat/agent-" + id
		}
		ba := strings.TrimSpace(base)
		if ba == "" {
			ba = "main"
		}
		w.Branch = b
		w.Base = ba
		w.Lines = []domain.TermLine{
			{K: "cmd", T: "$ git worktree add -b " + b + " " + p.Path + "/.wt/" + id + " " + ba},
			{K: "ok", T: "✓ worktree created on " + b},
			{K: "sys", T: "● starting agent…"},
			{K: "out", T: "reading task context…"},
		}
	}
	created, err := s.insertWorktree(w, projectID)
	if err != nil {
		return domain.Worktree{}, err
	}
	if _, err := s.db.Exec(`UPDATE projects SET expanded = 1 WHERE id = ?`, projectID); err != nil {
		return domain.Worktree{}, err
	}
	return created, nil
}

// UpdateWorktree patches a worktree's fields.
func (s *Store) UpdateWorktree(id string, p port.WorktreePatch) (domain.Worktree, error) {
	w, err := s.WorktreeByID(id)
	if err != nil {
		return domain.Worktree{}, err
	}
	if err := firstErr(
		setStr(s.db, "worktrees", "branch", id, p.Branch),
		setStr(s.db, "worktrees", "base", id, p.Base),
		setStr(s.db, "worktrees", "model", id, p.Model),
		setStr(s.db, "worktrees", "task", id, p.Task),
		setStr(s.db, "worktrees", "state", id, p.State),
		setInt(s.db, "worktrees", "ahead", id, p.Ahead),
		setInt(s.db, "worktrees", "behind", id, p.Behind),
		setInt(s.db, "worktrees", "tokens", id, p.Tokens),
		setInt(s.db, "worktrees", "elapsed", id, p.Elapsed),
		setInt(s.db, "worktrees", "added", id, p.Added),
		setInt(s.db, "worktrees", "removed", id, p.Removed),
		setInt(s.db, "worktrees", "files", id, p.Files),
	); err != nil {
		return domain.Worktree{}, err
	}
	if p.HasPending {
		if _, err := s.db.Exec(`UPDATE worktrees SET pending = ? WHERE id = ?`, p.Pending, id); err != nil {
			return domain.Worktree{}, err
		}
	}
	if p.AppendLine != nil {
		lines := append(w.Lines, *p.AppendLine)
		if len(lines) > maxLines {
			lines = lines[len(lines)-maxLines:]
		}
		linesJSON, err := json.Marshal(lines)
		if err != nil {
			return domain.Worktree{}, err
		}
		if _, err := s.db.Exec(`UPDATE worktrees SET lines = ? WHERE id = ?`, string(linesJSON), id); err != nil {
			return domain.Worktree{}, err
		}
	}
	return s.WorktreeByID(id)
}

// DeleteWorktree deletes a worktree.
func (s *Store) DeleteWorktree(id string) error {
	res, err := s.db.Exec(`DELETE FROM worktrees WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
