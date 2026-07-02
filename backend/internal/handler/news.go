package handler

import (
	"net/http"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// NewsHandler handles news CRUD endpoints.
type NewsHandler struct {
	st *store.Store
}

// NewNewsHandler creates a news handler.
func NewNewsHandler(st *store.Store) *NewsHandler {
	return &NewsHandler{st: st}
}

func (h *NewsHandler) PostNews(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source string `json:"source"`
		Title  string `json:"title"`
		Tag    string `json:"tag"`
		Time   string `json:"time"`
		Unread *bool  `json:"unread"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	unread := true
	if body.Unread != nil {
		unread = *body.Unread
	}
	n, err := h.st.CreateNews(r.PathValue("wsId"), body.Source, body.Title, body.Tag, body.Time, unread)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (h *NewsHandler) PatchNews(w http.ResponseWriter, r *http.Request) {
	var p port.NewsPatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	n, err := h.st.UpdateNews(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (h *NewsHandler) ReadAllNews(w http.ResponseWriter, r *http.Request) {
	n, err := h.st.MarkAllNewsRead(r.PathValue("wsId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"updated": n})
}

func (h *NewsHandler) DeleteNews(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteNews(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
