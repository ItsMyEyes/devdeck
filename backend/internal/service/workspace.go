package service

import (
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

// WorkspaceService wraps workspace operations with business logic.
type WorkspaceService struct {
	store port.Store
}

// NewWorkspaceService creates a workspace service.
func NewWorkspaceService(s port.Store) *WorkspaceService {
	return &WorkspaceService{store: s}
}

// List returns all workspaces with their full nested trees.
func (svc *WorkspaceService) List() ([]domain.Workspace, error) {
	return svc.store.Workspaces()
}

// Create creates a workspace.
func (svc *WorkspaceService) Create(name string) (domain.Workspace, error) {
	if name == "" {
		name = "New workspace"
	}
	return svc.store.CreateWorkspace(name)
}

// Update renames a workspace.
func (svc *WorkspaceService) Update(id string, name *string) (domain.Workspace, error) {
	return svc.store.UpdateWorkspace(id, name)
}

// Delete deletes a workspace and all its children.
func (svc *WorkspaceService) Delete(id string) error {
	return svc.store.DeleteWorkspace(id)
}
