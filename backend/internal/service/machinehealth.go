// Package service: MachineHealthCache holds the most recent health-check
// result for every registered machine, refreshed by a background poller so
// the Machines page reflects live status without a per-request round trip
// to each runtime. See
// docs/superpowers/specs/2026-07-14-hub-runtime-dual-role-and-polling-design.md.
package service

import (
	"context"
	"sync"
	"time"

	"loom/backend/internal/machineclient"
	"loom/backend/internal/store"
)

type MachineHealthCache struct {
	mu   sync.RWMutex
	byID map[string]machineclient.HealthStatus
}

func NewMachineHealthCache() *MachineHealthCache {
	return &MachineHealthCache{byID: make(map[string]machineclient.HealthStatus)}
}

// Get returns the cached status for machineID and whether one exists yet.
func (c *MachineHealthCache) Get(machineID string) (machineclient.HealthStatus, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	status, ok := c.byID[machineID]
	return status, ok
}

func (c *MachineHealthCache) Set(machineID string, status machineclient.HealthStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byID[machineID] = status
}

// RunPoller pings every machine currently in st's registry immediately,
// then every interval thereafter, caching each result. It blocks until ctx
// is cancelled; a failed store read or a single unreachable machine never
// stops the loop or affects any other machine's cached result.
func (c *MachineHealthCache) RunPoller(ctx context.Context, st *store.Store, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		c.pollOnce(ctx, st)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *MachineHealthCache) pollOnce(ctx context.Context, st *store.Store) {
	machines, err := st.Machines()
	if err != nil {
		return
	}
	for _, m := range machines {
		c.Set(m.ID, machineclient.CheckHealth(ctx, m))
	}
}
