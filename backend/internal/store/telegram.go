package store

import "devdeck/backend/internal/domain"

// TelegramConfig returns this machine's bridge state. HasToken is derived
// here rather than stored, so it can never disagree with the token column.
func (s *Store) TelegramConfig() (domain.TelegramConfig, error) {
	var cfg domain.TelegramConfig
	var token string
	err := s.db.QueryRow(
		`SELECT telegram_enabled, telegram_token, telegram_bot_username FROM settings WHERE id = 1`,
	).Scan(&cfg.Enabled, &token, &cfg.BotUsername)
	cfg.HasToken = token != ""
	return cfg, err
}

// SetTelegramConfig writes everything except the token — see
// SetTelegramBotToken. HasToken on the incoming value is ignored.
func (s *Store) SetTelegramConfig(cfg domain.TelegramConfig) error {
	_, err := s.db.Exec(
		`UPDATE settings SET telegram_enabled = ?, telegram_bot_username = ? WHERE id = 1`,
		cfg.Enabled, cfg.BotUsername,
	)
	return err
}

// TelegramBotToken returns the stored bot token, "" when unset. Deliberately
// separate from TelegramConfig for the same reason SignInPINHash is separate
// from Settings: the secret must never ride along in served JSON.
func (s *Store) TelegramBotToken() (string, error) {
	var token string
	err := s.db.QueryRow(`SELECT telegram_token FROM settings WHERE id = 1`).Scan(&token)
	return token, err
}

func (s *Store) SetTelegramBotToken(token string) error {
	_, err := s.db.Exec(`UPDATE settings SET telegram_token = ? WHERE id = 1`, token)
	return err
}

