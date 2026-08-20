// Memory config and browse endpoints. Hub-only, like completions.go —
// registered only when !isRuntime in main.go — because the Hindsight server
// and its credentials live on the hub alone; see domain.MemoryConfig's doc
// comment. A runtime reaches this functionality through
// /api/runtime/memory/* instead (runtime_memory.go), gated by machine key
// rather than the session/hub-key auth every route in this file relies on.
package handler

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
)

type MemoryHandler struct {
	svc *service.MemoryService
}

func NewMemoryHandler(svc *service.MemoryService) *MemoryHandler {
	return &MemoryHandler{svc: svc}
}

type memoryConfigResponse struct {
	Enabled      bool   `json:"enabled"`
	BaseURL      string `json:"baseUrl"`
	BankID       string `json:"bankId"`
	Hosting      string `json:"hosting"`
	LocalPort    int    `json:"localPort"`
	LocalRunning bool   `json:"localRunning"`
	LLMProvider  string `json:"llmProvider"`
	LLMModel     string `json:"llmModel"`
	LLMBaseURL   string `json:"llmBaseUrl"`
	AutoRecall   bool   `json:"autoRecall"`
	AutoRetain   bool   `json:"autoRetain"`
	RecallBudget string `json:"recallBudget"`
	MaxTokens    int    `json:"maxTokens"`
	Configured   bool   `json:"configured"`
}

func (h *MemoryHandler) respondConfig(w http.ResponseWriter, status int) {
	cfg, err := h.svc.Config()
	if handleStoreErr(w, err) {
		return
	}
	configured, err := h.svc.Configured()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, status, memoryConfigResponse{
		Enabled: cfg.Enabled, BaseURL: cfg.BaseURL, BankID: cfg.BankID,
		Hosting: cfg.Hosting, LocalPort: cfg.LocalPort, LocalRunning: cfg.LocalRunning,
		LLMProvider: cfg.LLMProvider, LLMModel: cfg.LLMModel, LLMBaseURL: cfg.LLMBaseURL,
		AutoRecall: cfg.AutoRecall, AutoRetain: cfg.AutoRetain,
		RecallBudget: cfg.RecallBudget, MaxTokens: cfg.MaxTokens,
		Configured: configured,
	})
}

func (h *MemoryHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	h.respondConfig(w, http.StatusOK)
}

type memoryConfigPatchBody struct {
	Enabled      *bool   `json:"enabled"`
	BaseURL      *string `json:"baseUrl"`
	BankID       *string `json:"bankId"`
	Hosting      *string `json:"hosting"`
	LocalPort    *int    `json:"localPort"`
	LLMProvider  *string `json:"llmProvider"`
	LLMModel     *string `json:"llmModel"`
	LLMBaseURL   *string `json:"llmBaseUrl"`
	AutoRecall   *bool   `json:"autoRecall"`
	AutoRetain   *bool   `json:"autoRetain"`
	RecallBudget *string `json:"recallBudget"`
	MaxTokens    *int    `json:"maxTokens"`
	APIKey       *string `json:"apiKey"`
	LLMAPIKey    *string `json:"llmApiKey"`
}

// PutConfig deliberately has no way to set LocalRunning: that field is the
// hub's own record of whether it actually started the local container, and
// it is written ONLY by the local lifecycle handlers (memory_local.go) as a
// side effect of a real start/stop — never as an arbitrary value a client
// could PATCH in, which could desync it from the container's real state.
func (h *MemoryHandler) PutConfig(w http.ResponseWriter, r *http.Request) {
	var body memoryConfigPatchBody
	raw, err := decodeBody(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_, hasBaseURL := raw["baseUrl"]
	_, hasBankID := raw["bankId"]
	_, hasLLMBaseURL := raw["llmBaseUrl"]

	if _, err := h.svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: body.Enabled,
		BaseURL: body.BaseURL, HasBaseURL: hasBaseURL,
		BankID: body.BankID, HasBankID: hasBankID,
		Hosting: body.Hosting, LocalPort: body.LocalPort,
		LLMProvider: body.LLMProvider, LLMModel: body.LLMModel,
		LLMBaseURL: body.LLMBaseURL, HasLLMBaseURL: hasLLMBaseURL,
		AutoRecall: body.AutoRecall, AutoRetain: body.AutoRetain,
		RecallBudget: body.RecallBudget, MaxTokens: body.MaxTokens,
		APIKey: body.APIKey, LLMAPIKey: body.LLMAPIKey,
	}); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	h.respondConfig(w, http.StatusOK)
}

type memoryTestBody struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
}

