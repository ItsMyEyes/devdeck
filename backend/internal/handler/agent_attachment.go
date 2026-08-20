package handler

import (
	"io"
	"net/http"
	"strings"
	"time"

	"devdeck/backend/internal/port"
)

// maxAgentAttachmentSize caps a single agent-chat image upload. Smaller than
// the issue-attachment cap (attachment.go's 15MB) because the composer's
// client-side downscale (imageCompression.ts) keeps uploads well under this
// before they ever reach the wire — see the design spec's Risks section.
const maxAgentAttachmentSize = 10 << 20 // 10MB

// AgentAttachmentHandler serves image uploads/downloads for the agent chat
// composer (Composer — Context Attachments, C1). Unlike AttachmentHandler
// (the issue-description editor's uploads, attachment.go), this takes
// port.Store — the newer convention AgentThreadHandler already uses — and
// validates the *sniffed* content type rather than trusting the client's
// declared Content-Type header, so a mislabeled real image is accepted and a
// spoofed label on non-image bytes is rejected.
type AgentAttachmentHandler struct {
	store port.Store
}

// NewAgentAttachmentHandler returns a handler wired to the given store.
func NewAgentAttachmentHandler(st port.Store) *AgentAttachmentHandler {
	return &AgentAttachmentHandler{store: st}
}

// PostAttachment handles POST /api/agent/threads/{threadId}/attachments: a
// multipart upload with field "file". threadId need not name an existing
// agent_thread row yet — CreateAgentAttachment allows an upload to race
// ahead of the thread's own EvtThreadCreated commit.
func (h *AgentAttachmentHandler) PostAttachment(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAgentAttachmentSize)
	if err := r.ParseMultipartForm(maxAgentAttachmentSize); err != nil {
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

	sniffLen := len(data)
	if sniffLen > 512 {
		sniffLen = 512
	}
	sniffed := http.DetectContentType(data[:sniffLen])
	if !strings.HasPrefix(sniffed, "image/") {
		writeErr(w, http.StatusBadRequest, "file must be an image")
		return
	}

	createdAt := time.Now().UTC().Format(time.RFC3339)
	att, err := h.store.CreateAgentAttachment(r.PathValue("threadId"), header.Filename, sniffed, data, createdAt)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, att)
}

// GetAttachment handles GET /api/agent/attachments/{id}: raw bytes, the
// stored (sniffed) content type, and a long-lived cache header — an
// attachment id is immutable, so caching it forever is honest.
func (h *AgentAttachmentHandler) GetAttachment(w http.ResponseWriter, r *http.Request) {
	att, data, err := h.store.AgentAttachmentData(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	w.Header().Set("Content-Type", att.MimeType)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
