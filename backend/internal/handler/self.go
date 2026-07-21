package handler

import (
	"net/http"
	"os"
	"os/exec"
	"time"
)

// SelfHandler exposes this process's own restart/stop lifecycle over HTTP,
// so the hub's Runtimes page can control a registered machine's process
// directly instead of the operator doing it by hand on that machine. See
// docs/superpowers/specs/2026-07-21-runtime-restart-stop-design.md.
type SelfHandler struct {
	// managed is true when an external supervisor (the Tauri desktop's
	// sidecar respawn loop) already owns this process's respawn lifecycle
	// — set via --managed/DEVDECK_MANAGED. A managed process must never
	// spawn its own replacement (the supervisor would end up spawning a
	// second one too), and must refuse to stop (the supervisor would just
	// silently relaunch it, which is worse than a clear error).
	managed bool
}

// NewSelfHandler creates a self-management handler.
func NewSelfHandler(managed bool) *SelfHandler {
	return &SelfHandler{managed: managed}
}

// spawnReplacement and exitProcess are swappable package-level vars so
// tests can assert what PostRestart/PostStop *would* do without actually
// spawning a child process or exiting the test binary.
var (
	spawnReplacement = defaultSpawnReplacement
	exitProcess      = defaultExitProcess
)

// defaultSpawnReplacement re-execs this binary: same executable path, same
// argv, detached so it outlives this process's exit. Used only when this
// process is unmanaged — a managed process relies on its supervisor to
// relaunch it instead (see SelfHandler.managed).
func defaultSpawnReplacement() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	detachFromParent(cmd)
	return cmd.Start()
}

// defaultExitProcess exits after a short delay so the HTTP response that
// triggered it has time to actually flush to the client first.
func defaultExitProcess() {
	time.Sleep(300 * time.Millisecond)
	os.Exit(0)
}

// PostRestart handles POST /api/self/restart. An unmanaged process spawns a
// detached copy of itself (same executable, same args) before exiting, so
// it comes back on its own with no external supervisor required. A managed
// process just exits — its supervisor already handles respawning it, and
// spawning a second replacement here would race that supervisor's own.
func (h *SelfHandler) PostRestart(w http.ResponseWriter, r *http.Request) {
	if !h.managed {
		if err := spawnReplacement(); err != nil {
			writeErr(w, http.StatusInternalServerError, "spawn replacement process: "+err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarting"})
	go exitProcess()
}

// PostStop handles POST /api/self/stop. An unmanaged process exits and
// stays down. A managed process refuses: its supervisor would silently
// relaunch it a moment later, which is worse than a clear error telling
// the operator why "stop" didn't stick.
func (h *SelfHandler) PostStop(w http.ResponseWriter, r *http.Request) {
	if h.managed {
		writeErr(w, http.StatusConflict, "this runtime is supervised by its desktop app and can't be stopped from here")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopping"})
	go exitProcess()
}
