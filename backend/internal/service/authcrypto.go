package service

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

// bcryptCost is used for both password and backup-code hashing.
const bcryptCost = 12

// encryptSecret encrypts plaintext with AES-256-GCM using key (must be 32
// bytes) and returns a base64-encoded "nonce||ciphertext" blob.
func encryptSecret(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// decryptSecret reverses encryptSecret.
func decryptSecret(key []byte, encoded string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, ciphertext := data[:gcm.NonceSize()], data[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// generateBackupCodes returns n random 10-character uppercase alphanumeric
// backup codes, e.g. "7K2F9QXB4M". The alphabet excludes O/0/I/1 to avoid
// visual ambiguity when a user copies a code by hand.
func generateBackupCodes(n int) ([]string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	codes := make([]string, n)
	for i := range codes {
		b := make([]byte, 10)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		for j, v := range b {
			b[j] = alphabet[int(v)%len(alphabet)]
		}
		codes[i] = string(b)
	}
	return codes, nil
}

// hashBackupCode bcrypt-hashes a backup code for storage.
func hashBackupCode(code string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(code), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// matchBackupCode returns the index of the first hash in hashes that code
// matches, or -1 if none match.
func matchBackupCode(hashes []string, code string) int {
	for i, h := range hashes {
		if bcrypt.CompareHashAndPassword([]byte(h), []byte(code)) == nil {
			return i
		}
	}
	return -1
}
