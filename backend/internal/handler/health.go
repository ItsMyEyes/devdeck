package handler

import (
	"net/http"
	"sync"
	"time"

	"devdeck/backend/internal/port"
)

// HealthHandler handles health-check requests.
type HealthHandler struct{}

// NewHealthHandler creates a health handler.
func NewHealthHandler() *HealthHandler { return &HealthHandler{} }

// ServeHTTP returns a simple health status.
func (h *HealthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// CapSSHChat is advertised by a process new enough to HOST an SSH DevOps
// chat thread: to spawn the agent locally, serve /api/agent-tools/ssh/* from
// its own token store, and dial the host itself using credentials fetched
// from the hub (machineclient.HubSecretSource).
//
// It exists because a hub and its runtimes are upgraded independently, and
// often are not on the same build. Before this, a client had no way to ask —
// so pointing a chat panel at a runtime that predates the feature produced a
// socket that connected, created a thread, and then failed every turn with
// "no agent configured", which reads as a broken feature rather than an
// out-of-date machine. The frontend gates the panel on this string and tells
// the operator to update the runtime when it is absent.
//
// Add a new constant per capability rather than versioning this list: version
// comparison would force the frontend to know which release introduced what,
// which is exactly the knowledge that goes stale.
const CapSSHChat = "ssh-chat"

// CapAgentChat is advertised by a process that serves the worktree agent chat
// socket (/ws/agent) and its supporting REST routes.
//
// Unlike CapSSHChat, whose absence is conclusive, this one is only ever a
// POSITIVE signal. Worktree chat long predates capability reporting, so a
// runtime that omits this string is far more likely to be an older build that
// serves chat perfectly well than one that cannot — and the client must not
// tell an operator to update a machine that is working. See
// agentChatSupport.ts: a missing capability list means "unknown, try it", and
// only a list that is present and lacks this string is treated as a definite
// no.
const CapAgentChat = "agent-chat"

// CapTelegram is advertised by a process that serves /api/telegram/*.
//
// Conclusive in its absence, like CapSSHChat and unlike CapAgentChat: the
// Telegram bridge is new, so a build that does not name it cannot have it.
//
// The failure it replaces is worth stating, because it is what these
// constants are for. A runtime older than the bridge has no /api/telegram/
// route, so the request falls through to the SPA's index.html and the client
// tries to JSON.parse an HTML document — the operator was shown
// "JSON Parse error: Unrecognized token '<'" next to that machine's name,
// which describes the parser's problem rather than theirs ("this machine is
// on an older build; update it").
const CapTelegram = "telegram"

// WhoamiHandler answers an authenticated liveness probe. Unlike
// /api/health (deliberately exempt from auth — see RequireKey/RequireAuth's
// public-path allowlists), this route is gated by the normal auth
// middleware: reaching it with a 200 proves both reachability and a
// correct credential. Used by machineclient.Probe before registering a new
// machine (see MachineHandler.PostMachine), and by the frontend to learn
// which optional features this process can serve (see capabilities).
type WhoamiHandler struct {
	role        string
	machineName string
	store       port.Store // nil on the hub; only runtimes report sync state
	hubURL      string     // configured --hub-url; empty on the hub and on a runtime that never set it
	machineIDMu sync.RWMutex
	machineID   string // this runtime's own hub-assigned id, once self-registration succeeds; empty until then

	// capabilities is what this process can actually do, as opposed to what
	// its version number implies. Set by SetCapabilities at wiring time
	// because it depends on how main.go was configured, not on this type.
	capabilities []string
}

// SetCapabilities records the optional features this process serves. Called
// once during wiring, before the listener accepts anything, so it needs no
// lock of its own.
func (h *WhoamiHandler) SetCapabilities(caps ...string) { h.capabilities = caps }

// NewWhoamiHandler creates a whoami handler. role is "hub" or "runtime";
// machineName is this process's display name when it is a runtime. Pass a
// non-nil store on runtimes so the response can report catalog freshness via
// lastSyncedAt; pass nil on the hub (and on --role both), which never
// replicates a catalog and so never has sync state to report. hubURL and
// machineID are only ever non-empty on a --role runtime process (machineID
// may still be empty briefly, before self-registration first succeeds) —
// the frontend uses both to build the "Sign in via hub" redirect.
func NewWhoamiHandler(role, machineName string, s port.Store, hubURL, machineID string) *WhoamiHandler {
	return &WhoamiHandler{role: role, machineName: machineName, store: s, hubURL: hubURL, machineID: machineID}
}

// SetMachineID updates the machine id this handler reports, once
// self-registration succeeds. Safe to call from a different goroutine than
// the one serving requests.
func (h *WhoamiHandler) SetMachineID(id string) {
	h.machineIDMu.Lock()
	h.machineID = id
	h.machineIDMu.Unlock()
}

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.machineIDMu.RLock()
	machineID := h.machineID
	h.machineIDMu.RUnlock()

	// Always an array, never null: the client treats a missing/!Array value as
	// "this build predates capability reporting", which is a DIFFERENT answer
	// from "this build reports no capabilities" and must not be conflated.
	caps := h.capabilities
	if caps == nil {
		caps = []string{}
	}
	body := map[string]any{
		"status":       "ok",
		"role":         h.role,
		"machineName":  h.machineName,
		"lastSyncedAt": nil,
		"hubUrl":       h.hubURL,
		"machineId":    machineID,
		"capabilities": caps,
	}
	if h.store != nil {
		if at, err := h.store.LastSyncedAt(); err == nil && at != nil {
			body["lastSyncedAt"] = at.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, body)
}
