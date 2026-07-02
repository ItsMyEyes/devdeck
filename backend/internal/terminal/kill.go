package terminal

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
