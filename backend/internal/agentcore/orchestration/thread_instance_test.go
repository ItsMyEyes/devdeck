package orchestration

import "testing"

// Regression: this mapping existed twice — the WS handler's auto-create and
// main.go's Reactor.InstanceFor each had a copy — and they diverged. The
// handler kept emitting ":default" (an empty Kind, matching no driver) after
// main.go learned to default, so a thread was created announcing one instance
// while the Reactor bound another. Real installs hit it immediately: every
// worktree was a root worktree with an empty Agent.
func TestInstanceIDForAgentDefaultsWhenUnset(t *testing.T) {
	if got := InstanceIDForAgent(""); got != "claude:default" {
		t.Fatalf("empty agent -> %q, want claude:default (never \":default\")", got)
	}
	if got := InstanceIDForAgent("codex"); got != "codex:default" {
		t.Fatalf("codex -> %q, want codex:default", got)
	}
}

func TestWorktreeIDForThreadStripsChatSuffix(t *testing.T) {
	if got := WorktreeIDForThread("w-abc"); got != "w-abc" {
		t.Fatalf("bare id -> %q", got)
	}
	if got := WorktreeIDForThread("w-abc::chat-2"); got != "w-abc" {
		t.Fatalf("split pane id -> %q, want w-abc", got)
	}
}
