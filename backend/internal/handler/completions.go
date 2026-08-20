package handler

import (
	"net/http"

	"devdeck/backend/internal/completions/provider"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
)

type CompletionsHandler struct {
	svc *service.CompletionsService
}

func NewCompletionsHandler(svc *service.CompletionsService) *CompletionsHandler {
	return &CompletionsHandler{svc: svc}
}

type completionsConfigResponse struct {
	Provider   string `json:"provider"`
	BaseURL    string `json:"baseUrl"`
	Model      string `json:"model"`
	Enabled    bool   `json:"enabled"`
	Configured bool   `json:"configured"`
}

func (h *CompletionsHandler) respondConfig(w http.ResponseWriter, status int) {
	cfg, err := h.svc.Config()
	if handleStoreErr(w, err) {
		return
	}
	configured, err := h.svc.Configured()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, status, completionsConfigResponse{
		Provider: cfg.Provider, BaseURL: cfg.BaseURL, Model: cfg.Model,
		Enabled: cfg.Enabled, Configured: configured,
	})
}

func (h *CompletionsHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	h.respondConfig(w, http.StatusOK)
}

type completionsConfigPatchBody struct {
	Provider *string `json:"provider"`
	BaseURL  *string `json:"baseUrl"`
	Model    *string `json:"model"`
	Enabled  *bool   `json:"enabled"`
	APIKey   *string `json:"apiKey"`
}

func (h *CompletionsHandler) PutConfig(w http.ResponseWriter, r *http.Request) {
	var body completionsConfigPatchBody
	raw, err := decodeBody(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_, hasBaseURL := raw["baseUrl"]

	if _, err := h.svc.UpdateConfig(port.CompletionsConfigPatch{
		Provider:   body.Provider,
		BaseURL:    body.BaseURL,
		HasBaseURL: hasBaseURL,
		Model:      body.Model,
		Enabled:    body.Enabled,
		APIKey:     body.APIKey,
	}); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	h.respondConfig(w, http.StatusOK)
}

type inlineCompletionRequestBody struct {
	Prefix           string                     `json:"prefix"`
	Suffix           string                     `json:"suffix"`
	Language         string                     `json:"language"`
	GroundingSymbols []provider.GroundingSymbol `json:"groundingSymbols"`
}

func (h *CompletionsHandler) PostInline(w http.ResponseWriter, r *http.Request) {
	var body inlineCompletionRequestBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	result, err := h.svc.Complete(r.Context(), provider.CompletionRequest{
		Prefix: body.Prefix, Suffix: body.Suffix, Language: body.Language,
		GroundingSymbols: body.GroundingSymbols,
	})
	if err == service.ErrCompletionsNotConfigured {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, "completion request failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"completion": result})
}
