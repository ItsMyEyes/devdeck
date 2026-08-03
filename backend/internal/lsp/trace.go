package lsp

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// traceLimit bounds the ring buffer. Only session-shaping messages are
// recorded (see recordClientMessage), not the full JSON-RPC stream, so a
// couple of hundred entries covers several editor sessions.
const traceLimit = 200

// tracer is a bounded, in-memory record of what DevDeck told a language
// server, exposed through GET /api/lsp/trace.
//
// It exists because the failure mode it diagnoses is invisible from the
// outside: a language server handed a document it cannot place inside the
// workspace does not error, it type-checks that file as a standalone package.
// The symptom is "undefined" for every symbol defined in a sibling file, which
// looks like broken code rather than a broken handshake. The only way to tell
// those apart is to see the `rootUri` and the document URIs that actually went
// over the wire.
type tracer struct {
	mu      sync.Mutex
	entries []TraceEntry
	seq     int
}

// TraceEntry is one recorded fact about an LSP session.
type TraceEntry struct {
	Seq     int    `json:"seq"`
	At      string `json:"at"`
	Kind    string `json:"kind"`
	Detail  string `json:"detail"`
	Worktree string `json:"worktree,omitempty"`
}

var globalTracer = &tracer{}

// now is overridable in tests so recorded timestamps are deterministic.
var now = func() time.Time { return time.Now() }

func (t *tracer) record(kind, worktree, format string, args ...any) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.seq++
	t.entries = append(t.entries, TraceEntry{
		Seq:      t.seq,
		At:       now().Format("15:04:05"),
		Kind:     kind,
		Worktree: worktree,
		Detail:   fmt.Sprintf(format, args...),
	})
	if len(t.entries) > traceLimit {
		t.entries = t.entries[len(t.entries)-traceLimit:]
	}
}

func (t *tracer) snapshot() []TraceEntry {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]TraceEntry, len(t.entries))
	copy(out, t.entries)
	return out
}

// Trace returns everything recorded so far, oldest first.
func Trace() []TraceEntry { return globalTracer.snapshot() }

// ResetTrace clears the buffer. Used by tests and by the UI's "clear" action so
// a fresh reproduction is not read against stale entries.
func ResetTrace() {
	globalTracer.mu.Lock()
	defer globalTracer.mu.Unlock()
	globalTracer.entries = nil
	globalTracer.seq = 0
}

// clientFrame is the subset of a client->server JSON-RPC message that decides
// whether a session is wired up correctly.
type clientFrame struct {
	Method string `json:"method"`
	Params struct {
		RootURI          *string `json:"rootUri"`
		WorkspaceFolders []struct {
			URI string `json:"uri"`
		} `json:"workspaceFolders"`
		TextDocument struct {
			URI        string `json:"uri"`
			LanguageID string `json:"languageId"`
			Version    int    `json:"version"`
		} `json:"textDocument"`
	} `json:"params"`
}

// recordClientMessage notes the handful of client->server messages that
// determine whether the server can place a document inside the workspace.
// Everything else (completion, hover, the didChange firehose) is skipped: the
// point is a readable session summary, not a packet capture.
func recordClientMessage(worktreeID string, payload []byte) {
	var frame clientFrame
	if err := json.Unmarshal(payload, &frame); err != nil {
		return
	}

	switch frame.Method {
	case "initialize":
		root := "null"
		if frame.Params.RootURI != nil {
			root = *frame.Params.RootURI
		}
		folders := make([]string, 0, len(frame.Params.WorkspaceFolders))
		for _, folder := range frame.Params.WorkspaceFolders {
			folders = append(folders, folder.URI)
		}
		if len(folders) == 0 {
			globalTracer.record("initialize", worktreeID, "rootUri=%s workspaceFolders=(none)", root)
			return
		}
		globalTracer.record("initialize", worktreeID, "rootUri=%s workspaceFolders=%v", root, folders)

	case "textDocument/didOpen":
		globalTracer.record("didOpen", worktreeID, "%s (languageId=%s)",
			frame.Params.TextDocument.URI, frame.Params.TextDocument.LanguageID)

	case "textDocument/didClose":
		globalTracer.record("didClose", worktreeID, "%s", frame.Params.TextDocument.URI)
	}
}
