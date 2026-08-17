package orchestration

import "strings"

// SSHThreadPrefix marks a thread id as belonging to the "ssh:" namespace
// (design spec §3.1): one thread per saved SSH connection, plus optional
// "::chat-N" extra chats — the same suffix shape a worktree thread id
// already uses (see WorktreeIDForThread).
//
//	w-<hex>[::chat-N]              worktree thread (existing, unchanged)
//	ssh:<connectionId>[::chat-N]   SSH thread      (new)
const SSHThreadPrefix = "ssh:"

// ToolRequestPrefix marks an approval request id as raised by DevDeck's own
// tool layer (service.SSHToolService, via ToolApprovalPrompter below) rather
// than by a provider. The Reactor's EvtThreadApprovalResponseRequested case
// uses this to skip Provider.RespondToRequest: a tool-gate request has no
// provider-side counterpart to answer.
const ToolRequestPrefix = "tool-"

// IsSSHThread reports whether threadID names an SSH chat thread rather than a
// worktree thread.
func IsSSHThread(threadID string) bool {
	return strings.HasPrefix(threadID, SSHThreadPrefix)
}

// SSHConnectionIDForThread extracts the SSH connection id from a thread id,
// stripping both the "ssh:" namespace prefix and any "::chat-N" extra-chat
// suffix. Callers should check IsSSHThread first; called on a non-SSH thread
// id it just returns the id unchanged (no "ssh:" prefix to strip).
func SSHConnectionIDForThread(threadID string) string {
	id := strings.TrimPrefix(threadID, SSHThreadPrefix)
	if i := strings.Index(id, "::"); i >= 0 {
		id = id[:i]
	}
	return id
}

// SSHThreadID builds the thread id for a saved SSH connection's primary
// chat. Extra chats append their own "::chat-N" suffix on top of this.
func SSHThreadID(connectionID string) string {
	return SSHThreadPrefix + connectionID
}
