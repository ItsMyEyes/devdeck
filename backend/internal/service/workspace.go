package service

import (
	"context"
	"log"
	"sync"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
)

// WorkspaceService wraps workspace operations with business logic.
type WorkspaceService struct {
	store   port.Store
	runtime bool
}

// NewWorkspaceService creates a workspace service for the hub role.
func NewWorkspaceService(s port.Store) *WorkspaceService {
	return &WorkspaceService{store: s}
}

// NewWorkspaceServiceForRuntime creates a workspace service for the runtime
// role, which serves its local replica directly. A runtime has no machine
// registry to fan out to, and its worktrees are already local — the hub's
// per-project fetch would be a network call to nowhere.
func NewWorkspaceServiceForRuntime(s port.Store) *WorkspaceService {
	return &WorkspaceService{store: s, runtime: true}
}

// List returns all workspaces with their full nested trees. Worktrees are
// runtime-owned (see docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md),
// so for every project assigned to a machine, this replaces the store's
// (always-empty, since the hub never holds real worktree rows) local result
// with a live fetch from that machine, concurrently and best-effort — an
// unreachable machine just leaves that project's worktrees empty, it does
// not fail the whole request.
//
// On a runtime, this fanout is skipped entirely: there are no other machines
// to ask, and the local replica's own worktrees are already attached by the
// store.
//
// ctx is the caller's — normally the inbound request's — so a client that
// gives up takes its fan-out down with it. These fetches previously used
// context.Background(), which meant an abandoned request (a browser
// navigating away, or a retry fired because a slow runtime blew past the
// client's patience) still held a goroutine and a socket per project until
// machineclient's own timeout expired, piling up exactly when the network is
// already struggling.
func (svc *WorkspaceService) List(ctx context.Context) ([]domain.Workspace, error) {
	workspaces, err := svc.store.Workspaces()
	if err != nil {
		return nil, err
	}
	if svc.runtime {
		return workspaces, nil
	}

	var wg sync.WaitGroup
	for wi := range workspaces {
		for pi := range workspaces[wi].Projects {
			proj := &workspaces[wi].Projects[pi]
			if proj.MachineID == "" {
				continue
			}
			wg.Add(1)
			go func(proj *domain.Project) {
				defer wg.Done()
				machine, err := svc.store.MachineByID(proj.MachineID)
				if err != nil {
					log.Printf("workspaces: project %s: machine %s: %v", proj.ID, proj.MachineID, err)
					return
				}
				worktrees, err := machineclient.FetchWorktrees(ctx, machine, proj.ID)
				if err != nil {
					log.Printf("workspaces: project %s: %v", proj.ID, err)
					return
				}
				proj.Worktrees = worktrees
			}(proj)
		}
	}
	wg.Wait()

	return workspaces, nil
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
