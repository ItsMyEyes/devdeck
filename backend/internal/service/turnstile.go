package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

// TurnstileVerifier validates Cloudflare Turnstile widget tokens against the
// siteverify API. A nil verifier means Turnstile is disabled; all methods are
// nil-safe so callers can hold one unconditionally.
type TurnstileVerifier struct {
	siteKey  string
	secret   string
	endpoint string
	client   *http.Client
}

// NewTurnstileVerifier creates a verifier for the given Turnstile key pair.
func NewTurnstileVerifier(siteKey, secret string) *TurnstileVerifier {
	return &TurnstileVerifier{
		siteKey:  siteKey,
		secret:   secret,
		endpoint: turnstileVerifyURL,
		client:   &http.Client{Timeout: 10 * time.Second},
	}
}

// Enabled reports whether Turnstile verification is configured.
func (t *TurnstileVerifier) Enabled() bool { return t != nil && t.secret != "" }

// SiteKey returns the public site key the frontend renders the widget with,
// or "" when Turnstile is disabled.
func (t *TurnstileVerifier) SiteKey() string {
	if t == nil {
		return ""
	}
	return t.siteKey
}

// Verify checks a widget token with Cloudflare's siteverify API. It fails
// closed: a missing token, a rejected challenge, or an unreachable API all
// reject the login attempt.
func (t *TurnstileVerifier) Verify(ctx context.Context, token, remoteIP string) error {
	if token == "" {
		return fmt.Errorf("captcha token missing: %w", ErrValidation)
	}
	form := url.Values{"secret": {t.secret}, "response": {token}}
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := t.client.Do(req)
	if err != nil {
		return fmt.Errorf("turnstile siteverify: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		Success    bool     `json:"success"`
		ErrorCodes []string `json:"error-codes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("turnstile siteverify: decode response: %w", err)
	}
	if !out.Success {
		return fmt.Errorf("captcha verification failed (%s): %w", strings.Join(out.ErrorCodes, ","), ErrValidation)
	}
	return nil
}
