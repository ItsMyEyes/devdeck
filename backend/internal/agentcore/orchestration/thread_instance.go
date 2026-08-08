package orchestration

import (
	"strings"

	"devdeck/backend/internal/agentcore/provider"
)

// DefaultAgent is used when a worktree has no Agent set — root worktrees, and
// any worktree created before that field existed, carry an empty one. The
// terminal handles that by opening a plain shell; chat has no such fallback
// and must name an agent or nothing can run.
//
// Claude is the only agent with a ported agentcore Driver today, and the
// settings default_model is a Claude model, so this matches what the
// composer's model picker already shows.
const DefaultAgent = "claude"

// WorktreeIDForThread strips a thread's chat-pane suffix. A threadID is either
// a bare worktree id or "<worktreeId>::chat-N" for an extra split chat pane
// (see paneTree.ts) — both name the same worktree.
func WorktreeIDForThread(threadID string) string {
	if i := strings.Index(threadID, "::"); i >= 0 {
		return threadID[:i]
	}
	return threadID
}

// InstanceIDForAgent maps a worktree's Agent field to the InstanceID that
// should run its threads.
//
// This exists as ONE function because it previously existed as two — the WS
// handler's auto-create and main.go's Reactor.InstanceFor each had their own
// copy, and they diverged: the handler kept emitting ":default" (an empty
// Kind, matching no driver) after main.go learned to default. A thread was
// then created announcing one instance while the Reactor bound another.
func InstanceIDForAgent(agent string) provider.InstanceID {
	if agent == "" {
		agent = DefaultAgent
	}
	return provider.InstanceID(agent + ":default")
}
