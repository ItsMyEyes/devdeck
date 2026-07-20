package service

import (
	"errors"
	"fmt"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// CatalogService handles hub-side operations on data pushed up from runtimes.
type CatalogService struct {
	store port.Store
}

// NewCatalogService creates a catalog service.
func NewCatalogService(s port.Store) *CatalogService {
	return &CatalogService{store: s}
}

// ReplayProjectRequest is one project a runtime created while the hub was
// unreachable, being pushed up for the hub to accept. MachineID is
// deliberately absent: the caller is always the authenticated machine
// itself (see handler.RequireMachineKey), never a value the request
// controls.
type ReplayProjectRequest struct {
	ID          string
	WorkspaceID string
	Name        string
	Path        string
	Repo        string
}

// ReplayProject accepts one replayed project for machineID (resolved from
// the caller's own key, never from the request). Translates the store's
// generic "workspace not found" into ErrConflict (409): the spec requires a
// runtime be able to distinguish "the hub hasn't seen this yet, retry" from
// "this project's workspace is gone for good".
func (svc *CatalogService) ReplayProject(machineID string, req ReplayProjectRequest) (domain.Project, error) {
	p, err := svc.store.ReplayLocalProject(req.ID, req.WorkspaceID, req.Name, req.Path, req.Repo, machineID)
	if errors.Is(err, store.ErrNotFound) {
		return domain.Project{}, fmt.Errorf("workspace %s does not exist: %w", req.WorkspaceID, ErrConflict)
	}
	return p, err
}
