// Package service's MemoryService is the hub-side owner of DevDeck's
// persistent agent memory: the only place that turns domain.MemoryConfig +
// the stored API keys into a live memory.Client, and the only place that
// knows how to fold a Scope into the tags/document layout a bank uses.
//
// A runtime never constructs one of these directly — see
// domain.MemoryConfig's doc comment and machineclient/memory.go — it always
// calls back through the hub's machine-key-gated routes, which this service
// backs.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/memoryhost"
	"devdeck/backend/internal/port"
)

// ErrMemoryNotConfigured is returned when the feature is disabled or no base
// URL is stored. Handlers map this to 204/no-op, mirroring
// ErrCompletionsNotConfigured — an unconfigured memory layer is a silent
// no-op, never a surfaced error to the agent or the operator's turn.
var ErrMemoryNotConfigured = errors.New("memory: not configured")

var validMemoryLLMProviders = map[string]bool{
	"openai": true, "anthropic": true, "gemini": true,
	"groq": true, "ollama": true, "lmstudio": true,
}

var validRecallBudgets = map[string]bool{"low": true, "mid": true, "high": true}

var validMemoryHosting = map[string]bool{"manual": true, "container": true, "baremetal": true}

type MemoryService struct {
	store port.Store
	// dataDir is this hub's own persistent-state root (the same directory
	// its --db lives in, e.g. filepath.Dir(dbPath)) — a locally managed
	// container's bind-mounted volume, or a bare-metal process's working
	// directory and pidfile, live under dataDir/hindsight-data. Empty is a
	// valid, tested value: it just means LocalStart/LocalStop will fail if
	// ever called, which is exactly memorybackfill's situation — a one-shot
	// batch tool with no business starting a server.
	dataDir string

	// recallCache dedupes RecallBlock calls that share a bank+thread+query
	// key within recallCacheTTL. It exists because recall sits on a turn's
	// hot path (Reactor.react blocks SendTurn on it — see
	// orchestration.MemoryHooks' doc comment) with no dedup of its own: a
	// double-submit, a quick retry, or two near-identical follow-up turns
	// each paid a fresh Hindsight round-trip and a fresh MaxTokens-sized
	// block, even when the answer could not have changed in the interim.
	// Keyed on the exact request text, not a fuzzy match — a query that
	// differs at all is a different bank of memories that might matter, so
	// it always gets a real recall.
	recallMu       sync.Mutex
	recallCache    map[string]recallCacheEntry
	recallCacheTTL time.Duration
}

// recallCacheCap bounds recallCache's size. Hit on write, not on a timer —
// this process has no background goroutine to sweep it, so an unbounded
// number of distinct thread+query pairs would otherwise grow the map
// forever over a long-running hub's lifetime.
const recallCacheCap = 256

// defaultRecallCacheTTL: long enough to absorb a double-submit or a burst of
// quick follow-ups, short enough that a bank mutated by a retain moments
// ago (see RetainAsync) is reflected again well within a normal
// back-and-forth conversation.
const defaultRecallCacheTTL = 60 * time.Second

type recallCacheEntry struct {
	block   string
	expires time.Time
}

func NewMemoryService(st port.Store, dataDir string) *MemoryService {
	return &MemoryService{
		store:          st,
		dataDir:        dataDir,
		recallCache:    make(map[string]recallCacheEntry),
		recallCacheTTL: defaultRecallCacheTTL,
	}
}

// localDataDir is where a locally managed process/container's persistent
// state lives — a subdirectory of the hub's own data root, not dataDir
// itself, so it doesn't crowd the sqlite file and other top-level state.
func (s *MemoryService) localDataDir() string {
	return filepath.Join(s.dataDir, "hindsight-data")
}

func (s *MemoryService) Config() (domain.MemoryConfig, error) {
	return s.store.MemoryConfig()
}

