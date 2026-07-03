package handler

import (
	"net/http"
	"time"

	"loom/backend/internal/store"
)

// CommentHandler handles issue comment CRUD endpoints — both top-level
// comments and single-level-deep replies, disambiguated by an optional
// parentId in the request body.
type CommentHandler struct {
	st *store.Store
}

// NewCommentHandler creates a comment handler.
func NewCommentHandler(st *store.Store) *CommentHandler {
	return &CommentHandler{st: st}
}

// PostComment adds a comment (or, with parentId set, a reply) to an issue.
func (h *CommentHandler) PostComment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Author   string  `json:"author"`
		Body     string  `json:"body"`
		ParentID *string `json:"parentId"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	createdAt := time.Now().UTC().Format(time.RFC3339)
	c, err := h.st.CreateIssueComment(r.PathValue("issueId"), body.ParentID, body.Author, body.Body, createdAt)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// ListComments returns every comment and reply on an issue.
func (h *CommentHandler) ListComments(w http.ResponseWriter, r *http.Request) {
	comments, err := h.st.ListIssueComments(r.PathValue("issueId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, comments)
}

// PatchComment edits a comment or reply's body.
func (h *CommentHandler) PatchComment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Body string `json:"body"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	updatedAt := time.Now().UTC().Format(time.RFC3339)
	c, err := h.st.UpdateIssueComment(r.PathValue("id"), updatedAt, body.Body)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// DeleteComment deletes a comment or reply.
func (h *CommentHandler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteIssueComment(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