// PostTest handles POST /api/memory/test — the Settings panel's "Test
// connection" action. Deliberately takes baseUrl/apiKey in the body instead of
// reading stored config: it must work while an operator is still typing,
// before anything has been saved.
func (h *MemoryHandler) PostTest(w http.ResponseWriter, r *http.Request) {
	var body memoryTestBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.svc.TestConnection(r.Context(), body.BaseURL, body.APIKey); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------------------
// Browse — the Memory page. Every handler here returns the server's own JSON
// shape untouched (memory.Client already does for the untyped ones), so the
// page renders whatever Hindsight actually has rather than a Go-side model
// that could quietly drift from it.
// ---------------------------------------------------------------------------

func (h *MemoryHandler) writeNotConfigured(w http.ResponseWriter, err error) bool {
	if err == service.ErrMemoryNotConfigured {
		writeErr(w, http.StatusServiceUnavailable, "memory is not configured")
		return true
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return true
	}
	return false
}

func (h *MemoryHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.svc.Stats(r.Context())
	if h.writeNotConfigured(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (h *MemoryHandler) GetTags(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Tags(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *MemoryHandler) GetMemories(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ListMemories(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetOperations backs the Overview tab's "what's happening right now" panel.
func (h *MemoryHandler) GetOperations(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Operations(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *MemoryHandler) GetGraph(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Graph(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func (h *MemoryHandler) GetEntityGraph(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.EntityGraph(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func (h *MemoryHandler) GetTimeseries(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Timeseries(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func (h *MemoryHandler) GetDocuments(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Documents(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func (h *MemoryHandler) GetMentalModels(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.MentalModels(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func (h *MemoryHandler) GetEntities(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Entities(r.Context(), r.URL.Query())
	if h.writeNotConfigured(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

// GetExport handles GET /api/memory/export — the Memory page's "Export
// Brain" button. Streams the archive as a file download rather than JSON:
// the browser's normal download flow is the whole point, not another
// envelope for the frontend to unwrap.
func (h *MemoryHandler) GetExport(w http.ResponseWriter, r *http.Request) {
	data, filename, err := h.svc.ExportBrain(r.Context())
	if h.writeNotConfigured(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// PostImport handles POST /api/memory/import — the Memory page's "Import
// Brain" dialog. Takes a multipart upload so the browser can hand over the
// file the operator picked without a base64 round trip.
func (h *MemoryHandler) PostImport(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid upload: "+err.Error())
		return
	}
	mode := r.FormValue("mode")
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read upload: "+err.Error())
		return
	}
	summary, err := h.svc.ImportBrain(r.Context(), mode, header.Filename, data)
	if errors.Is(err, service.ErrInvalidImportMode) {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if h.writeNotConfigured(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

type memoryRecallBody struct {
	Query     string   `json:"query"`
	Budget    string   `json:"budget"`
	MaxTokens int      `json:"maxTokens"`
	Tags      []string `json:"tags"`
}

// PostRecall is a manual, operator-triggered search — distinct from the
// automatic per-turn recall in orchestration's MemoryHooks, which never goes
// through HTTP at all on the hub (see main.go's resolveScope wiring).
func (h *MemoryHandler) PostRecall(w http.ResponseWriter, r *http.Request) {
	var body memoryRecallBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	out, err := h.svc.Recall(r.Context(), memory.RecallRequest{
		Query: body.Query, Budget: body.Budget, MaxTokens: body.MaxTokens, Tags: body.Tags,
	})
	if h.writeNotConfigured(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type memoryReflectBody struct {
	Query     string `json:"query"`
	Budget    string `json:"budget"`
	MaxTokens int    `json:"maxTokens"`
}

func (h *MemoryHandler) PostReflect(w http.ResponseWriter, r *http.Request) {
	var body memoryReflectBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	out, err := h.svc.Reflect(r.Context(), memory.ReflectRequest{
		Query: body.Query, Budget: body.Budget, MaxTokens: body.MaxTokens,
	})
	if h.writeNotConfigured(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type memoryGlobalBody struct {
	Text string `json:"text"`
}

// PostGlobalPreference handles POST /api/memory/global — the Memory page's "add
// a global preference" action. It stores one operator preference in the
// cross-project global tier (memory.GlobalTag), the deliberate escape hatch from
// the per-project scoping auto-recall now applies (see
// service.MemoryService.RetainGlobal and memory.RecallTags). Empty text is a
// client error (400); a not-configured/unreachable bank degrades through
// writeNotConfigured like every other browse handler here.
func (h *MemoryHandler) PostGlobalPreference(w http.ResponseWriter, r *http.Request) {
	var body memoryGlobalBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(body.Text) == "" {
		writeErr(w, http.StatusBadRequest, "text is required")
		return
	}
	if h.writeNotConfigured(w, h.svc.RetainGlobal(r.Context(), body.Text)) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
