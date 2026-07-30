package handler

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"time"

	"devdeck/backend/internal/selfupdate"
	"devdeck/backend/internal/terminal"
	"devdeck/backend/internal/version"
)

// UpdateService is the subset of selfupdate.Updater this handler needs, so
// tests can substitute a fake instead of reaching GitHub and overwriting the
// test binary.
type UpdateService interface {
	Check(ctx context.Context, currentVersion, selfSHA256 string) (*selfupdate.CheckResult, error)
	Install(ctx context.Context, currentVersion, execPath string) (*selfupdate.RunResult, error)
}

// SelfHandler exposes this process's own version, update, restart, and stop
// lifecycle over HTTP, so the hub's Machines page can inspect and control a
// registered machine's process directly instead of the operator doing it by
// hand on that machine. See
// docs/superpowers/specs/2026-07-21-runtime-restart-stop-design.md and
// docs/superpowers/specs/2026-07-30-version-sha256-update-ui-design.md.
type SelfHandler struct {
	// managed is true when an external supervisor (the Tauri desktop's
	// sidecar respawn loop) already owns this process's respawn lifecycle
	// — set via --managed/DEVDECK_MANAGED. A managed process must never
	// spawn its own replacement (the supervisor would end up spawning a
	// second one too), must refuse to stop (the supervisor would just
	// silently relaunch it, which is worse than a clear error), and must
	// refuse to update (it is a binary bundled inside a signed desktop
	// app; overwriting it invalidates that bundle).
	managed bool
	// ver is this build's embedded version string (version.Version).
	ver string
	// tokenConfigured records whether a GitHub token was supplied to this
	// process. Only the boolean crosses the API boundary — never the token.
	tokenConfigured bool
	updater         UpdateService
}

// NewSelfHandler creates a self-management handler.
func NewSelfHandler(managed bool, ver string, tokenConfigured bool, updater UpdateService) *SelfHandler {
	return &SelfHandler{managed: managed, ver: ver, tokenConfigured: tokenConfigured, updater: updater}
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

// GetVersion handles GET /api/self/version. It touches no network, so the
// Machines page can call it for every row. An unreadable executable yields an
// empty sha256 rather than an error — the version is still worth reporting.
func (h *SelfHandler) GetVersion(w http.ResponseWriter, r *http.Request) {
	sum, _ := version.SelfSHA256()
	writeJSON(w, http.StatusOK, map[string]any{"version": h.ver, "sha256": sum})
}

// GetUpdateCheck handles GET /api/self/update-check. It answers 200 even when
// the check itself failed, reporting the reason in the body: the hub fans this
// out across every machine, and one unreachable GitHub must not blank the page.
func (h *SelfHandler) GetUpdateCheck(w http.ResponseWriter, r *http.Request) {
	sum, _ := version.SelfSHA256()
	body := map[string]any{
		"current":          h.ver,
		"latest":           "",
		"updateAvailable":  false,
		"checksumVerified": selfupdate.ChecksumVerifiedUnknown,
		"tokenConfigured":  h.tokenConfigured,
		"activeSessions":   terminal.ActiveSessionCount(),
		"managed":          h.managed,
		"error":            "",
	}

	res, err := h.updater.Check(r.Context(), h.ver, sum)
	if err != nil {
		body["error"] = err.Error()
		writeJSON(w, http.StatusOK, body)
		return
	}
	body["latest"] = res.Latest
	body["updateAvailable"] = res.UpdateAvailable
	body["checksumVerified"] = res.ChecksumVerified
	writeJSON(w, http.StatusOK, body)
}

// PostUpdate handles POST /api/self/update: download the latest release,
// verify it, and swap this binary. It never restarts — the caller decides
// when, since a restart drops every live terminal on this machine.
func (h *SelfHandler) PostUpdate(w http.ResponseWriter, r *http.Request) {
	if h.managed {
		writeErr(w, http.StatusConflict, "this runtime is supervised by its desktop app — update it by installing a new desktop release")
		return
	}
	exe, err := os.Executable()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "resolve current executable path: "+err.Error())
		return
	}
	res, err := h.updater.Install(r.Context(), h.ver, exe)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	status := "updated"
	if !res.Updated {
		status = "up-to-date"
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "version": res.Version, "warning": res.Warning})
}
