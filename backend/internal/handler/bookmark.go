package handler

import (
	"net/http"
	"net/url"
	"strings"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// maxIconDataURLLen caps a client-supplied iconDataUrl on PATCH (re-editing a
// bookmark never re-fetches the favicon) — matches FaviconService's own
// faviconMaxIconBytes budget with room for the "data:...;base64," prefix and
// base64's ~4/3 expansion.
const maxIconDataURLLen = 100_000

// BookmarkHandler handles the machine-proxied Browser tile's saved pages.
// Bookmarks are hub-role only and stored server-side (not localStorage) so the
// same list shows up whether the operator is on the desktop app or a phone
// hitting the same hub.
type BookmarkHandler struct {
	st      *store.Store
	favicon *service.FaviconService
}

func NewBookmarkHandler(st *store.Store, favicon *service.FaviconService) *BookmarkHandler {
	return &BookmarkHandler{st: st, favicon: favicon}
}

func validBookmarkURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// validIconDataURL accepts only a size-capped "data:image/...;base64,..." —
// the one shape FaviconService itself ever produces — so a client can't smuggle
// an oversized blob or a non-image/javascript: URL into storage via PATCH.
func validIconDataURL(raw string) bool {
	if raw == "" {
		return true
	}
	if len(raw) > maxIconDataURLLen {
		return false
	}
	return strings.HasPrefix(raw, "data:image/")
}

func (h *BookmarkHandler) GetBookmarks(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Bookmarks()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// PostBookmark saves a new bookmark (or updates the existing one for this
// machine+url — see store.CreateBookmark), fetching the page's favicon
// through the owning machine's forward proxy before responding. The favicon
// fetch is best-effort: any failure just leaves iconDataUrl empty, it never
// fails the save.
func (h *BookmarkHandler) PostBookmark(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID *string `json:"machineId"`
		Group     *string `json:"group"`
		Title     *string `json:"title"`
		URL       *string `json:"url"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if str(body.Title) == "" || str(body.URL) == "" {
		writeErr(w, http.StatusBadRequest, "title and url are required")
		return
	}
	if !validBookmarkURL(str(body.URL)) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}

	iconDataURL := h.favicon.Fetch(r.Context(), str(body.MachineID), str(body.URL))
	b, err := h.st.CreateBookmark(str(body.MachineID), str(body.Group), str(body.Title), str(body.URL), iconDataURL)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (h *BookmarkHandler) PatchBookmark(w http.ResponseWriter, r *http.Request) {
	var p port.BookmarkPatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if p.IconDataURL != nil && !validIconDataURL(*p.IconDataURL) {
		writeErr(w, http.StatusBadRequest, "iconDataUrl must be a data:image/... URL")
		return
	}
	b, err := h.st.UpdateBookmark(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (h *BookmarkHandler) DeleteBookmark(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteBookmark(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
