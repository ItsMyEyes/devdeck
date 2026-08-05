package store

import (
	"testing"

	"devdeck/backend/internal/domain"
)

func TestPublishedSOCKSDefaultsOnFreshDB(t *testing.T) {
	s := newTestStore(t)

	cfg, err := s.PublishedSOCKS()
	if err != nil {
		t.Fatalf("PublishedSOCKS: %v", err)
	}
	if cfg.Enabled {
		t.Errorf("Enabled = true on a fresh db, want false")
	}
	if cfg.Port != 1080 {
		t.Errorf("Port = %d, want 1080", cfg.Port)
	}
	if cfg.Key != "" {
		t.Errorf("Key = %q, want empty", cfg.Key)
	}
}

func TestSetPublishedSOCKSRoundTrips(t *testing.T) {
	s := newTestStore(t)

	want := domain.PublishedSOCKSConfig{Enabled: true, Port: 1081, Key: "abc123"}
	if err := s.SetPublishedSOCKS(want); err != nil {
		t.Fatalf("SetPublishedSOCKS: %v", err)
	}

	got, err := s.PublishedSOCKS()
	if err != nil {
		t.Fatalf("PublishedSOCKS: %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}
