package handler

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// forwardStopper is the subset of *sshmgr.Forwarder that SSHHandler needs:
// tearing down a live port-forward's listener/client when the saved
// connection it belongs to is deleted. A narrow interface (rather than the
// concrete type) keeps this package free of an sshmgr import and lets tests
// fake it. Stop is idempotent and always returns nil.
type forwardStopper interface {
	Stop(forwardID string) error
}

// poolEvicter is the subset of *sshmgr.FilePool that SSHHandler needs:
// dropping a cached SSH+SFTP pair so the next pooled operation (SFTP,
// stats, RunCommand) dials fresh instead of reusing a client that points at
// a host/credential/host-key this connection no longer has.
type poolEvicter interface {
	Evict(connectionID string)
}

// SSHHandler handles the hub's saved-SSH-connection registry. Secrets ride
// in on create/update bodies, are encrypted at rest via SSHSecretService,
// and never serialize back out (domain.SSHSecret is json:"-" throughout).
//
// forwarder and pool are nil-tolerant: existing tests/constructions that
// don't care about live forwards or pooled connections may pass nil, in
// which case the corresponding cleanup step is simply skipped.
type SSHHandler struct {
	st        *store.Store
	secrets   *service.SSHSecretService
	forwarder forwardStopper
	pool      poolEvicter
}

func NewSSHHandler(st *store.Store, secrets *service.SSHSecretService, forwarder forwardStopper, pool poolEvicter) *SSHHandler {
	return &SSHHandler{st: st, secrets: secrets, forwarder: forwarder, pool: pool}
}

func validSSHAuthType(t string) bool {
	return t == "password" || t == "privatekey"
}

// maxJumpChainDepth bounds how many bastion hops validateJumpChain will walk
// before giving up — a generous ceiling for a real-world chain, cheap enough
// to check synchronously on every write.
const maxJumpChainDepth = 8

// nilIfEmpty treats an empty-string pointer the same as no value — the
// frontend's "none" select option submits "" rather than omitting the key.
func nilIfEmpty(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// validateJumpChain checks that jumpID names an existing connection and that
// chaining selfID through it would not create a cycle. selfID is "" on
// create, since a brand-new connection can't yet be part of any cycle.
func (h *SSHHandler) validateJumpChain(selfID, jumpID string) error {
	seen := map[string]bool{}
	if selfID != "" {
		seen[selfID] = true
	}
	cur := jumpID
	for depth := 0; depth < maxJumpChainDepth; depth++ {
		if cur == "" {
			return nil
		}
		if seen[cur] {
			return fmt.Errorf("jump connection chain forms a cycle at %s", cur)
		}
		seen[cur] = true
		conn, err := h.st.SSHConnectionByID(cur)
		if err != nil {
			return fmt.Errorf("jump connection %s not found", cur)
		}
		if conn.JumpConnectionID == nil {
			return nil
		}
		cur = *conn.JumpConnectionID
	}
	return fmt.Errorf("jump connection chain exceeds max depth of %d", maxJumpChainDepth)
}

// validateExecutorMachine checks that machineID names an existing Machine.
func (h *SSHHandler) validateExecutorMachine(machineID string) error {
	if _, err := h.st.MachineByID(machineID); err != nil {
		return fmt.Errorf("executor machine %s not found", machineID)
	}
	return nil
}

// sshSecretFields are the write-only credential fields accepted alongside
// connection fields on create/update. Blank/absent means "leave unchanged".
type sshSecretFields struct {
	Password       *string `json:"password"`
	PrivateKey     *string `json:"privateKey"`
	PrivateKeyPath *string `json:"privateKeyPath"`
	Passphrase     *string `json:"passphrase"`
}

func readPrivateKeyPath(raw string) (string, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return "", nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
	} else if !filepath.IsAbs(path) {
		path = filepath.Join(home, ".ssh", path)
	}

	clean := filepath.Clean(path)
	sshDir := filepath.Join(home, ".ssh")
	rel, err := filepath.Rel(sshDir, clean)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("privateKeyPath must point inside ~/.ssh")
	}

	key, err := os.ReadFile(clean)
	if err != nil {
		return "", fmt.Errorf("read private key %s: %w", raw, err)
	}
	return string(key), nil
}

