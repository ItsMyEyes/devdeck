// Package procgroup groups a spawned child process together with every
// further process it goes on to spawn (a shell wrapper's real payload, a
// language server's build subprocess, ...) so the whole tree can be torn
// down as a unit instead of just the one PID the caller happens to hold.
//
// On Unix this is already solved: internal/terminal starts each PTY command
// in its own session, making its pid double as the process-group id, and
// signals -pid to reach every descendant. This package exists for Windows,
// where TerminateProcess only ever kills the exact process handle it is
// given — never its children — and there is no equivalent of a process
// group to signal instead. Two concrete failures follow from that gap:
//
//  1. A CLI installed as an npm .cmd shim (claude, codex, ...) is launched
//     as `cmd.exe /c foo.cmd args` (see command_windows.go's
//     platformCommand). Killing that outer cmd.exe leaves the real Node
//     process it started running forever as an orphan.
//  2. This backend itself dying — a crash, a forced quit, a self-update
//     replacing the binary — leaves every agent CLI and language server it
//     ever spawned running too, since nothing is left alive to signal them.
//
// See Attach for how a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_
// CLOSE fixes both at once.
package procgroup
