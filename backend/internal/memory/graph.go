package memory

import (
	"sort"
	"strings"
)

// GraphNode/GraphEdge mirror Hindsight's real /graph and /entities/graph
// response shape — Cytoscape.js "elements" JSON, fields nested one level
// down under `data` — confirmed by curling a live server, not by trusting
// its (missing) OpenAPI schema. See frontend/src/features/memory/
// MemoryGraph.tsx's unwrap() for the same shape verified independently on
// the frontend side.
type GraphNode struct {
	Data struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	} `json:"data"`
}

type GraphEdge struct {
	Data struct {
		Source   string  `json:"source"`
		Target   string  `json:"target"`
		LinkType string  `json:"linkType"`
		Weight   float64 `json:"weight"`
	} `json:"data"`
}

type GraphResponse struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// GraphNeighbor is one edge away from a matched node — the entity/fact on
// the other end, how it's linked, and how strongly.
type GraphNeighbor struct {
	Entity   string  `json:"entity"`
	LinkType string  `json:"linkType"`
	Weight   float64 `json:"weight"`
}

type GraphNeighborsResult struct {
	Entity    string          `json:"entity"`
	Neighbors []GraphNeighbor `json:"neighbors"`
}

// GraphLookup is Neighbors' outcome. Exactly one of three shapes:
//   - Found: len(Results) >= 1, one entry per matched node (usually one).
//   - Ambiguous: too many labels matched (>5) — Candidates lists them so the
//     caller can retry with an exact one instead of guessing which it meant.
//   - Neither: Query matched nothing within the graph handed to Neighbors.
type GraphLookup struct {
	Query      string                 `json:"query"`
	Found      bool                   `json:"found"`
	Ambiguous  bool                   `json:"ambiguous,omitempty"`
	Candidates []string               `json:"candidates,omitempty"`
	Results    []GraphNeighborsResult `json:"results,omitempty"`
	Hint       string                 `json:"hint,omitempty"`
}

// Neighbors looks query up in g's nodes and returns what it is actually
// linked to. Shared by the graph_neighbors MCP tool (internal/issuemcp) and
// the `devdeck memory graph` CLI subcommand (internal/memorycli) — the
// matching/traversal logic every caller of Hindsight's graph endpoints needs
// lives here exactly once.
func Neighbors(g GraphResponse, query string) GraphLookup {
	matches := MatchNodes(g.Nodes, query)
	if len(matches) == 0 {
		return GraphLookup{
			Query: query,
			Hint:  "no node label matched within the nodes pulled — call recall first to get the exact label, or raise the limit used to fetch the graph",
		}
	}
	if len(matches) > 5 {
		names := make([]string, len(matches))
		for i, n := range matches {
			names[i] = n.Data.Label
		}
		return GraphLookup{
			Query: query, Ambiguous: true, Candidates: names,
			Hint: "multiple nodes match — call again with one exact label from candidates",
		}
	}

	byID := make(map[string]GraphNode, len(g.Nodes))
	for _, n := range g.Nodes {
		byID[n.Data.ID] = n
	}

	results := make([]GraphNeighborsResult, 0, len(matches))
	for _, m := range matches {
		var neighbors []GraphNeighbor
		for _, e := range g.Edges {
			if e.Data.Source == e.Data.Target {
				continue // self-loop (Hindsight emits these for some semantic links) — not a neighbor
			}
			var otherID string
			switch m.Data.ID {
			case e.Data.Source:
				otherID = e.Data.Target
			case e.Data.Target:
				otherID = e.Data.Source
			default:
				continue
			}
			other, ok := byID[otherID]
			if !ok {
				continue
			}
			neighbors = append(neighbors, GraphNeighbor{Entity: other.Data.Label, LinkType: e.Data.LinkType, Weight: e.Data.Weight})
		}
		sort.Slice(neighbors, func(i, j int) bool { return neighbors[i].Weight > neighbors[j].Weight })
		results = append(results, GraphNeighborsResult{Entity: m.Data.Label, Neighbors: neighbors})
	}

	return GraphLookup{Query: query, Found: true, Results: results}
}

// MatchNodes prefers an exact (case-insensitive) label match; when none
// exists it falls back to substring matches, which is what lets a caller
// that only half-remembers a label ("kubernetes" vs "Kubernetes cluster")
// still land on candidates instead of an empty result.
func MatchNodes(nodes []GraphNode, query string) []GraphNode {
	q := strings.ToLower(strings.TrimSpace(query))
	var exact, partial []GraphNode
	for _, n := range nodes {
		label := strings.ToLower(n.Data.Label)
		switch {
		case label == q:
			exact = append(exact, n)
		case strings.Contains(label, q):
			partial = append(partial, n)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	return partial
}
