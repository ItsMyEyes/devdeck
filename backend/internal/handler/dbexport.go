// Handler for the database module's bulk export path. Kept separate from
// dbexec.go (the paged read path) because it is the one endpoint that streams
// its response instead of writing one JSON document; it defines a method on
// the same *DBExecHandler and reuses its routing decisions.
package handler

import (
	"log"
	"net/http"
	"strings"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/dbquery"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
)

const (
	// exportPageSize is how many rows each Rows call asks for. Bounded so a
	// wide table's page stays a reasonable amount of memory, and so an export
	// the client abandons stops within one page.
	exportPageSize = 1000

	// exportMaxRows is the hard server cap. An export is a file the operator
	// downloads; without a ceiling, one request against a billion-row table
	// would stream until something else broke.
	exportMaxRows = 1000000
)

// exportRequest is the POST body. Object/Filters/Sort mirror PostRows so the
// grid can export exactly what it is showing.
type exportRequest struct {
	Object  port.ObjectRef `json:"object"`
	Filters []port.Filter  `json:"filters"`
	Sort    []port.SortKey `json:"sort"`
	Format  string         `json:"format"`
	// Limit caps the rows written. 0 means "up to the server cap".
	Limit int `json:"limit"`
}

// PostExport streams a table's rows to the response in csv, json, or sql.
//
// Unlike every other endpoint here it writes its body incrementally, which
// changes the error contract partway through: once the first byte is out, the
// status line and headers are already committed and there is no way to send
// the {"error":...} envelope. Failures before that point use the envelope as
// usual; failures after it abort the connection, so the client sees a
// truncated download rather than a valid file that silently stops early.
//
// Routing matches PostRows: hub-local execution opens one connection and pages
// through it, and a connection pinned to a runtime forwards one "rows" request
// per page over the machine hop. The output is identical either way.
func (h *DBExecHandler) PostExport(w http.ResponseWriter, r *http.Request) {
	var body exportRequest
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if strings.TrimSpace(body.Object.Name) == "" {
		writeErr(w, http.StatusBadRequest, "object.name is required")
		return
	}
	switch body.Format {
	case dbquery.FormatCSV, dbquery.FormatJSON, dbquery.FormatSQL:
	default:
		writeErr(w, http.StatusBadRequest, "format must be one of csv, json, sql")
		return
	}
	if body.Limit < 0 {
		writeErr(w, http.StatusBadRequest, "limit must not be negative")
		return
	}

	connID := r.PathValue("id")
	ctx, cancel := dbdriver.WithStatementTimeout(r.Context(), 0)
	defer cancel()

	remote, machine, err := h.exec.IsRemote(connID)
	if handleStoreErr(w, err) {
		return
	}
	d, err := h.exec.Descriptor(connID)
	if handleStoreErr(w, err) {
		return
	}

	// One page is fetched before any byte is written, so the common failures
	// (unknown table, unreachable database, a rejected identifier) still land
	// in the normal envelope with mapDriverErr's redaction applied.
	var fetch func(cursor []any, offset, limit int) (port.ResultSet, error)
	if remote {
		fetch = func(cursor []any, offset, limit int) (port.ResultSet, error) {
			var out port.ResultSet
			req := runtimeDBRequest{Descriptor: d, Op: "rows", Rows: port.RowsRequest{
				Object: body.Object, Filters: body.Filters, Sort: body.Sort,
				Cursor: cursor, Offset: offset, Limit: limit,
			}}
			err := machineclient.RunDBRequest(ctx, machine, runtimeExecPath, req, &out)
			return out, err
		}
	} else {
		conn, release, err := h.exec.Conn(ctx, connID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, mapDriverErr("connect", err, d))
			return
		}
		defer release()
		fetch = func(cursor []any, offset, limit int) (port.ResultSet, error) {
			return conn.Rows(ctx, port.RowsRequest{
				Object: body.Object, Filters: body.Filters, Sort: body.Sort,
				Cursor: cursor, Offset: offset, Limit: limit,
			})
		}
	}

	first, err := fetch(nil, 0, exportPageSize)
	if err != nil {
		writeErr(w, statusForDBErr(err), mapDriverErr("export", err, d))
		return
	}

	// LOB columns carry a size placeholder rather than a value in a ResultSet
	// (see the projection in each driver's Rows), so they are dropped from
	// every format instead of writing a byte count where data belongs.
	cols, indexes, omitted := dbquery.SplitExportColumns(first.Columns)
	if len(cols) == 0 {
		writeErr(w, http.StatusBadRequest, "no exportable columns: every column is a large object")
		return
	}

	caps, err := h.exec.EngineCaps(d.Engine)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	spec := dbquery.ExportSpec{
		Object: body.Object, Columns: cols, OmittedLOB: omitted,
		Caps: caps, Engine: d.Engine,
	}

	// Built before the header goes out: the sql encoder's Begin quotes the
	// object and column names, and QuoteIdent rejects a hostile identifier
	// rather than escaping it — that rejection has to be an envelope, not a
	// truncated file.
	var buf deferredWriter
	enc, err := dbquery.NewExportEncoder(body.Format, &buf, spec)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := enc.Begin(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	w.Header().Set("Content-Type", dbquery.ExportContentType(body.Format))
	w.Header().Set("Content-Disposition", contentDisposition(body.Object.Name+dbquery.ExportExtension(body.Format)))
	w.WriteHeader(http.StatusOK)
	buf.to = w
	if err := buf.flush(); err != nil {
		return
	}

	limit := exportMaxRows
	if body.Limit > 0 && body.Limit < limit {
		limit = body.Limit
	}

	written := 0
	page := first
	// requested tracks what the page just fetched actually asked for. A page
	// shorter than its own request means the table is exhausted — comparing
	// against exportPageSize instead would cut the last partial page short
	// whenever the remaining budget shrank the request below it.
	requested := exportPageSize
	offset := 0
	for {
		for _, row := range page.Rows {
			if written >= limit {
				break
			}
			if err := enc.Row(dbquery.ProjectRow(row, indexes)); err != nil {
				abortExport(connID, err)
				return
			}
			written++
		}
		if written >= limit || len(page.Rows) < requested {
			break
		}

		var cursor []any
		if page.UsedOffsetPaging {
			// No usable keyset cursor (no primary key, or a nullable sort
			// column) — fall back to the offset the driver honors in that mode.
			offset += len(page.Rows)
		} else {
			if page.NextCursor == nil {
				break
			}
			cursor = page.NextCursor
		}

		requested = exportPageSize
		if remaining := limit - written; remaining < requested {
			requested = remaining
		}
		page, err = fetch(cursor, offset, requested)
		if err != nil {
			abortExport(connID, err)
			return
		}
	}

	if err := enc.End(); err != nil {
		abortExport(connID, err)
		return
	}
	_ = buf.flush()
}

