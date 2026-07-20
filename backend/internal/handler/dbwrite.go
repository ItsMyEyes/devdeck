// Handlers for the database module's write path: row commits and table/index
// DDL. Kept separate from dbexec.go (the read path) so neither file grows
// unwieldy; both define methods on the same *DBExecHandler and share its
// dispatch()/runOp() machinery.
package handler

import (
	"context"
	"errors"
	"net/http"

	"devdeck/backend/internal/port"
)

// PostIndexes lists a table's indexes — needed by the frontend to explain why
// a table is or is not editable (the row-identity ladder's level 2), and by
// the table designer to show existing indexes before altering them.
func (h *DBExecHandler) PostIndexes(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object port.ObjectRef `json:"object"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	out := []port.IndexMeta{}
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "indexes", Object: body.Object}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) { return c.Indexes(ctx, body.Object) })
}

// PostCommit applies a batch of pending grid edits as one transaction. Each
// edit's row identity is resolved fresh against the object's live schema —
// never trusted from the request — inside RowWriter.CommitEdits; a
// rows-affected mismatch rolls back the whole batch and this returns 409 via
// dispatch's statusForDBErr, so the client can re-read the row and retry
// rather than silently doing nothing or corrupting an unrelated row.
func (h *DBExecHandler) PostCommit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Edits []port.RowEdit `json:"edits"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(body.Edits) == 0 {
		writeErr(w, http.StatusBadRequest, "edits is required")
		return
	}
	var out port.CommitResult
	h.dispatch(w, r, runtimeExecPath, runtimeDBRequest{Op: "commit", Edits: body.Edits}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			rw, ok := c.(port.RowWriter)
			if !ok {
				return nil, errors.New("this engine does not support row writes")
			}
			return rw.CommitEdits(ctx, body.Edits)
		})
}

type ddlPreviewResponse struct {
	Statements []string `json:"statements"`
}

// PostDDLPreview renders the exact statements a TablePlan implies without
// executing them — the "preview before apply" step the design calls for.
func (h *DBExecHandler) PostDDLPreview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Plan port.TablePlan `json:"plan"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out ddlPreviewResponse
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "ddlPreview", TablePlan: body.Plan}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			dw, ok := c.(port.DDLWriter)
			if !ok {
				return nil, errors.New("this engine does not support DDL")
			}
			stmts, err := dw.Plan(ctx, body.Plan)
			return ddlPreviewResponse{Statements: stmts}, err
		})
}

// PostDDLApply executes a TablePlan's statements inside one transaction.
func (h *DBExecHandler) PostDDLApply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Plan port.TablePlan `json:"plan"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out port.CommitResult
	h.dispatch(w, r, runtimeExecPath, runtimeDBRequest{Op: "ddlApply", TablePlan: body.Plan}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			dw, ok := c.(port.DDLWriter)
			if !ok {
				return nil, errors.New("this engine does not support DDL")
			}
			return dw.Apply(ctx, body.Plan)
		})
}

type showCreateResponse struct {
	DDL string `json:"ddl"`
}

// PostShowCreate renders an object's CREATE statement — a read-only-tab
// convenience in Navicat-style tools, and the "generated DDL" tab the design
// calls for.
func (h *DBExecHandler) PostShowCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object port.ObjectRef `json:"object"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out showCreateResponse
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "showCreate", Object: body.Object}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			dr, ok := c.(port.DDLReader)
			if !ok {
				return nil, errors.New("this engine does not support DDL introspection")
			}
			ddl, err := dr.ShowCreate(ctx, body.Object)
			return showCreateResponse{DDL: ddl}, err
		})
}
