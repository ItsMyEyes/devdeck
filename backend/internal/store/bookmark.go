package store

import (
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

func scanBookmark(sc scanner) (domain.Bookmark, error) {
	var b domain.Bookmark
	err := sc.Scan(&b.ID, &b.MachineID, &b.Group, &b.Title, &b.URL, &b.IconDataURL)
	return b, err
}

// Bookmarks returns all saved Browser-tile bookmarks, most recently created first.
func (s *Store) Bookmarks() ([]domain.Bookmark, error) {
	rows, err := s.db.Query(`SELECT id, machine_id, group_name, title, url, icon_data_url FROM bookmarks ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Bookmark{}
	for rows.Next() {
		b, err := scanBookmark(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// BookmarkByID returns a single bookmark.
func (s *Store) BookmarkByID(id string) (domain.Bookmark, error) {
	b, err := scanBookmark(s.db.QueryRow(`SELECT id, machine_id, group_name, title, url, icon_data_url FROM bookmarks WHERE id = ?`, id))
	if err != nil {
		return domain.Bookmark{}, mapNotFound(err)
	}
	return b, nil
}

// CreateBookmark saves a new bookmark, or updates the existing one if this
// machine already has a bookmark for this exact url — starring a page twice
// from the same machine is a re-save, not a duplicate (enforced by the
// idx_bookmarks_machine_url unique index).
func (s *Store) CreateBookmark(machineID, group, title, url, iconDataURL string) (domain.Bookmark, error) {
	if group == "" {
		group = domain.DefaultBookmarkGroup
	}
	if existing, err := scanBookmark(s.db.QueryRow(
		`SELECT id, machine_id, group_name, title, url, icon_data_url FROM bookmarks WHERE machine_id = ? AND url = ?`,
		machineID, url,
	)); err == nil {
		if _, err := s.db.Exec(
			`UPDATE bookmarks SET group_name = ?, title = ?, icon_data_url = ? WHERE id = ?`,
			group, title, iconDataURL, existing.ID,
		); err != nil {
			return domain.Bookmark{}, err
		}
		return s.BookmarkByID(existing.ID)
	}

	id := idGen("bm-")
	if _, err := s.db.Exec(
		`INSERT INTO bookmarks (id, machine_id, group_name, title, url, icon_data_url) VALUES (?, ?, ?, ?, ?, ?)`,
		id, machineID, group, title, url, iconDataURL,
	); err != nil {
		return domain.Bookmark{}, err
	}
	return s.BookmarkByID(id)
}

// UpdateBookmark applies a partial update to a saved bookmark.
func (s *Store) UpdateBookmark(id string, p port.BookmarkPatch) (domain.Bookmark, error) {
	if _, err := s.BookmarkByID(id); err != nil {
		return domain.Bookmark{}, err
	}
	if err := firstErr(
		setStr(s.db, "bookmarks", "group_name", id, p.Group),
		setStr(s.db, "bookmarks", "title", id, p.Title),
		setStr(s.db, "bookmarks", "icon_data_url", id, p.IconDataURL),
	); err != nil {
		return domain.Bookmark{}, err
	}
	return s.BookmarkByID(id)
}

// DeleteBookmark deletes a saved bookmark.
func (s *Store) DeleteBookmark(id string) error {
	res, err := s.db.Exec(`DELETE FROM bookmarks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