func (h *SSHHandler) storeSecrets(connectionID string, s sshSecretFields) error {
	if s.Password != nil && *s.Password != "" {
		if err := h.secrets.Set(connectionID, "password", *s.Password); err != nil {
			return err
		}
	}
	privateKey := ""
	if s.PrivateKey != nil && *s.PrivateKey != "" {
		privateKey = *s.PrivateKey
	} else if s.PrivateKeyPath != nil && *s.PrivateKeyPath != "" {
		key, err := readPrivateKeyPath(*s.PrivateKeyPath)
		if err != nil {
			return err
		}
		privateKey = key
	}
	if privateKey != "" {
		if err := h.secrets.Set(connectionID, "privatekey", privateKey); err != nil {
			return err
		}
	}
	if s.Passphrase != nil && *s.Passphrase != "" {
		if err := h.secrets.Set(connectionID, "passphrase", *s.Passphrase); err != nil {
			return err
		}
	}
	return nil
}

// GetConnections lists saved SSH connections (never their secrets).
func (h *SSHHandler) GetConnections(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.SSHConnections()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *SSHHandler) PostConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name              *string `json:"name"`
		Group             *string `json:"group"`
		Host              *string `json:"host"`
		Port              *int    `json:"port"`
		Username          *string `json:"username"`
		AuthType          *string `json:"authType"`
		JumpConnectionID  *string `json:"jumpConnectionId"`
		ExecutorMachineID *string `json:"executorMachineId"`
		sshSecretFields
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if str(body.Name) == "" || str(body.Host) == "" || str(body.Username) == "" {
		writeErr(w, http.StatusBadRequest, "name, host and username are required")
		return
	}
	authType := str(body.AuthType)
	if !validSSHAuthType(authType) {
		writeErr(w, http.StatusBadRequest, "authType must be \"password\" or \"privatekey\"")
		return
	}
	portNum := 22
	if body.Port != nil {
		portNum = *body.Port
	}
	if portNum < 1 || portNum > 65535 {
		writeErr(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}
	if authType == "password" && (body.Password == nil || *body.Password == "") {
		writeErr(w, http.StatusBadRequest, "password is required for password auth")
		return
	}
	if authType == "privatekey" && (body.PrivateKey == nil || *body.PrivateKey == "") && (body.PrivateKeyPath == nil || *body.PrivateKeyPath == "") {
		writeErr(w, http.StatusBadRequest, "privateKey or privateKeyPath is required for privatekey auth")
		return
	}
	if body.PrivateKeyPath != nil && *body.PrivateKeyPath != "" {
		if _, err := readPrivateKeyPath(*body.PrivateKeyPath); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	jumpConnectionID := nilIfEmpty(body.JumpConnectionID)
	if jumpConnectionID != nil {
		if err := h.validateJumpChain("", *jumpConnectionID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	executorMachineID := nilIfEmpty(body.ExecutorMachineID)
	if executorMachineID != nil {
		if err := h.validateExecutorMachine(*executorMachineID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	conn, err := h.st.CreateSSHConnection(str(body.Name), str(body.Group), str(body.Host), portNum, str(body.Username), authType, jumpConnectionID, executorMachineID)
	if handleStoreErr(w, err) {
		return
	}
	if handleStoreErr(w, h.storeSecrets(conn.ID, body.sshSecretFields)) {
		return
	}
	writeJSON(w, http.StatusOK, conn)
}

func (h *SSHHandler) PatchConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		port.SSHConnectionPatch
		sshSecretFields
	}
	raw, err := decodeBody(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, ok := raw["jumpConnectionId"]; ok {
		body.HasJumpConnectionID = true
		body.JumpConnectionID = nilIfEmpty(body.JumpConnectionID)
	}
	if _, ok := raw["executorMachineId"]; ok {
		body.HasExecutorMachineID = true
		body.ExecutorMachineID = nilIfEmpty(body.ExecutorMachineID)
	}
	if body.AuthType != nil && !validSSHAuthType(*body.AuthType) {
		writeErr(w, http.StatusBadRequest, "authType must be \"password\" or \"privatekey\"")
		return
	}
	if body.Port != nil && (*body.Port < 1 || *body.Port > 65535) {
		writeErr(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}
	if body.PrivateKeyPath != nil && *body.PrivateKeyPath != "" {
		if _, err := readPrivateKeyPath(*body.PrivateKeyPath); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	id := r.PathValue("id")
	if body.HasJumpConnectionID && body.JumpConnectionID != nil {
		if err := h.validateJumpChain(id, *body.JumpConnectionID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if body.HasExecutorMachineID && body.ExecutorMachineID != nil {
		if err := h.validateExecutorMachine(*body.ExecutorMachineID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	conn, err := h.st.UpdateSSHConnection(id, body.SSHConnectionPatch)
	if handleStoreErr(w, err) {
		return
	}
	if handleStoreErr(w, h.storeSecrets(conn.ID, body.sshSecretFields)) {
		return
	}
	// Host, port, username, authType or credentials may have just changed.
	// sshmgr.FilePool keys purely on connection id with a 10-minute idle
	// TTL, so without this, every pooled REST path (SFTP, stats polling,
	// RunCommand) would keep hitting the OLD host/credentials for up to 10
	// minutes. The interactive shell (sshmgr.Server.HandleWS) doesn't need
	// this: it dials fresh per WebSocket, so it never has a stale entry to
	// evict.
	if h.pool != nil {
		h.pool.Evict(conn.ID)
	}
	writeJSON(w, http.StatusOK, conn)
}

// DeleteConnection removes a saved connection. Its DB row cascades away
// (ssh_forwards.connection_id ... ON DELETE CASCADE), but that only cleans
// up the row — sshmgr.Forwarder keeps live listeners/clients in a purely
// in-memory map, and sshmgr.FilePool keeps a cached SSH+SFTP pair the same
// way. Neither is touched by a DB delete, so both are torn down explicitly
// here, BEFORE the row goes away, mirroring SSHForwardHandler.Delete.
func (h *SSHHandler) DeleteConnection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Stopping forwards for a connection id that turns out not to exist is
	// harmless: SSHForwards returns an empty list for an unknown id (it's a
	// plain SELECT ... WHERE, not a single-row lookup that errors), so the
	// loop below is simply a no-op and Stop is idempotent regardless. That
	// means no pre-existence check is needed here — the real not-found
	// signal still comes from DeleteSSHConnection below. A genuine SSHForwards
	// error is treated as best-effort cleanup and doesn't block the delete.
	if h.forwarder != nil {
		if forwards, err := h.st.SSHForwards(id); err == nil {
			for _, f := range forwards {
				_ = h.forwarder.Stop(f.ID) // idempotent, always returns nil
			}
		}
	}
	if h.pool != nil {
		h.pool.Evict(id)
	}
	if handleStoreErr(w, h.st.DeleteSSHConnection(id)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PostAcceptHostKey clears the connection's pinned host-key fingerprint
// after a host-key-changed block, so the next connect re-pins whatever key
// the host presents — the operator's explicit "accept new key".
func (h *SSHHandler) PostAcceptHostKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if handleStoreErr(w, h.st.SetSSHHostKey(id, nil)) {
		return
	}
	// Accepting a new host key means the identity of the host changed (or
	// was just confirmed after a change) — any cached pooled transport to
	// it, dialed under the old pin, must not be reused. Same nil-tolerance
	// and TTL rationale as PatchConnection above.
	if h.pool != nil {
		h.pool.Evict(id)
	}
	w.WriteHeader(http.StatusNoContent)
}
