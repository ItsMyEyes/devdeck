package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// DBHandler serves the hub's database-connection registry. Credentials ride
// in on create/update bodies, are encrypted at rest via DBSecretService, and
// never serialize back out (domain.DBSecret is json:"-" throughout).
type DBHandler struct {
	st      *store.Store
	secrets *service.DBSecretService
}

func NewDBHandler(st *store.Store, secrets *service.DBSecretService) *DBHandler {
	return &DBHandler{st: st, secrets: secrets}
}

// dbSecretFields are the write-only credential fields accepted alongside
// connection fields. Absent means "leave unchanged".
type dbSecretFields struct {
	Password   *string `json:"password"`
	CACert     *string `json:"caCert"`
	ClientCert *string `json:"clientCert"`
	ClientKey  *string `json:"clientKey"`
}

type dbConnectionBody struct {
	Name               *string `json:"name"`
	Group              *string `json:"group"`
	Engine             *string `json:"engine"`
	Host               *string `json:"host"`
	Port               *int    `json:"port"`
	Username           *string `json:"username"`
	Database           *string `json:"database"`
	SSLMode            *string `json:"sslMode"`
	ExecutorMachineID  *string `json:"executorMachineId"`
	TunnelConnectionID *string `json:"tunnelConnectionId"`
	IsProduction       *bool   `json:"isProduction"`
	dbSecretFields
}

// validateDBExecutor checks the machine exists and that the hub may send
// decrypted credentials to it over its registered URL.
func (h *DBHandler) validateDBExecutor(machineID string) error {
	m, err := h.st.MachineByID(machineID)
	if err != nil {
		return fmt.Errorf("executor machine %s not found", machineID)
	}
	return service.ValidateExecutorURL(m.URL)
}

// validateDBTunnel checks that tunnelID names an existing SSH connection.
func (h *DBHandler) validateDBTunnel(tunnelID string) error {
	if _, err := h.st.SSHConnectionByID(tunnelID); err != nil {
		return fmt.Errorf("tunnel connection %s not found", tunnelID)
	}
	return nil
}

// storeSecrets persists any non-empty credential fields, replacing whatever
// was previously stored for that kind. Blank/absent means "leave unchanged".
func (h *DBHandler) storeSecrets(connectionID string, s dbSecretFields) error {
	if s.Password != nil && *s.Password != "" {
		if err := h.secrets.Set(connectionID, "password", *s.Password); err != nil {
			return err
		}
	}
	if s.CACert != nil && *s.CACert != "" {
		if err := h.secrets.Set(connectionID, "ca_cert", *s.CACert); err != nil {
			return err
		}
	}
	if s.ClientCert != nil && *s.ClientCert != "" {
		if err := h.secrets.Set(connectionID, "client_cert", *s.ClientCert); err != nil {
			return err
		}
	}
	if s.ClientKey != nil && *s.ClientKey != "" {
		if err := h.secrets.Set(connectionID, "client_key", *s.ClientKey); err != nil {
			return err
		}
	}
	return nil
}

