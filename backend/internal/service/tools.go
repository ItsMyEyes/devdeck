package service

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

//go:embed markitdown_convert.py
var markitdownScript []byte

// ToolsConfig names the external binaries the Tools module shells out to.
// pandoc and mermaid-cli (mmdc) have no pure-Go equivalent; markitdown is a
// Python library, invoked through the embedded markitdown_convert.py script.
type ToolsConfig struct {
	PythonBin string
	PandocBin string
	MmdcBin   string
}

// ToolUnavailableError reports a missing external dependency. The Install
// field is surfaced to API clients so the error is actionable.
type ToolUnavailableError struct {
	Tool    string
	Install string
}

func (e *ToolUnavailableError) Error() string {
	return fmt.Sprintf("%s is not installed — install it with: %s", e.Tool, e.Install)
}

// ToolsService implements the Tools module: document -> markdown conversion
// (markitdown) and markdown -> docx/pdf export with mermaid diagram
// rendering (mermaid-cli + pandoc).
type ToolsService struct {
	cfg        ToolsConfig
	scriptPath string
}

// NewToolsService writes the embedded markitdown conversion script to a temp
// file once, so the server binary stays self-contained (mirrors the webui
// package embedding the built frontend).
func NewToolsService(cfg ToolsConfig) (*ToolsService, error) {
	dir, err := os.MkdirTemp("", "loom-tools-")
	if err != nil {
		return nil, fmt.Errorf("create tools temp dir: %w", err)
	}
	scriptPath := filepath.Join(dir, "markitdown_convert.py")
	if err := os.WriteFile(scriptPath, markitdownScript, 0o500); err != nil {
		return nil, fmt.Errorf("write markitdown script: %w", err)
	}
	return &ToolsService{cfg: cfg, scriptPath: scriptPath}, nil
}

func lookPath(bin, install string) error {
	if _, err := exec.LookPath(bin); err != nil {
		return &ToolUnavailableError{Tool: bin, Install: install}
	}
	return nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}

// ToMarkdown converts an uploaded document to markdown via markitdown.
// LLM-assisted image description activates automatically when
// OPENAI_API_KEY and MARKITDOWN_LLM_MODEL are present in the process
// environment (typically loaded from --env at startup).
func (s *ToolsService) ToMarkdown(ctx context.Context, filename string, data []byte) (string, error) {
	if err := lookPath(s.cfg.PythonBin, `install Python 3, then: pip install "markitdown[all]" openai pymupdf4llm`); err != nil {
		return "", err
	}

	dir, err := os.MkdirTemp("", "loom-markitdown-*")
	if err != nil {
		return "", fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(dir)

	ext := filepath.Ext(filename)
	if ext == "" {
		ext = ".bin"
	}
	src := filepath.Join(dir, "input"+ext)
	if err := os.WriteFile(src, data, 0o600); err != nil {
		return "", fmt.Errorf("write temp file: %w", err)
	}

	cmd := exec.CommandContext(ctx, s.cfg.PythonBin, s.scriptPath, src)
	cmd.Env = os.Environ()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := firstLine(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if strings.Contains(msg, "ModuleNotFoundError") || strings.Contains(stderr.String(), "No module named 'markitdown'") {
			return "", &ToolUnavailableError{Tool: "markitdown (python package)", Install: `pip install "markitdown[all]" openai pymupdf4llm`}
		}
		return "", fmt.Errorf("markitdown: %s", msg)
	}
	return stdout.String(), nil
}

var mermaidBlockRe = regexp.MustCompile("(?s)```mermaid\\s*\\n(.*?)\\n```")

// MarkdownToDocument exports markdown to docx or pdf via pandoc, rendering
// any ```mermaid fenced blocks to PNG images (via mermaid-cli) first, since
// pandoc has no native mermaid support.
func (s *ToolsService) MarkdownToDocument(ctx context.Context, markdown, format string) ([]byte, error) {
	if format != "docx" && format != "pdf" {
		return nil, fmt.Errorf("unsupported format %q", format)
	}
	if err := lookPath(s.cfg.PandocBin, "brew install pandoc (see https://pandoc.org/installing.html)"); err != nil {
		return nil, err
	}

	dir, err := os.MkdirTemp("", "loom-export-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(dir)

	rendered, err := s.renderMermaidBlocks(ctx, dir, markdown)
	if err != nil {
		return nil, err
	}

	srcPath := filepath.Join(dir, "input.md")
	if err := os.WriteFile(srcPath, []byte(rendered), 0o600); err != nil {
		return nil, fmt.Errorf("write markdown: %w", err)
	}
	outPath := filepath.Join(dir, "output."+format)

	args := []string{srcPath, "-o", outPath, "--resource-path", dir, "--standalone"}
	cmd := exec.CommandContext(ctx, s.cfg.PandocBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := firstLine(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("pandoc: %s", msg)
	}

	out, err := os.ReadFile(outPath)
	if err != nil {
		return nil, fmt.Errorf("read pandoc output: %w", err)
	}
	return out, nil
}

// renderMermaidBlocks replaces every ```mermaid fenced block with a markdown
// image reference to a PNG rendered via mermaid-cli (mmdc). Returns the
// markdown unchanged (and without invoking mmdc) if no mermaid block exists.
func (s *ToolsService) renderMermaidBlocks(ctx context.Context, dir, markdown string) (string, error) {
	matches := mermaidBlockRe.FindAllStringSubmatchIndex(markdown, -1)
	if len(matches) == 0 {
		return markdown, nil
	}
	if err := lookPath(s.cfg.MmdcBin, "npm install -g @mermaid-js/mermaid-cli"); err != nil {
		return "", err
	}

	var out strings.Builder
	last := 0
	for i, m := range matches {
		start, end := m[0], m[1]
		diagStart, diagEnd := m[2], m[3]
		diagram := markdown[diagStart:diagEnd]

		inPath := filepath.Join(dir, fmt.Sprintf("mermaid-%d.mmd", i))
		outPath := filepath.Join(dir, fmt.Sprintf("mermaid-%d.png", i))
		if err := os.WriteFile(inPath, []byte(diagram), 0o600); err != nil {
			return "", fmt.Errorf("write mermaid source: %w", err)
		}

		cmd := exec.CommandContext(ctx, s.cfg.MmdcBin, "-i", inPath, "-o", outPath, "-b", "white")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			msg := firstLine(stderr.String())
			if msg == "" {
				msg = err.Error()
			}
			return "", fmt.Errorf("mermaid-cli: diagram %d: %s", i+1, msg)
		}

		out.WriteString(markdown[last:start])
		out.WriteString("![diagram " + strconv.Itoa(i+1) + "](" + outPath + ")")
		last = end
	}
	out.WriteString(markdown[last:])
	return out.String(), nil
}
