// Package memorybackfill is a one-shot batch job that populates the
// persistent-memory bank from a database's EXISTING agent chat history —
// every user message DevDeck already logged before this feature existed, or
// before it was turned on for a given machine.
//
// It is a package, not a `cmd/`, for the same reason issuemcp and sshtoolcli
// are: DevDeck ships one executable, reached here as `devdeck memory-backfill`
// (see Dispatch).
//
// It reads only user turns (EvtThreadTurnStartRequested), not the assistant's
// replies. The assistant's text is not durably stored as its own field — it
// only exists reconstructed from a run of ContentDelta events folded into
// EvtThreadActivityAppended's payload, the same accumulation
// orchestration.Ingestion does live in memory and never persists on its own.
// Rebuilding that here would mean re-implementing Ingestion's buffering
// against the durable log for a one-time backfill; what the user asked,
// decided, and stated as preference — the highest-signal, cheapest-to-extract
// half of the conversation — is what this backfills.
//
// Run this against the database that holds the memory configuration (see
// domain.MemoryConfig's doc comment) — ordinarily the hub's own --db. Safe to
// re-run: each thread's items are retained with update_mode "replace" against
// a document_id of the thread id, so a second run reflects the CURRENT full
// history rather than duplicating it.
package memorybackfill

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// Subcommand is the argv[1] that routes the DevDeck executable into this
// package instead of booting a server.
const Subcommand = "memory-backfill"

// Dispatch runs the backfill when argv names Subcommand in first position,
// returning the process exit code and true. Otherwise it returns false and
// the caller carries on with its own argument parsing.
func Dispatch(argv []string) (code int, handled bool) {
	if len(argv) < 2 || argv[1] != Subcommand {
		return 0, false
	}
	if err := run(argv[2:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "devdeck %s: %v\n", Subcommand, err)
		return 1, true
	}
	return 0, true
}

func run(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("devdeck "+Subcommand, flag.ContinueOnError)
	fs.SetOutput(stderr)
	dbPath := fs.String("db", envOr("DEVDECK_DB", defaultDBPath()), "sqlite database path — must be the one holding the memory configuration, ordinarily the hub's own --db")
	machineName := fs.String("machine", "", "machine name to tag retained memories with (default: OS hostname)")
	dryRun := fs.Bool("dry-run", false, "print what would be retained without calling the memory server")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *machineName == "" {
		if h, err := os.Hostname(); err == nil {
			*machineName = h
		}
	}

	db, err := store.Open(*dbPath)
	if err != nil {
		return fmt.Errorf("open db %s: %w", *dbPath, err)
	}
	defer db.Close()
	st := store.New(db)

	// Empty dataDir: this one-shot batch tool only ever calls memSvc.Client()
	// below, never LocalStart/LocalStop — see NewMemoryService's doc comment.
	memSvc := service.NewMemoryService(st, "")
	var (
		client *memory.Client
		bank   string
	)
	if !*dryRun {
		client, bank, err = memSvc.Client()
		if err != nil {
			return fmt.Errorf("memory is not configured on %s — enable it from Settings first (or pass --dry-run to preview): %w", *dbPath, err)
		}
	}

	events, err := st.AllAgentEvents()
	if err != nil {
		return fmt.Errorf("read agent event log: %w", err)
	}
	threads := groupByThread(events)
	fmt.Fprintf(stdout, "memory-backfill: %d thread(s) in %s\n", len(threads), *dbPath)

	ctx := context.Background()
	retained, skipped := 0, 0
	for _, threadID := range sortedKeys(threads) {
		items := userItems(threadID, threads[threadID], st, *machineName)
		if len(items) == 0 {
			skipped++
			continue
		}
		if *dryRun {
			fmt.Fprintf(stdout, "  %s: would retain %d message(s)\n", threadID, len(items))
			retained++
			continue
		}
		if _, err := client.Retain(ctx, bank, memory.RetainRequest{Items: items, Async: true}); err != nil {
			fmt.Fprintf(stderr, "  %s: retain failed: %v\n", threadID, err)
			continue
		}
		fmt.Fprintf(stdout, "  %s: retained %d message(s)\n", threadID, len(items))
		retained++
	}
	fmt.Fprintf(stdout, "memory-backfill: done — %d thread(s) retained, %d empty/skipped\n", retained, skipped)
	return nil
}

// groupByThread buckets the durable event log by thread, preserving each
// thread's original commit order — Seq is monotonic across the whole log, so
// a stable sort on it is enough.
func groupByThread(events []orchestration.Event) map[string][]orchestration.Event {
	out := make(map[string][]orchestration.Event)
	for _, ev := range events {
		if ev.ThreadID == "" {
			continue
		}
		out[ev.ThreadID] = append(out[ev.ThreadID], ev)
	}
	for _, evts := range out {
		sort.Slice(evts, func(i, j int) bool { return evts[i].Seq < evts[j].Seq })
	}
	return out
}

func sortedKeys(m map[string][]orchestration.Event) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// userItems extracts one memory.MemoryItem per user turn on threadID, tagged
// with the same scope shape main.go's live resolveScope uses — see
// memory.Scope's doc comment for why these are tags on one shared bank.
func userItems(threadID string, events []orchestration.Event, st *store.Store, machineName string) []memory.MemoryItem {
	scope := memory.Scope{Machine: machineName, Thread: threadID}
	if provider := providerFromCreate(events); provider != "" {
		scope.Provider = provider
	}
	if orchestration.IsSSHThread(threadID) {
		scope.Surface = "ssh"
		if conn, err := st.SSHConnectionByID(orchestration.SSHConnectionIDForThread(threadID)); err == nil {
			scope.Project = conn.Name
		}
	} else {
		scope.Surface = "worktree"
		if wt, err := st.WorktreeByID(orchestration.WorktreeIDForThread(threadID)); err == nil {
			if proj, err := st.ProjectByID(wt.ProjectID); err == nil {
				scope.Project = proj.Name
			}
		}
	}

	var items []memory.MemoryItem
	for _, ev := range events {
		if ev.Type != orchestration.EvtThreadTurnStartRequested {
			continue
		}
		var p orchestration.TurnStartPayload
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			continue
		}
		text := strings.TrimSpace(p.Text)
		if text == "" {
			continue
		}
		items = append(items, memory.MemoryItem{
			Content:    "user: " + text,
			Context:    "devdeck agent chat turn (" + scope.Surface + "), backfilled from history",
			Timestamp:  time.UnixMilli(ev.CreatedAt).UTC().Format(time.RFC3339),
			DocumentID: threadID,
			UpdateMode: "replace",
			Tags:       scope.Tags(),
			Metadata:   scope.Metadata(),
		})
	}
	return items
}

// providerFromCreate reads the agent kind off EvtThreadCreated's instanceId
// ("<kind>:<instanceId>"), the one place a thread's provider is recorded.
func providerFromCreate(events []orchestration.Event) string {
	for _, ev := range events {
		if ev.Type != orchestration.EvtThreadCreated {
			continue
		}
		var p struct {
			InstanceID string `json:"instanceId"`
		}
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return ""
		}
		kind, _, _ := strings.Cut(p.InstanceID, ":")
		return kind
	}
	return ""
}

// defaultDBPath mirrors issuemcp's: the same directory the server's own --db
// default resolves against, so a bare `devdeck memory-backfill` attaches to
// the hub's database instead of silently creating an empty one.
func defaultDBPath() string {
	executable, err := os.Executable()
	if err != nil {
		return filepath.Join("data", "devdeck.db")
	}
	return filepath.Join(filepath.Dir(executable), "data", "devdeck.db")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
