package orchestration

import "context"

// MemoryHooks connects the Reactor/Ingestion pair to DevDeck's persistent
// agent memory, without either of them importing a concrete memory client.
// Mirrors the existing InstanceFor/OnInstanceStarted style on Reactor: a
// struct of narrow func fields, injected from main.go, zero value fully
// no-op — so every pre-existing bare Reactor{}/Ingestion{} literal in this
// package's own tests keeps compiling and behaving identically.
//
// Both directions are deliberately asymmetric:
//
//   - Recall is synchronous and BLOCKS the turn — the recalled block has to
//     exist before SendTurn runs, or it cannot be prepended. It still must
//     never take the turn down: an implementation is expected to time out and
//     return "" rather than propagate an error (see memory.Client's
//     RecallTimeout and the closure main.go builds around it).
//   - Retain is fire-and-forget. Nothing downstream is waiting on it, and a
//     slow or unreachable memory server must never add latency to a chat
//     turn — an implementation is expected to run it in its own goroutine.
type MemoryHooks struct {
	// Recall returns the block to prepend to a turn's text, or "" when memory
	// is disabled, the bank has nothing relevant, or the call failed.
	Recall func(ctx context.Context, threadID, query string) string

	// Retain stores one role's text against threadID's memory document.
	// role is "user" or "assistant".
	Retain func(ctx context.Context, threadID, role, text string)
}

// recall calls the hook if one is configured, and is safe to call on a zero
// MemoryHooks value.
func (h MemoryHooks) recall(ctx context.Context, threadID, query string) string {
	if h.Recall == nil {
		return ""
	}
	return h.Recall(ctx, threadID, query)
}

// retain calls the hook if one is configured, and is safe to call on a zero
// MemoryHooks value. Skips empty text — there is nothing to store.
func (h MemoryHooks) retain(ctx context.Context, threadID, role, text string) {
	if h.Retain == nil || text == "" {
		return
	}
	h.Retain(ctx, threadID, role, text)
}
