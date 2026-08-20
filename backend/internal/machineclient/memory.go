// memory.go is the one file in this package that runs BACKWARDS relative to
// every other file here: everything else is the hub calling out to a
// runtime's own address. This is a runtime calling back to the hub, using its
// own machine key, for the two persistent-memory operations — because the
// Hindsight server and its credentials live only on the hub (see
// domain.MemoryConfig's doc comment). It reuses this package rather than
// getting its own because the call shape (bearer machine key, JSON body,
// unwrap the hub's {"error":...} envelope) is identical to FetchCatalog and
// ReplayProject just above.
package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"devdeck/backend/internal/memory"
)

// memoryRecallTimeout has to clear memory.RecallTimeout (the hub's own bound
// on the Hindsight call it makes on the runtime's behalf) with slack for the
// extra network hop, or the runtime would give up before the hub's own
// timeout even fires — turning a slow-but-answering recall into a guaranteed
// failure instead of an occasionally-slow one.
const memoryRecallTimeout = memory.RecallTimeout + 5*time.Second

// memoryRetainTimeout only bounds queuing the retain on the hub — the hub's
// handler hands off to its own fire-and-forget goroutine and responds
// immediately, so this is a thin margin over an ordinary request, not
// memory.RetainTimeout.
const memoryRetainTimeout = 5 * time.Second

// MemoryScope mirrors internal/memory.Scope on the wire. Duplicated rather
// than imported directly as JSON tags on memory.Scope: that type has no JSON
// tags of its own (it is a Go-side construct whose Tags()/Metadata() do the
// only serialization it needs internally), and giving it wire tags for this
// one caller would be a wart on a type most callers never marshal.
type MemoryScope struct {
	Project  string `json:"project,omitempty"`
	Machine  string `json:"machine,omitempty"`
	Provider string `json:"provider,omitempty"`
	Surface  string `json:"surface,omitempty"`
	Thread   string `json:"thread"`
}

func toWireScope(s memory.Scope) MemoryScope {
	return MemoryScope{Project: s.Project, Machine: s.Machine, Provider: s.Provider, Surface: s.Surface, Thread: s.Thread}
}

type memoryRecallBody struct {
	Scope MemoryScope `json:"scope"`
	Query string      `json:"query"`
}

type memoryRecallResult struct {
	Block string `json:"block"`
}

// RecallMemory asks the hub to search persistent memory and returns the block
// to prepend to a turn's text, or "" on any failure — a runtime's recall hook
// must degrade silently, never fail a turn because memory is unreachable.
func RecallMemory(ctx context.Context, hubURL, machineKey string, scope memory.Scope, query string) string {
	ctx, cancel := context.WithTimeout(ctx, memoryRecallTimeout)
	defer cancel()

	body, err := json.Marshal(memoryRecallBody{Scope: toWireScope(scope), Query: query})
	if err != nil {
		return ""
	}
	url := strings.TrimRight(hubURL, "/") + "/api/runtime/memory/recall"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+machineKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var out memoryRecallResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ""
	}
	return out.Block
}

type memoryRetainBody struct {
	Scope MemoryScope `json:"scope"`
	Role  string      `json:"role"`
	Text  string      `json:"text"`
}

// RetainMemory asks the hub to store one role's turn text. Fire-and-forget on
// the caller's side too: it starts its own goroutine and returns immediately,
// matching service.MemoryService.RetainAsync's contract so a runtime's
// Ingestion hook never blocks a turn from settling on this call.
func RetainMemory(hubURL, machineKey string, scope memory.Scope, role, text string) {
	if text == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), memoryRetainTimeout)
		defer cancel()

		body, err := json.Marshal(memoryRetainBody{Scope: toWireScope(scope), Role: role, Text: text})
		if err != nil {
			return
		}
		url := strings.TrimRight(hubURL, "/") + "/api/runtime/memory/retain"
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+machineKey)
		req.Header.Set("Content-Type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			log.Printf("machineclient: retain memory: %v", err)
			return
		}
		defer resp.Body.Close()
	}()
}
