package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
)

// RuntimeSSHHandler backs /api/runtime/ssh/secret, the machine-key-gated
// route a runtime calls to decrypt one of its OWN connections' credentials.
//
// This route hands a decrypted SSH password or private key to another
// process, so it is the most sensitive route in the codebase and every line
// below exists to bound that.
//
// It exists because DevOps chat now runs entirely on the executor runtime —
// the agent process AND the SSH tool calls it makes — rather than the agent
// running on the hub and only the TCP dial being tunnelled out (the split
// sshmgr/executor.go still implements for the shell/SFTP/forwarding paths,
// which are unchanged). Executing the tools next to the agent means the
// dialing process needs the credential, and the credential lives encrypted
// on the hub.
//
// The trust boundary this widens is real and deliberate: before this, a
// runtime relayed bytes for an SSH session and "never sees a password, a
// private key, or the plaintext session" (sshmgr/executor.go). A runtime that
// serves DevOps chat now does. The compensating control is scope, enforced
// below: a machine may only ever decrypt credentials for connections whose
// ExecutorMachineID names that same machine. A registered runtime cannot ask
// for a connection it does not execute, and cannot enumerate connections at
// all — it must already know the id, which it learns only from its own
// machine-scoped catalog slice (store.CatalogForMachine).
type RuntimeSSHHandler struct {
	st      port.Store
	secrets *service.SSHSecretService
}

func NewRuntimeSSHHandler(st port.Store, secrets *service.SSHSecretService) *RuntimeSSHHandler {
	return &RuntimeSSHHandler{st: st, secrets: secrets}
}

type runtimeSSHSecretBody struct {
	ConnectionID string `json:"connectionId"`
	// Kind is "password" | "privatekey" | "passphrase" — sshmgr.SecretSource's
	// own vocabulary, passed straight through.
	Kind string `json:"kind"`
}

// PostSecret handles POST /api/runtime/ssh/secret.
//
// Answers {"value":"…","found":true} or {"found":false}. A missing credential
// is NOT an error: sshmgr.SecretSource's contract is (value, ok, error), and a
// connection that authenticates by key legitimately has no password stored.
//
// The response body is never logged, here or in machineclient.FetchSSHSecret
// on the other side — the same rule machineclient.RunDBRequest already states
// for the descriptor it forwards.
func (h *RuntimeSSHHandler) PostSecret(w http.ResponseWriter, r *http.Request) {
	m, ok := MachineFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body runtimeSSHSecretBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.ConnectionID == "" || body.Kind == "" {
		writeErr(w, http.StatusBadRequest, "connectionId and kind are required")
		return
	}

	conn, err := h.st.SSHConnectionByID(body.ConnectionID)
	if handleStoreErr(w, err) {
		return
	}
	// The authorization check, and the reason this route is safe to expose.
	// Deliberately 404 rather than 403: a machine that may not execute this
	// connection must not be able to tell "exists but not yours" apart from
	// "does not exist", or this route becomes an oracle for enumerating the
	// operator's whole SSH inventory by id.
	if conn.ExecutorMachineID == nil || *conn.ExecutorMachineID != m.ID {
		writeErr(w, http.StatusNotFound, "connection not found")
		return
	}

	value, found, err := h.secrets.Get(body.ConnectionID, body.Kind)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read credential")
		return
	}
	if !found {
		writeJSON(w, http.StatusOK, map[string]any{"found": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"found": true, "value": value})
}
