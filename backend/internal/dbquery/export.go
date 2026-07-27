package dbquery

import (
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"

	"devdeck/backend/internal/port"
)

// Export formats. These are the values the export endpoint accepts in its
// "format" field.
const (
	FormatCSV  = "csv"
	FormatJSON = "json"
	FormatSQL  = "sql"
)

// ExportSpec is everything an encoder needs that does not change per row.
//
// Columns must already have had LOB columns removed (see SplitExportColumns):
// a ResultSet's cell for a LOB column is a size placeholder rather than the
// value, so exporting it would write a byte count where the operator expects
// data. OmittedLOB names what was dropped, so the sql encoder can say so.
type ExportSpec struct {
	Object     port.ObjectRef
	Columns    []port.ColumnMeta
	OmittedLOB []string
	Caps       port.DBCaps
	// Engine selects the literal dialect for the sql format ("postgres" |
	// "mysql" | "sqlite"). Unused by csv and json.
	Engine string
}

// ExportEncoder streams rows in one format. Begin writes any preamble, Row is
// called once per row as pages arrive, and End writes the closing bytes.
//
// It is deliberately a streaming interface rather than a "render these rows"
// function: an export can be a million rows, and buffering them to build one
// string would hold the whole table in memory.
type ExportEncoder interface {
	Begin() error
	Row(values []any) error
	End() error
}

// NewExportEncoder returns the encoder for format, writing to w.
func NewExportEncoder(format string, w io.Writer, spec ExportSpec) (ExportEncoder, error) {
	switch format {
	case FormatCSV:
		return &csvEncoder{w: csv.NewWriter(w), spec: spec}, nil
	case FormatJSON:
		return &jsonEncoder{w: w, spec: spec}, nil
	case FormatSQL:
		return &sqlEncoder{w: w, spec: spec}, nil
	default:
		return nil, fmt.Errorf("unsupported export format %q", format)
	}
}

// ExportContentType maps a format to its response Content-Type. The sql format
// is text/plain rather than application/sql: the latter is unregistered, and a
// browser handles the former predictably.
func ExportContentType(format string) string {
	switch format {
	case FormatCSV:
		return "text/csv"
	case FormatJSON:
		return "application/json"
	case FormatSQL:
		return "text/plain"
	default:
		return "application/octet-stream"
	}
}

// ExportExtension maps a format to the filename extension used in the
// attachment Content-Disposition.
func ExportExtension(format string) string {
	switch format {
	case FormatCSV:
		return ".csv"
	case FormatJSON:
		return ".json"
	case FormatSQL:
		return ".sql"
	default:
		return ".txt"
	}
}

// SplitExportColumns partitions cols into the ones an export can carry and the
// LOB columns it must drop, returning the surviving columns, their indexes
// into an unprojected row, and the dropped column names.
func SplitExportColumns(cols []port.ColumnMeta) (keep []port.ColumnMeta, indexes []int, omitted []string) {
	keep = make([]port.ColumnMeta, 0, len(cols))
	indexes = make([]int, 0, len(cols))
	omitted = []string{}
	for i, c := range cols {
		if c.IsLOB {
			omitted = append(omitted, c.Name)
			continue
		}
		keep = append(keep, c)
		indexes = append(indexes, i)
	}
	return keep, indexes, omitted
}

// ProjectRow selects indexes out of a full result row. An index past the end
// of the row yields nil rather than panicking: by the time rows are streaming,
// the response status and headers are already committed, so a malformed row
// must degrade to an empty cell instead of tearing down the process.
func ProjectRow(row []any, indexes []int) []any {
	out := make([]any, len(indexes))
	for i, idx := range indexes {
		if idx >= 0 && idx < len(row) {
			out[i] = row[idx]
		}
	}
	return out
}

// --- CSV ---------------------------------------------------------------------

type csvEncoder struct {
	w    *csv.Writer
	spec ExportSpec
}

func (e *csvEncoder) Begin() error {
	header := make([]string, len(e.spec.Columns))
	for i, c := range e.spec.Columns {
		header[i] = c.Name
	}
	return e.w.Write(header)
}