func (s *MemoryService) UpdateConfig(p port.MemoryConfigPatch) (domain.MemoryConfig, error) {
	if p.LLMProvider != nil && !validMemoryLLMProviders[*p.LLMProvider] {
		return domain.MemoryConfig{}, fmt.Errorf("memory: invalid llm provider %q", *p.LLMProvider)
	}
	if p.RecallBudget != nil && !validRecallBudgets[*p.RecallBudget] {
		return domain.MemoryConfig{}, fmt.Errorf("memory: invalid recall budget %q", *p.RecallBudget)
	}
	if p.Hosting != nil && !validMemoryHosting[*p.Hosting] {
		return domain.MemoryConfig{}, fmt.Errorf("memory: invalid hosting %q", *p.Hosting)
	}
	return s.store.UpdateMemoryConfig(p)
}

func (s *MemoryService) Configured() (bool, error) {
	return s.store.MemoryConfigured()
}

// ---------------------------------------------------------------------------
// Local lifecycle — "container" and "baremetal" hosting. See
// domain.MemoryConfig.Hosting's doc comment and internal/memoryhost's
// package comment for the full picture: these two modes are the ones where
// DevDeck itself runs the Hindsight process on this machine, so an operator
// never has to open a terminal.
// ---------------------------------------------------------------------------

// ErrMemoryHostingNotLocal is returned by the Local* methods when
// domain.MemoryConfig.Hosting is "manual" — there is nothing for this hub to
// start or stop, since the operator's own process (wherever it runs) owns
// its own lifecycle.
var ErrMemoryHostingNotLocal = errors.New("memory: hosting is not container or baremetal")

func localMode(hosting string) (memoryhost.Mode, bool) {
	switch hosting {
	case "container":
		return memoryhost.ModeContainer, true
	case "baremetal":
		return memoryhost.ModeBareMetal, true
	default:
		return "", false
	}
}

// LocalStatus reports the current state of the locally managed
// process/container, or ErrMemoryHostingNotLocal when Hosting is "manual".
func (s *MemoryService) LocalStatus(ctx context.Context) (memoryhost.Status, error) {
	cfg, err := s.store.MemoryConfig()
	if err != nil {
		return memoryhost.Status{}, err
	}
	mode, ok := localMode(cfg.Hosting)
	if !ok {
		return memoryhost.Status{}, ErrMemoryHostingNotLocal
	}
	return memoryhost.GetStatus(ctx, mode, s.localDataDir()), nil
}

// LocalLogs returns the locally managed process/container's last `tail`
// lines, or ErrMemoryHostingNotLocal when Hosting is "manual".
func (s *MemoryService) LocalLogs(ctx context.Context, tail int) (string, error) {
	cfg, err := s.store.MemoryConfig()
	if err != nil {
		return "", err
	}
	mode, ok := localMode(cfg.Hosting)
	if !ok {
		return "", ErrMemoryHostingNotLocal
	}
	return memoryhost.Logs(ctx, mode, tail, s.localDataDir())
}

// LocalStart starts (or resumes) the locally managed process/container using
// the stored config, then records BOTH the resulting BaseURL and the
// operator's persisted intent (LocalRunning) — the same "config write as a
// side effect of a real action" restraint PutConfig's own doc comment
// describes: this is the ONLY place LocalRunning is ever set true, and it is
// set only after memoryhost.Start actually succeeds, never optimistically.
func (s *MemoryService) LocalStart(ctx context.Context) error {
	cfg, err := s.store.MemoryConfig()
	if err != nil {
		return err
	}
	mode, ok := localMode(cfg.Hosting)
	if !ok {
		return ErrMemoryHostingNotLocal
	}
	localPort := cfg.LocalPort
	if localPort <= 0 {
		localPort = 8888
	}
	llmKey, err := s.store.MemoryLLMAPIKey()
	if err != nil {
		return err
	}

	if err := memoryhost.Start(ctx, mode, memoryhost.StartConfig{
		Port:        localPort,
		DataDir:     s.localDataDir(),
		LLMProvider: cfg.LLMProvider,
		LLMModel:    cfg.LLMModel,
		LLMBaseURL:  cfg.LLMBaseURL,
		LLMAPIKey:   llmKey,
	}); err != nil {
		return err
	}

	// An operator choosing local hosting should not ALSO have to type a base
	// URL by hand — Start just made the bank reachable at exactly this
	// loopback address, so BaseURL is derived, not operator-entered. Enabled
	// is set too: clicking "Start" is the whole gesture of turning this
	// feature on, not a separate step after it.
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", localPort)
	enabled, running := true, true
	_, err = s.store.UpdateMemoryConfig(port.MemoryConfigPatch{
		Enabled: &enabled, BaseURL: &baseURL, HasBaseURL: true,
		LocalPort: &localPort, LocalRunning: &running,
	})
	return err
}

