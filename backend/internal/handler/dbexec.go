package handler

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
)

// DBExecHandler serves the database read path: the capability matrix, a
// liveness probe, object-tree introspection, and paged reads.
//
// Every endpoint is dual-routed. A connection with no executor machine runs on
// the hub, which dials the database itself. A connection pinned to a runtime
// runs there instead: the hub assembles the descriptor, forwards it over the
// authenticated machine hop, and the runtime dials. The endpoint shapes are
// identical either way, so the frontend never learns which happened.
type DBExecHandler struct {
	exec *service.DBExecService
}

func NewDBExecHandler(exec *service.DBExecService) *DBExecHandler {
	return &DBExecHandler{exec: exec}
}

// Runtime paths the hub forwards to. Split by side effect rather than by
// convenience: introspection is read-only metadata, exec touches data.
const (
	runtimeIntrospectPath = "/api/db/introspect"
	runtimeExecPath       = "/api/db/exec"
)

// runtimeDBRequest is the hub→runtime wire format. One struct covers every
// operation so the two runtime endpoints stay a single decode.
//
// Descriptor carries decrypted credentials. This value must never be logged
// and never travel toward a browser (see the package comment on
// service/dbexec.go).
type runtimeDBRequest struct {
	Descriptor port.DSNDescriptor `json:"descriptor"`
	// Op selects the operation; the set each endpoint accepts is listed on
	// RuntimeIntrospect and RuntimeExec.
	Op        string           `json:"op"`
	Tree      port.TreePath    `json:"tree"`
	Object    port.ObjectRef   `json:"object"`
	Filters   []port.Filter    `json:"filters"`
	Rows      port.RowsRequest `json:"rows"`
	Column    string           `json:"column"`
	Identity  []port.Filter    `json:"identity"`
	SQL       string           `json:"sql"`
	Args      []any            `json:"args"`
	Edits     []port.RowEdit   `json:"edits"`
	TablePlan port.TablePlan   `json:"tablePlan"`
}

// countResponse, lobResponse, and testResponse keep the hub-local and
// runtime-forwarded paths byte-identical: the hub decodes the runtime's JSON
// into exactly the type it would otherwise have built itself.
type countResponse struct {
	Count int64 `json:"count"`
}

// lobResponse carries one large-object cell. encoding/json renders []byte as
// base64, so the value survives the runtime hop unchanged.
type lobResponse struct {
	Value []byte `json:"value"`
}

// testResponse reports reachability. A connection that cannot be opened is
// data, not an error — same contract as GET /api/machines/{id}/health.
type testResponse struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

// GetEngines returns every registered engine's capabilities. The frontend
// renders tree nodes and toolbar actions from these rather than branching on
// engine name.
func (h *DBExecHandler) GetEngines(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, dbdriver.AllCaps())
}

// --- hub endpoints ----------------------------------------------------------

func (h *DBExecHandler) PostTree(w http.ResponseWriter, r *http.Request) {
	var p port.TreePath
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	out := []port.TreeNode{}
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "tree", Tree: p}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) { return c.Tree(ctx, p) })
}

func (h *DBExecHandler) PostColumns(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object port.ObjectRef `json:"object"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	out := []port.ColumnMeta{}
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "columns", Object: body.Object}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) { return c.Columns(ctx, body.Object) })
}

func (h *DBExecHandler) PostStats(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object port.ObjectRef `json:"object"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out port.TableStats
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "stats", Object: body.Object}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) { return c.Stats(ctx, body.Object) })
}

