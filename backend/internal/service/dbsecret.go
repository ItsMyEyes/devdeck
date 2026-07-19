package service

import (
	"errors"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// DBSecretService encrypts database credentials into the db_secrets table and
// decrypts them for the driver layer. It reuses the AES-256-GCM helpers in
// authcrypto.go, keyed by the same master key as TOTP and SSH secrets.
// These values never leave the server: unlike Machine.Key, which is
// deliberately distributed to clients, a database password is only ever sent
// onward to a runtime executor over an authenticated tailnet/TLS hop.
type DBSecretService struct {
	st  port.Store
	key []byte
}

func NewDBSecretService(st port.Store, key []byte) *DBSecretService {
	return &DBSecretService{st: st, key: key}
}

// Set encrypts plaintext and stores it as connectionID's credential of the
// given kind ("password" | "ca_cert" | "client_cert" | "client_key"),
// replacing any previous value of that kind.
func (s *DBSecretService) Set(connectionID, kind, plaintext string) error {
	ct, err := encryptSecret(s.key, plaintext)
	if err != nil {
		return err
	}
	return s.st.UpsertDBSecret(connectionID, kind, ct)
}

// Get decrypts connectionID's credential of the given kind. ok is false
// (with a nil error) when no credential of that kind is stored.
func (s *DBSecretService) Get(connectionID, kind string) (string, bool, error) {
	sec, err := s.st.DBSecretRow(connectionID, kind)
	if errors.Is(err, store.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	plaintext, err := decryptSecret(s.key, sec.CipherText)
	if err != nil {
		return "", false, err
	}
	return plaintext, true, nil
}

// Clear removes one credential kind for a connection.
func (s *DBSecretService) Clear(connectionID, kind string) error {
	return s.st.DeleteDBSecret(connectionID, kind)
}
