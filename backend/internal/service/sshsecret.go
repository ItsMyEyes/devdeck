package service

import (
	"errors"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// SSHSecretService encrypts SSH credentials into the ssh_secrets table and
// decrypts them for the SSH dialer. It reuses the AES-256-GCM helpers in
// authcrypto.go, keyed by the same master key as TOTP secret storage.
// Unlike Machine.Key (deliberately distributed to clients for direct-first
// connections), these secrets never leave the server.
type SSHSecretService struct {
	st  port.Store
	key []byte
}

func NewSSHSecretService(st port.Store, key []byte) *SSHSecretService {
	return &SSHSecretService{st: st, key: key}
}

// Set encrypts plaintext and stores it as connectionID's credential of the
// given kind ("password" | "privatekey" | "passphrase"), replacing any
// previous value of that kind.
func (s *SSHSecretService) Set(connectionID, kind, plaintext string) error {
	ct, err := encryptSecret(s.key, plaintext)
	if err != nil {
		return err
	}
	return s.st.UpsertSSHSecret(connectionID, kind, ct)
}

// Get decrypts connectionID's credential of the given kind. ok is false
// (with a nil error) when no credential of that kind is stored.
func (s *SSHSecretService) Get(connectionID, kind string) (string, bool, error) {
	sec, err := s.st.SSHSecret(connectionID, kind)
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
