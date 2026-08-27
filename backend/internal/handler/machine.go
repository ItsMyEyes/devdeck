package handler

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/handovertoken"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// MachineHandler handles the hub's runtime-machine registry.
type MachineHandler struct {
	st          *store.Store
	healthCache *service.MachineHealthCache
	authSvc     *service.AuthService // nil-safe: only PostToken (Task 4) uses it
	signingPriv ed25519.PrivateKey
}

func NewMachineHandler(st *store.Store, healthCache *service.MachineHealthCache, authSvc *service.AuthService, signingPriv ed25519.PrivateKey) *MachineHandler {
	return &MachineHandler{st: st, healthCache: healthCache, authSvc: authSvc, signingPriv: signingPriv}
}

// withSigningKey stamps every Machine in the slice with this hub's Ed25519
// public key before it's serialized — see domain.Machine.SigningPublicKey.
func (h *MachineHandler) withSigningKey(machines []domain.Machine) []domain.Machine {
	pub := base64.StdEncoding.EncodeToString(h.signingPriv.Public().(ed25519.PublicKey))
	for i := range machines {
		machines[i].SigningPublicKey = pub
	}
	return machines
}

func (h *MachineHandler) withSigningKeyOne(m domain.Machine) domain.Machine {
	m.SigningPublicKey = base64.StdEncoding.EncodeToString(h.signingPriv.Public().(ed25519.PublicKey))
	return m
}

// validMachineURL accepts absolute http/https URLs.
func validMachineURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// GetMachines lists registered machines, keys included: this is the
// key-distribution endpoint for direct-first clients (behind hub auth).
func (h *MachineHandler) GetMachines(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Machines()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withSigningKey(list))
}

func (h *MachineHandler) PostMachine(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    *string `json:"name"`
		URL     *string `json:"url"`
		Key     *string `json:"key"`
		IsLocal *bool   `json:"isLocal"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if str(body.Name) == "" || str(body.URL) == "" || str(body.Key) == "" {
		writeErr(w, http.StatusBadRequest, "name, url and key are required")
		return
	}
	if !validMachineURL(str(body.URL)) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	if err := machineclient.Probe(r.Context(), str(body.URL), str(body.Key)); err != nil {
		writeErr(w, http.StatusBadRequest, "could not connect to machine: "+err.Error())
		return
	}
	m, err := h.st.CreateMachine(str(body.Name), str(body.URL), str(body.Key), body.IsLocal != nil && *body.IsLocal)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withSigningKeyOne(m))
}

func (h *MachineHandler) PatchMachine(w http.ResponseWriter, r *http.Request) {
	var p port.MachinePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if p.URL != nil && !validMachineURL(*p.URL) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	m, err := h.st.UpdateMachine(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withSigningKeyOne(m))
}

func (h *MachineHandler) DeleteMachine(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteMachine(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetMachineHealth reports a machine's status. It serves the background
// poller's cached result when one exists (see MachineHealthCache), falling
// back to a single live check for a machine that hasn't been polled yet
// (just added, or the hub just started). Offline is a normal answer (200),
// not an error: the frontend polls this to drive status badges and
// direct-vs-proxy fallback.
func (h *MachineHandler) GetMachineHealth(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	status, ok := h.healthCache.Get(m.ID)
	if !ok {
		status = machineclient.CheckHealth(r.Context(), m)
	}
	writeJSON(w, http.StatusOK, healthResponse(status))
}

// PostToken handles POST /api/machines/{id}/token. The caller must already
// hold a valid hub session (this route is hub-only, gated by the normal
// RequireAuth cookie check — no new auth path here). It mints a 60-second
// token scoped to this one machine, which the browser then uses to sign
// into that runtime's own UI without re-entering credentials.
func (h *MachineHandler) PostToken(w http.ResponseWriter, r *http.Request) {
	user, err := h.authSvc.CurrentUser(cookieValue(r, sessionCookieName))
	if handleStoreErr(w, err) {
		return
	}
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	tok, err := handovertoken.Issue(h.signingPriv, user.ID, m.ID, time.Now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": tok})
}

// PostMachineRestart handles POST /api/machines/{id}/restart: tells the
// target machine's own process to restart itself. Works for the local
// machine too — its stored URL is its own http://127.0.0.1:<port>, so this
// is a loopback call back into this exact process. See machineclient.Restart.
func (h *MachineHandler) PostMachineRestart(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	if err := machineclient.Restart(r.Context(), m); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarting"})
}

// PostMachineStop handles POST /api/machines/{id}/stop: tells the target
// machine's own process to stop. Refused for the local machine — the Tauri
// desktop's respawn loop would just relaunch it, so there is no "stopped"
// state to reach for that row (see design doc, Decision 3).
func (h *MachineHandler) PostMachineStop(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	if m.IsLocal {
		writeErr(w, http.StatusBadRequest, "the local machine can't be stopped from here")
		return
	}
	if err := machineclient.Stop(r.Context(), m); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopping"})
}

// GetMachineVersion handles GET /api/machines/{id}/version, forwarding the
// target machine's own build info. Cheap and network-free on the target, so
// the Machines page calls it for every row.
func (h *MachineHandler) GetMachineVersion(w http.ResponseWriter, r *http.Request) {
	h.proxySelf(w, r, machineclient.Version)
}

// GetMachineBusy handles GET /api/machines/{id}/busy, forwarding what a
// restart of that machine would destroy: its live terminal and agent-run
// counts. Like GetMachineVersion it is network-free on the target, so it is
// cheap enough to ask before offering a restart.
func (h *MachineHandler) GetMachineBusy(w http.ResponseWriter, r *http.Request) {
	h.proxySelf(w, r, machineclient.Busy)
}

// GetMachineUpdateCheck handles GET /api/machines/{id}/update-check. The
// target reaches GitHub, so this is operator-initiated only — never polled.
func (h *MachineHandler) GetMachineUpdateCheck(w http.ResponseWriter, r *http.Request) {
	h.proxySelf(w, r, machineclient.UpdateCheck)
}

// PostMachineUpdate handles POST /api/machines/{id}/update: the target
// downloads, verifies, and installs the latest release. It does not restart —
// the frontend issues a separate restart so a failed install never triggers
// one.
func (h *MachineHandler) PostMachineUpdate(w http.ResponseWriter, r *http.Request) {
	h.proxySelf(w, r, machineclient.Update)
}

// proxySelf looks a machine up and forwards its /api/self/* response body
// verbatim, so the runtime stays the single source of truth for these
// schemas. A failure is a 502 carrying the target's own message, matching
// PostMachineRestart.
func (h *MachineHandler) proxySelf(w http.ResponseWriter, r *http.Request, call func(context.Context, domain.Machine) (json.RawMessage, error)) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	body, err := call(r.Context(), m)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func healthResponse(s machineclient.HealthStatus) map[string]any {
	if s.Status != "online" {
		return map[string]any{"status": "offline"}
	}
	return map[string]any{"status": "online", "latencyMs": s.LatencyMs}
}
