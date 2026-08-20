// Package memorycli exposes DevDeck's persistent agent memory (see
// internal/service/memory.go) as a plain, one-shot CLI — `devdeck memory
// recall "<query>"` / `devdeck memory graph "<entity>"` — for an agent whose
// CLI has no MCP client at all. pi is the reason this package exists (see
// internal/agentcore/provider/pi's package comment: SupportsMCP is false,
// and a live `pi --help` confirms it — no mcp subcommand, no related flag).
// Every other provider gets the same recall/graph capability through
// Hindsight's own MCP server plus the graph_neighbors MCP tool
// (internal/issuemcp); this package is what a bash-only agent runs instead,
// wired in via a skill (see docs/pi memory skill) rather than a protocol
// handshake.
//
// It is a subcommand of the DevDeck binary, not a separate program — same
// "one executable" reasoning as internal/issuemcp and internal/sshtoolcli.
// It opens the same SQLite database the main server uses (WAL mode supports
// the two processes sharing the file) purely to read domain.MemoryConfig;
// it never writes to it.
package memorycli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// Subcommand is the argv[1] that routes the DevDeck executable into this
// package instead of booting a server.
const Subcommand = "memory"

// Dispatch runs a one-shot memory command when argv names Subcommand in
// first position, returning the process exit code and true. Otherwise it
// returns false and the caller carries on with its own argument parsing.
func Dispatch(argv []string) (code int, handled bool) {
	if len(argv) < 2 || argv[1] != Subcommand {
		return 0, false
	}
	if len(argv) < 3 {
		fmt.Fprintln(os.Stderr, "devdeck memory: expected a subcommand (recall, graph)")
		return 1, true
	}
	var err error
	switch argv[2] {
	case "recall":
		err = runRecall(argv[3:], os.Stdout, os.Stderr)
	case "graph":
		err = runGraph(argv[3:], os.Stdout, os.Stderr)
	default:
		err = fmt.Errorf("unknown subcommand %q (want recall or graph)", argv[2])
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "devdeck memory %s: %v\n", argv[2], err)
		return 1, true
	}
	return 0, true
}

// openMemoryService opens dbPath and returns a MemoryService backed by it,
// plus a close func the caller must defer — NOT closed here, since the
// service needs the connection alive for the query it's about to run, not
// just for the open call itself.
func openMemoryService(dbPath string) (*service.MemoryService, func() error, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, nil, fmt.Errorf("create database directory: %w", err)
	}
	db, err := store.Open(dbPath)
	if err != nil {
		return nil, nil, fmt.Errorf("open db: %w", err)
	}
	return service.NewMemoryService(store.New(db), filepath.Dir(dbPath)), db.Close, nil
}

func runRecall(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("devdeck memory recall", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dbPath := fs.String("db", envOr("DEVDECK_DB", defaultDBPath()), "sqlite database path (same file the DevDeck backend uses)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	query := fs.Arg(0)
	if query == "" {
		return fmt.Errorf("usage: devdeck memory recall \"<query>\" [--db path]")
	}

	svc, closeDB, err := openMemoryService(*dbPath)
	if err != nil {
		return err
	}
	defer closeDB()
	resp, err := svc.Recall(context.Background(), memory.RecallRequest{
		Query: query, Budget: "mid", MaxTokens: 1536, PreferObservations: true,
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(resp)
}

func runGraph(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("devdeck memory graph", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dbPath := fs.String("db", envOr("DEVDECK_DB", defaultDBPath()), "sqlite database path (same file the DevDeck backend uses)")
	mode := fs.String("mode", "entities", `"entities" (default) or "facts"`)
	limit := fs.Int("limit", 300, "max graph nodes to pull before matching")
	if err := fs.Parse(args); err != nil {
		return err
	}
	entity := fs.Arg(0)
	if entity == "" {
		return fmt.Errorf(`usage: devdeck memory graph "<entity>" [--db path] [--mode entities|facts] [--limit N]`)
	}
	if *limit <= 0 || *limit > 2000 {
		*limit = 300
	}

	svc, closeDB, err := openMemoryService(*dbPath)
	if err != nil {
		return err
	}
	defer closeDB()

	q := url.Values{}
	q.Set("limit", strconv.Itoa(*limit))

	ctx := context.Background()
	var raw json.RawMessage
	switch *mode {
	case "facts":
		raw, err = svc.Graph(ctx, q)
	case "entities":
		q.Set("min_count", "1")
		raw, err = svc.EntityGraph(ctx, q)
	default:
		return fmt.Errorf(`--mode must be "entities" or "facts", got %q`, *mode)
	}
	if err != nil {
		return err
	}

	var g memory.GraphResponse
	if err := json.Unmarshal(raw, &g); err != nil {
		return fmt.Errorf("parse memory graph: %w", err)
	}
	return json.NewEncoder(stdout).Encode(memory.Neighbors(g, entity))
}

// defaultDBPath resolves ./data/devdeck.db beside the executable — the same
// default the server (and internal/issuemcp's own subcommand) uses, so a
// skill invoking this with no --db attaches to the hub's real database.
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