// LocalStop stops the locally managed process/container and clears the
// persisted intent, so a hub restart does not try to re-establish it.
func (s *MemoryService) LocalStop(ctx context.Context) error {
	cfg, err := s.store.MemoryConfig()
	if err != nil {
		return err
	}
	mode, ok := localMode(cfg.Hosting)
	if !ok {
		return ErrMemoryHostingNotLocal
	}
	if err := memoryhost.Stop(ctx, mode, s.localDataDir()); err != nil {
		return err
	}
	running := false
	_, err = s.store.UpdateMemoryConfig(port.MemoryConfigPatch{LocalRunning: &running})
	return err
}

// LocalStartIfRunning re-establishes the locally managed process/container
// on hub boot if the operator's persisted intent says it should be up —
// mirrors PublishedSOCKSService.StartIfEnabled's exact pattern (see
// main.go's call to it). Never returns an error worth failing boot over:
// image/package missing, engine down, or hosting not local at all are all
// just "nothing to restore right now".
func (s *MemoryService) LocalStartIfRunning(ctx context.Context) error {
	cfg, err := s.store.MemoryConfig()
	if err != nil {
		return err
	}
	if _, ok := localMode(cfg.Hosting); !ok || !cfg.LocalRunning {
		return nil
	}
	return s.LocalStart(ctx)
}

// client builds a memory.Client from stored config, or ErrMemoryNotConfigured
// when the feature is off or has no server address. cfg is returned alongside
// it since most callers need both.
func (s *MemoryService) client() (*memory.Client, domain.MemoryConfig, error) {
	cfg, err := s.store.MemoryConfig()
	if err != nil {
		return nil, domain.MemoryConfig{}, err
	}
	if !cfg.Enabled || cfg.BaseURL == "" {
		return nil, cfg, ErrMemoryNotConfigured
	}
	key, err := s.store.MemoryAPIKey()
	if err != nil {
		return nil, cfg, err
	}
	return memory.NewClient(cfg.BaseURL, key), cfg, nil
}

// TestConnection is what Settings' "Test connection" action calls: it must
// work even with Enabled left off while an operator is still filling in the
// form, so it builds its own client rather than going through client() above.
func (s *MemoryService) TestConnection(ctx context.Context, baseURL, apiKey string) error {
	if baseURL == "" {
		return errors.New("memory: base URL is required")
	}
	return memory.NewClient(baseURL, apiKey).Health(ctx)
}

// MCPEndpointInfo is what main.go wires into provider.SessionStartInput.
// MCPEndpoint for a provider process spawned on THIS SAME machine.
type MCPEndpointInfo struct {
	URL   string
	Token string
}

// MCPEndpoint returns the live Hindsight MCP endpoint for the configured
// bank, or ok=false when memory is disabled or unconfigured.
//
// Deliberately hub/both-local only — main.go only calls this when !isRuntime.
// A CLI process spawned on a REMOTE runtime cannot reach cfg.BaseURL at all in
// the common case (it is typically a loopback address meaningful only on the
// hub's own machine), and handing a remote process the raw Hindsight API key
// to embed in its own MCP config would leak a credential DevDeck otherwise
// keeps hub-side for every other memory operation. Recall/retain already give
// a remote runtime's agent full memory coverage without this (see
// orchestration.MemoryHooks) — MCP only adds the OPTIONAL ability for the
// model to call retain/recall/reflect mid-turn on its own initiative.
func (s *MemoryService) MCPEndpoint() (MCPEndpointInfo, bool) {
	cfg, err := s.store.MemoryConfig()
	if err != nil || !cfg.Enabled || cfg.BaseURL == "" {
		return MCPEndpointInfo{}, false
	}
	key, err := s.store.MemoryAPIKey()
	if err != nil {
		return MCPEndpointInfo{}, false
	}
	return MCPEndpointInfo{
		URL:   strings.TrimRight(cfg.BaseURL, "/") + "/mcp/" + bank(cfg) + "/",
		Token: key,
	}, true
}

