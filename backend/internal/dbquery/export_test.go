package dbquery

import (
	"bytes"
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

func xCol(name string) port.ColumnMeta { return port.ColumnMeta{Name: name} }
func xLOB(name string) port.ColumnMeta { return port.ColumnMeta{Name: name, IsLOB: true} }
func xObj(name string) port.ObjectRef  { return port.ObjectRef{Name: name, Kind: "table"} }
func i64(v int64) any                  { return v }

var (
	myCaps   = port.DBCaps{QuoteChar: "`"}
	liteCaps = port.DBCaps{QuoteChar: `"`}
)

func encodeAll(t *testing.T, format string, spec ExportSpec, rows [][]any) string {
	t.Helper()
	var buf bytes.Buffer
	enc, err := NewExportEncoder(format, &buf, spec)
	if err != nil {
		t.Fatalf("NewExportEncoder(%q): %v", format, err)
	}
	if err := enc.Begin(); err != nil {
		t.Fatalf("begin: %v", err)
	}
	for _, r := range rows {
		if err := enc.Row(r); err != nil {
			t.Fatalf("row %v: %v", r, err)
		}
	}
	if err := enc.End(); err != nil {
		t.Fatalf("end: %v", err)
	}
	return buf.String()
}

// --- column selection --------------------------------------------------------

func TestSplitExportColumnsDropsLOBColumns(t *testing.T) {
	// ResultSet cells for LOB columns are size placeholders, not values, so
	// exporting them would write a number where the operator expects data.
	cols := []port.ColumnMeta{xCol("id"), xLOB("payload"), xCol("name"), xLOB("thumb")}
	keep, idx, omitted := SplitExportColumns(cols)

	if len(keep) != 2 || keep[0].Name != "id" || keep[1].Name != "name" {
		t.Fatalf("keep = %+v, want [id name]", keep)
	}
	if len(idx) != 2 || idx[0] != 0 || idx[1] != 2 {
		t.Fatalf("idx = %v, want [0 2]", idx)
	}
	if len(omitted) != 2 || omitted[0] != "payload" || omitted[1] != "thumb" {
		t.Fatalf("omitted = %v, want [payload thumb]", omitted)
	}
}

func TestSplitExportColumnsKeepsEverythingWhenNoLOB(t *testing.T) {
	keep, idx, omitted := SplitExportColumns([]port.ColumnMeta{xCol("a"), xCol("b")})
	if len(keep) != 2 || len(idx) != 2 || len(omitted) != 0 {
		t.Fatalf("keep = %+v, idx = %v, omitted = %v", keep, idx, omitted)
	}
}

func TestProjectRowTakesOnlyTheKeptIndexes(t *testing.T) {
	got := ProjectRow([]any{"a", "SKIP", "c"}, []int{0, 2})
	if len(got) != 2 || got[0] != "a" || got[1] != "c" {
		t.Fatalf("got %v, want [a c]", got)
	}
}

func TestProjectRowIgnoresIndexesPastTheRow(t *testing.T) {
	// A short row (a driver that returned fewer cells than columns) must not
	// panic mid-stream — the response is already committed by then.
	got := ProjectRow([]any{"a"}, []int{0, 2})
	if len(got) != 2 || got[0] != "a" || got[1] != nil {
		t.Fatalf("got %v, want [a <nil>]", got)
	}
}

// --- CSV ---------------------------------------------------------------------

func TestCSVFieldRendering(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"nil is an empty field", nil, ""},
		{"string passes through", "alpha", "alpha"},
		{"int", 42, "42"},
		{"int64", i64(-7), "-7"},
		{"float keeps precision", 1.5, "1.5"},
		{"float without a fraction stays bare", float64(20), "20"},
		{"true", true, "true"},
		{"false", false, "false"},
		{"bytes are hex with a 0x prefix", []byte{0xde, 0xad}, "0xdead"},
		{"empty bytes", []byte{}, "0x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CSVField(tt.in); got != tt.want {
				t.Fatalf("CSVField(%#v) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestCSVExportExactBytes(t *testing.T) {
	spec := ExportSpec{Object: xObj("assets"), Columns: []port.ColumnMeta{xCol("id"), xCol("name")}, Caps: liteCaps, Engine: "sqlite"}
	got := encodeAll(t, FormatCSV, spec, [][]any{
		{i64(1), "alpha"},
		{i64(2), nil},
	})
	want := "id,name\n1,alpha\n2,\n"
	if got != want {
		t.Fatalf("csv =\n%q\nwant\n%q", got, want)
	}
}

func TestCSVQuotesPerRFC4180(t *testing.T) {
	spec := ExportSpec{Object: xObj("t"), Columns: []port.ColumnMeta{xCol("v")}, Caps: liteCaps, Engine: "sqlite"}
	got := encodeAll(t, FormatCSV, spec, [][]any{
		{`has,comma`},
		{`has"quote`},
		{"has\nnewline"},
	})
	want := "v\n\"has,comma\"\n\"has\"\"quote\"\n\"has\nnewline\"\n"
	if got != want {
		t.Fatalf("csv =\n%q\nwant\n%q", got, want)
	}
}

func TestCSVHeaderOnlyWhenThereAreNoRows(t *testing.T) {
	spec := ExportSpec{Object: xObj("t"), Columns: []port.ColumnMeta{xCol("a"), xCol("b")}, Caps: liteCaps, Engine: "sqlite"}
	if got := encodeAll(t, FormatCSV, spec, nil); got != "a,b\n" {
		t.Fatalf("csv = %q, want just the header row", got)
	}
}

// --- JSON --------------------------------------------------------------------

func TestJSONExportIsOneStreamedArray(t *testing.T) {
	spec := ExportSpec{Object: xObj("assets"), Columns: []port.ColumnMeta{xCol("id"), xCol("name")}, Caps: liteCaps, Engine: "sqlite"}
	got := encodeAll(t, FormatJSON, spec, [][]any{
		{i64(1), "alpha"},
		{i64(2), nil},
	})
	want := `[{"id":1,"name":"alpha"},{"id":2,"name":null}]`
	if got != want {
		t.Fatalf("json = %s\nwant %s", got, want)
	}
}

func TestJSONEmptyExportIsAnEmptyArray(t *testing.T) {
	spec := ExportSpec{Object: xObj("t"), Columns: []port.ColumnMeta{xCol("a")}, Caps: liteCaps, Engine: "sqlite"}
	if got := encodeAll(t, FormatJSON, spec, nil); got != "[]" {
		t.Fatalf("json = %s, want []", got)
	}
}

func TestJSONRendersBytesAsBase64AndEscapesStrings(t *testing.T) {
	spec := ExportSpec{Object: xObj("t"), Columns: []port.ColumnMeta{xCol("blob"), xCol("txt")}, Caps: liteCaps, Engine: "sqlite"}
	got := encodeAll(t, FormatJSON, spec, [][]any{{[]byte("hi"), `a"b`}})
	want := `[{"blob":"aGk=","txt":"a\"b"}]`
	if got != want {
		t.Fatalf("json = %s\nwant %s", got, want)
	}
}

func TestJSONKeysFollowColumnOrder(t *testing.T) {
	// A map would serialize alphabetically; the export must match the grid's
	// column order instead.
	spec := ExportSpec{Object: xObj("t"), Columns: []port.ColumnMeta{xCol("zeta"), xCol("alpha")}, Caps: liteCaps, Engine: "sqlite"}
	got := encodeAll(t, FormatJSON, spec, [][]any{{1, 2}})
	if got != `[{"zeta":1,"alpha":2}]` {
		t.Fatalf("json = %s, want column order preserved", got)
	}
}

// --- SQL literals ------------------------------------------------------------

func TestSQLLiteral(t *testing.T) {
	tests := []struct {
		name   string
		in     any
		engine string
		want   string
	}{
		{"nil is NULL", nil, "postgres", "NULL"},
		{"string is single-quoted", "alpha", "postgres", "'alpha'"},
		{"embedded quote is doubled", "O'Brien", "postgres", "'O''Brien'"},
		{"only quotes are escaped, backslashes are literal", `a\b`, "postgres", `'a\b'`},
		{"timestamp-like string passes through quoted", "2026-07-27T10:00:00Z", "postgres", "'2026-07-27T10:00:00Z'"},
		{"int", 42, "postgres", "42"},
		{"negative int64", i64(-7), "mysql", "-7"},
		{"uint", uint(9), "sqlite", "9"},
		{"float", 1.5, "postgres", "1.5"},
		{"postgres bool true", true, "postgres", "TRUE"},
		{"postgres bool false", false, "postgres", "FALSE"},
		{"mysql bool true", true, "mysql", "1"},
		{"mysql bool false", false, "mysql", "0"},
		{"sqlite bool true", true, "sqlite", "1"},
		{"sqlite bool false", false, "sqlite", "0"},
		{"postgres bytes are a hex string cast to bytea", []byte{0xde, 0xad}, "postgres", `'\xdead'::bytea`},
		{"mysql bytes are 0x hex", []byte{0xde, 0xad}, "mysql", "0xdead"},
		{"sqlite bytes are X-quoted hex", []byte{0xde, 0xad}, "sqlite", "X'dead'"},
		{"postgres empty bytes", []byte{}, "postgres", `'\x'::bytea`},
		{"mysql empty bytes cannot be a bare 0x", []byte{}, "mysql", "''"},
		{"sqlite empty bytes", []byte{}, "sqlite", "X''"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := SQLLiteral(tt.in, tt.engine)
			if err != nil {
				t.Fatalf("SQLLiteral(%#v, %q): %v", tt.in, tt.engine, err)
			}
			if got != tt.want {
				t.Fatalf("SQLLiteral(%#v, %q) = %s, want %s", tt.in, tt.engine, got, tt.want)
			}
		})
	}
}

func TestSQLLiteralRejectsNulBytesInStrings(t *testing.T) {
	// A NUL truncates the statement in several client libraries; it is a bug
	// or a hostile value either way, and rejecting matches QuoteIdent.
	if _, err := SQLLiteral("a\x00b", "postgres"); err == nil {
		t.Fatal("expected a NUL byte to be rejected")
	}
}

func TestSQLLiteralRejectsNonFiniteFloats(t *testing.T) {
	inf := 1.0
	for i := 0; i < 400; i++ {
		inf *= 10
	}
	if _, err := SQLLiteral(inf, "postgres"); err == nil {
		t.Fatal("expected +Inf to be rejected: no portable SQL literal exists for it")
	}
}

func TestSQLLiteralRejectsUnsupportedTypes(t *testing.T) {
	if _, err := SQLLiteral(struct{ A int }{1}, "postgres"); err == nil {
		t.Fatal("expected an unsupported Go type to be rejected")
	}
}

// --- SQL export --------------------------------------------------------------

func TestSQLExportExactBytes(t *testing.T) {
	spec := ExportSpec{Object: xObj("assets"), Columns: []port.ColumnMeta{xCol("id"), xCol("name")}, Caps: liteCaps, Engine: "sqlite"}
	got := encodeAll(t, FormatSQL, spec, [][]any{
		{i64(1), "alpha"},
		{i64(2), nil},
	})
	want := "INSERT INTO \"assets\" (\"id\", \"name\") VALUES (1, 'alpha');\n" +
		"INSERT INTO \"assets\" (\"id\", \"name\") VALUES (2, NULL);\n"
	if got != want {
		t.Fatalf("sql =\n%s\nwant\n%s", got, want)
	}
}

func TestSQLExportQualifiesWithSchemaAndBacktickQuoting(t *testing.T) {
	pg := ExportSpec{
		Object:  port.ObjectRef{Database: "app", Schema: "public", Name: "assets", Kind: "table"},
		Columns: []port.ColumnMeta{xCol("id")}, Caps: pgCaps, Engine: "postgres",
	}
	if got := encodeAll(t, FormatSQL, pg, [][]any{{1}}); got != `INSERT INTO "public"."assets" ("id") VALUES (1);`+"\n" {
		t.Fatalf("postgres sql = %s", got)
	}

	my := ExportSpec{Object: xObj("assets"), Columns: []port.ColumnMeta{xCol("id")}, Caps: myCaps, Engine: "mysql"}
	if got := encodeAll(t, FormatSQL, my, [][]any{{1}}); got != "INSERT INTO `assets` (`id`) VALUES (1);\n" {
		t.Fatalf("mysql sql = %s", got)
	}
}

func TestSQLExportNotesOmittedLOBColumnsInATrailingComment(t *testing.T) {
	spec := ExportSpec{
		Object: xObj("assets"), Columns: []port.ColumnMeta{xCol("id")},
		OmittedLOB: []string{"payload", "thumb"}, Caps: liteCaps, Engine: "sqlite",
	}
	got := encodeAll(t, FormatSQL, spec, [][]any{{1}})
	if !strings.HasSuffix(got, "-- omitted large-object columns: payload, thumb\n") {
		t.Fatalf("sql =\n%s\nwant a trailing omission comment", got)
	}
	if strings.Count(got, "INSERT INTO") != 1 {
		t.Fatalf("comment interfered with the statements:\n%s", got)
	}
}

func TestSQLExportWritesNoCommentWhenNothingWasOmitted(t *testing.T) {
	spec := ExportSpec{Object: xObj("t"), Columns: []port.ColumnMeta{xCol("id")}, Caps: liteCaps, Engine: "sqlite"}
	if got := encodeAll(t, FormatSQL, spec, [][]any{{1}}); strings.Contains(got, "--") {
		t.Fatalf("sql = %s, want no comment", got)
	}
}

// CSV and JSON omit LOB columns silently — there is no comment syntax that
// would survive a spreadsheet or a JSON parser.
func TestCSVAndJSONCarryNoOmissionNote(t *testing.T) {
	for _, format := range []string{FormatCSV, FormatJSON} {
		spec := ExportSpec{
			Object: xObj("t"), Columns: []port.ColumnMeta{xCol("id")},
			OmittedLOB: []string{"payload"}, Caps: liteCaps, Engine: "sqlite",
		}
		got := encodeAll(t, format, spec, [][]any{{1}})
		if strings.Contains(got, "payload") || strings.Contains(got, "lobOmitted") {
			t.Fatalf("%s export mentions the omitted column: %s", format, got)
		}
	}
}

func TestSQLExportRejectsAnIdentifierCarryingTheQuoteChar(t *testing.T) {
	// QuoteIdent rejects rather than escapes; the encoder must surface that
	// instead of emitting a broken statement.
	spec := ExportSpec{Object: xObj(`as"sets`), Columns: []port.ColumnMeta{xCol("id")}, Caps: liteCaps, Engine: "sqlite"}
	var buf bytes.Buffer
	enc, err := NewExportEncoder(FormatSQL, &buf, spec)
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	if err := enc.Begin(); err == nil {
		if err := enc.Row([]any{1}); err == nil {
			t.Fatal("expected a hostile object name to be rejected")
		}
	}
}

// --- format plumbing ---------------------------------------------------------

func TestNewExportEncoderRejectsAnUnknownFormat(t *testing.T) {
	spec := ExportSpec{Object: xObj("t"), Columns: []port.ColumnMeta{xCol("id")}, Caps: liteCaps, Engine: "sqlite"}
	if _, err := NewExportEncoder("xlsx", &bytes.Buffer{}, spec); err == nil {
		t.Fatal("expected an unknown format to be rejected")
	}
}

func TestExportContentTypeAndExtension(t *testing.T) {
	tests := []struct {
		format, contentType, ext string
	}{
		{FormatCSV, "text/csv", ".csv"},
		{FormatJSON, "application/json", ".json"},
		{FormatSQL, "text/plain", ".sql"},
	}
	for _, tt := range tests {
		if got := ExportContentType(tt.format); got != tt.contentType {
			t.Errorf("ExportContentType(%q) = %q, want %q", tt.format, got, tt.contentType)
		}
		if got := ExportExtension(tt.format); got != tt.ext {
			t.Errorf("ExportExtension(%q) = %q, want %q", tt.format, got, tt.ext)
		}
	}
}
