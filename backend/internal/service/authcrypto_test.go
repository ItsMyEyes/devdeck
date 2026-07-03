package service

import "testing"

func TestEncryptDecryptSecretRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	encrypted, err := encryptSecret(key, "JBSWY3DPEHPK3PXP")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted == "JBSWY3DPEHPK3PXP" {
		t.Fatal("encryptSecret returned the plaintext unchanged")
	}
	decrypted, err := decryptSecret(key, encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if decrypted != "JBSWY3DPEHPK3PXP" {
		t.Errorf("decryptSecret = %q, want %q", decrypted, "JBSWY3DPEHPK3PXP")
	}
}

func TestDecryptSecretFailsWithWrongKey(t *testing.T) {
	key1 := make([]byte, 32)
	key2 := make([]byte, 32)
	key2[0] = 1
	encrypted, err := encryptSecret(key1, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptSecret(key2, encrypted); err == nil {
		t.Error("decryptSecret with the wrong key should fail, got nil error")
	}
}

func TestGenerateBackupCodesAreUniqueAndCorrectLength(t *testing.T) {
	codes, err := generateBackupCodes(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != 10 {
		t.Fatalf("len(codes) = %d, want 10", len(codes))
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if len(c) != 10 {
			t.Errorf("code %q has length %d, want 10", c, len(c))
		}
		if seen[c] {
			t.Errorf("duplicate backup code %q", c)
		}
		seen[c] = true
	}
}

func TestMatchBackupCodeFindsAndRejects(t *testing.T) {
	hash, err := hashBackupCode("ABCD123456")
	if err != nil {
		t.Fatal(err)
	}
	hashes := []string{hash}
	if idx := matchBackupCode(hashes, "ABCD123456"); idx != 0 {
		t.Errorf("matchBackupCode = %d, want 0", idx)
	}
	if idx := matchBackupCode(hashes, "WRONGCODE1"); idx != -1 {
		t.Errorf("matchBackupCode = %d, want -1", idx)
	}
}