// Client returns the configured Hindsight client and bank id for a caller
// that needs direct, synchronous access — currently only the
// memory-backfill subcommand (internal/memorybackfill), which retains a
// thread's full historical turn set in one batched call per thread rather
// than the one-item, fire-and-forget shape RetainAsync exists for.
func (s *MemoryService) Client() (*memory.Client, string, error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, "", err
	}
	return c, bank(cfg), nil
}

// bank returns the configured bank id, defaulting to "devdeck" — the same
// default the migration seeds a fresh row with, kept here too so a config row
// hand-edited or reset to "" does not silently start writing to Hindsight's
// literal default bank.
func bank(cfg domain.MemoryConfig) string {
	if cfg.BankID == "" {
		return "devdeck"
	}
	return cfg.BankID
}

// ---------------------------------------------------------------------------
// The two calls orchestration hooks into (see orchestration.MemoryHooks and
// main.go's resolveScope). Both degrade to "do nothing" rather than erroring
// when memory is unavailable — a chat turn must never fail, slow down, or
// visibly change because the memory server is down or unconfigured.
// ---------------------------------------------------------------------------

// RecallBlock searches the bank and returns the block to prepend to a turn's
// text, or "" when memory is disabled, empty, or the call failed/timed out.
// Errors are logged, never returned — see the doc comment above.
//
// Every call is logged with its outcome (cache hit/miss/error), duration and
// block size — the data this package's design leans on (see MemoryHooks'
// doc comment on why recall blocks the turn at all) but never had a way to
// measure. `grep 'memory: recall' server.log` is the effectiveness
// evaluation: cache=hit rows are turns that would otherwise have paid a
// full Hindsight round-trip and gotten an identical answer.
func (s *MemoryService) RecallBlock(ctx context.Context, scope memory.Scope, query string) string {
	if query == "" {
		return ""
	}
	cfg, err := s.store.MemoryConfig()
	if err != nil || !cfg.Enabled || !cfg.AutoRecall || cfg.BaseURL == "" {
		return ""
	}

	start := time.Now()
	key := bank(cfg) + "\x00" + scope.Thread + "\x00" + query
	if block, ok := s.recallCacheGet(key); ok {
		log.Printf("memory: recall thread=%s cache=hit duration=%s chars=%d", scope.Thread, time.Since(start), len(block))
		return block
	}

	c, _, err := s.client()
	if err != nil {
		return ""
	}
	budget := cfg.RecallBudget
	if budget == "" {
		budget = "mid"
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 1536
	}
	// Scope the recall to this thread's own project plus the global tier — NOT
	// the whole shared bank. Without this, a chat on one project recalls every
	// project's facts, so an unrelated (e.g. security) project's memories bleed
	// in as noise, or trip a server-side cyber safeguard. See memory.RecallTags.
	tags, tagsMatch := memory.RecallTags(scope)
	rctx, cancel := context.WithTimeout(ctx, memory.RecallTimeout)
	defer cancel()
	resp, err := c.Recall(rctx, bank(cfg), memory.RecallRequest{
		Query: query, Budget: budget, MaxTokens: maxTokens,
		Tags: tags, TagsMatch: tagsMatch,
		PreferObservations: true,
	})
	if err != nil {
		log.Printf("memory: recall failed, thread=%s cache=miss duration=%s err=%v", scope.Thread, time.Since(start), err)
		return ""
	}
	block := memory.FormatRecall(resp.Results, time.Now())
	log.Printf("memory: recall thread=%s tags=%v cache=miss duration=%s results=%d chars=%d", scope.Thread, tags, time.Since(start), len(resp.Results), len(block))
	s.recallCacheSet(key, block)
	return block
}

