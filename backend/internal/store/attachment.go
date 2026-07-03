package store

import "loom/backend/internal/domain"

// CreateAttachment stores a file uploaded to an issue's description editor.
func (s *Store) CreateAttachment(issueID, filename, mimeType string, data []byte, createdAt string) (domain.Attachment, error) {
	if _, err := s.issueByID(issueID); err != nil {
		return domain.Attachment{}, err
	}
	id := idGen("att-")
	if _, err := s.db.Exec(
		`INSERT INTO issue_attachments (id, issue_id, filename, mime_type, size, data, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, issueID, filename, mimeType, len(data), data, createdAt,
	); err != nil {
		return domain.Attachment{}, err
	}
	return s.attachmentMetaByID(id)
}

// ListAttachments returns every attachment uploaded to an issue, newest first.
func (s *Store) ListAttachments(issueID string) ([]domain.Attachment, error) {
	if _, err := s.issueByID(issueID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(
		`SELECT id, issue_id, filename, mime_type, size, created_at FROM issue_attachments
		 WHERE issue_id = ? ORDER BY created_at DESC`, issueID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Attachment{}
	for rows.Next() {
		var a domain.Attachment
		if err := rows.Scan(&a.ID, &a.IssueID, &a.Filename, &a.MimeType, &a.Size, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) attachmentMetaByID(id string) (domain.Attachment, error) {
	var a domain.Attachment
	err := s.db.QueryRow(
		`SELECT id, issue_id, filename, mime_type, size, created_at FROM issue_attachments WHERE id = ?`, id,
	).Scan(&a.ID, &a.IssueID, &a.Filename, &a.MimeType, &a.Size, &a.CreatedAt)
	if err != nil {
		return domain.Attachment{}, mapNotFound(err)
	}
	return a, nil
}

// AttachmentData returns an attachment's metadata plus its raw file bytes,
// for serving via GET /api/attachments/{id}.
func (s *Store) AttachmentData(id string) (domain.Attachment, []byte, error) {
	var a domain.Attachment
	var data []byte
	err := s.db.QueryRow(
		`SELECT id, issue_id, filename, mime_type, size, created_at, data FROM issue_attachments WHERE id = ?`, id,
	).Scan(&a.ID, &a.IssueID, &a.Filename, &a.MimeType, &a.Size, &a.CreatedAt, &data)
	if err != nil {
		return domain.Attachment{}, nil, mapNotFound(err)
	}
	return a, data, nil
}

// DeleteAttachment deletes an attachment.
func (s *Store) DeleteAttachment(id string) error {
	res, err := s.db.Exec(`DELETE FROM issue_attachments WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