// PostCount runs COUNT(*). It is a separate endpoint precisely because it is
// never on a read path: the grid shows the engine's estimate, and an exact
// count is an explicit user action.
func (h *DBExecHandler) PostCount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object  port.ObjectRef `json:"object"`
		Filters []port.Filter  `json:"filters"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out countResponse
	h.dispatch(w, r, runtimeExecPath, runtimeDBRequest{Op: "count", Object: body.Object, Filters: body.Filters}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			n, err := c.CountExact(ctx, body.Object, body.Filters)
			return countResponse{Count: n}, err
		})
}

func (h *DBExecHandler) PostRows(w http.ResponseWriter, r *http.Request) {
	var req port.RowsRequest
	if _, err := decodeBody(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out port.ResultSet
	h.dispatch(w, r, runtimeExecPath, runtimeDBRequest{Op: "rows", Rows: req}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) { return c.Rows(ctx, req) })
}

// PostLOB fetches one large-object cell that Rows deferred to a size marker.
func (h *DBExecHandler) PostLOB(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object   port.ObjectRef `json:"object"`
		Column   string         `json:"column"`
		Identity []port.Filter  `json:"identity"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out lobResponse
	h.dispatch(w, r, runtimeExecPath,
		runtimeDBRequest{Op: "lob", Object: body.Object, Column: body.Column, Identity: body.Identity}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			v, err := c.LOBValue(ctx, body.Object, body.Column, body.Identity)
			return lobResponse{Value: v}, err
		})
}