// recallCacheGet returns the cached block for key, or ok=false when absent
// or expired. An expired entry is left for the next Set's sweep rather than
// deleted here — a read-only path taking the lock to mutate the map on
// every miss would defeat the point of a cache that is supposed to be cheap
// to check.
func (s *MemoryService) recallCacheGet(key string) (string, bool) {
	s.recallMu.Lock()
	defer s.recallMu.Unlock()
	e, ok := s.recallCache[key]
	if !ok || time.Now().After(e.expires) {
		return "", false
	}
	return e.block, true
}

func (s *MemoryService) recallCacheSet(key, block string) {
	s.recallMu.Lock()
	defer s.recallMu.Unlock()
	now := time.Now()
	for k, e := range s.recallCache {
		if now.After(e.expires) {
			delete(s.recallCache, k)
		}
	}
	if len(s.recallCache) >= recallCacheCap {
		var oldestKey string
		var oldestExpiry time.Time
		first := true
		for k, e := range s.recallCache {
			if first || e.expires.Before(oldestExpiry) {
				oldestKey, oldestExpiry, first = k, e.expires, false
			}
		}
		delete(s.recallCache, oldestKey)
	}
	s.recallCache[key] = recallCacheEntry{block: block, expires: now.Add(s.recallCacheTTL)}
}

// RetainAsync stores one role's turn text against scope's thread document.
// Fire-and-forget by design — it starts its own goroutine with its own
// timeout, detached from ctx's cancellation, so a turn that has already
// finished (and whose ctx may be cancelled) still gets its reply retained.
func (s *MemoryService) RetainAsync(ctx context.Context, scope memory.Scope, role, text string) {
	if text == "" {
		return
	}
	cfg, err := s.store.MemoryConfig()
	if err != nil || !cfg.Enabled || !cfg.AutoRetain || cfg.BaseURL == "" {
		return
	}
	c, _, err := s.client()
	if err != nil {
		return
	}
	b := bank(cfg)
	go func() {
		rctx, cancel := context.WithTimeout(context.Background(), memory.RetainTimeout)
		defer cancel()
		item := memory.MemoryItem{
			Content:    role + ": " + text,
			Context:    "devdeck agent chat turn (" + scope.Surface + ")",
			DocumentID: scope.Thread,
			UpdateMode: "append",
			Tags:       scope.Tags(),
			Metadata:   scope.Metadata(),
		}
		if _, err := c.Retain(rctx, b, memory.RetainRequest{Items: []memory.MemoryItem{item}, Async: true}); err != nil {
			log.Printf("memory: retain failed, thread=%s role=%s err=%v", scope.Thread, role, err)
		}
	}()
}

// ---------------------------------------------------------------------------
// Manual / browse operations — the Memory page and an operator-triggered
// reflect. Unlike RecallBlock/RetainAsync these return real errors: a person
// clicking "Ask" or opening the Memory page needs to know the call failed,
// not have it silently swallowed.
// ---------------------------------------------------------------------------

func (s *MemoryService) Recall(ctx context.Context, req memory.RecallRequest) (memory.RecallResponse, error) {
	c, cfg, err := s.client()
	if err != nil {
		return memory.RecallResponse{}, err
	}
	return c.Recall(ctx, bank(cfg), req)
}

// RetainGlobal stores one operator preference in the cross-project global tier:
// a fact tagged memory.GlobalTag with NO project tag, so RecallBlock surfaces it
// in every project's chats regardless of which one is active. This is the
// deliberate escape hatch from the project scoping RecallTags draws — auto-retain
// tags every turn with its own project, so the only way a preference travels
// across companies is for the operator to add it here, from the Memory page.
//
// Unlike RetainAsync this is synchronous and returns a real error: it backs an
// operator clicking "Add", who needs to know if the write failed. Each call is
// its own document (no DocumentID), so preferences accumulate instead of
// overwriting one another.
func (s *MemoryService) RetainGlobal(ctx context.Context, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("memory: empty global preference")
	}
	c, cfg, err := s.client()
	if err != nil {
		return err
	}
	item := memory.MemoryItem{
		Content:    text,
		Context:    "devdeck global operator preference",
		Tags:       []string{memory.GlobalTag},
		Metadata:   map[string]any{"source": "devdeck", "global": true},
		UpdateMode: "append",
	}
	_, err = c.Retain(ctx, bank(cfg), memory.RetainRequest{Items: []memory.MemoryItem{item}})
	return err
}

