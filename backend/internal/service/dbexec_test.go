package service

import (
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

func TestDescriptorIncludesDecryptedPassword(t *testing.T) {
	st := newTestStore(t)
	secrets := NewDBSecretService(st, testMasterKey(t))
	svc := NewDBExecService(st, secrets)

	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	_ = secrets.Set(c.ID, "password", "s3cret")

	d, err := svc.Descriptor(c.ID)
	if err != nil {
		t.Fatalf("descriptor: %v", err)
	}
	if d.Password != "s3cret" {
		t.Fatalf("password not decrypted into descriptor")
	}
}

func TestDescriptorIncludesTunnelCredentialsWithFingerprint(t *testing.T) {
	st := newTestStore(t)
	secrets := NewDBSecretService(st, testMasterKey(t))
	svc := NewDBExecService(st, secrets)

	ssh, _ := st.CreateSSHConnection("bastion", "", "b.example.com", 22, "u", "password", nil, nil)
	pinned := "SHA256:pinned"
	_ = st.SetSSHHostKey(ssh.ID, &pinned)
	tunnelID := ssh.ID
	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, &tunnelID, false)

	d, err := svc.Descriptor(c.ID)
	if err != nil {
		t.Fatalf("descriptor: %v", err)
	}
	if d.Tunnel == nil {
		t.Fatal("tunnel descriptor missing")
	}
	if d.Tunnel.HostKeyFingerprint != "SHA256:pinned" {
		t.Fatalf("fingerprint = %q, want the pinned value", d.Tunnel.HostKeyFingerprint)
	}
}

func TestDescriptorRejectsTunnelWithoutPinnedHostKey(t *testing.T) {
	// A tunnel whose host key was never pinned cannot be verified, so
	// building a descriptor for it must fail rather than dial blindly.
	st := newTestStore(t)
	svc := NewDBExecService(st, NewDBSecretService(st, testMasterKey(t)))

	ssh, _ := st.CreateSSHConnection("bastion", "", "b.example.com", 22, "u", "password", nil, nil)
	tunnelID := ssh.ID
	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, &tunnelID, false)

	if _, err := svc.Descriptor(c.ID); err == nil {
		t.Fatal("descriptor built for an unpinned tunnel, want rejection")
	}
}

func TestExecRechecksExecutorURLAtExecutionTime(t *testing.T) {
	// The machine URL can change after the connection was saved, so the
	// transport rule must be re-checked here, not only at save time.
	st := newTestStore(t)
	svc := NewDBExecService(st, NewDBSecretService(st, testMasterKey(t)))

	m, _ := st.CreateMachine("runtime", "http://runtime.tail1234.ts.net:8989", "k", false)
	mid := m.ID
	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", &mid, nil, false)

	badURL := "http://203.0.113.9:8989"
	_, _ = st.UpdateMachine(m.ID, port.MachinePatch{URL: &badURL})

	_, _, err := svc.IsRemote(c.ID)
	if err == nil || !strings.Contains(err.Error(), "http") {
		t.Fatalf("err = %v, want rejection of the now-plaintext executor URL", err)
	}
}
