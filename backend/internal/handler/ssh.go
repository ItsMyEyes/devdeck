package handler

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"loom/backend/internal/port"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

// SSHHandler handles the hub's saved-SSH-connection registry. Secrets ride
// in on create/update bodies, are encrypted at rest via SSHSecretService,
// and never serialize back out (domain.SSHSecret is json:"-" throughout).
type SSHHandler struct {
	st      *store.Store
	secrets *service.SSHSecretService
}

func NewSSHHandler(st *store.Store, secrets *service.SSHSecretService) *SSHHandler {
	return &SSHHandler{st: st, secrets: secrets}
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
	writeJSON(w, http.StatusOK, conn)
}

func (h *SSHHandler) DeleteConnection(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteSSHConnection(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PostAcceptHostKey clears the connection's pinned host-key fingerprint
// after a host-key-changed block, so the next connect re-pins whatever key
// the host presents — the operator's explicit "accept new key".
func (h *SSHHandler) PostAcceptHostKey(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.SetSSHHostKey(r.PathValue("id"), nil)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