func (s *MemoryService) Reflect(ctx context.Context, req memory.ReflectRequest) (memory.ReflectResponse, error) {
	c, cfg, err := s.client()
	if err != nil {
		return memory.ReflectResponse{}, err
	}
	return c.Reflect(ctx, bank(cfg), req)
}

func (s *MemoryService) Stats(ctx context.Context) (memory.BankStats, error) {
	c, cfg, err := s.client()
	if err != nil {
		return memory.BankStats{}, err
	}
	return c.Stats(ctx, bank(cfg))
}

func (s *MemoryService) Tags(ctx context.Context, q url.Values) (memory.TagsResponse, error) {
	c, cfg, err := s.client()
	if err != nil {
		return memory.TagsResponse{}, err
	}
	return c.Tags(ctx, bank(cfg), q)
}

func (s *MemoryService) ListMemories(ctx context.Context, q url.Values) (memory.ListResponse, error) {
	c, cfg, err := s.client()
	if err != nil {
		return memory.ListResponse{}, err
	}
	return c.ListMemories(ctx, bank(cfg), q)
}

// Operations is what the Overview tab polls for "what is happening right
// now" — see memory.Client.Operations's doc comment.
func (s *MemoryService) Operations(ctx context.Context, q url.Values) (memory.OperationsResponse, error) {
	c, cfg, err := s.client()
	if err != nil {
		return memory.OperationsResponse{}, err
	}
	return c.Operations(ctx, bank(cfg), q)
}

func (s *MemoryService) Graph(ctx context.Context, q url.Values) (json.RawMessage, error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, err
	}
	return c.Graph(ctx, bank(cfg), q)
}

func (s *MemoryService) EntityGraph(ctx context.Context, q url.Values) (json.RawMessage, error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, err
	}
	return c.EntityGraph(ctx, bank(cfg), q)
}

func (s *MemoryService) Timeseries(ctx context.Context, q url.Values) (json.RawMessage, error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, err
	}
	return c.Timeseries(ctx, bank(cfg), q)
}

func (s *MemoryService) Documents(ctx context.Context, q url.Values) (json.RawMessage, error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, err
	}
	return c.Documents(ctx, bank(cfg), q)
}

func (s *MemoryService) MentalModels(ctx context.Context, q url.Values) (json.RawMessage, error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, err
	}
	return c.MentalModels(ctx, bank(cfg), q)
}

func (s *MemoryService) Entities(ctx context.Context, q url.Values) (json.RawMessage, error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, err
	}
	return c.Entities(ctx, bank(cfg), q)
}

// ---------------------------------------------------------------------------
// Export/Import Brain — moving a bank's content to another machine or cloud.
// Both are the Memory page's operator-triggered actions, so like Recall/
// RetainGlobal above (not RecallBlock/RetainAsync) they return real errors.
// ---------------------------------------------------------------------------

// ErrInvalidImportMode is returned by ImportBrain for any mode other than
// "merge" or "replace" — a caller bug (the frontend only ever sends one of
// the two), not something an operator can trigger by mistake.
var ErrInvalidImportMode = errors.New("memory: invalid import mode")

// brainTransferTimeout bounds one Export/ImportBrain call end to end (submit
// + poll +, for export, download). Generous because a large bank's document
// export/import can take a while; short enough that a stuck Hindsight worker
// doesn't hang an operator's request forever.
const brainTransferTimeout = 5 * time.Minute

const operationPollInterval = 1 * time.Second

// pollOperation blocks until bank's operationID reaches a terminal state,
// checking every operationPollInterval until ctx's deadline (callers derive
// ctx with brainTransferTimeout). Returns the terminal status, or an error if
// ctx expires first or the server reports failed/cancelled/not_found.
func (s *MemoryService) pollOperation(ctx context.Context, c *memory.Client, bank, operationID string) (memory.OperationStatus, error) {
	for {
		st, err := c.GetOperation(ctx, bank, operationID)
		if err != nil {
			return memory.OperationStatus{}, err
		}
		switch st.Status {
		case "completed":
			return st, nil
		case "failed", "cancelled", "not_found":
			msg := st.ErrorMessage
			if msg == "" {
				msg = "operation " + st.Status
			}
			return st, fmt.Errorf("operation %s: %s", operationID, msg)
		}
		select {
		case <-ctx.Done():
			return memory.OperationStatus{}, ctx.Err()
		case <-time.After(operationPollInterval):
		}
	}
}

