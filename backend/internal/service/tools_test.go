package service

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func skipIfMissing(t *testing.T, bin string) {
	t.Helper()
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("%s not on PATH, skipping", bin)
	}
}

func TestToolsService_ToMarkdown(t *testing.T) {
	cfg := ToolsConfig{PythonBin: defaultPythonBinForTest(), PandocBin: "pandoc", MmdcBin: "mmdc"}
	skipIfMissing(t, cfg.PythonBin)

	svc, err := NewToolsService(cfg)
	if err != nil {
		t.Fatalf("NewToolsService: %v", err)
	}

	md, err := svc.ToMarkdown(context.Background(), "note.txt", []byte("Hello, DevDeck Tools."))
	if err != nil {
		var unavailable *ToolUnavailableError
		if errAs(err, &unavailable) {
			t.Skipf("markitdown package not installed: %v", err)
		}
		t.Fatalf("ToMarkdown: %v", err)
	}
	if !strings.Contains(md, "Hello, DevDeck Tools.") {
		t.Fatalf("expected converted markdown to contain source text, got: %q", md)
	}
}

func TestToolsService_ToMarkdown_PDFKeepsStructure(t *testing.T) {
	cfg := ToolsConfig{PythonBin: defaultPythonBinForTest(), PandocBin: "pandoc", MmdcBin: "mmdc"}
	skipIfMissing(t, cfg.PythonBin)

	svc, err := NewToolsService(cfg)
	if err != nil {
		t.Fatalf("NewToolsService: %v", err)
	}

	data, err := os.ReadFile(filepath.Join("testdata", "structured.pdf"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	md, err := svc.ToMarkdown(context.Background(), "structured.pdf", data)
	if err != nil {
		var unavailable *ToolUnavailableError
		if errAs(err, &unavailable) {
			t.Skipf("markitdown package not installed: %v", err)
		}
		t.Fatalf("ToMarkdown: %v", err)
	}
	if !strings.Contains(md, "Laporan Kuartal") {
		t.Fatalf("expected converted markdown to contain source text, got: %q", md)
	}
	if !strings.Contains(md, "#") {
		t.Fatalf("expected PDF headings to survive as markdown headings, got: %q", md)
	}
}

func TestToolsService_MarkdownToDocument_WithMermaid(t *testing.T) {
	skipIfMissing(t, "pandoc")
	skipIfMissing(t, "mmdc")

	svc, err := NewToolsService(ToolsConfig{PythonBin: defaultPythonBinForTest(), PandocBin: "pandoc", MmdcBin: "mmdc"})
	if err != nil {
		t.Fatalf("NewToolsService: %v", err)
	}

	markdown := "# Title\n\nSome text.\n\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```\n"
	out, err := svc.MarkdownToDocument(context.Background(), markdown, "docx")
	if err != nil {
		t.Fatalf("MarkdownToDocument: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("expected non-empty docx output")
	}
}

func defaultPythonBinForTest() string {
	for _, candidate := range []string{"../../tools/venv/bin/python3", "python3"} {
		if _, err := exec.LookPath(candidate); err == nil {
			return candidate
		}
	}
	return "python3"
}

func errAs(err error, target **ToolUnavailableError) bool {
	u, ok := err.(*ToolUnavailableError)
	if ok {
		*target = u
	}
	return ok
}
