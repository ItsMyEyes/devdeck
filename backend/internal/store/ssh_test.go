package store

import (
	"strings"
	"testing"

	"loom/backend/internal/port"
)

func TestCreateSSHConnectionRoundtrip(t *testing.T) {
	st := newTestStore(t)
	c, err := st.CreateSSHConnection("prod-web", "web.example.com", 2222, "deploy", "password")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(c.ID, "sc-") {
		t.Errorf("ID = %q, want sc- prefix", c.ID)
	}
	if c.Port != 2222 || c.Username != "deploy" || c.AuthType != "password" {
		t.Errorf("fields not persisted: %+v", c)
	}
	if c.HostKeyFingerprint != nil || c.JumpConnectionID != nil || c.ExecutorMachineID != nil {
		t.Errorf("nullable fields must start nil: %+v", c)
	}
	list, err := st.SSHConnections()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != c.ID {
		t.Errorf("SSHConnections() = %+v, want the created row", list)
	}
}

func TestUpdateSSHConnectionPatchesFields(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "old.example.com", 22, "root", "password")
	name, portNum := "b", 2200
	got, err := st.UpdateSSHConnection(c.ID, port.SSHConnectionPatch{Name: &name, Port: &portNum})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "b" || got.Port != 2200 || got.Host != "old.example.com" {
		t.Errorf("patch result = %+v", got)
	}
}

func TestUpdateSSHConnectionHostChangeClearsPinnedKey(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "old.example.com", 22, "root", "password")
	fp := "SHA256:abc"
	if err := st.SetSSHHostKey(c.ID, &fp); err != nil {
		t.Fatal(err)
	}
	host := "new.example.com"
	got, err := st.UpdateSSHConnection(c.ID, port.SSHConnectionPatch{Host: &host})
	if err != nil {
		t.Fatal(err)
	}
	if got.HostKeyFingerprint != nil {
		t.Errorf("fingerprint = %q, want cleared after host change", *got.HostKeyFingerprint)
	}
}

func TestUpdateSSHConnectionNonHostPatchKeepsPinnedKey(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "same.example.com", 22, "root", "password")
	fp := "SHA256:abc"
	if err := st.SetSSHHostKey(c.ID, &fp); err != nil {
		t.Fatal(err)
	}
	// Patching only the name (and even re-sending the SAME host, as the edit
	// dialog does) must NOT clear the pin — only an actual host change does.
	name, host := "renamed", "same.example.com"
	got, err := st.UpdateSSHConnection(c.ID, port.SSHConnectionPatch{Name: &name, Host: &host})
	if err != nil {
		t.Fatal(err)
	}
	if got.HostKeyFingerprint == nil || *got.HostKeyFingerprint != fp {
		t.Errorf("fingerprint = %v, want preserved when host is unchanged", got.HostKeyFingerprint)
	}
}

func TestSetSSHHostKeyPinAndClear(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "h", 22, "u", "password")
	fp := "SHA256:abc"
	if err := st.SetSSHHostKey(c.ID, &fp); err != nil {
		t.Fatal(err)
	}
	got, _ := st.SSHConnectionByID(c.ID)
	if got.HostKeyFingerprint == nil || *got.HostKeyFingerprint != fp {
		t.Fatalf("fingerprint not pinned: %+v", got.HostKeyFingerprint)
	}
	if err := st.SetSSHHostKey(c.ID, nil); err != nil {
		t.Fatal(err)
	}
	got, _ = st.SSHConnectionByID(c.ID)
	if got.HostKeyFingerprint != nil {
		t.Errorf("fingerprint = %q, want cleared", *got.HostKeyFingerprint)
	}
	if err := st.SetSSHHostKey("sc-missing", &fp); err != ErrNotFound {
		t.Errorf("missing id err = %v, want ErrNotFound", err)
	}
}

func TestUpsertSSHSecretReplaces(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "h", 22, "u", "password")
	if err := st.UpsertSSHSecret(c.ID, "password", "cipher-1"); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertSSHSecret(c.ID, "password", "cipher-2"); err != nil {
		t.Fatal(err)
	}
	sec, err := st.SSHSecret(c.ID, "password")
	if err != nil {
		t.Fatal(err)
	}
	if sec.CipherText != "cipher-2" || sec.StorageKind != "db" {
		t.Errorf("secret = %+v, want replaced cipher-2", sec)
	}
	if _, err := st.SSHSecret(c.ID, "passphrase"); err != ErrNotFound {
		t.Errorf("missing kind err = %v, want ErrNotFound", err)
	}
}

func TestDeleteSSHConnectionCascadesSecrets(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "h", 22, "u", "password")
	_ = st.UpsertSSHSecret(c.ID, "password", "cipher")
	if err := st.DeleteSSHConnection(c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SSHConnectionByID(c.ID); err != ErrNotFound {
		t.Errorf("connection err = %v, want ErrNotFound", err)
	}
	if _, err := st.SSHSecret(c.ID, "password"); err != ErrNotFound {
		t.Errorf("secret err = %v, want ErrNotFound (cascade)", err)
	}
	if err := st.DeleteSSHConnection(c.ID); err != ErrNotFound {
		t.Errorf("double delete err = %v, want ErrNotFound", err)
	}
}
