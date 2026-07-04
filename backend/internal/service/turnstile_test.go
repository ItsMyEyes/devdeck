package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func stubSiteverify(t *testing.T, v *TurnstileVerifier, handler http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	v.endpoint = srv.URL
}

func TestTurnstileVerify(t *testing.T) {
	t.Run("missing token fails without calling the API", func(t *testing.T) {
		v := NewTurnstileVerifier("site", "secret")
		v.endpoint = "http://127.0.0.1:1" // would fail if contacted
		err := v.Verify(context.Background(), "", "")
		if !errors.Is(err, ErrValidation) {
			t.Fatalf("err = %v, want ErrValidation", err)
		}
	})

	t.Run("success", func(t *testing.T) {
		v := NewTurnstileVerifier("site", "secret")
		stubSiteverify(t, v, func(w http.ResponseWriter, r *http.Request) {
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if got := r.PostFormValue("secret"); got != "secret" {
				t.Errorf("secret = %q, want %q", got, "secret")
			}
			if got := r.PostFormValue("response"); got != "tok-123" {
				t.Errorf("response = %q, want %q", got, "tok-123")
			}
			if got := r.PostFormValue("remoteip"); got != "203.0.113.9" {
				t.Errorf("remoteip = %q, want %q", got, "203.0.113.9")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"success":true}`))
		})
		if err := v.Verify(context.Background(), "tok-123", "203.0.113.9"); err != nil {
			t.Fatalf("Verify() = %v, want nil", err)
		}
	})

	t.Run("rejected challenge maps to ErrValidation", func(t *testing.T) {
		v := NewTurnstileVerifier("site", "secret")
		stubSiteverify(t, v, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"success":false,"error-codes":["invalid-input-response"]}`))
		})
		err := v.Verify(context.Background(), "bad-token", "")
		if !errors.Is(err, ErrValidation) {
			t.Fatalf("err = %v, want ErrValidation", err)
		}
	})

	t.Run("unreachable API fails closed", func(t *testing.T) {
		v := NewTurnstileVerifier("site", "secret")
		v.endpoint = "http://127.0.0.1:1"
		if err := v.Verify(context.Background(), "tok", ""); err == nil {
			t.Fatal("Verify() = nil, want error when siteverify is unreachable")
		}
	})

	t.Run("nil verifier is disabled", func(t *testing.T) {
		var v *TurnstileVerifier
		if v.Enabled() {
			t.Error("nil verifier reports enabled")
		}
		if v.SiteKey() != "" {
			t.Error("nil verifier reports a site key")
		}
	})
}
