package memory

import "testing"

func node(id, label string) GraphNode {
	var n GraphNode
	n.Data.ID = id
	n.Data.Label = label
	return n
}

func edge(source, target, linkType string, weight float64) GraphEdge {
	var e GraphEdge
	e.Data.Source = source
	e.Data.Target = target
	e.Data.LinkType = linkType
	e.Data.Weight = weight
	return e
}

func TestNeighborsExactMatch(t *testing.T) {
	g := GraphResponse{
		Nodes: []GraphNode{node("1", "Kubernetes"), node("2", "RKE2"), node("3", "Docker")},
		Edges: []GraphEdge{
			edge("1", "2", "cooccurrence", 9),
			edge("1", "3", "cooccurrence", 2),
		},
	}
	got := Neighbors(g, "Kubernetes")
	if !got.Found || got.Ambiguous || len(got.Results) != 1 {
		t.Fatalf("got = %+v", got)
	}
	r := got.Results[0]
	if r.Entity != "Kubernetes" || len(r.Neighbors) != 2 {
		t.Fatalf("result = %+v", r)
	}
	// Sorted by weight descending.
	if r.Neighbors[0].Entity != "RKE2" || r.Neighbors[0].Weight != 9 {
		t.Fatalf("neighbors[0] = %+v, want RKE2 weight 9 first", r.Neighbors[0])
	}
	if r.Neighbors[1].Entity != "Docker" {
		t.Fatalf("neighbors[1] = %+v", r.Neighbors[1])
	}
}

func TestNeighborsCaseInsensitiveExactBeatsSubstring(t *testing.T) {
	g := GraphResponse{
		Nodes: []GraphNode{node("1", "Kubernetes"), node("2", "Kubernetes cluster")},
	}
	got := Neighbors(g, "kubernetes")
	if !got.Found || len(got.Results) != 1 || got.Results[0].Entity != "Kubernetes" {
		t.Fatalf("got = %+v, want exact match to win over the substring match", got)
	}
}

func TestNeighborsSubstringFallback(t *testing.T) {
	g := GraphResponse{
		Nodes: []GraphNode{node("1", "Kubernetes cluster")},
	}
	got := Neighbors(g, "kube")
	if !got.Found || len(got.Results) != 1 || got.Results[0].Entity != "Kubernetes cluster" {
		t.Fatalf("got = %+v, want substring match", got)
	}
}

func TestNeighborsNotFound(t *testing.T) {
	g := GraphResponse{Nodes: []GraphNode{node("1", "Kubernetes")}}
	got := Neighbors(g, "totally-unrelated")
	if got.Found || got.Ambiguous || got.Hint == "" {
		t.Fatalf("got = %+v, want not-found with a hint", got)
	}
}

func TestNeighborsAmbiguousOverFiveMatches(t *testing.T) {
	g := GraphResponse{Nodes: []GraphNode{
		node("1", "dev1"), node("2", "dev2"), node("3", "dev3"),
		node("4", "dev4"), node("5", "dev5"), node("6", "dev6"),
	}}
	got := Neighbors(g, "dev")
	if got.Found || !got.Ambiguous || len(got.Candidates) != 6 {
		t.Fatalf("got = %+v, want ambiguous with 6 candidates", got)
	}
}

func TestNeighborsExcludesSelfLoops(t *testing.T) {
	g := GraphResponse{
		Nodes: []GraphNode{node("1", "A")},
		Edges: []GraphEdge{edge("1", "1", "semantic", 1)},
	}
	got := Neighbors(g, "A")
	if !got.Found || len(got.Results[0].Neighbors) != 0 {
		t.Fatalf("got = %+v, want a self-loop to produce zero neighbors, not A->A", got)
	}
}
