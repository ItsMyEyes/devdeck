package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"

	"loom/backend/internal/service"
)

// maxToolUploadSize caps a single document uploaded for markdown conversion.
const maxToolUploadSize = 25 << 20 // 25MB

// ToolsHandler serves the Tools module: document -> markdown conversion and
// markdown -> docx/pdf export.
type ToolsHandler struct {
	svc *service.ToolsService
}

// NewToolsHandler creates a tools handler.
func NewToolsHandler(svc *service.ToolsService) *ToolsHandler {
	return &ToolsHandler{svc: svc}
}

// PostMarkitdown converts an uploaded document to markdown.
func (h *ToolsHandler) PostMarkitdown(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxToolUploadSize)
	if err := r.ParseMultipartForm(maxToolUploadSize); err != nil {
		writeErr(w, http.StatusBadRequest, "file too large or invalid form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "missing file")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "failed to read file")
		return
	}

	markdown, err := h.svc.ToMarkdown(r.Context(), header.Filename, data)
	if writeToolErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"filename": header.Filename,
		"markdown": markdown,
	})
}

type markdownExportBody struct {
	Markdown string `json:"markdown"`
	Format   string `json:"format"` // "docx" | "pdf"
	Filename string `json:"filename"`
}

// PostMarkdownExport converts markdown (with mermaid diagrams) to a docx or
// pdf file and streams the result back as a download.
func (h *ToolsHandler) PostMarkdownExport(w http.ResponseWriter, r *http.Request) {
	var body markdownExportBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Markdown == "" {
		writeErr(w, http.StatusBadRequest, "markdown is required")
		return
	}
	if body.Format != "docx" && body.Format != "pdf" {
		writeErr(w, http.StatusBadRequest, "format must be \"docx\" or \"pdf\"")
		return
	}

	out, err := h.svc.MarkdownToDocument(r.Context(), body.Markdown, body.Format)
	if writeToolErr(w, err) {
		return
	}

	filename := body.Filename
	if filename == "" {
		filename = "document"
	}
	contentType := "application/pdf"
	if body.Format == "docx" {
		contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filename+"."+body.Format))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

// writeToolErr maps a Tools service error to an HTTP response. Missing
// external dependencies (markitdown/pandoc/mermaid-cli) surface as 503 with
// an actionable install command; everything else is a generic 500 — never
// leak raw stderr from the shelled-out process beyond its first line.
func writeToolErr(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	var unavailable *service.ToolUnavailableError
	if errors.As(err, &unavailable) {
		writeErr(w, http.StatusServiceUnavailable, unavailable.Error())
		return true
	}
	writeErr(w, http.StatusInternalServerError, err.Error())
	return true
}
