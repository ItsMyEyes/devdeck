package service

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

// skipIfMissing skips the test when bin isn't on PATH. Shared with
// ssh_file_test.go and worktree_file_test.go, which shell out to real
// search tools (rg/grep/find) unrelated to the Tools module rewrite.
func skipIfMissing(t *testing.T, bin string) {
	t.Helper()
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("%s not on PATH, skipping", bin)
	}
}

func newTestToolsService(t *testing.T) *ToolsService {
	t.Helper()
	svc, err := NewToolsService(ToolsConfig{})
	if err != nil {
		t.Fatalf("NewToolsService: %v", err)
	}
	return svc
}

func TestToolsService_ToMarkdown_TXT(t *testing.T) {
	svc := newTestToolsService(t)
	md, err := svc.ToMarkdown(context.Background(), "note.txt", []byte("Hello, DevDeck Tools."))
	if err != nil {
		t.Fatalf("ToMarkdown: %v", err)
	}
	if !strings.Contains(md, "Hello, DevDeck Tools.") {
		t.Fatalf("expected converted markdown to contain source text, got: %q", md)
	}
}

func TestToolsService_ToMarkdown_PDFKeepsStructure(t *testing.T) {
	svc := newTestToolsService(t)

	data, err := os.ReadFile(filepath.Join("testdata", "structured.pdf"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	md, err := svc.ToMarkdown(context.Background(), "structured.pdf", data)
	if err != nil {
		t.Fatalf("ToMarkdown: %v", err)
	}
	if !strings.Contains(md, "Laporan Kuartal") {
		t.Fatalf("expected converted markdown to contain source text, got: %q", md)
	}
	if !strings.Contains(md, "#") {
		t.Fatalf("expected PDF headings to survive as markdown headings, got: %q", md)
	}
}

// TestToolsService_ToMarkdown_DOCX round-trips a docx built by our own
// exporter back through the reader, which doubles as a real-fixture test
// without needing to vendor a binary .docx file.
func TestToolsService_ToMarkdown_DOCX(t *testing.T) {
	svc := newTestToolsService(t)

	docx, err := svc.MarkdownToDocument(context.Background(), "# Quarterly Report\n\nRevenue grew **20%** this quarter.\n", "docx")
	if err != nil {
		t.Fatalf("MarkdownToDocument(docx): %v", err)
	}

	md, err := svc.ToMarkdown(context.Background(), "report.docx", docx)
	if err != nil {
		t.Fatalf("ToMarkdown(docx): %v", err)
	}
	if !strings.Contains(md, "Quarterly Report") {
		t.Fatalf("expected heading text to survive round-trip, got: %q", md)
	}
	if !strings.Contains(md, "#") {
		t.Fatalf("expected heading style to convert to a markdown heading, got: %q", md)
	}
	if !strings.Contains(md, "Revenue grew 20% this quarter.") {
		t.Fatalf("expected paragraph text to survive round-trip, got: %q", md)
	}
}

func TestToolsService_ToMarkdown_XLSX(t *testing.T) {
	f := excelize.NewFile()
	defer f.Close()
	sheet := f.GetSheetName(0)
	f.SetCellValue(sheet, "A1", "Name")
	f.SetCellValue(sheet, "B1", "Score")
	f.SetCellValue(sheet, "A2", "Ada")
	f.SetCellValue(sheet, "B2", 97)

	var buf bytes.Buffer
	if _, err := f.WriteTo(&buf); err != nil {
		t.Fatalf("build xlsx fixture: %v", err)
	}

	svc := newTestToolsService(t)
	md, err := svc.ToMarkdown(context.Background(), "scores.xlsx", buf.Bytes())
	if err != nil {
		t.Fatalf("ToMarkdown(xlsx): %v", err)
	}
	if !strings.Contains(md, "Ada") || !strings.Contains(md, "97") {
		t.Fatalf("expected sheet data in markdown table, got: %q", md)
	}
	if !strings.Contains(md, "|") {
		t.Fatalf("expected a GFM table, got: %q", md)
	}
}

func TestToolsService_ToMarkdown_HTML(t *testing.T) {
	svc := newTestToolsService(t)
	html := `<h1>Title</h1><p>Hello <b>world</b>.</p>`
	md, err := svc.ToMarkdown(context.Background(), "page.html", []byte(html))
	if err != nil {
		t.Fatalf("ToMarkdown(html): %v", err)
	}
	if !strings.Contains(md, "Title") || !strings.Contains(md, "Hello") || !strings.Contains(md, "world") {
		t.Fatalf("expected converted markdown to contain source text, got: %q", md)
	}
}

func TestToolsService_ToMarkdown_UnsupportedAudio(t *testing.T) {
	svc := newTestToolsService(t)
	_, err := svc.ToMarkdown(context.Background(), "voice.mp3", []byte("not really audio"))
	if err == nil {
		t.Fatal("expected an error for an unsupported audio format")
	}
	var unsupported *UnsupportedFormatError
	if !asUnsupported(err, &unsupported) {
		t.Fatalf("expected *UnsupportedFormatError, got %T: %v", err, err)
	}
}

// TestToolsService_MarkdownToDocument_RoundTripIntegrity is the concrete
// "tanpa membuat files rusak" guarantee: markdown covering every block type
// (heading, bold/italic, list, table, code block, and a mermaid diagram)
// must produce a structurally valid docx and PDF, not just a non-empty blob.
func TestToolsService_MarkdownToDocument_RoundTripIntegrity(t *testing.T) {
	svc := newTestToolsService(t)
	markdown := "# Title\n\n" +
		"Some **bold** and _italic_ text.\n\n" +
		"- one\n- two\n\n" +
		"| A | B |\n| --- | --- |\n| 1 | 2 |\n\n" +
		"```go\nfmt.Println(\"hi\")\n```\n\n" +
		"```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```\n"

	t.Run("docx", func(t *testing.T) {
		out, err := svc.MarkdownToDocument(context.Background(), markdown, "docx")
		if err != nil {
			t.Fatalf("MarkdownToDocument(docx): %v", err)
		}
		if len(out) == 0 {
			t.Fatal("expected non-empty docx output")
		}
		zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
		if err != nil {
			t.Fatalf("docx output is not a valid zip: %v", err)
		}
		var haveDoc, haveImage bool
		for _, f := range zr.File {
			if f.Name == "word/document.xml" {
				haveDoc = true
			}
			if strings.HasPrefix(f.Name, "word/media/image") {
				haveImage = true
			}
		}
		if !haveDoc {
			t.Fatal("docx zip missing word/document.xml")
		}
		if !haveImage {
			t.Fatal("expected the mermaid flowchart to render as an embedded image")
		}

		body, err := docxToMarkdown(out)
		if err != nil {
			t.Fatalf("word/document.xml did not parse back as markdown: %v", err)
		}
		if !strings.Contains(body, "Title") {
			t.Fatalf("round-tripped docx lost heading text: %q", body)
		}
	})

	t.Run("pdf", func(t *testing.T) {
		out, err := svc.MarkdownToDocument(context.Background(), markdown, "pdf")
		if err != nil {
			t.Fatalf("MarkdownToDocument(pdf): %v", err)
		}
		if !bytes.HasPrefix(out, []byte("%PDF-")) {
			t.Fatalf("pdf output missing %%PDF- header: %q", out[:min(20, len(out))])
		}
		if !bytes.Contains(out, []byte("%%EOF")) {
			t.Fatal("pdf output missing EOF trailer marker")
		}
	})
}

// TestToolsService_MarkdownToDocument_PDFPreservesInlineStylingEverywhere
// guards against headings, blockquotes and list items silently losing
// bold/italic/code formatting in the PDF export — they used to render
// through runsPlainText (plain concatenated text), while only plain
// paragraphs went through writeInlineRuns and kept their styling. A heading
// is always bold; combined with an *italic* word inside it, fpdf's core font
// for that combination is literally named "...-BoldOblique" in the output
// bytes (confirmed empirically against go-pdf/fpdf directly) — a plain-text
// heading never requests that combined style, so its presence is a reliable
// signal the inline run's italic flag survived alongside the heading's own
// forced bold.
func TestToolsService_MarkdownToDocument_PDFPreservesInlineStylingEverywhere(t *testing.T) {
	svc := newTestToolsService(t)
	markdown := "# Heading with *italic* inside\n\n" +
		"> A blockquote with **bold** inside\n\n" +
		"- A list item with **bold** *and italic*\n"

	out, err := svc.MarkdownToDocument(context.Background(), markdown, "pdf")
	if err != nil {
		t.Fatalf("MarkdownToDocument(pdf): %v", err)
	}
	if !bytes.Contains(out, []byte("BoldOblique")) {
		t.Fatal("expected the combined bold+italic core font to appear somewhere in the pdf, " +
			"meaning a heading/blockquote/list item's inline styling survived export")
	}
}

// TestToolsService_MarkdownToDocument_PreservesHyperlinks guards against a
// markdown link's destination being silently discarded — it used to become
// inert plain text with the URL nowhere in the output, in both formats.
func TestToolsService_MarkdownToDocument_PreservesHyperlinks(t *testing.T) {
	svc := newTestToolsService(t)
	markdown := "See the [DevDeck repo](https://example.com/devdeck-test-link) for more.\n"

	t.Run("docx", func(t *testing.T) {
		out, err := svc.MarkdownToDocument(context.Background(), markdown, "docx")
		if err != nil {
			t.Fatalf("MarkdownToDocument(docx): %v", err)
		}
		zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
		if err != nil {
			t.Fatalf("docx output is not a valid zip: %v", err)
		}
		var doc, rels string
		for _, f := range zr.File {
			switch f.Name {
			case "word/document.xml":
				doc = readZipFile(t, f)
			case "word/_rels/document.xml.rels":
				rels = readZipFile(t, f)
			}
		}
		if !strings.Contains(doc, "<w:hyperlink") {
			t.Fatalf("expected document.xml to contain a w:hyperlink element, got: %q", doc)
		}
		if !strings.Contains(rels, "https://example.com/devdeck-test-link") ||
			!strings.Contains(rels, `TargetMode="External"`) {
			t.Fatalf("expected an external hyperlink relationship for the link target, got: %q", rels)
		}
	})

	t.Run("pdf", func(t *testing.T) {
		out, err := svc.MarkdownToDocument(context.Background(), markdown, "pdf")
		if err != nil {
			t.Fatalf("MarkdownToDocument(pdf): %v", err)
		}
		if !bytes.Contains(out, []byte("/URI")) || !bytes.Contains(out, []byte("example.com/devdeck-test-link")) {
			t.Fatal("expected the pdf to contain a URI link annotation for the link target")
		}
	})
}

func readZipFile(t *testing.T, f *zip.File) string {
	t.Helper()
	rc, err := f.Open()
	if err != nil {
		t.Fatalf("open %s: %v", f.Name, err)
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read %s: %v", f.Name, err)
	}
	return string(data)
}

func asUnsupported(err error, target **UnsupportedFormatError) bool {
	u, ok := err.(*UnsupportedFormatError)
	if ok {
		*target = u
	}
	return ok
}
