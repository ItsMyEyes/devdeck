package handler

import (
	"net/http"

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

// sshSecretFields are the write-only credential fields accepted alongside
// connection fields on create/update. Blank/absent means "leave unchanged".
type sshSecretFields struct {
	Password   *string `json:"password"`
	PrivateKey *string `json:"privateKey"`
	Passphrase *string `json:"passphrase"`
}

func (h *SSHHandler) storeSecrets(connectionID string, s sshSecretFields) error {
	if s.Password != nil && *s.Password != "" {
		if err := h.secrets.Set(connectionID, "password", *s.Password); err != nil {
			return err
		}
	}
	if s.PrivateKey != nil && *s.PrivateKey != "" {
		if err := h.secrets.Set(connectionID, "privatekey", *s.PrivateKey); err != nil {
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
		Name     *string `json:"name"`
		Host     *string `json:"host"`
		Port     *int    `json:"port"`
		Username *string `json:"username"`
		AuthType *string `json:"authType"`
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
	if authType == "privatekey" && (body.PrivateKey == nil || *body.PrivateKey == "") {
		writeErr(w, http.StatusBadRequest, "privateKey is required for privatekey auth")
		return
	}
	conn, err := h.st.CreateSSHConnection(str(body.Name), str(body.Host), portNum, str(body.Username), authType)
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
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.AuthType != nil && !validSSHAuthType(*body.AuthType) {
		writeErr(w, http.StatusBadRequest, "authType must be \"password\" or \"privatekey\"")
		return
	}
	if body.Port != nil && (*body.Port < 1 || *body.Port > 65535) {
		writeErr(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}
	conn, err := h.st.UpdateSSHConnection(r.PathValue("id"), body.SSHConnectionPatch)
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
