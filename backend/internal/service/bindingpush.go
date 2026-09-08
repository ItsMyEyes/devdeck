// Package service: BindingStatusCache and RunBindingPushLoop are the hub
// side of automatic runtime binding — see RuntimeBinder for the runtime
// side. A hub that already has a machine registered pushes its own URL and
// that machine's id to it, on a loop, so a machine added through the
// Machines UI does not also need --hub-url/--hub-key hand-configured on the
// machine itself before its catalog-backed features (SSH DevOps chat,
// worktree sync) work.
package service

import (
	"context"
	"sync"
	"time"

	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/store"
)

// BindingStatus is the outcome of the most recent push attempt to one
// machine, cached the same way MachineHealthCache caches health checks, so
// the Machines page can explain a not-yet-synced runtime instead of leaving
// it looking identical to an empty one.
type BindingStatus struct {
	// HubReachable is false when this hub could not determine its own
	// reachable URL (e.g. bound to loopback with Tailscale serve off) — the
	// push was never attempted, because there was no URL to send.
	HubReachable bool
	// Adopted mirrors the runtime's own answer: true once it has accepted
	// this hub's push. False while adoption is still pending or refused (an
	// explicit --hub-url on that runtime). Sticky once true — a tick that
	// gets no fresh answer from the runtime (HubReachable false, or the push
	// itself failed to land) carries the previous value forward rather than
	// resetting it, so an already-synced runtime never flashes a false
	// alarm over a one-tick blip. See pushBindingsOnce.
	Adopted bool
	// Reason explains a false HubReachable, a false Adopted, or — on a
	// sticky-Adopted tick — why THIS attempt didn't get a fresh answer, even
	// though Adopted itself still reads true from an earlier cycle.
	Reason   string
	PushedAt time.Time
}

// BindingStatusCache holds the most recent binding-push outcome per machine.
type BindingStatusCache struct {
	mu   sync.RWMutex
	byID map[string]BindingStatus
}

func NewBindingStatusCache() *BindingStatusCache {
	return &BindingStatusCache{byID: make(map[string]BindingStatus)}
}

// Get returns the cached status for machineID and whether one exists yet.
func (c *BindingStatusCache) Get(machineID string) (BindingStatus, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	status, ok := c.byID[machineID]
	return status, ok
}

func (c *BindingStatusCache) Set(machineID string, status BindingStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byID[machineID] = status
}

// HubURLResolver reports this hub's own URL as a remote machine should dial
// it — in practice, *handler.TailscaleStatusHandler.ReachableURL, since a
// hub and its runtimes share one tailnet (package machineclient's doc
// comment). ok is false when no such URL is available right now (Tailscale
// unusable, or serve not running), with reason explaining why.
type HubURLResolver func() (url string, ok bool, reason string)

// RunBindingPushLoop pushes this hub's identity to every registered,
// non-local machine, immediately and then every interval, caching each
// outcome in cache. Mirrors MachineHealthCache.RunPoller: it blocks until ctx
// is cancelled, and a failed store read or one unreachable machine never
// stops the loop or affects any other machine.
//
// IsLocal machines are skipped: they are the same process as this hub (the
// Tauri desktop's embedded runtime, or a --role both self-registration), so
// there is nothing to push to — a --role both process must never point its
// own sync loop at itself (RunSyncLoop's doc comment explains why).
func RunBindingPushLoop(ctx context.Context, st *store.Store, cache *BindingStatusCache, resolveHubURL HubURLResolver, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		pushBindingsOnce(ctx, st, cache, resolveHubURL)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func pushBindingsOnce(ctx context.Context, st *store.Store, cache *BindingStatusCache, resolveHubURL HubURLResolver) {
	machines, err := st.Machines()
	if err != nil {
		return
	}
	hubURL, ok, reason := resolveHubURL()
	for _, m := range machines {
		if m.IsLocal {
			continue
		}
		// prev.Adopted is carried forward whenever this tick gets no fresh
		// answer FROM THE RUNTIME ITSELF (the hub has no URL to push with, or
		// the push attempt never reached the machine): neither case says
		// anything new about whether that runtime already adopted a binding
		// on an earlier, successful cycle. Once adopted, a runtime keeps
		// syncing on its own schedule regardless of this hub's next push —
		// resetting Adopted to false here would raise a false "not synced"
		// alarm for an already-healthy runtime over what is often a one-tick
		// blip (a Tailscale serve restart, a momentary network hiccup).
		prev, _ := cache.Get(m.ID)
		if !ok {
			cache.Set(m.ID, BindingStatus{HubReachable: false, Adopted: prev.Adopted, Reason: reason, PushedAt: time.Now()})
			continue
		}
		adopted, pushReason, err := machineclient.PushBinding(ctx, m, hubURL)
		if err != nil {
			cache.Set(m.ID, BindingStatus{HubReachable: true, Adopted: prev.Adopted, Reason: err.Error(), PushedAt: time.Now()})
			continue
		}
		cache.Set(m.ID, BindingStatus{HubReachable: true, Adopted: adopted, Reason: pushReason, PushedAt: time.Now()})
	}
}
