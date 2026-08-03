package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// Settings returns the singleton settings row.
func (s *Store) Settings() (domain.Settings, error) {
	var set domain.Settings
	var active sql.NullString
	err := s.db.QueryRow(`SELECT active_workspace_id, default_model FROM settings WHERE id = 1`).
		Scan(&active, &set.DefaultModel)
	if err != nil {
		return set, err
	}
	if active.Valid {
		v := active.String
		set.ActiveWorkspaceID = &v
	}
	return set, nil
}

// UpdateSettings applies a partial settings update.
func (s *Store) UpdateSettings(p port.SettingsPatch) (domain.Settings, error) {
	if p.HasActive {
		if _, err := s.db.Exec(`UPDATE settings SET active_workspace_id = ? WHERE id = 1`, p.ActiveWorkspaceID); err != nil {
			return domain.Settings{}, err
		}
	}
	if p.DefaultModel != nil {
		if _, err := s.db.Exec(`UPDATE settings SET default_model = ? WHERE id = 1`, *p.DefaultModel); err != nil {
			return domain.Settings{}, err
		}
	}
	return s.Settings()
}

// SignInPINHash returns the bcrypt hash of the runtime sign-in PIN, or "" when
// none has been set. Deliberately separate from Settings(): the hash must
// never ride along in the JSON the settings endpoint serves.
func (s *Store) SignInPINHash() (string, error) {
	var hash string
	err := s.db.QueryRow(`SELECT signin_pin_hash FROM settings WHERE id = 1`).Scan(&hash)
	return hash, err
}

// SetSignInPINHash replaces the stored runtime sign-in PIN hash.
func (s *Store) SetSignInPINHash(hash string) error {
	_, err := s.db.Exec(`UPDATE settings SET signin_pin_hash = ? WHERE id = 1`, hash)
	return err
}

func (s *Store) setActiveWorkspace(id *string) error {
	_, err := s.db.Exec(`UPDATE settings SET active_workspace_id = ? WHERE id = 1`, id)
	return err
}
