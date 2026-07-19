package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// TodoHandler handles todo CRUD endpoints.
type TodoHandler struct {
	st *store.Store
}

// NewTodoHandler creates a todo handler.
func NewTodoHandler(st *store.Store) *TodoHandler {
	return &TodoHandler{st: st}
}

// PostTodo creates a todo.
func (h *TodoHandler) PostTodo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text     string  `json:"text"`
		Priority *string `json:"priority"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	priority := "normal"
	if body.Priority != nil && *body.Priority != "" {
		priority = *body.Priority
	}
	t, err := h.st.CreateTodo(r.PathValue("wsId"), body.Text, priority)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// PatchTodo updates a todo.
func (h *TodoHandler) PatchTodo(w http.ResponseWriter, r *http.Request) {
	var p port.TodoPatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	t, err := h.st.UpdateTodo(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// DeleteTodo deletes a todo.
func (h *TodoHandler) DeleteTodo(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteTodo(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ClearDoneTodos deletes all done todos in a workspace.
func (h *TodoHandler) ClearDoneTodos(w http.ResponseWriter, r *http.Request) {
	n, err := h.st.ClearDoneTodos(r.PathValue("wsId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"deleted": n})
}
