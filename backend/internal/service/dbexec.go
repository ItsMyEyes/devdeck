// Package service — database execution routing.
//
// A port.DSNDescriptor assembled here carries DECRYPTED credentials: the
// database password, client key, and any SSH tunnel password or private key.
// It must never be logged, never included in an error message returned to a
// client, and never serialized toward a browser. Its only legitimate
// destinations are a local driver Open and an authenticated hub→runtime hop.
package service

import (
	"context"
	"fmt"
	"time"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// DBExecService turns a saved connection row into something dialable: it
// decrypts the credentials into a descriptor, decides whether the connection
// executes on the hub or on a registered runtime, and opens hub-local
// connections. Remote execution forwards the descriptor instead of dialing.
type DBExecService struct {
	st         port.Store
	secrets    *DBSecretService
	sshSecrets *SSHSecretService
}

// NewDBExecService wires the execution service. The SSH secret service is
// derived from the same master key as the database secrets: a tunnel's
// credentials are decrypted on the same hop as the database password it
// protects.
func NewDBExecService(st port.Store, secrets *DBSecretService) *DBExecService {
	return &DBExecService{
		st:         st,
		secrets:    secrets,
		sshSecrets: NewSSHSecretService(st, secrets.key),
	}
}

// Descriptor assembles everything needed to dial connID, decrypting the
// stored credentials. See the package comment: the result must never be
// logged or returned to a client.
func (s *DBExecService) Descriptor(connID string) (port.DSNDescriptor, error) {
	c, err := s.st.DBConnectionByID(connID)
	if err != nil {
		return port.DSNDescriptor{}, err
	}

	d := port.DSNDescriptor{
		ConnectionID: c.ID,
		Engine:       c.Engine,
		Host:         c.Host,
		Port:         c.Port,
		Username:     c.Username,
		Database:     c.Database,
		SSLMode:      c.SSLMode,
	}
	if c.ServerCertFingerprint != nil {
		d.ServerCertFingerprint = *c.ServerCertFingerprint
	}

	for _, f := range []struct {
		kind string
		dst  *string
	}{
		{"password", &d.Password},
		{"ca_cert", &d.CACert},
		{"client_cert", &d.ClientCert},
		{"client_key", &d.ClientKey},
	} {
		v, ok, err := s.secrets.Get(c.ID, f.kind)
		if err != nil {
			return port.DSNDescriptor{}, fmt.Errorf("decrypt %s for connection %s: %w", f.kind, c.ID, err)
		}
		if ok {
			*f.dst = v
		}
	}

	if c.TunnelConnectionID != nil && *c.TunnelConnectionID != "" {
		tun, err := s.tunnelDescriptor(*c.TunnelConnectionID)
		if err != nil {
			return port.DSNDescriptor{}, err
		}
		d.Tunnel = &tun
	}
	return d, nil
}

// tunnelDescriptor resolves an SSHConnection into dialable tunnel credentials.
func (s *DBExecService) tunnelDescriptor(sshID string) (port.TunnelDescriptor, error) {
	sc, err := s.st.SSHConnectionByID(sshID)
	if err != nil {
		return port.TunnelDescriptor{}, err
	}

	// An unpinned host key means the tunnel cannot be authenticated. Dialing
	// anyway would create exactly the man-in-the-middle exposure the tunnel
	// exists to prevent, so this is a hard error rather than a warning.
	if sc.HostKeyFingerprint == nil || *sc.HostKeyFingerprint == "" {
		return port.TunnelDescriptor{}, fmt.Errorf("ssh connection %q has no pinned host key; open a terminal to %s once to pin it before using it as a database tunnel", sc.Name, sc.Host)
	}

	t := port.TunnelDescriptor{
		Host:               sc.Host,
		Port:               sc.Port,
		Username:           sc.Username,
		AuthType:           sc.AuthType,
		HostKeyFingerprint: *sc.HostKeyFingerprint,
	}
	for _, f := range []struct {
		kind string
		dst  *string
	}{
		{"password", &t.Password},
		{"privatekey", &t.PrivateKey},
		{"passphrase", &t.Passphrase},
	} {
		v, ok, err := s.sshSecrets.Get(sc.ID, f.kind)
		if err != nil {
			return port.TunnelDescriptor{}, fmt.Errorf("decrypt tunnel %s for ssh connection %s: %w", f.kind, sc.ID, err)
		}
		if ok {
			*f.dst = v
		}
	}
	return t, nil
}

// IsRemote reports whether connID executes on a registered runtime machine
// rather than on the hub, returning that machine when it does.
//
// The executor URL is re-validated here, not only when the connection was
// saved: a machine's URL can be edited afterwards, and the hub is about to
// send a decrypted password to whatever address is registered now.
func (s *DBExecService) IsRemote(connID string) (bool, domain.Machine, error) {
	c, err := s.st.DBConnectionByID(connID)
	if err != nil {
		return false, domain.Machine{}, err
	}
	if c.ExecutorMachineID == nil || *c.ExecutorMachineID == "" {
		return false, domain.Machine{}, nil
	}
	m, err := s.st.MachineByID(*c.ExecutorMachineID)
	if err != nil {
		return false, domain.Machine{}, err
	}
	if err := ValidateExecutorURL(m.URL); err != nil {
		return false, domain.Machine{}, err
	}
	return true, m, nil
}

// EngineCaps returns an engine's capability set, for callers that need to
// build SQL text (identifier quoting) without opening a connection.
func (s *DBExecService) EngineCaps(engine string) (port.DBCaps, error) {
	drv, err := dbdriver.Get(engine)
	if err != nil {
		return port.DBCaps{}, err
	}
	return drv.Capabilities(), nil
}

// RecordQueryHistory appends one SQL editor execution to connID's history.
//
// It exists so the handler can record without holding a raw store: DBExecService
// already owns the port.Store, and handing a store to a handler that otherwise
// only speaks to this service would widen its reach for no reason.
//
// errMsg must already be the redacted, client-facing message produced by
// mapDriverErr — never a raw driver error, which routinely quotes the
// connection string it failed to dial.
func (s *DBExecService) RecordQueryHistory(connID, sqlText, status, errMsg string, elapsedMS int64, rowCount int) error {
	_, err := s.st.AddDBQueryHistory(connID, sqlText, status, errMsg, elapsedMS, rowCount,
		time.Now().UTC().Format(time.RFC3339))
	return err
}

// QueryHistory returns connID's recorded executions, newest first.
func (s *DBExecService) QueryHistory(connID string, limit int) ([]domain.DBQueryHistoryEntry, error) {
	return s.st.DBQueryHistory(connID, limit)
}

// ClearQueryHistory drops every recorded execution for connID.
func (s *DBExecService) ClearQueryHistory(connID string) error {
	return s.st.ClearDBQueryHistory(connID)
}

// Conn opens a hub-local connection to connID's database. The returned
// release function closes it and must always be called.
//
// Remote connections are not opened here: the handler forwards the descriptor
// to the runtime, which dials on its own side.
func (s *DBExecService) Conn(ctx context.Context, connID string) (port.DBConn, func(), error) {
	d, err := s.Descriptor(connID)
	if err != nil {
		return nil, nil, err
	}
	drv, err := dbdriver.Get(d.Engine)
	if err != nil {
		return nil, nil, err
	}
	conn, err := drv.Open(ctx, d)
	if err != nil {
		return nil, nil, err
	}
	return conn, func() { _ = conn.Close() }, nil
}