// PostQuery runs read SQL from the editor. Phase 2 is read-only; statements
// that modify data arrive with the write path in Phase 3.
func (h *DBExecHandler) PostQuery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SQL  string `json:"sql"`
		Args []any  `json:"args"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if strings.TrimSpace(body.SQL) == "" {
		writeErr(w, http.StatusBadRequest, "sql is required")
		return
	}
	var out port.ResultSet
	h.dispatch(w, r, runtimeExecPath, runtimeDBRequest{Op: "query", SQL: body.SQL, Args: body.Args}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) { return c.Query(ctx, body.SQL, body.Args) })
}

// PostTest opens the connection, runs a trivial liveness query, and closes it.
//
// A connection that cannot be reached is data, not an error: this always
// answers 200 with {"ok":false,"reason":...}, matching the
// GET /api/machines/{id}/health contract in CONTRACTS.md. Rendering an
// unreachable database as an HTTP failure would make the UI show an error
// banner for something the operator is deliberately probing.
func (h *DBExecHandler) PostTest(w http.ResponseWriter, r *http.Request) {
	connID := r.PathValue("id")
	ctx, cancel := dbdriver.WithStatementTimeout(r.Context(), 0)
	defer cancel()

	// Store-level failures (unknown connection, an unpinned tunnel, a machine
	// URL that is no longer an acceptable executor) stay real HTTP errors —
	// they are configuration faults, not "the database is down".
	remote, machine, err := h.exec.IsRemote(connID)
	if handleStoreErr(w, err) {
		return
	}
	d, err := h.exec.Descriptor(connID)
	if handleStoreErr(w, err) {
		return
	}

	if remote {
		var out testResponse
		if err := machineclient.RunDBRequest(ctx, machine, runtimeExecPath,
			runtimeDBRequest{Descriptor: d, Op: "test"}, &out); err != nil {
			writeJSON(w, http.StatusOK, testResponse{OK: false, Reason: mapDriverErr("test", err, d)})
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	conn, release, err := h.exec.Conn(ctx, connID)
	if err != nil {
		writeJSON(w, http.StatusOK, testResponse{OK: false, Reason: mapDriverErr("connect", err, d)})
		return
	}
	defer release()
	if _, err := conn.Query(ctx, livenessQuery, nil); err != nil {
		writeJSON(w, http.StatusOK, testResponse{OK: false, Reason: mapDriverErr("connect", err, d)})
		return
	}
	writeJSON(w, http.StatusOK, testResponse{OK: true})
}

// livenessQuery is valid on PostgreSQL, MySQL, and SQLite alike.
const livenessQuery = "SELECT 1"

// dispatch runs one operation either on the hub or on the connection's
// executor runtime, writing the result or a scrubbed error.
//
// local produces the value for hub-local execution; out is a pointer to the
// same shape, used to decode a runtime's reply. Keeping both in one place is
// what guarantees the two transports return identical JSON.
func (h *DBExecHandler) dispatch(
	w http.ResponseWriter,
	r *http.Request,
	runtimePath string,
	req runtimeDBRequest,
	out any,
	local func(context.Context, port.DBConn) (any, error),
) {
	connID := r.PathValue("id")
	// Derived from the request context, so closing the browser tab cancels the
	// in-flight statement instead of leaving it pinning a connection.
	ctx, cancel := dbdriver.WithStatementTimeout(r.Context(), 0)
	defer cancel()

	remote, machine, err := h.exec.IsRemote(connID)
	if handleStoreErr(w, err) {
		return
	}
	// Assembled even for hub-local execution: mapDriverErr needs the credential
	// values to scrub them out of driver messages.
	d, err := h.exec.Descriptor(connID)
	if handleStoreErr(w, err) {
		return
	}

	if remote {
		req.Descriptor = d
		if err := machineclient.RunDBRequest(ctx, machine, runtimePath, req, out); err != nil {
			writeErr(w, statusForDBErr(err), mapDriverErr(req.Op, err, d))
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	conn, release, err := h.exec.Conn(ctx, connID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, mapDriverErr("connect", err, d))
		return
	}
	defer release()

	res, err := local(ctx, conn)
	if err != nil {
		writeErr(w, statusForDBErr(err), mapDriverErr(req.Op, err, d))
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// --- runtime endpoints ------------------------------------------------------

// RuntimeIntrospect answers read-only metadata operations for a descriptor the
// hub forwarded. Ops: tree, columns, stats.
//
// This route accepts decrypted credentials in its body, so it must only ever
// be registered behind key auth (see main.go).
func (h *DBExecHandler) RuntimeIntrospect(w http.ResponseWriter, r *http.Request) {
	h.runtimeRun(w, r, map[string]bool{
		"tree": true, "columns": true, "stats": true, "indexes": true, "ddlPreview": true, "showCreate": true,
	})
}

// RuntimeExec answers data operations for a forwarded descriptor.
// Ops: rows, query, count, lob, test.
func (h *DBExecHandler) RuntimeExec(w http.ResponseWriter, r *http.Request) {
	h.runtimeRun(w, r, map[string]bool{"rows": true, "query": true, "count": true, "lob": true, "test": true, "commit": true, "ddlApply": true})
}

// RuntimeClose releases a runtime-held connection for a descriptor.
//
// Phase 2 opens and closes a connection per request, so there is nothing
// cached to release and this is a no-op acknowledgement. The route exists now
// so the hub's teardown call is not a 404 and so connection pooling can be
// added on the runtime side without a protocol change.
func (h *DBExecHandler) RuntimeClose(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// runtimeRun decodes a forwarded request, dials the described database, runs
// the operation, and closes. allowed restricts which operations this endpoint
// answers, so /api/db/introspect cannot be used to run arbitrary SQL.
func (h *DBExecHandler) runtimeRun(w http.ResponseWriter, r *http.Request, allowed map[string]bool) {
	var req runtimeDBRequest
	if _, err := decodeBody(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !allowed[req.Op] {
		writeErr(w, http.StatusBadRequest, "unsupported operation for this endpoint")
		return
	}

	ctx, cancel := dbdriver.WithStatementTimeout(r.Context(), 0)
	defer cancel()

	drv, err := dbdriver.Get(req.Descriptor.Engine)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	conn, err := drv.Open(ctx, req.Descriptor)
	if err != nil {
		if req.Op == "test" {
			writeJSON(w, http.StatusOK, testResponse{OK: false, Reason: mapDriverErr("connect", err, req.Descriptor)})
			return
		}
		writeErr(w, http.StatusInternalServerError, mapDriverErr("connect", err, req.Descriptor))
		return
	}
	defer func() { _ = conn.Close() }()

	res, err := runOp(ctx, conn, req)
	if err != nil {
		writeErr(w, statusForDBErr(err), mapDriverErr(req.Op, err, req.Descriptor))
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// runOp maps an operation name onto the matching port.DBConn call. It returns
// the same shapes the hub-local path produces.
func runOp(ctx context.Context, conn port.DBConn, req runtimeDBRequest) (any, error) {
	switch req.Op {
	case "tree":
		return conn.Tree(ctx, req.Tree)
	case "columns":
		return conn.Columns(ctx, req.Object)
	case "stats":
		return conn.Stats(ctx, req.Object)
	case "indexes":
		return conn.Indexes(ctx, req.Object)
	case "showCreate":
		dr, ok := conn.(port.DDLReader)
		if !ok {
			return nil, errors.New("this engine does not support DDL introspection")
		}
		ddl, err := dr.ShowCreate(ctx, req.Object)
		return showCreateResponse{DDL: ddl}, err
	case "rows":
		return conn.Rows(ctx, req.Rows)
	case "query":
		return conn.Query(ctx, req.SQL, req.Args)
	case "count":
		n, err := conn.CountExact(ctx, req.Object, req.Filters)
		return countResponse{Count: n}, err
	case "lob":
		v, err := conn.LOBValue(ctx, req.Object, req.Column, req.Identity)
		return lobResponse{Value: v}, err
	case "commit":
		rw, ok := conn.(port.RowWriter)
		if !ok {
			return nil, errors.New("this engine does not support row writes")
		}
		return rw.CommitEdits(ctx, req.Edits)
	case "ddlPreview":
		dw, ok := conn.(port.DDLWriter)
		if !ok {
			return nil, errors.New("this engine does not support DDL")
		}
		stmts, err := dw.Plan(ctx, req.TablePlan)
		return ddlPreviewResponse{Statements: stmts}, err
	case "ddlApply":
		dw, ok := conn.(port.DDLWriter)
		if !ok {
			return nil, errors.New("this engine does not support DDL")
		}
		return dw.Apply(ctx, req.TablePlan)
	case "test":
		if _, err := conn.Query(ctx, livenessQuery, nil); err != nil {
			return testResponse{OK: false, Reason: mapDriverErr("connect", err, req.Descriptor)}, nil
		}
		return testResponse{OK: true}, nil
	default:
		return nil, errors.New("unsupported operation")
	}
}

// --- error mapping ----------------------------------------------------------

// statusForDBErr classifies a driver/commit error into its HTTP status.
// Every op defaults to 500; a rows-affected mismatch is a conflict (409) the
// client can retry after re-reading the row, not a server fault.
// errors.As also unwraps a forwarded runtime's *machineclient.RemoteError, so
// a remote commit's conflict is classified identically to a local one — this
// is the mechanism that survives the hub→runtime JSON hop, where a plain
// Go error's type would not.
func statusForDBErr(err error) int {
	if errors.Is(err, port.ErrRowsAffectedMismatch) {
		return http.StatusConflict
	}
	var remoteErr *machineclient.RemoteError
	if errors.As(err, &remoteErr) && remoteErr.Status == http.StatusConflict {
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}

// mapDriverErr turns a driver failure into a message that is safe to hand a
// client, and records it server-side.
//
// Driver errors routinely quote the connection string they failed to dial, so
// returning err.Error() verbatim would publish the database password to
// whoever triggered the failure. Every credential in the descriptor is
// therefore replaced before the text leaves this function — including in the
// log line, since a log file is not a safe home for a plaintext password
// either.
func mapDriverErr(op string, err error, d port.DSNDescriptor) string {
	if op == "" {
		op = "database request"
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		log.Printf("db %s: connection %s: statement timed out", op, d.ConnectionID)
		return op + ": the statement exceeded its time limit and was cancelled"
	case errors.Is(err, context.Canceled):
		log.Printf("db %s: connection %s: cancelled", op, d.ConnectionID)
		return op + ": the request was cancelled"
	}
	msg := redactCredentials(err.Error(), d)
	log.Printf("db %s: connection %s: %s", op, d.ConnectionID, msg)
	return op + ": " + msg
}

// redactCredentials replaces every secret carried by the descriptor with a
// placeholder wherever it appears in s.
func redactCredentials(s string, d port.DSNDescriptor) string {
	secrets := []string{d.Password, d.ClientKey, d.CACert, d.ClientCert}
	if d.Tunnel != nil {
		secrets = append(secrets, d.Tunnel.Password, d.Tunnel.PrivateKey, d.Tunnel.Passphrase)
	}
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		s = strings.ReplaceAll(s, secret, "[redacted]")
	}
	return s
}
