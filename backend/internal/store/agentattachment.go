package store

import "devdeck/backend/internal/domain"

// CreateAgentAttachment stores a file uploaded from an agent chat composer
// (an image, today). Unlike CreateAttachment (issue_attachments), this has
// no issueByID-style existence guard: threadID need not name an existing
// agent_thread row. C2's "upload immediately, on add" means the upload can
// race ahead of the thread's own EvtThreadCreated commit — rejecting that
// would make the very first message of a new thread unable to carry an
// image. DeleteOrphanAgentAttachments sweeps anything left permanently
// orphaned by a thread that never arrives.
func (s *Store) CreateAgentAttachment(threadID, name, mimeType string, data []byte, createdAt string) (domain.AgentAttachment, error) {
	id := idGen("aatt-")
	if _, err := s.db.Exec(
		`INSERT INTO agent_attachment (id, thread_id, name, mime_type, size_bytes, data, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, threadID, name, mimeType, len(data), data, createdAt,
	); err != nil {
		return domain.AgentAttachment{}, err
	}
	return s.agentAttachmentMetaByID(id)
}

func (s *Store) agentAttachmentMetaByID(id string) (domain.AgentAttachment, error) {
	var a domain.AgentAttachment
	err := s.db.QueryRow(
		`SELECT id, thread_id, name, mime_type, size_bytes, created_at FROM agent_attachment WHERE id = ?`, id,
	).Scan(&a.ID, &a.ThreadID, &a.Name, &a.MimeType, &a.SizeBytes, &a.CreatedAt)
	if err != nil {
		return domain.AgentAttachment{}, mapNotFound(err)
	}
	return a, nil
}

// AgentAttachmentData returns an attachment's metadata plus its raw bytes,
// for serving via GET /api/agent/attachments/{id}.
func (s *Store) AgentAttachmentData(id string) (domain.AgentAttachment, []byte, error) {
	var a domain.AgentAttachment
	var data []byte
	err := s.db.QueryRow(
		`SELECT id, thread_id, name, mime_type, size_bytes, created_at, data FROM agent_attachment WHERE id = ?`, id,
	).Scan(&a.ID, &a.ThreadID, &a.Name, &a.MimeType, &a.SizeBytes, &a.CreatedAt, &data)
	if err != nil {
		return domain.AgentAttachment{}, nil, mapNotFound(err)
	}
	return a, data, nil
}

// DeleteOrphanAgentAttachments sweeps attachments whose thread_id names no
// agent_thread row — run at startup. This is the backstop for the ordering
// CreateAgentAttachment deliberately allows: an upload whose thread never
// actually gets created (the WebSocket dropped before EvtThreadCreated
// committed) would otherwise sit in the table forever with no id anyone can
// reach it by. A thread that legitimately still exists is untouched.
func (s *Store) DeleteOrphanAgentAttachments() (int, error) {
	res, err := s.db.Exec(
		`DELETE FROM agent_attachment WHERE thread_id NOT IN (SELECT id FROM agent_thread)`,
	)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}
