package handler

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"loom/backend/internal/store"
)

// maxAttachmentSize caps a single description-editor file upload.
const maxAttachmentSize = 15 << 20 // 15MB

// AttachmentHandler handles issue attachment upload/download/delete.
type AttachmentHandler struct {
	st *store.Store
}

// NewAttachmentHandler creates an attachment handler.
func NewAttachmentHandler(st *store.Store) *AttachmentHandler {
	return &AttachmentHandler{st: st}
}

// PostAttachment uploads a file attached to an issue's description.
func (h *AttachmentHandler) PostAttachment(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentSize)
	if err := r.ParseMultipartForm(maxAttachmentSize); err != nil {
		writeErr(w, http.StatusBadRequest, "file too large or invalid form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "missing file")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "failed to read file")
		return
	}

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	createdAt := time.Now().UTC().Format(time.RFC3339)
	att, err := h.st.CreateAttachment(r.PathValue("issueId"), header.Filename, mimeType, data, createdAt)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, att)
}

// ListAttachments returns every attachment uploaded to an issue, for a
// dedicated attachments view (independent of what's inlined in the markdown).
func (h *AttachmentHandler) ListAttachments(w http.ResponseWriter, r *http.Request) {
	atts, err := h.st.ListAttachments(r.PathValue("issueId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, atts)
}

// GetAttachment serves the raw bytes of a previously uploaded attachment,
// so it can be referenced directly from markdown as an image/link src.
func (h *AttachmentHandler) GetAttachment(w http.ResponseWriter, r *http.Request) {
	att, data, err := h.st.AttachmentData(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	w.Header().Set("Content-Type", att.MimeType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename=%q`, att.Filename))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// DeleteAttachment deletes an attachment.
func (h *AttachmentHandler) DeleteAttachment(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteAttachment(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
