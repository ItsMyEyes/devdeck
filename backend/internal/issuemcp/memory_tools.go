package issuemcp

// This file's tools have nothing to do with issues — they live in this
// package for the same reason server.go's package comment gives for issues:
// one MCP process (`devdeck mcp-server`), not a second binary. They expose
// DevDeck's persistent-memory entity/fact graph (see internal/memory and
// internal/service/memory.go) so an agent can look up what an entity is
// actually linked to, instead of guessing a connection from an isolated
// recall snippet. The parsing/matching/traversal logic itself lives in
// internal/memory (memory.GraphResponse, memory.Neighbors) — shared with the
// `devdeck memory graph` CLI subcommand (internal/memorycli), which pi uses
// since it has no MCP client at all.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/service"
)

type memoryTools struct {
	mem *service.MemoryService
}

func registerMemoryTools(s *server.MCPServer, mem *service.MemoryService) {
	h := &memoryTools{mem: mem}
	s.AddTool(mcp.NewTool("graph_neighbors",
		mcp.WithDescription(
			"Look up an entity's or fact's REAL relationships in DevDeck's persistent memory "+
				"graph — what it's actually linked to, how (linkType: cooccurrence, semantic, "+
				"temporal, entity, caused_by) and how strongly (weight). Use this instead of "+
				"inferring a connection from an isolated recall snippet: recall returns facts "+
				"that matched a query, not the relationships between them.",
		),
		mcp.WithString("entity", mcp.Required(),
			mcp.Description("The entity or fact label to look up. Copy it verbatim from a prior recall/reflect/graph_neighbors result — don't guess the spelling; an unmatched label returns candidates instead of guessing for you.")),
		mcp.WithString("mode",
			mcp.Description(`"entities" (default): the entity co-occurrence graph. "facts": the raw memory/fact graph, which has richer edge types (semantic, temporal, caused_by).`),
			mcp.Enum("entities", "facts")),
		mcp.WithNumber("limit",
			mcp.Description("Max graph nodes to pull before matching against `entity` (default 300). Raise it only if a real entity/fact isn't being found within the default window.")),
	), h.graphNeighbors)
}

func (h *memoryTools) graphNeighbors(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	entity, err := req.RequireString("entity")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	mode := req.GetString("mode", "entities")
	limit := req.GetInt("limit", 300)
	if limit <= 0 || limit > 2000 {
		limit = 300
	}

	q := url.Values{}
	q.Set("limit", strconv.Itoa(limit))

	var raw json.RawMessage
	var callErr error
	switch mode {
	case "facts":
		raw, callErr = h.mem.Graph(ctx, q)
	case "", "entities":
		q.Set("min_count", "1")
		raw, callErr = h.mem.EntityGraph(ctx, q)
	default:
		return mcp.NewToolResultError(`mode must be "entities" or "facts"`), nil
	}
	if callErr != nil {
		return mcp.NewToolResultError(fmt.Sprintf("memory graph unavailable: %v", callErr)), nil
	}

	var g memory.GraphResponse
	if err := json.Unmarshal(raw, &g); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("parse memory graph: %v", err)), nil
	}

	return jsonResult(memory.Neighbors(g, entity))
}
