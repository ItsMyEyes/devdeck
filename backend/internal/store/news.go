package store

import (
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

func (s *Store) newsOf(wsID string) ([]domain.NewsItem, error) {
	rows, err := s.db.Query(`SELECT id, source, title, tag, time, unread FROM news WHERE workspace_id = ? ORDER BY rowid ASC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.NewsItem{}
	for rows.Next() {
		var n domain.NewsItem
		if err := rows.Scan(&n.ID, &n.Source, &n.Title, &n.Tag, &n.Time, &n.Unread); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Store) newsByID(id string) (domain.NewsItem, error) {
	var n domain.NewsItem
	err := s.db.QueryRow(`SELECT id, source, title, tag, time, unread FROM news WHERE id = ?`, id).
		Scan(&n.ID, &n.Source, &n.Title, &n.Tag, &n.Time, &n.Unread)
	if err != nil {
		return domain.NewsItem{}, mapNotFound(err)
	}
	return n, err
}

func (s *Store) CreateNews(wsID, source, title, tag, time string, unread bool) (domain.NewsItem, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.NewsItem{}, err
	}
	if !ok {
		return domain.NewsItem{}, ErrNotFound
	}
	id := idGen("n-")
	if _, err := s.db.Exec(`INSERT INTO news (id, workspace_id, source, title, tag, time, unread) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, wsID, source, title, tag, time, boolInt(unread)); err != nil {
		return domain.NewsItem{}, err
	}
	return s.newsByID(id)
}

func (s *Store) UpdateNews(id string, p port.NewsPatch) (domain.NewsItem, error) {
	if _, err := s.newsByID(id); err != nil {
		return domain.NewsItem{}, err
	}
	if p.Unread != nil {
		if _, err := s.db.Exec(`UPDATE news SET unread = ? WHERE id = ?`, boolInt(*p.Unread), id); err != nil {
			return domain.NewsItem{}, err
		}
	}
	return s.newsByID(id)
}

func (s *Store) MarkAllNewsRead(wsID string) (int64, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, ErrNotFound
	}
	res, err := s.db.Exec(`UPDATE news SET unread = 0 WHERE workspace_id = ? AND unread = 1`, wsID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (s *Store) DeleteNews(id string) error {
	res, err := s.db.Exec(`DELETE FROM news WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