func (s *Store) TelegramUsers() ([]domain.TelegramUser, error) {
	rows, err := s.db.Query(`SELECT user_id, label, added_at FROM telegram_users ORDER BY added_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []domain.TelegramUser{}
	for rows.Next() {
		var u domain.TelegramUser
		if err := rows.Scan(&u.UserID, &u.Label, &u.AddedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// AddTelegramUser upserts: re-pairing an account already on the list refreshes
// its label instead of creating a second row for the same id.
func (s *Store) AddTelegramUser(u domain.TelegramUser) error {
	_, err := s.db.Exec(
		`INSERT INTO telegram_users (user_id, label, added_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET label = excluded.label, added_at = excluded.added_at`,
		u.UserID, u.Label, u.AddedAt,
	)
	return err
}

func (s *Store) DeleteTelegramUser(userID int64) error {
	_, err := s.db.Exec(`DELETE FROM telegram_users WHERE user_id = ?`, userID)
	return err
}

func (s *Store) TelegramBindings() ([]domain.TelegramBinding, error) {
	rows, err := s.db.Query(`SELECT thread_id, chat_id, topic_id, model, agent, last_seq, pinned_message_id FROM telegram_bindings ORDER BY thread_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := []domain.TelegramBinding{}
	for rows.Next() {
		var b domain.TelegramBinding
		if err := rows.Scan(&b.ThreadID, &b.ChatID, &b.TopicID, &b.Model, &b.Agent, &b.LastSeq, &b.PinnedMessageID); err != nil {
			return nil, err
		}
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// TelegramBindingByThread returns sql.ErrNoRows when the thread is not
// published — callers treat that as "not published", not as a failure.
func (s *Store) TelegramBindingByThread(threadID string) (domain.TelegramBinding, error) {
	var b domain.TelegramBinding
	err := s.db.QueryRow(
		`SELECT thread_id, chat_id, topic_id, model, agent, last_seq, pinned_message_id FROM telegram_bindings WHERE thread_id = ?`,
		threadID,
	).Scan(&b.ThreadID, &b.ChatID, &b.TopicID, &b.Model, &b.Agent, &b.LastSeq, &b.PinnedMessageID)
	return b, err
}

// SetTelegramBinding upserts the whole row EXCEPT last_seq, which only
// SetTelegramBindingSeq moves. Rebinding a thread to a different chat must not
// silently rewind its replay cursor and re-mirror the entire transcript.
func (s *Store) SetTelegramBinding(b domain.TelegramBinding) error {
	_, err := s.db.Exec(
		`INSERT INTO telegram_bindings (thread_id, chat_id, topic_id, model, agent, last_seq) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(thread_id) DO UPDATE SET chat_id = excluded.chat_id, topic_id = excluded.topic_id, model = excluded.model, agent = excluded.agent`,
		b.ThreadID, b.ChatID, b.TopicID, b.Model, b.Agent, b.LastSeq,
	)
	return err
}

// SetTelegramBindingPin records which message this bridge pinned in the
// destination chat, or clears it with 0. Separate from SetTelegramBinding for
// the same reason SetTelegramBindingSeq is: the row has to exist before the
// confirmation can be sent, so the message id is only known one round trip
// after the binding was written.
func (s *Store) SetTelegramBindingPin(threadID string, messageID int64) error {
	_, err := s.db.Exec(`UPDATE telegram_bindings SET pinned_message_id = ? WHERE thread_id = ?`, messageID, threadID)
	return err
}

// SetTelegramBindingAgent records /agents' choice for a destination
// publishing a single thread. Separate from the upsert for the same reason
// the pin and seq setters are: it is written after the row exists.
func (s *Store) SetTelegramBindingAgent(threadID, agent string) error {
	_, err := s.db.Exec(`UPDATE telegram_bindings SET agent = ? WHERE thread_id = ?`, agent, threadID)
	return err
}

// SetTelegramBindingModel records /model's choice, or clears it with "".
// Separate from the upsert for the same reason SetTelegramBindingAgent is: it
// moves ONE column on a row that already exists, where the upsert would have to
// re-supply chat_id and topic_id just to get there — and a read-modify-write
// that raced a re-point would write the destination back to a stale one.
func (s *Store) SetTelegramBindingModel(threadID, model string) error {
	_, err := s.db.Exec(`UPDATE telegram_bindings SET model = ? WHERE thread_id = ?`, model, threadID)
	return err
}

func (s *Store) SetTelegramBindingSeq(threadID string, seq uint64) error {
	_, err := s.db.Exec(`UPDATE telegram_bindings SET last_seq = ? WHERE thread_id = ?`, seq, threadID)
	return err
}

func (s *Store) DeleteTelegramBinding(threadID string) error {
	_, err := s.db.Exec(`DELETE FROM telegram_bindings WHERE thread_id = ?`, threadID)
	return err
}

// TelegramProjectBindings lists every project published to a forum group on
// this machine. Small by construction — one row per project an operator has
// opted to publish — so the reconciler scanning it every sweep is cheap.
func (s *Store) TelegramProjectBindings() ([]domain.TelegramProjectBinding, error) {
	rows, err := s.db.Query(`SELECT project_id, chat_id, topic_id, agent, pinned_message_id FROM telegram_project_bindings ORDER BY project_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := []domain.TelegramProjectBinding{}
	for rows.Next() {
		var b domain.TelegramProjectBinding
		if err := rows.Scan(&b.ProjectID, &b.ChatID, &b.TopicID, &b.Agent, &b.PinnedMessageID); err != nil {
			return nil, err
		}
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// TelegramProjectBindingByID returns sql.ErrNoRows when the project is not
// published — callers treat that as "not published", not as a failure, the
// same way TelegramBindingByThread does.
func (s *Store) TelegramProjectBindingByID(projectID string) (domain.TelegramProjectBinding, error) {
	var b domain.TelegramProjectBinding
	err := s.db.QueryRow(
		`SELECT project_id, chat_id, topic_id, agent, pinned_message_id FROM telegram_project_bindings WHERE project_id = ?`,
		projectID,
	).Scan(&b.ProjectID, &b.ChatID, &b.TopicID, &b.Agent, &b.PinnedMessageID)
	return b, err
}

// SetTelegramProjectBinding upserts. Re-publishing a project to a different
// group just moves where it points; the per-session rows in telegram_bindings
// are reconciled separately by the bridge, which creates topics in whichever
// group this now names.
func (s *Store) SetTelegramProjectBinding(b domain.TelegramProjectBinding) error {
	_, err := s.db.Exec(
		`INSERT INTO telegram_project_bindings (project_id, chat_id, topic_id, agent, pinned_message_id) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET chat_id = excluded.chat_id, topic_id = excluded.topic_id`,
		b.ProjectID, b.ChatID, b.TopicID, b.Agent, b.PinnedMessageID,
	)
	return err
}

// SetTelegramProjectBindingAgent records /agents' choice. Separate from the
// upsert above for the same reason the pin setter is: re-publishing a project
// must not silently reset an agent the operator picked.
func (s *Store) SetTelegramProjectBindingAgent(projectID, agent string) error {
	_, err := s.db.Exec(`UPDATE telegram_project_bindings SET agent = ? WHERE project_id = ?`, agent, projectID)
	return err
}

func (s *Store) SetTelegramProjectBindingPin(projectID string, messageID int64) error {
	_, err := s.db.Exec(`UPDATE telegram_project_bindings SET pinned_message_id = ? WHERE project_id = ?`, messageID, projectID)
	return err
}

func (s *Store) DeleteTelegramProjectBinding(projectID string) error {
	_, err := s.db.Exec(`DELETE FROM telegram_project_bindings WHERE project_id = ?`, projectID)
	return err
}