// abortExport ends a partially written response without a valid trailer.
//
// The status line and headers are long gone by this point, so the envelope is
// unavailable; panicking with http.ErrAbortHandler makes net/http drop the
// connection without logging a stack trace, which is what turns the download
// into a visible failure instead of a file that quietly ends early. The real
// cause is logged server-side first — the redacted form, since a driver error
// quotes the DSN it failed on.
func abortExport(connID string, err error) {
	log.Printf("db export: connection %s: aborted mid-stream: %v", connID, err)
	panic(http.ErrAbortHandler)
}

// deferredWriter buffers the encoder's output until the response headers have
// been committed, then writes straight through.
//
// The encoder has to run its preamble before the header is sent (so an
// identifier rejection can still be an envelope), but that preamble is already
// body bytes. Holding them for one flush is what lets both be true.
type deferredWriter struct {
	pending []byte
	to      http.ResponseWriter
}

func (b *deferredWriter) Write(p []byte) (int, error) {
	if b.to == nil {
		b.pending = append(b.pending, p...)
		return len(p), nil
	}
	if err := b.flush(); err != nil {
		return 0, err
	}
	n, err := b.to.Write(p)
	if err == nil {
		// Streaming an export through a proxy is the normal deployment, and an
		// un-flushed 1000-row page can sit in a buffer for a long time.
		if f, ok := b.to.(http.Flusher); ok {
			f.Flush()
		}
	}
	return n, err
}

func (b *deferredWriter) flush() error {
	if b.to == nil || len(b.pending) == 0 {
		return nil
	}
	_, err := b.to.Write(b.pending)
	b.pending = nil
	return err
}
