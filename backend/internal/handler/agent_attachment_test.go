package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/store"
)

// pngFixture is just enough bytes for http.DetectContentType to sniff
// "image/png" — the 8-byte PNG signature — not a decodable image. The
// handler under test only sniffs; it never decodes.
var pngFixture = append([]byte("\x89PNG\r\n\x1a\n"), []byte("rest-of-file-not-a-real-image")...)

func newAgentAttachmentTestHandler(t *testing.T) *AgentAttachmentHandler {
	t.Helper()
	return NewAgentAttachmentHandler(store.NewTestStore(t))
}

// agentAttachmentUploadRequest builds a multipart POST with one "file" part.
// partContentType, when non-empty, is the part's own declared Content-Type
// header — the thing PostAttachment must NOT trust, since it sniffs the
// bytes instead.
func agentAttachmentUploadRequest(t *testing.T, threadID, filename, partContentType string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)

	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filename))
	if partContentType != "" {
		header.Set("Content-Type", partContentType)
	}
	part, err := mw.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/agent/threads/"+threadID+"/attachments", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("threadId", threadID)
	return req
}

func assertErrorEnvelope(t *testing.T, body []byte) {
	t.Helper()
	var env map[string]string
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode error envelope: %v (body %s)", err, body)
	}
	if env["error"] == "" {
		t.Fatalf(`body = %s, want {"error":...}`, body)
	}
}

func TestPostAttachment_Success(t *testing.T) {
	h := newAgentAttachmentTestHandler(t)
	req := agentAttachmentUploadRequest(t, "w-1", "shot.png", "image/png", pngFixture)

	rec := httptest.NewRecorder()
	h.PostAttachment(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	var got domain.AgentAttachment
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID == "" || got.ThreadID != "w-1" || got.Name != "shot.png" || got.MimeType != "image/png" {
		t.Fatalf("got = %+v", got)
	}
	if got.SizeBytes != int64(len(pngFixture)) {
		t.Fatalf("sizeBytes = %d, want %d", got.SizeBytes, len(pngFixture))
	}
	if strings.Contains(rec.Body.String(), `"data"`) {
		t.Fatalf("response leaked a data field: %s", rec.Body.String())
	}
}

func TestPostAttachment_MissingFile400(t *testing.T) {
	h := newAgentAttachmentTestHandler(t)

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("notfile", "x"); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/agent/threads/w-1/attachments", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("threadId", "w-1")

	rec := httptest.NewRecorder()
	h.PostAttachment(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	assertErrorEnvelope(t, rec.Body.Bytes())
}

// TestPostAttachment_NonImage400 is the specific behavior that
// differentiates this handler from handler/attachment.go's PostAttachment:
// the client's declared Content-Type is a lie ("image/png") but the bytes
// are plain text. The sniffed type must win, so this is rejected.
func TestPostAttachment_NonImage400(t *testing.T) {
	h := newAgentAttachmentTestHandler(t)
	req := agentAttachmentUploadRequest(t, "w-1", "evil.png", "image/png", []byte("plain text, not an image"))

	rec := httptest.NewRecorder()
	h.PostAttachment(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	assertErrorEnvelope(t, rec.Body.Bytes())
}

// TestPostAttachment_MislabeledRealImageAccepted is the other direction of
// the same sniffing behavior: the client's declared Content-Type is wrong
// ("text/plain") but the bytes are a real image signature. A header-trusting
// implementation would reject this; sniffing accepts it.
func TestPostAttachment_MislabeledRealImageAccepted(t *testing.T) {
	h := newAgentAttachmentTestHandler(t)
	req := agentAttachmentUploadRequest(t, "w-1", "shot.png", "text/plain", pngFixture)

	rec := httptest.NewRecorder()
	h.PostAttachment(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	var got domain.AgentAttachment
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.MimeType != "image/png" {
		t.Fatalf("mimeType = %q, want image/png (sniffed, not the declared text/plain)", got.MimeType)
	}
}

func TestPostAttachment_Oversize400(t *testing.T) {
	h := newAgentAttachmentTestHandler(t)
	oversized := bytes.Repeat([]byte("a"), 10<<20+1)
	req := agentAttachmentUploadRequest(t, "w-1", "big.png", "image/png", oversized)

	rec := httptest.NewRecorder()
	h.PostAttachment(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	assertErrorEnvelope(t, rec.Body.Bytes())
}

func TestGetAttachment_Success(t *testing.T) {
	st := store.NewTestStore(t)
	h := NewAgentAttachmentHandler(st)
	created, err := st.CreateAgentAttachment("w-1", "shot.png", "image/png", pngFixture, "2026-08-15T00:00:00Z")
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/agent/attachments/"+created.ID, nil)
	req.SetPathValue("id", created.ID)
	rec := httptest.NewRecorder()
	h.GetAttachment(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "private, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", cc)
	}
	if !bytes.Equal(rec.Body.Bytes(), pngFixture) {
		t.Fatalf("body mismatch")
	}
}

func TestGetAttachment_UnknownID404(t *testing.T) {
	h := newAgentAttachmentTestHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/agent/attachments/aatt-nope", nil)
	req.SetPathValue("id", "aatt-nope")
	rec := httptest.NewRecorder()
	h.GetAttachment(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %q)", rec.Code, rec.Body.String())
	}
	assertErrorEnvelope(t, rec.Body.Bytes())
}