// GetConnections lists saved database connections (never their secrets).
func (h *DBHandler) GetConnections(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.DBConnections()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *DBHandler) PostConnection(w http.ResponseWriter, r *http.Request) {
	var body dbConnectionBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	engine := str(body.Engine)
	if err := service.ValidateEngine(engine); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	isProduction := body.IsProduction != nil && *body.IsProduction
	sslMode := str(body.SSLMode)
	if err := service.ValidateSSLMode(engine, sslMode, isProduction); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := service.ValidateDBHost(str(body.Host)); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	executorMachineID := nilIfEmpty(body.ExecutorMachineID)
	if executorMachineID != nil {
		if err := h.validateDBExecutor(*executorMachineID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	tunnelConnectionID := nilIfEmpty(body.TunnelConnectionID)
	if tunnelConnectionID != nil {
		if err := h.validateDBTunnel(*tunnelConnectionID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	portNum := 0
	if body.Port != nil {
		portNum = *body.Port
	}
	conn, err := h.st.CreateDBConnection(str(body.Name), str(body.Group), engine, str(body.Host), portNum,
		str(body.Username), str(body.Database), sslMode, executorMachineID, tunnelConnectionID, isProduction)
	if handleStoreErr(w, err) {
		return
	}
	if handleStoreErr(w, h.storeSecrets(conn.ID, body.dbSecretFields)) {
		return
	}
	writeJSON(w, http.StatusOK, conn)
}

func (h *DBHandler) PatchConnection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	existing, err := h.st.DBConnectionByID(id)
	if handleStoreErr(w, err) {
		return
	}

	var body struct {
		port.DBConnectionPatch
		dbSecretFields
	}
	raw, err := decodeBody(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, ok := raw["executorMachineId"]; ok {
		body.HasExecutorMachineID = true
		body.ExecutorMachineID = nilIfEmpty(body.ExecutorMachineID)
	}
	if _, ok := raw["tunnelConnectionId"]; ok {
		body.HasTunnelConnectionID = true
		body.TunnelConnectionID = nilIfEmpty(body.TunnelConnectionID)
	}

	// Validation must run against the merged post-patch state, not just the
	// fields present in this request body — otherwise flipping isProduction
	// to true on a connection whose sslMode was never verified would sail
	// through untouched.
	engine := existing.Engine
	if body.Engine != nil {
		engine = *body.Engine
	}
	sslMode := existing.SSLMode
	if body.SSLMode != nil {
		sslMode = *body.SSLMode
	}
	host := existing.Host
	if body.Host != nil {
		host = *body.Host
	}
	isProduction := existing.IsProduction
	if body.IsProduction != nil {
		isProduction = *body.IsProduction
	}
	executorMachineID := existing.ExecutorMachineID
	if body.HasExecutorMachineID {
		executorMachineID = body.ExecutorMachineID
	}
	tunnelConnectionID := existing.TunnelConnectionID
	if body.HasTunnelConnectionID {
		tunnelConnectionID = body.TunnelConnectionID
	}

	if err := service.ValidateEngine(engine); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := service.ValidateSSLMode(engine, sslMode, isProduction); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := service.ValidateDBHost(host); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if executorMachineID != nil {
		if err := h.validateDBExecutor(*executorMachineID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if tunnelConnectionID != nil {
		if err := h.validateDBTunnel(*tunnelConnectionID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	conn, err := h.st.UpdateDBConnection(id, body.DBConnectionPatch)
	if handleStoreErr(w, err) {
		return
	}
	if handleStoreErr(w, h.storeSecrets(conn.ID, body.dbSecretFields)) {
		return
	}
	writeJSON(w, http.StatusOK, conn)
}

func (h *DBHandler) DeleteConnection(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteDBConnection(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validDBSecretKind reports whether kind is one of the credential kinds
// DBSecretService understands.
func validDBSecretKind(kind string) bool {
	switch kind {
	case "password", "ca_cert", "client_cert", "client_key":
		return true
	default:
		return false
	}
}

// PostSecret sets or clears a single credential kind for a connection. An
// empty value clears the credential rather than storing an empty secret.
func (h *DBHandler) PostSecret(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind  *string `json:"kind"`
		Value *string `json:"value"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	kind := str(body.Kind)
	if !validDBSecretKind(kind) {
		writeErr(w, http.StatusBadRequest, "kind must be one of password, ca_cert, client_cert, client_key")
		return
	}
	id := r.PathValue("id")
	value := str(body.Value)
	var err error
	if value == "" {
		err = h.secrets.Clear(id, kind)
	} else {
		err = h.secrets.Set(id, kind, value)
	}
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetSavedQueries lists a connection's saved SQL snippets.
func (h *DBHandler) GetSavedQueries(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.DBSavedQueries(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *DBHandler) PostSavedQuery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string `json:"name"`
		SQL  *string `json:"sql"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	q, err := h.st.CreateDBSavedQuery(r.PathValue("id"), str(body.Name), str(body.SQL), time.Now().UTC().Format(time.RFC3339))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, q)
}

func (h *DBHandler) PatchSavedQuery(w http.ResponseWriter, r *http.Request) {
	var patch port.DBSavedQueryPatch
	if _, err := decodeBody(r, &patch); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	q, err := h.st.UpdateDBSavedQuery(r.PathValue("qid"), time.Now().UTC().Format(time.RFC3339), patch)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, q)
}

func (h *DBHandler) DeleteSavedQuery(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteDBSavedQuery(r.PathValue("qid"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// History query-parameter bounds. The default is what the panel shows without
// asking; the maximum matches the per-connection retention cap in
// store.AddDBQueryHistory, so a larger request cannot return more anyway.
const (
	defaultHistoryLimit = 50
	maxHistoryLimit     = 200
)

// GetQueryHistory lists a connection's recorded SQL editor executions, newest
// first. ?limit= is optional; an out-of-range value is clamped rather than
// rejected, but an unparseable one is a client bug worth reporting.
func (h *DBHandler) GetQueryHistory(w http.ResponseWriter, r *http.Request) {
	limit := defaultHistoryLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "limit must be an integer")
			return
		}
		limit = n
	}
	if limit <= 0 {
		limit = defaultHistoryLimit
	}
	if limit > maxHistoryLimit {
		limit = maxHistoryLimit
	}
	list, err := h.st.DBQueryHistory(r.PathValue("id"), limit)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// DeleteQueryHistory clears a connection's recorded executions. Clearing an
// already-empty history is not an error — see store.ClearDBQueryHistory.
func (h *DBHandler) DeleteQueryHistory(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.ClearDBQueryHistory(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