func (e *csvEncoder) Row(values []any) error {
	fields := make([]string, len(values))
	for i, v := range values {
		fields[i] = CSVField(v)
	}
	return e.w.Write(fields)
}

func (e *csvEncoder) End() error {
	e.w.Flush()
	return e.w.Error()
}

// CSVField renders one value as CSV text. Quoting is left to encoding/csv,
// which implements RFC 4180; this only decides what the unquoted text is.
//
// NULL becomes an empty field. CSV has no way to distinguish NULL from an
// empty string, and inventing a sentinel (`\N`, "NULL") would corrupt any
// table that legitimately contains that text.
func CSVField(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		// Hex with an 0x prefix: a spreadsheet renders raw bytes as mojibake,
		// and base64 is indistinguishable from a string column's contents.
		return "0x" + hex.EncodeToString(t)
	case bool:
		return strconv.FormatBool(t)
	case float32:
		return strconv.FormatFloat(float64(t), 'g', -1, 32)
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		if s, ok := formatInteger(v); ok {
			return s
		}
		return fmt.Sprint(v)
	}
}

// --- JSON --------------------------------------------------------------------

// jsonEncoder streams one array of objects. It writes the brackets and commas
// itself and encodes only one row at a time, so a million-row export never
// materializes as a single value.
type jsonEncoder struct {
	w     io.Writer
	spec  ExportSpec
	wrote bool
	err   error
}

func (e *jsonEncoder) Begin() error {
	return e.write("[")
}

func (e *jsonEncoder) Row(values []any) error {
	if e.err != nil {
		return e.err
	}
	if e.wrote {
		if err := e.write(","); err != nil {
			return err
		}
	}
	e.wrote = true

	// Built by hand rather than via a map so the keys follow the grid's column
	// order; encoding/json sorts map keys alphabetically.
	var b strings.Builder
	b.WriteByte('{')
	for i, c := range e.spec.Columns {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(c.Name)
		if err != nil {
			return err
		}
		b.Write(key)
		b.WriteByte(':')

		var v any
		if i < len(values) {
			v = values[i]
		}
		val, err := json.Marshal(v)
		if err != nil {
			return err
		}
		b.Write(val)
	}
	b.WriteByte('}')
	return e.write(b.String())
}

func (e *jsonEncoder) End() error {
	return e.write("]")
}

func (e *jsonEncoder) write(s string) error {
	if e.err != nil {
		return e.err
	}
	_, e.err = io.WriteString(e.w, s)
	return e.err
}

// --- SQL ---------------------------------------------------------------------

// sqlEncoder writes one INSERT statement per row, plus a trailing comment
// naming any LOB columns the export dropped.
type sqlEncoder struct {
	w      io.Writer
	spec   ExportSpec
	prefix string // "INSERT INTO <obj> (<cols>) VALUES "
}

func (e *sqlEncoder) Begin() error {
	target, err := QuoteObject(e.spec.Object, e.spec.Caps)
	if err != nil {
		return err
	}
	quoted := make([]string, len(e.spec.Columns))
	for i, c := range e.spec.Columns {
		q, err := QuoteIdent(c.Name, e.spec.Caps.QuoteChar)
		if err != nil {
			return err
		}
		quoted[i] = q
	}
	e.prefix = "INSERT INTO " + target + " (" + strings.Join(quoted, ", ") + ") VALUES "
	return nil
}

func (e *sqlEncoder) Row(values []any) error {
	if e.prefix == "" {
		return fmt.Errorf("sql export: Begin was not called or failed")
	}
	lits := make([]string, len(e.spec.Columns))
	for i := range e.spec.Columns {
		var v any
		if i < len(values) {
			v = values[i]
		}
		lit, err := SQLLiteral(v, e.spec.Engine)
		if err != nil {
			return err
		}
		lits[i] = lit
	}
	_, err := io.WriteString(e.w, e.prefix+"("+strings.Join(lits, ", ")+");\n")
	return err
}

