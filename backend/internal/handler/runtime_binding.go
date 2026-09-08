package handler

import "net/http"

// runtimeBinder is the subset of *service.RuntimeBinder this handler needs.
// An interface so tests can drive both outcomes without constructing the
// real binder's collaborators.
type runtimeBinder interface {
	Bind(hubURL, machineID string) (adopted bool, reason string)
}

// RuntimeBindingHandler serves PUT /api/runtime/binding: a hub that already
// has this machine registered (service.RunBindingPushLoop) pushes its own
// URL and this machine's hub-assigned id, so the runtime can start syncing
// without the operator hand-configuring --hub-url/--hub-key here.
//
// Registered only on --role runtime (main.go), never on --role both: a
// "both" process is its own hub and must never point its sync loop at
// itself — see service.RunSyncLoop's doc comment for what that would do to
// its own catalog.
//
// Authenticated the same way every other runtime route is: RequireRuntimeAuth
// checks the Authorization header against this process's own --key before
// the request ever reaches here. The hub already holds that exact key (it is
// what the Machines registry stores for this machine), so no new credential
// exists on either side.
type RuntimeBindingHandler struct {
	binder runtimeBinder
}

// NewRuntimeBindingHandler creates a runtime-binding handler.
func NewRuntimeBindingHandler(binder runtimeBinder) *RuntimeBindingHandler {
	return &RuntimeBindingHandler{binder: binder}
}

type runtimeBindingRequest struct {
	HubURL    string `json:"hubUrl"`
	MachineID string `json:"machineId"`
}

type runtimeBindingResponse struct {
	Adopted bool   `json:"adopted"`
	Reason  string `json:"reason,omitempty"`
}

func (h *RuntimeBindingHandler) PutBinding(w http.ResponseWriter, r *http.Request) {
	var body runtimeBindingRequest
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	adopted, reason := h.binder.Bind(body.HubURL, body.MachineID)
	writeJSON(w, http.StatusOK, runtimeBindingResponse{Adopted: adopted, Reason: reason})
}
