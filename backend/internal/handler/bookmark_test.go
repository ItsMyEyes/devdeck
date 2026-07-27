package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

func decodeJSONBody(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.NewDecoder(rec.Body).Decode(dst); err != nil {
		t.Fatalf("decode response body: %v (body=%s)", err, rec.Body.String())
	}
}

func newTestBookmarkHandler(t *testing.T) *BookmarkHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	return NewBookmarkHandler(st, service.NewFaviconService(st))
}

func TestPostBookmarkValidatesRequiredFields(t *testing.T) {
	h := newTestBookmarkHandler(t)
	rec := httptest.NewRecorder()
	h.PostBookmark(rec, httptest.NewRequest(http.MethodPost, "/api/bookmarks",
		strings.NewReader(`{"title":"Example"}`))) // missing url
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostBookmarkRejectsNonHTTPURL(t *testing.T) {
	h := newTestBookmarkHandler(t)
	rec := httptest.NewRecorder()
	h.PostBookmark(rec, httptest.NewRequest(http.MethodPost, "/api/bookmarks",
		strings.NewReader(`{"title":"Example","url":"ftp://x"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// TestPostBookmarkSucceedsWithoutMachineID covers saving a bookmark with no
// machineId (an unassigned bookmark) — FaviconService.Fetch short-circuits on
// a blank machineId, so this exercises the handler without any network I/O.
func TestPostBookmarkSucceedsWithoutMachineID(t *testing.T) {
	h := newTestBookmarkHandler(t)
	rec := httptest.NewRecorder()
	h.PostBookmark(rec, httptest.NewRequest(http.MethodPost, "/api/bookmarks",
		strings.NewReader(`{"title":"Example","url":"https://example.com/","group":"Docs"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var got domain.Bookmark
	decodeJSONBody(t, rec, &got)
	if got.Title != "Example" || got.URL != "https://example.com/" || got.Group != "Docs" || got.IconDataURL != "" {
		t.Errorf("PostBookmark result = %+v", got)
	}
}

func TestPostBookmarkResavingSameURLUpdatesInPlace(t *testing.T) {
	h := newTestBookmarkHandler(t)

	rec := httptest.NewRecorder()
	h.PostBookmark(rec, httptest.NewRequest(http.MethodPost, "/api/bookmarks",
		strings.NewReader(`{"title":"Example","url":"https://example.com/","group":"Docs"}`)))
	var first domain.Bookmark
	decodeJSONBody(t, rec, &first)

	rec2 := httptest.NewRecorder()
	h.PostBookmark(rec2, httptest.NewRequest(http.MethodPost, "/api/bookmarks",
		strings.NewReader(`{"title":"Example Renamed","url":"https://example.com/","group":"Reading"}`)))
	var second domain.Bookmark
	decodeJSONBody(t, rec2, &second)

	if second.ID != first.ID {
		t.Errorf("re-saving the same url created a new bookmark: %q != %q", second.ID, first.ID)
	}
	list, err := h.st.Bookmarks()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Errorf("Bookmarks() len = %d, want 1", len(list))
	}
}

func TestPatchBookmarkRejectsOversizedIconDataURL(t *testing.T) {
	h := newTestBookmarkHandler(t)
	b, err := h.st.CreateBookmark("", "Docs", "Example", "https://example.com/", "")
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/bookmarks/{id}", h.PatchBookmark)
	huge := `"data:image/png;base64,` + strings.Repeat("A", maxIconDataURLLen) + `"`
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/bookmarks/"+b.ID,
		strings.NewReader(`{"iconDataUrl":`+huge+`}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPatchBookmarkRejectsNonImageDataURL(t *testing.T) {
	h := newTestBookmarkHandler(t)
	b, err := h.st.CreateBookmark("", "Docs", "Example", "https://example.com/", "")
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/bookmarks/{id}", h.PatchBookmark)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/bookmarks/"+b.ID,
		strings.NewReader(`{"iconDataUrl":"javascript:alert(1)"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPatchBookmarkAppliesPartialUpdate(t *testing.T) {
	h := newTestBookmarkHandler(t)
	b, err := h.st.CreateBookmark("", "Docs", "Example", "https://example.com/", "")
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/bookmarks/{id}", h.PatchBookmark)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/bookmarks/"+b.ID,
		strings.NewReader(`{"title":"Renamed"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var got domain.Bookmark
	decodeJSONBody(t, rec, &got)
	if got.Title != "Renamed" || got.Group != "Docs" {
		t.Errorf("PatchBookmark result = %+v", got)
	}
}

func TestDeleteBookmarkRemovesIt(t *testing.T) {
	h := newTestBookmarkHandler(t)
	b, err := h.st.CreateBookmark("", "Docs", "Example", "https://example.com/", "")
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("DELETE /api/bookmarks/{id}", h.DeleteBookmark)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/bookmarks/"+b.ID, nil))
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}

	list, err := h.st.Bookmarks()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Errorf("Bookmarks() len = %d, want 0 after delete", len(list))
	}
}

func TestGetBookmarksListsAll(t *testing.T) {
	h := newTestBookmarkHandler(t)
	if _, err := h.st.CreateBookmark("", "Docs", "Example", "https://example.com/", ""); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.GetBookmarks(rec, httptest.NewRequest(http.MethodGet, "/api/bookmarks", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got []domain.Bookmark
	decodeJSONBody(t, rec, &got)
	if len(got) != 1 {
		t.Errorf("GetBookmarks len = %d, want 1", len(got))
	}
}