// End notes the dropped LOB columns. A comment is the only way to say this in
// a .sql file without breaking replay; csv and json have no comment syntax
// that survives a spreadsheet or a JSON parser, so they omit silently.
func (e *sqlEncoder) End() error {
	if len(e.spec.OmittedLOB) == 0 {
		return nil
	}
	_, err := io.WriteString(e.w, "-- omitted large-object columns: "+strings.Join(e.spec.OmittedLOB, ", ")+"\n")
	return err
}

// SQLLiteral renders v as an inline SQL literal for engine.
//
// Values are inlined rather than bound because the output is a text file the
// operator replays elsewhere, so there is no statement to bind to. That makes
// this function the whole safety boundary for the sql format: a string's
// embedded single quotes are doubled per the SQL standard, and a NUL byte is
// rejected outright rather than escaped — several client libraries truncate a
// statement at the first NUL, which would silently change what the replayed
// file does. Backslashes are deliberately left alone: standard SQL gives them
// no meaning inside a string, and doubling them would corrupt every Windows
// path stored in a text column. (MySQL's non-standard backslash escaping is
// disabled by NO_BACKSLASH_ESCAPES and is a server-mode concern, not something
// an exporter can paper over.)
func SQLLiteral(v any, engine string) (string, error) {
	switch t := v.(type) {
	case nil:
		return "NULL", nil
	case string:
		return quoteSQLString(t)
	case []byte:
		return byteLiteral(t, engine), nil
	case bool:
		return boolLiteral(t, engine), nil
	case float32:
		return floatLiteral(float64(t), 32)
	case float64:
		return floatLiteral(t, 64)
	default:
		if s, ok := formatInteger(v); ok {
			return s, nil
		}
		return "", fmt.Errorf("cannot render %T as a SQL literal", v)
	}
}

func quoteSQLString(s string) (string, error) {
	if strings.ContainsRune(s, 0) {
		return "", fmt.Errorf("value contains a null byte and cannot be written as a SQL literal")
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'", nil
}

// byteLiteral renders binary data in each engine's native hex form.
func byteLiteral(b []byte, engine string) string {
	h := hex.EncodeToString(b)
	switch engine {
	case "mysql":
		// MySQL's 0x form has no zero-length spelling; 0x alone is a syntax
		// error, so an empty blob falls back to an empty string literal.
		if h == "" {
			return "''"
		}
		return "0x" + h
	case "sqlite":
		return "X'" + h + "'"
	default:
		// PostgreSQL: a hex-format bytea string, cast so it is unambiguous in
		// a bare VALUES list.
		return `'\x` + h + `'::bytea`
	}
}

// boolLiteral renders a boolean. PostgreSQL has real booleans; MySQL and
// SQLite represent them as 1/0 integers, which is also what their own dumps
// emit.
func boolLiteral(b bool, engine string) string {
	switch engine {
	case "mysql", "sqlite":
		if b {
			return "1"
		}
		return "0"
	default:
		if b {
			return "TRUE"
		}
		return "FALSE"
	}
}

func floatLiteral(f float64, bits int) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", fmt.Errorf("cannot render %v as a SQL literal: no portable spelling exists", f)
	}
	return strconv.FormatFloat(f, 'g', -1, bits), nil
}

// formatInteger renders every Go integer width the database/sql drivers can
// hand back. Reported separately from the string result so callers can tell
// "not an integer" from "the integer zero".
func formatInteger(v any) (string, bool) {
	switch t := v.(type) {
	case int:
		return strconv.FormatInt(int64(t), 10), true
	case int8:
		return strconv.FormatInt(int64(t), 10), true
	case int16:
		return strconv.FormatInt(int64(t), 10), true
	case int32:
		return strconv.FormatInt(int64(t), 10), true
	case int64:
		return strconv.FormatInt(t, 10), true
	case uint:
		return strconv.FormatUint(uint64(t), 10), true
	case uint8:
		return strconv.FormatUint(uint64(t), 10), true
	case uint16:
		return strconv.FormatUint(uint64(t), 10), true
	case uint32:
		return strconv.FormatUint(uint64(t), 10), true
	case uint64:
		return strconv.FormatUint(t, 10), true
	default:
		return "", false
	}
}
