package handler

import (
	"encoding/json"
	"net/http"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/sshmgr"
)

// SSHForwardHandler serves the forwarding rule CRUD and lifecycle endpoints.
type SSHForwardHandler struct {
	store     port.Store
	forwarder *sshmgr.Forwarder // unexported field name — Step 1's test reads it directly
}

// NewSSHForwardHandler returns a handler wired to the given store and forwarder.
func NewSSHForwardHandler(st port.Store, fwd *sshmgr.Forwarder) *SSHForwardHandler {
	return &SSHForwardHandler{store: st, forwarder: fwd}
}

// validateForwardPayload checks the HTTP-level constraints that are stricter
// than sshmgr.validateForward (unexported, cannot be called from here).
// The duplication is intentional: a rule can be edited between the write and
// the Start call, so both layers must validate independently.
func validateForwardPayload(f domain.SSHForward) string {
	switch f.Mode {
	case "local", "remote":
		if f.TargetHost == "" || f.TargetPort < 1 || f.TargetPort > 65535 {
			return "mode " + f.Mode + " requires a target host and port (1-65535)"
		}
	case "dynamic":
		if f.TargetHost != "" || f.TargetPort != 0 {
			return "mode dynamic takes no target: each proxied connection carries its own"
		}
	default:
		return "unknown forward mode " + strQ(f.Mode)
	}
	if f.BindPort < 1 || f.BindPort > 65535 {
		return "bind port must be between 1 and 65535"
	}
	return ""
}

func strQ(s string) string { return `"` + s + `"` }

// GetForConnection returns all saved forwarding rules for a connection.
// Returns an empty array (not null) when there are no rules.
func (h *SSHForwardHandler) GetForConnection(w http.ResponseWriter, r *http.Request) {
	forwards, err := h.store.SSHForwards(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, forwards)
}

// Post creates a new forwarding rule on a connection after validating it.
func (h *SSHForwardHandler) Post(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode       *string `json:"mode"`
		BindHost   *string `json:"bindHost"`
		BindPort   *int    `json:"bindPort"`
		TargetHost *string `json:"targetHost"`
		TargetPort *int    `json:"targetPort"`
		Label      *string `json:"label"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	rule := domain.SSHForward{
		ConnectionID: r.PathValue("id"),
		Mode:         strVal(body.Mode),
		BindHost:     strVal(body.BindHost),
		BindPort:     intVal(body.BindPort),
		TargetHost:   strVal(body.TargetHost),
		TargetPort:   intVal(body.TargetPort),
		Label:        strVal(body.Label),
	}
	// Default bind host to loopback when omitted.
	if rule.BindHost == "" {
		rule.BindHost = "127.0.0.1"
	}
	if msg := validateForwardPayload(rule); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	created, err := h.store.CreateSSHForward(rule.ConnectionID, rule.Mode, rule.BindHost,
		rule.BindPort, rule.TargetHost, rule.TargetPort, rule.Label)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, created)
}

// Patch merges fields into an existing forwarding rule. If the rule is
// currently active (starting, running, or reconnecting), it is stopped,
// patched, and restarted so the live listener matches the new rule. If it is
// off or failed, only the row is updated — Patch never starts an off rule.
func (h *SSHForwardHandler) Patch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	existing, err := h.store.SSHForwardByID(id)
	if handleStoreErr(w, err) {
		return
	}
	var body struct {
		Mode       *string `json:"mode"`
		BindHost   *string `json:"bindHost"`
		BindPort   *int    `json:"bindPort"`
		TargetHost *string `json:"targetHost"`
		TargetPort *int    `json:"targetPort"`
		Label      *string `json:"label"`
	}
	raw, err := decodeBody(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Build candidate by merging patch fields over the existing rule.
	candidate := existing
	if _, ok := raw["mode"]; ok {
		candidate.Mode = strVal(body.Mode)
	}
	if _, ok := raw["bindHost"]; ok {
		if strVal(body.BindHost) != "" {
			candidate.BindHost = strVal(body.BindHost)
		} else {
			candidate.BindHost = "127.0.0.1"
		}
	}
	if _, ok := raw["bindPort"]; ok {
		candidate.BindPort = intVal(body.BindPort)
	}
	if _, ok := raw["targetHost"]; ok {
		candidate.TargetHost = strVal(body.TargetHost)
	}
	if _, ok := raw["targetPort"]; ok {
		candidate.TargetPort = intVal(body.TargetPort)
	}
	if _, ok := raw["label"]; ok {
		candidate.Label = strVal(body.Label)
	}

	if msg := validateForwardPayload(candidate); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}

	wasActive := false
	switch h.forwarder.StateOf(id).Status {
	case "starting", "running", "reconnecting":
		wasActive = true
		_ = h.forwarder.Stop(id)
	}

	patch := forwardPatchFromBody(body, raw)
	updated, err := h.store.UpdateSSHForward(id, patch)
	if handleStoreErr(w, err) {
		return
	}

	if wasActive {
		_, _ = h.forwarder.Start(updated)
	}

	writeJSON(w, http.StatusOK, updated)
}

// Delete stops the forward if active, then deletes the saved rule.
func (h *SSHForwardHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_ = h.forwarder.Stop(id) // idempotent, always returns nil
	if handleStoreErr(w, h.store.DeleteSSHForward(id)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PostStart starts a forwarding listener from a full rule in the request body.
// This takes the connection id as given, with no check that it matches a
// real/owned connection — a deliberate trust-boundary decision, not an
// oversight: this is an internal hub API on DevDeck's own authenticated
// surface. Pushing the whole rule rather than an id is also what keeps a
// persisted-rule read out of CatalogSnapshot.
func (h *SSHForwardHandler) PostStart(w http.ResponseWriter, r *http.Request) {
	var rule domain.SSHForward
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	state, err := h.forwarder.Start(rule)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// PostStop tears a forward down without touching the saved rule.
// Returns the resulting state, which is naturally "off" for a stopped forward.
func (h *SSHForwardHandler) PostStop(w http.ResponseWriter, r *http.Request) {
	_ = h.forwarder.Stop(r.PathValue("id"))
	writeJSON(w, http.StatusOK, h.forwarder.StateOf(r.PathValue("id")))
}

// GetStates returns the live status of every active forward on this machine.
// Returns an empty array (not null) when nothing is active — States() builds
// its slice with make([], 0, ...) so there is no nil path.
func (h *SSHForwardHandler) GetStates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.forwarder.States())
}

func strVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func intVal(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// forwardPatchFromBody builds a port.SSHForwardPatch from the parsed raw body,
// only setting fields whose keys were present in the JSON.
func forwardPatchFromBody(body struct {
	Mode       *string `json:"mode"`
	BindHost   *string `json:"bindHost"`
	BindPort   *int    `json:"bindPort"`
	TargetHost *string `json:"targetHost"`
	TargetPort *int    `json:"targetPort"`
	Label      *string `json:"label"`
}, raw map[string]json.RawMessage) port.SSHForwardPatch {
	var p port.SSHForwardPatch
	if _, ok := raw["mode"]; ok {
		p.Mode = body.Mode
	}
	if _, ok := raw["bindHost"]; ok {
		p.BindHost = body.BindHost
	}
	if _, ok := raw["bindPort"]; ok {
		p.BindPort = body.BindPort
	}
	if _, ok := raw["targetHost"]; ok {
		p.TargetHost = body.TargetHost
	}
	if _, ok := raw["targetPort"]; ok {
		p.TargetPort = body.TargetPort
	}
	if _, ok := raw["label"]; ok {
		p.Label = body.Label
	}
	return p
}
