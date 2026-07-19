package dbdriver

import (
	"context"
	"testing"

	"devdeck/backend/internal/port"
)

func TestOpenTunnelRequiresHostKeyFingerprint(t *testing.T) {
	// An unverified tunnel creates the man-in-the-middle exposure it exists
	// to prevent, so a missing pin is a hard error rather than a warning.
	_, _, err := OpenTunnel(context.Background(), port.TunnelDescriptor{
		Host: "bastion.example.com", Port: 22, Username: "u", AuthType: "password", Password: "p",
	}, "db.internal:5432")
	if err == nil {
		t.Fatal("tunnel opened without a host key fingerprint, want rejection")
	}
}

func TestOpenTunnelRejectsUnknownAuthType(t *testing.T) {
	_, _, err := OpenTunnel(context.Background(), port.TunnelDescriptor{
		Host: "h", Port: 22, Username: "u", AuthType: "magic", HostKeyFingerprint: "SHA256:abc",
	}, "db:5432")
	if err == nil {
		t.Fatal("unknown auth type accepted, want rejection")
	}
}