// ExportBrain packages the configured bank's full content — facts, entities,
// causal links, chunks, and consolidated observations — as a transfer ZIP an
// operator can move to another machine or cloud. It is the Memory page's
// "Export Brain" button: submits Hindsight's async document-transfer export,
// polls it to completion, and downloads the resulting archive.
func (s *MemoryService) ExportBrain(ctx context.Context) (data []byte, filename string, err error) {
	c, cfg, err := s.client()
	if err != nil {
		return nil, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, brainTransferTimeout)
	defer cancel()
	b := bank(cfg)

	sub, err := c.ExportDocuments(ctx, b, true)
	if err != nil {
		return nil, "", fmt.Errorf("memory: start export: %w", err)
	}
	st, err := s.pollOperation(ctx, c, b, sub.OperationID)
	if err != nil {
		return nil, "", fmt.Errorf("memory: export: %w", err)
	}
	key, _ := st.ResultMetadata["storage_key"].(string)
	if key == "" {
		return nil, "", errors.New("memory: export completed with no storage_key")
	}
	data, err = c.DownloadFile(ctx, key)
	if err != nil {
		return nil, "", fmt.Errorf("memory: download export: %w", err)
	}
	name, _ := st.ResultMetadata["filename"].(string)
	if name == "" {
		name = fmt.Sprintf("%s-brain-%s.zip", b, time.Now().UTC().Format("20060102-150405"))
	}
	return data, name, nil
}

// ImportSummary is what the Memory page's "Import Brain" dialog shows after
// a successful import.
type ImportSummary struct {
	// Cleared is true when Replace mode wiped the bank's existing memory
	// content and observations before importing.
	Cleared bool `json:"cleared"`
	// Raw carries whatever Hindsight's import operation reported in its
	// result_metadata (e.g. imported/skipped document counts) — untyped for
	// the same reason memory.ListResponse's items are: the schema is not a
	// contract DevDeck can rely on.
	Raw map[string]any `json:"raw,omitempty"`
}

// ImportBrain uploads a transfer ZIP produced by ExportBrain into the
// configured bank. mode is "merge" (add anything new, leave existing
// documents untouched) or "replace" (wipe the bank's existing memory content
// and observations first, then import the archive fresh) — see the mode
// switch below for exactly how each maps onto Hindsight's on_conflict.
func (s *MemoryService) ImportBrain(ctx context.Context, mode, filename string, data []byte) (ImportSummary, error) {
	var onConflict string
	switch mode {
	case "merge":
		onConflict = "skip"
	case "replace":
		onConflict = "replace"
	default:
		return ImportSummary{}, fmt.Errorf("%w: %q", ErrInvalidImportMode, mode)
	}

	c, cfg, err := s.client()
	if err != nil {
		return ImportSummary{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, brainTransferTimeout)
	defer cancel()
	b := bank(cfg)

	var summary ImportSummary
	if mode == "replace" {
		if _, err := c.ClearMemories(ctx, b); err != nil {
			return ImportSummary{}, fmt.Errorf("memory: clear existing memories: %w", err)
		}
		if _, err := c.ClearObservations(ctx, b); err != nil {
			return ImportSummary{}, fmt.Errorf("memory: clear existing observations: %w", err)
		}
		summary.Cleared = true
	}

	sub, err := c.ImportDocuments(ctx, b, onConflict, filename, data)
	if err != nil {
		return ImportSummary{}, fmt.Errorf("memory: start import: %w", err)
	}
	st, err := s.pollOperation(ctx, c, b, sub.OperationID)
	if err != nil {
		return ImportSummary{}, fmt.Errorf("memory: import: %w", err)
	}
	summary.Raw = st.ResultMetadata
	return summary, nil
}
