package service

import (
	"context"
	"errors"
	"log"
	"time"

	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
)

// SyncConfig describes what a runtime needs to keep its catalog replica fresh.
type SyncConfig struct {
	HubURL     string // hub base URL
	MachineKey string // this runtime's own key; the hub resolves us from it
}

// RunSyncLoop refreshes the catalog replica forever, every `every`.
//
// Unlike machineclient.RunSelfRegisterLoop — which retries until it succeeds
// once and then returns — this loop never exits: the replica has to keep
// tracking the hub for the process's whole life. Start it only after
// registration has succeeded, since the hub cannot resolve a machine by a key
// it has never stored.
//
// Failures are logged and retried on the next tick, never fatal. A stale
// replica is always better than an empty one, so a failed pull deliberately
// leaves the previous snapshot in place.
func RunSyncLoop(ctx context.Context, st port.Store, cfg SyncConfig, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		syncOnce(ctx, st, cfg)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func syncOnce(ctx context.Context, st port.Store, cfg SyncConfig) {
	pushLocalProjects(ctx, st, cfg)

	snap, err := machineclient.FetchCatalog(ctx, cfg.HubURL, cfg.MachineKey)
	if err != nil {
		log.Printf("catalog sync: fetch: %v", err)
		return
	}
	if err := st.ApplyCatalogSnapshot(snap, time.Now()); err != nil {
		log.Printf("catalog sync: apply: %v", err)
		return
	}
	log.Printf("catalog sync: %d workspace(s), %d project(s), %d ssh connection(s)",
		len(snap.Workspaces), len(snap.Projects), len(snap.SSHConnections))
}

// pushLocalProjects replays every project created while the hub was
// unreachable. Runs before the pull below: a project accepted here should
// come back as a hub row in the SAME cycle's snapshot, never appearing
// twice. A push failure is logged and left for the next tick — it never
// blocks the pull, since a stale replica is still better than none.
func pushLocalProjects(ctx context.Context, st port.Store, cfg SyncConfig) {
	local, err := st.LocalProjects()
	if err != nil {
		log.Printf("catalog sync: list local projects: %v", err)
		return
	}
	for _, p := range local {
		_, err := machineclient.ReplayProject(ctx, cfg.HubURL, cfg.MachineKey, p)
		switch {
		case err == nil:
			// Flip to origin=hub NOW, before the pull below applies a
			// snapshot containing this same project id — ApplyCatalogSnapshot
			// only deletes origin='hub' rows before reinserting, so a row
			// still marked 'local' at that point would collide with the
			// snapshot's copy on its own primary key.
			if err := st.MarkProjectSynced(p.ID); err != nil {
				log.Printf("catalog sync: mark %s synced: %v", p.ID, err)
			}
		case errors.Is(err, machineclient.ErrWorkspaceGone):
			if err := st.SetProjectSyncError(p.ID, "this project's workspace no longer exists on the hub"); err != nil {
				log.Printf("catalog sync: record sync error for %s: %v", p.ID, err)
			}
		default:
			log.Printf("catalog sync: replay %s: %v", p.ID, err)
		}
	}
}
