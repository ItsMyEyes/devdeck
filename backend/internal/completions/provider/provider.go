// Package provider implements the BYOK LLM adapters for AI inline
// completions — one stateless HTTP call per request, not an orchestrated
// agent session (see backend/internal/agentcore/provider for that).
package provider

import "context"

type GroundingSymbol struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

type CompletionRequest struct {
	Prefix           string
	Suffix           string
	Language         string
	GroundingSymbols []GroundingSymbol
}

type Config struct {
	Provider string
	BaseURL  string
	Model    string
	APIKey   string
}

// Adapter calls one BYOK provider. Implementations must not use
// assistant-turn prefill — current-generation models on both supported
// providers reject it. Use a forced tool call instead (see anthropic.go /
// openaicompat.go).
type Adapter interface {
	Complete(ctx context.Context, req CompletionRequest, cfg Config) (string, error)
}

var completionToolSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"completion": map[string]any{
			"type":        "string",
			"description": "The code to insert at the cursor. No markdown fences, no explanation — just the code.",
		},
	},
	"required":             []string{"completion"},
	"additionalProperties": false,
}

const completionSystemPrompt = `You are a code completion engine. Given the code before and after the cursor, plus real symbols known to exist at this location (from the language server), emit the code that should be inserted at the cursor. Only reference functions, methods, and types listed in the provided symbols or already visible in the prefix/suffix — never invent an API that isn't shown. Call the emit_completion tool with the code to insert; do not include markdown fences or explanation.`

func buildUserContent(req CompletionRequest) string {
	var b []byte
	b = append(b, "Language: "+req.Language+"\n\n"...)
	if len(req.GroundingSymbols) > 0 {
		b = append(b, "Known symbols at this location:\n"...)
		for _, sym := range req.GroundingSymbols {
			b = append(b, "- "+sym.Name+" ("+sym.Kind+"): "+sym.Detail+"\n"...)
		}
		b = append(b, "\n"...)
	}
	b = append(b, "Code before cursor:\n"...)
	b = append(b, req.Prefix...)
	b = append(b, "\n<CURSOR>\n"...)
	b = append(b, "Code after cursor:\n"...)
	b = append(b, req.Suffix...)
	return string(b)
}
