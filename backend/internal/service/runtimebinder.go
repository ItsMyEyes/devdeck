package service

import "sync"

// RuntimeBinder adopts a hub's pushed identity on a --role runtime process
// that was launched without --hub-url, so an operator does not have to
// hand-configure the hub address on every machine the hub already has
// registered. See handler.RuntimeBindingHandler (PUT /api/runtime/binding),
// the only caller, and service.RunBindingPushLoop, the hub-side sender.
//
// Before this, a machine added through the Machines UI still needed its own
// --hub-url/--hub-key set by hand on that machine before anything
// catalog-backed (SSH DevOps chat, worktree sync) worked — the hub knowing
// about a machine and that machine knowing about the hub were two separate,
// manually-kept-in-sync facts.
type RuntimeBinder struct {
	// explicitHubURL is the --hub-url this process was launched with. A
	// non-empty value means the operator already told this runtime which hub
	// to use, so a pushed one must never override it — Bind refuses outright.
	explicitHubURL string
	// onBind points this process's live collaborators (the whoami handler,
	// the SSH secret source) at the newly learned hub. Called synchronously,
	// before startSync, so anything asking those collaborators for a hub URL
	// right after Bind returns sees the new one.
	onBind func(hubURL, machineID string)
	// startSync begins this runtime's catalog sync loop. Called at most once
	// per process — see the bound guard below — because RunSyncLoop never
	// exits on its own and a second call would run two loops applying
	// snapshots concurrently.
	startSync func(hubURL string)

	mu     sync.Mutex
	bound  bool
	hubURL string
}

// NewRuntimeBinder creates a binder. explicitHubURL is empty unless the
// operator set --hub-url at launch.
func NewRuntimeBinder(explicitHubURL string, onBind func(hubURL, machineID string), startSync func(hubURL string)) *RuntimeBinder {
	return &RuntimeBinder{explicitHubURL: explicitHubURL, onBind: onBind, startSync: startSync}
}

// Bind adopts a hub's pushed hubURL/machineID.
//
// Idempotent by design, because the hub re-pushes on every cycle
// (RunBindingPushLoop) rather than only once: a repeat push naming the same
// hub this process already adopted is a harmless no-op. A push naming a
// DIFFERENT hub while already bound is refused rather than silently
// re-pointing a live sync loop at a new source mid-flight — rebinding to a
// different hub is not a supported live operation; it needs a restart.
func (b *RuntimeBinder) Bind(hubURL, machineID string) (adopted bool, reason string) {
	if b.explicitHubURL != "" {
		return false, "this runtime was launched with its own --hub-url and does not accept a pushed one"
	}
	if hubURL == "" || machineID == "" {
		return false, "hubUrl and machineId are required"
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.bound {
		if b.hubURL != hubURL {
			return false, "already bound to a different hub"
		}
		return true, ""
	}
	b.bound = true
	b.hubURL = hubURL
	b.onBind(hubURL, machineID)
	b.startSync(hubURL)
	return true, ""
}
