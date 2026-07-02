package store

import (
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func (s *Store) todosOf(wsID string) ([]domain.Todo, error) {
	rows, err := s.db.Query(`SELECT id, text, done, priority FROM todos WHERE workspace_id = ? ORDER BY rowid DESC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Todo{}
	for rows.Next() {
		var t domain.Todo
		if err := rows.Scan(&t.ID, &t.Text, &t.Done, &t.Priority); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) todoByID(id string) (domain.Todo, error) {
	var t domain.Todo
	err := s.db.QueryRow(`SELECT id, text, done, priority FROM todos WHERE id = ?`, id).
		Scan(&t.ID, &t.Text, &t.Done, &t.Priority)
	if err != nil {
		return domain.Todo{}, mapNotFound(err)
	}
	return t, err
}

func (s *Store) CreateTodo(wsID, text, priority string) (domain.Todo, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.Todo{}, err
	}
	if !ok {
		return domain.Todo{}, ErrNotFound
	}
	if priority == "" {
		priority = "normal"
	}
	id := idGen("t-")
	if _, err := s.db.Exec(`INSERT INTO todos (id, workspace_id, text, done, priority) VALUES (?, ?, ?, 0, ?)`,
		id, wsID, text, priority); err != nil {
		return domain.Todo{}, err
	}
	return s.todoByID(id)
}

func (s *Store) UpdateTodo(id string, p port.TodoPatch) (domain.Todo, error) {
	if _, err := s.todoByID(id); err != nil {
		return domain.Todo{}, err
	}
	if err := firstErr(
		setStr(s.db, "todos", "text", id, p.Text),
		setStr(s.db, "todos", "priority", id, p.Priority),
	); err != nil {
		return domain.Todo{}, err
	}
	if p.Done != nil {
		if _, err := s.db.Exec(`UPDATE todos SET done = ? WHERE id = ?`, boolInt(*p.Done), id); err != nil {
			return domain.Todo{}, err
		}
	}
	return s.todoByID(id)
}

func (s *Store) DeleteTodo(id string) error {
	res, err := s.db.Exec(`DELETE FROM todos WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ClearDoneTodos(wsID string) (int64, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, ErrNotFound
	}
	res, err := s.db.Exec(`DELETE FROM todos WHERE workspace_id = ? AND done = 1`, wsID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}
