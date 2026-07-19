package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"

	"devdeck/backend/internal/service"
)

func newToolsHandlerForTest(t *testing.T) *ToolsHandler {
	t.Helper()
	pythonBin := "python3"
	for _, candidate := range []string{"../../tools/venv/bin/python3", "python3"} {
		if _, err := exec.LookPath(candidate); err == nil {
			pythonBin = candidate
			break
		}
	}
	svc, err := service.NewToolsService(service.ToolsConfig{PythonBin: pythonBin, PandocBin: "pandoc", MmdcBin: "mmdc"})
	if err != nil {
		t.Fatalf("NewToolsService: %v", err)
	}
	return NewToolsHandler(svc)
}

func TestPostMarkitdown(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not on PATH")
	}
	h := newToolsHandlerForTest(t)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", "note.txt")
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	fw.Write([]byte("Hello from the handler test."))
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/tools/markitdown", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()

	h.PostMarkitdown(rec, req)

	if rec.Code == http.StatusServiceUnavailable {
		t.Skipf("markitdown not installed: %s", rec.Body.String())
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Filename string `json:"filename"`
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if body.Filename != "note.txt" {
		t.Errorf("filename = %q, want note.txt", body.Filename)
	}
	if body.Markdown == "" {
		t.Error("expected non-empty markdown")
	}
}

func TestPostMarkdownExport(t *testing.T) {
	if _, err := exec.LookPath("pandoc"); err != nil {
		t.Skip("pandoc not on PATH")
	}
	h := newToolsHandlerForTest(t)

	payload := `{"markdown":"# Title\n\nHello.","format":"docx","filename":"my-doc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/tools/markdown-export", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.PostMarkdownExport(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="my-doc.docx"` {
		t.Errorf("Content-Disposition = %q", cd)
	}
	if rec.Body.Len() == 0 {
		t.Error("expected non-empty docx body")
	}
}

func TestPostMarkdownExportRejectsBadFormat(t *testing.T) {
	h := newToolsHandlerForTest(t)

	payload := `{"markdown":"# hi","format":"txt"}`
	req := httptest.NewRequest(http.MethodPost, "/api/tools/markdown-export", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.PostMarkdownExport(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
