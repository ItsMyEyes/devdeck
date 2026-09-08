package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// csvToMarkdown renders a CSV file as a GFM table.
func csvToMarkdown(data []byte) (string, error) {
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return "", fmt.Errorf("parse csv: %w", err)
	}
	return rowsToMarkdownTable(rows), nil
}

// jsonToMarkdown pretty-prints JSON inside a fenced code block, so it stays
// readable and round-trippable rather than being flattened to prose.
func jsonToMarkdown(data []byte) (string, error) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return "", fmt.Errorf("parse json: %w", err)
	}
	pretty, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "", fmt.Errorf("format json: %w", err)
	}
	return "```json\n" + string(pretty) + "\n```\n", nil
}

// rowsToMarkdownTable renders a rectangular-ish string grid (ragged rows
// allowed) as a GFM table, treating the first row as the header.
func rowsToMarkdownTable(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	cols := 0
	for _, row := range rows {
		if len(row) > cols {
			cols = len(row)
		}
	}
	pad := func(row []string) []string {
		out := make([]string, cols)
		copy(out, row)
		return out
	}
	esc := func(s string) string {
		s = strings.ReplaceAll(s, "|", "\\|")
		s = strings.ReplaceAll(s, "\n", " ")
		return s
	}
	var sb strings.Builder
	writeRow := func(row []string) {
		sb.WriteString("|")
		for _, cell := range pad(row) {
			sb.WriteString(" " + esc(cell) + " |")
		}
		sb.WriteString("\n")
	}
	writeRow(rows[0])
	sb.WriteString("|")
	for i := 0; i < cols; i++ {
		sb.WriteString(" --- |")
	}
	sb.WriteString("\n")
	for _, row := range rows[1:] {
		writeRow(row)
	}
	return sb.String()
}

var imageMIMEByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
}

// imageToMarkdown captions an image via an OpenAI-compatible vision model
// when OPENAI_API_KEY and MARKITDOWN_LLM_MODEL are configured (typically
// loaded from --env at startup). This was already a plain HTTP call before
// the rewrite -- no external binary was ever involved -- so behavior is
// unchanged; it's just made directly from Go instead of shelling out to a
// Python helper script.
func imageToMarkdown(ctx context.Context, ext string, data []byte) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	model := os.Getenv("MARKITDOWN_LLM_MODEL")
	if apiKey == "" || model == "" {
		return "", &ToolUnavailableError{
			Tool:    "image captioning",
			Install: "set OPENAI_API_KEY and MARKITDOWN_LLM_MODEL (see COMMANDS.md) to enable LLM-generated image descriptions",
		}
	}
	mime := imageMIMEByExt[ext]
	if mime == "" {
		mime = "application/octet-stream"
	}
	dataURL := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)

	baseURL := strings.TrimRight(os.Getenv("OPENAI_BASE_URL"), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}

	reqBody := map[string]any{
		"model": model,
		"messages": []map[string]any{
			{
				"role": "user",
				"content": []map[string]any{
					{"type": "text", "text": "Write a detailed, factual caption describing this image."},
					{"type": "image_url", "image_url": map[string]string{"url": dataURL}},
				},
			},
		},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("encode caption request: %w", err)
	}

	httpCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(httpCtx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build caption request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("caption request: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read caption response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("caption request: %s: %s", resp.Status, firstLine(string(respBody)))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("parse caption response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("caption response had no choices")
	}
	return "# Image\n\n" + strings.TrimSpace(parsed.Choices[0].Message.Content) + "\n", nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}
