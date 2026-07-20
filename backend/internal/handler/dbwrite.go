// Handlers for the database module's write path: row commits and table/index
// DDL. Kept separate from dbexec.go (the read path) so neither file grows
// unwieldy; both define methods on the same *DBExecHandler and share its
// dispatch()/runOp() machinery.
package handler

import (
	"context"
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
