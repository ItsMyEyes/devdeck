package service

import (
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// SeedService wraps seed operations.
type SeedService struct {
	store port.Store
}

// NewSeedService creates a seed service.
func NewSeedService(s port.Store) *SeedService {
	return &SeedService{store: s}
}

// Seed wipes all data and inserts the demo dataset.
func (svc *SeedService) Seed() ([]domain.Workspace, error) {
	return svc.store.Seed()
}
