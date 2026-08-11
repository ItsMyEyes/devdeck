package terminal

import "devdeck/backend/internal/domain"

// activeRegistry is the process-wide session registry, set once by
// NewServer. terminal.KillSession is wired into WorktreeService as a plain
// func(string) error callback (see cmd/server/main.go), so it can't carry a
// *Server receiver — it reaches the live registry through this package var
// instead.
var activeRegistry *registry

// KillSession terminates the PTY session (shell or agent process) for a
// worktree session id, if one is running. It is idempotent: if no session
// was ever attached, or it already exited, it returns nil.
func KillSession(session string) error {
	if activeRegistry == nil {
		return nil
	}
	activeRegistry.kill(session)
	return nil
}

// KillWorktreeSessions terminates every PTY session belonging to a worktree:
// its primary session (id == worktreeID) plus any extra terminal-pane
// sessions split off it, which use "<worktreeID>::term-N" as their session
// id (see frontend/src/features/terminal/paneTree.ts). Without this, extra
// panes would only ever be reaped by the idle-grace TTL after a worktree
// delete instead of immediately.
func KillWorktreeSessions(worktreeID string) error {
	if activeRegistry == nil {
		return nil
	}
	activeRegistry.killByWorktree(worktreeID)
	return nil
}

// ActiveSessionCount reports how many PTY sessions this process is currently
// running, so the UI can warn how many terminals a restart will disconnect.
// A process that never started a terminal server (a pure --role hub) has a nil
// registry and reports 0, matching how KillSession guards the same var.
func ActiveSessionCount() int {
	if activeRegistry == nil {
		return 0
	}
	return activeRegistry.count()
}

// ActiveSessions reports every PTY session this process is currently
// running, so an operator can see (and, via DeleteSession, kill) a session
// whose id fell out of the frontend's pane layout and would otherwise only
// be cleared by a backend restart. Always returns a non-nil slice — `[]`,
// never `null`, on the wire — matching Forwarder.States. A process with no
// terminal server (a pure --role hub) has a nil registry and reports none,
// matching ActiveSessionCount's guard.
func ActiveSessions() []domain.TerminalSession {
	if activeRegistry == nil {
		return []domain.TerminalSession{}
	}
	return activeRegistry.snapshot()
}

// KillAllSessions terminates every PTY session this process is currently
// running and returns how many were killed, for a graceful-shutdown path
// that must not leave child processes running past the server exiting. A
// process with no terminal server (a pure --role hub) has a nil registry and
// kills none, matching ActiveSessionCount/ActiveSessions's guard.
func KillAllSessions() int {
	if activeRegistry == nil {
		return 0
	}
	return activeRegistry.killAll()
}
