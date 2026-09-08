package service

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// ToolsConfig previously named the external binaries the Tools module
// shelled out to. Nothing is shelled out anymore -- every conversion is
// pure Go, compiled straight into the server binary -- so this is now an
// empty placeholder kept only so NewToolsService's call sites don't need to
// change again if a future knob shows up.
type ToolsConfig struct{}

// ToolUnavailableError reports a Tools-module feature that isn't usable in
// the current configuration (e.g. no LLM key set for image captioning). The
// Install field is surfaced to API clients so the error is actionable.
type ToolUnavailableError struct {
	Tool    string
	Install string
}

func (e *ToolUnavailableError) Error() string {
	return fmt.Sprintf("%s is not available: %s", e.Tool, e.Install)
}

// UnsupportedFormatError reports an input/output format the Tools module
// does not (and, for some formats such as audio, cannot reasonably) support.
type UnsupportedFormatError struct {
	Format string
	Reason string
}

func (e *UnsupportedFormatError) Error() string {
	return fmt.Sprintf("unsupported format %q: %s", e.Format, e.Reason)
}

// ToolsService implements the Tools module: document -> markdown conversion
// and markdown -> docx/pdf export with mermaid diagram rendering. Everything
// runs in-process -- no Python/markitdown, no pandoc, no mermaid-cli -- so
// there is nothing to install for the module to work.
type ToolsService struct{}

// NewToolsService constructs the Tools service. It no longer does any I/O
// (no embedded script to stage to a temp file), so it cannot fail, but keeps
// returning an error to avoid another signature change if that ever changes.
func NewToolsService(_ ToolsConfig) (*ToolsService, error) {
	return &ToolsService{}, nil
}

var audioExts = map[string]bool{
	".mp3": true, ".wav": true, ".m4a": true, ".ogg": true, ".flac": true, ".aac": true,
}

var imageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true,
}

// ToMarkdown converts an uploaded document to markdown. The converter is
// chosen by file extension; LLM-assisted image description activates
// automatically when OPENAI_API_KEY and MARKITDOWN_LLM_MODEL are present in
// the process environment (typically loaded from --env at startup).
func (s *ToolsService) ToMarkdown(ctx context.Context, filename string, data []byte) (string, error) {
	ext := strings.ToLower(filepath.Ext(filename))
	switch {
	case ext == ".docx":
		return docxToMarkdown(data)
	case ext == ".pptx":
		return pptxToMarkdown(data)
	case ext == ".xlsx" || ext == ".xlsm":
		return xlsxToMarkdown(data)
	case ext == ".html" || ext == ".htm":
		return htmlToMarkdown(data)
	case ext == ".pdf":
		return pdfToMarkdown(data)
	case ext == ".md" || ext == ".markdown" || ext == ".txt":
		return string(data), nil
	case ext == ".csv":
		return csvToMarkdown(data)
	case ext == ".json":
		return jsonToMarkdown(data)
	case imageExts[ext]:
		return imageToMarkdown(ctx, ext, data)
	case audioExts[ext]:
		return "", &UnsupportedFormatError{Format: ext, Reason: "audio transcription is not supported"}
	default:
		return "", &UnsupportedFormatError{Format: ext, Reason: "no converter for this file type"}
	}
}

// MarkdownToDocument exports markdown to docx or pdf, rendering any
// ```mermaid fenced blocks to images inline via the pure-Go mermaid
// renderer (any diagram type it doesn't understand degrades to a labeled
// code block showing the raw source instead of failing the export).
func (s *ToolsService) MarkdownToDocument(ctx context.Context, markdown, format string) ([]byte, error) {
	if format != "docx" && format != "pdf" {
		return nil, fmt.Errorf("unsupported format %q", format)
	}
	blocks := parseMarkdownToBlocks(markdown)
	if format == "docx" {
		return renderDocx(blocks)
	}
	return renderPDF(blocks)
}
