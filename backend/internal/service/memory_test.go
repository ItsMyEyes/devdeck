package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/memoryhost"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

func newTestMemoryService(t *testing.T) *MemoryService {
	t.Helper()
	return NewMemoryService(store.NewTestStore(t), t.TempDir())
}

func TestMemoryConfigDefaultsDisabled(t *testing.T) {
	svc := newTestMemoryService(t)
	cfg, err := svc.Config()
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if cfg.Enabled {
		t.Fatal("expected memory disabled by default")
	}
	if cfg.BankID != "devdeck" {
		t.Fatalf("BankID = %q, want default 'devdeck'", cfg.BankID)
	}
}

func TestUpdateConfigRejectsInvalidLLMProvider(t *testing.T) {
	svc := newTestMemoryService(t)
	bad := "not-a-real-provider"
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{LLMProvider: &bad}); err == nil {
		t.Fatal("expected error for invalid llm provider")
	}
}

func TestUpdateConfigRejectsInvalidBudget(t *testing.T) {
	svc := newTestMemoryService(t)
	bad := "extreme"
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{RecallBudget: &bad}); err == nil {
		t.Fatal("expected error for invalid recall budget")
	}
}

func TestUpdateConfigAppliesFields(t *testing.T) {
	svc := newTestMemoryService(t)
	enabled := true
	baseURL := "http://127.0.0.1:8888"
	bank := "my-bank"
	provider := "ollama"

	cfg, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, BaseURL: &baseURL, HasBaseURL: true,
		BankID: &bank, HasBankID: true, LLMProvider: &provider,
	})
	if err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	if !cfg.Enabled || cfg.BaseURL != baseURL || cfg.BankID != bank || cfg.LLMProvider != provider {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestRecallBlockReturnsEmptyWhenDisabled(t *testing.T) {
	svc := newTestMemoryService(t)
	if got := svc.RecallBlock(context.Background(), memory.Scope{Thread: "w-1"}, "what do I like?"); got != "" {
		t.Fatalf("RecallBlock = %q, want empty when disabled", got)
	}
}

func TestRecallBlockReturnsEmptyOnEmptyQuery(t *testing.T) {
	svc := newTestMemoryService(t)
	enabled, autoRecall := true, true
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{Enabled: &enabled, AutoRecall: &autoRecall}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	if got := svc.RecallBlock(context.Background(), memory.Scope{Thread: "w-1"}, ""); got != "" {
		t.Fatalf("RecallBlock = %q, want empty for empty query", got)
	}
}

func TestRecallBlockFormatsServerResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(memory.RecallResponse{Results: []memory.RecallResult{
			{Text: "prefers dark mode", Type: "world"},
		}})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled, autoRecall := true, true
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRecall: &autoRecall, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	block := svc.RecallBlock(context.Background(), memory.Scope{Thread: "w-1"}, "preferences?")
	if block == "" {
		t.Fatal("expected non-empty block")
	}
	if !contains(block, "prefers dark mode") {
		t.Fatalf("block = %q, missing recalled text", block)
	}
}

// TestRecallBlockCachesRepeatedQuery is the effectiveness evaluation for the
// recall cache: it proves a repeated thread+query pair collapses to ONE
// Hindsight round-trip, and measures the latency this saves directly rather
// than asserting on call counts alone. The server sleeps 150ms per request
// — long enough that a cache miss is unmistakably slower than a hit, short
// enough to keep the test fast.
func TestRecallBlockCachesRepeatedQuery(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(150 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(memory.RecallResponse{Results: []memory.RecallResult{
			{Text: "prefers dark mode", Type: "world"},
		}})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled, autoRecall := true, true
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRecall: &autoRecall, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	scope := memory.Scope{Thread: "w-1"}

	start := time.Now()
	first := svc.RecallBlock(context.Background(), scope, "preferences?")
	firstDuration := time.Since(start)

	start = time.Now()
	second := svc.RecallBlock(context.Background(), scope, "preferences?")
	secondDuration := time.Since(start)

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("Hindsight calls = %d, want 1 (second call should be served from cache)", got)
	}
	if first != second {
		t.Fatalf("cached block differs from original: %q vs %q", second, first)
	}
	if firstDuration < 150*time.Millisecond {
		t.Fatalf("first call duration = %s, want >= 150ms (should have hit the server)", firstDuration)
	}
	if secondDuration >= 50*time.Millisecond {
		t.Fatalf("cached call duration = %s, want < 50ms — cache did not avoid the round-trip", secondDuration)
	}
	t.Logf("effectiveness: miss=%s hit=%s (%.0fx faster)", firstDuration, secondDuration, float64(firstDuration)/float64(secondDuration))
}

// TestRecallBlockCacheMissAcrossThreads proves the cache is scoped per
// thread: the same question asked in two different threads must not leak
// one thread's memory recall into another's turn.
func TestRecallBlockCacheMissAcrossThreads(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_ = json.NewEncoder(w).Encode(memory.RecallResponse{})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled, autoRecall := true, true
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRecall: &autoRecall, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	svc.RecallBlock(context.Background(), memory.Scope{Thread: "w-1"}, "same question")
	svc.RecallBlock(context.Background(), memory.Scope{Thread: "w-2"}, "same question")

	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("Hindsight calls = %d, want 2 — different threads must not share a cache entry", got)
	}
}

// TestRecallBlockCacheExpiresAfterTTL proves a cached block is not served
// forever — a bank mutated by a retain after the first call must be
// reflected again once the TTL passes.
func TestRecallBlockCacheExpiresAfterTTL(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_ = json.NewEncoder(w).Encode(memory.RecallResponse{})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	svc.recallCacheTTL = 10 * time.Millisecond
	enabled, autoRecall := true, true
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRecall: &autoRecall, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	scope := memory.Scope{Thread: "w-1"}
	svc.RecallBlock(context.Background(), scope, "still relevant?")
	time.Sleep(30 * time.Millisecond)
	svc.RecallBlock(context.Background(), scope, "still relevant?")

	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("Hindsight calls = %d, want 2 — a stale entry past its TTL must not be served", got)
	}
}

func TestRecallBlockSkippedWhenAutoRecallOff(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_ = json.NewEncoder(w).Encode(memory.RecallResponse{})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled, autoRecall := true, false
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRecall: &autoRecall, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	svc.RecallBlock(context.Background(), memory.Scope{Thread: "w-1"}, "anything")
	if called {
		t.Fatal("expected no request to the memory server when AutoRecall is off")
	}
}

// TestRecallBlockScopesToProjectPlusGlobal is the regression guard for the
// whole-bank bleed: an auto-recall must ask Hindsight only for THIS thread's
// project plus the global tier, never every project's facts at once. Before
// the fix the request carried no tags, so an unrelated project's memories
// (e.g. a security project's exploit notes) rode into a plain app chat and
// tripped a server-side cyber safeguard.
func TestRecallBlockScopesToProjectPlusGlobal(t *testing.T) {
	got := make(chan memory.RecallRequest, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req memory.RecallRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		got <- req
		_ = json.NewEncoder(w).Encode(memory.RecallResponse{})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled, autoRecall := true, true
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRecall: &autoRecall, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	svc.RecallBlock(context.Background(), memory.Scope{Thread: "w-1", Project: "demo", Surface: "worktree"}, "anything")

	select {
	case req := <-got:
		wantTags := []string{"project:demo", "scope:global"}
		if !reflect.DeepEqual(req.Tags, wantTags) {
			t.Fatalf("recall Tags = %v, want %v — auto-recall must be scoped, not whole-bank", req.Tags, wantTags)
		}
		if req.TagsMatch != "any" {
			t.Fatalf("recall TagsMatch = %q, want any", req.TagsMatch)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("recall never reached the server")
	}
}

// TestRetainGlobalTagsGlobalWithoutProject proves the global tier's write side:
// a preference is tagged scope:global and NOTHING else, so it lands outside any
// project's partition and RecallTags' "any" match will surface it everywhere.
func TestRetainGlobalTagsGlobalWithoutProject(t *testing.T) {
	got := make(chan memory.RetainRequest, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req memory.RetainRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		got <- req
		_ = json.NewEncoder(w).Encode(memory.RetainResponse{Success: true})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled := true
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	if err := svc.RetainGlobal(context.Background(), "  always prefer tabs over spaces  "); err != nil {
		t.Fatalf("RetainGlobal: %v", err)
	}

	select {
	case req := <-got:
		if len(req.Items) != 1 {
			t.Fatalf("items = %d, want 1", len(req.Items))
		}
		item := req.Items[0]
		if !reflect.DeepEqual(item.Tags, []string{memory.GlobalTag}) {
			t.Fatalf("Tags = %v, want [%s] with no project tag", item.Tags, memory.GlobalTag)
		}
		if item.Content != "always prefer tabs over spaces" {
			t.Fatalf("Content = %q, want trimmed preference text", item.Content)
		}
		if item.DocumentID != "" {
			t.Fatalf("DocumentID = %q, want empty so each preference is its own document", item.DocumentID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("retain never reached the server")
	}
}

func TestRetainGlobalRejectsEmptyText(t *testing.T) {
	svc := newTestMemoryService(t)
	enabled := true
	baseURL := "http://127.0.0.1:8888"
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{Enabled: &enabled, BaseURL: &baseURL, HasBaseURL: true}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	if err := svc.RetainGlobal(context.Background(), "   "); err == nil {
		t.Fatal("expected error for empty preference text")
	}
}

func TestRetainAsyncSendsToServer(t *testing.T) {
	done := make(chan memory.RetainRequest, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req memory.RetainRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		done <- req
		_ = json.NewEncoder(w).Encode(memory.RetainResponse{Success: true})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled, autoRetain := true, true
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRetain: &autoRetain, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	svc.RetainAsync(context.Background(), memory.Scope{Thread: "w-1", Project: "demo"}, "user", "fix the bug")

	select {
	case req := <-done:
		if len(req.Items) != 1 {
			t.Fatalf("items = %d, want 1", len(req.Items))
		}
		item := req.Items[0]
		if item.DocumentID != "w-1" || item.UpdateMode != "append" {
			t.Fatalf("item = %+v", item)
		}
		if !contains(item.Content, "fix the bug") {
			t.Fatalf("content = %q, missing text", item.Content)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("retain never reached the server")
	}
}

func TestRetainAsyncSkippedWhenAutoRetainOff(t *testing.T) {
	called := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called <- struct{}{}
		_ = json.NewEncoder(w).Encode(memory.RetainResponse{Success: true})
	}))
	defer srv.Close()

	svc := newTestMemoryService(t)
	enabled, autoRetain := true, false
	url := srv.URL
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, AutoRetain: &autoRetain, BaseURL: &url, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	svc.RetainAsync(context.Background(), memory.Scope{Thread: "w-1"}, "user", "text")
	select {
	case <-called:
		t.Fatal("expected no request when AutoRetain is off")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestMCPEndpointFalseWhenDisabled(t *testing.T) {
	svc := newTestMemoryService(t)
	if _, ok := svc.MCPEndpoint(); ok {
		t.Fatal("expected ok=false when memory is disabled")
	}
}

func TestMCPEndpointBuildsBankScopedURL(t *testing.T) {
	svc := newTestMemoryService(t)
	enabled := true
	baseURL := "http://127.0.0.1:8888"
	bank := "acme"
	key := "hsk_test"
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, BaseURL: &baseURL, HasBaseURL: true,
		BankID: &bank, HasBankID: true, APIKey: &key,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	info, ok := svc.MCPEndpoint()
	if !ok {
		t.Fatal("expected ok=true when memory is enabled and configured")
	}
	if info.URL != "http://127.0.0.1:8888/mcp/acme/" {
		t.Fatalf("URL = %q", info.URL)
	}
	if info.Token != "hsk_test" {
		t.Fatalf("Token = %q", info.Token)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestLocalStatusReturnsErrHostingNotLocalByDefault(t *testing.T) {
	svc := newTestMemoryService(t)
	if _, err := svc.LocalStatus(context.Background()); !errors.Is(err, ErrMemoryHostingNotLocal) {
		t.Fatalf("err = %v, want ErrMemoryHostingNotLocal", err)
	}
}

func TestLocalStartReturnsErrHostingNotLocalWhenManual(t *testing.T) {
	svc := newTestMemoryService(t)
	if err := svc.LocalStart(context.Background()); !errors.Is(err, ErrMemoryHostingNotLocal) {
		t.Fatalf("err = %v, want ErrMemoryHostingNotLocal", err)
	}
}

func TestLocalStopReturnsErrHostingNotLocalWhenManual(t *testing.T) {
	svc := newTestMemoryService(t)
	if err := svc.LocalStop(context.Background()); !errors.Is(err, ErrMemoryHostingNotLocal) {
		t.Fatalf("err = %v, want ErrMemoryHostingNotLocal", err)
	}
}

func TestLocalStartIfRunningNoOpsWhenManual(t *testing.T) {
	svc := newTestMemoryService(t)
	if err := svc.LocalStartIfRunning(context.Background()); err != nil {
		t.Fatalf("LocalStartIfRunning: %v", err)
	}
}

func TestLocalStartIfRunningNoOpsWhenLocalRunningIsFalse(t *testing.T) {
	svc := newTestMemoryService(t)
	hosting := "container"
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{Hosting: &hosting}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	// LocalRunning defaults to false — StartIfRunning must not attempt a
	// real container start just because Hosting is "container".
	if err := svc.LocalStartIfRunning(context.Background()); err != nil {
		t.Fatalf("LocalStartIfRunning: %v", err)
	}
	cfg, err := svc.Config()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalRunning {
		t.Fatal("LocalRunning should still be false — nothing should have started")
	}
}

func TestUpdateConfigRejectsInvalidHosting(t *testing.T) {
	svc := newTestMemoryService(t)
	bad := "cloud"
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{Hosting: &bad}); err == nil {
		t.Fatal("expected error for invalid hosting value")
	}
}

// exportImportHindsightServer stubs the parts of Hindsight's document-transfer
// API ExportBrain/ImportBrain drive: submit export/import, poll the operation
// to "completed" on the second poll (proving the poll loop actually loops),
// serve the download, and record any DELETE calls a Replace-mode import made.
func exportImportHindsightServer(t *testing.T) (*httptest.Server, *int32) {
	t.Helper()
	var opPolls int32
	var deletes []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/document-transfer/export"):
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(memory.DocumentTransferSubmitResponse{OperationID: "op-export", Status: "pending"})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/document-transfer"):
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(memory.DocumentTransferSubmitResponse{OperationID: "op-import", Status: "pending"})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/operations/"):
			n := atomic.AddInt32(&opPolls, 1)
			if n < 2 {
				_ = json.NewEncoder(w).Encode(memory.OperationStatus{Status: "processing"})
				return
			}
			if strings.HasSuffix(r.URL.Path, "op-export") {
				_ = json.NewEncoder(w).Encode(memory.OperationStatus{
					Status:         "completed",
					ResultMetadata: map[string]any{"storage_key": "key-1", "filename": "acme-brain.zip"},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(memory.OperationStatus{
				Status:         "completed",
				ResultMetadata: map[string]any{"imported": float64(3), "skipped": float64(1)},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/files/download/key-1"):
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write([]byte("zip-bytes"))
		case r.Method == http.MethodDelete:
			deletes = append(deletes, r.URL.Path)
			_ = json.NewEncoder(w).Encode(memory.DeleteResponse{Success: true, DeletedCount: 2})
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(func() {
		if len(deletes) > 1 {
			t.Logf("deletes observed: %v", deletes)
		}
	})
	return srv, &opPolls
}

func configuredMemoryService(t *testing.T, baseURL string) *MemoryService {
	t.Helper()
	svc := newTestMemoryService(t)
	enabled := true
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, BaseURL: &baseURL, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	return svc
}

func TestExportBrainPollsAndDownloadsArchive(t *testing.T) {
	srv, polls := exportImportHindsightServer(t)
	defer srv.Close()
	svc := configuredMemoryService(t, srv.URL)

	data, filename, err := svc.ExportBrain(context.Background())
	if err != nil {
		t.Fatalf("ExportBrain: %v", err)
	}
	if string(data) != "zip-bytes" {
		t.Fatalf("data = %q", data)
	}
	if filename != "acme-brain.zip" {
		t.Fatalf("filename = %q", filename)
	}
	if atomic.LoadInt32(polls) < 2 {
		t.Fatal("expected pollOperation to poll more than once before completing")
	}
}

func TestImportBrainMergeSkipsWithoutClearing(t *testing.T) {
	var deletePaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletePaths = append(deletePaths, r.URL.Path)
		}
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/document-transfer"):
			var gotQuery = r.URL.Query().Get("on_conflict")
			if gotQuery != "skip" {
				t.Fatalf("on_conflict = %q, want skip for merge", gotQuery)
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(memory.DocumentTransferSubmitResponse{OperationID: "op-import", Status: "pending"})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/operations/"):
			_ = json.NewEncoder(w).Encode(memory.OperationStatus{
				Status:         "completed",
				ResultMetadata: map[string]any{"imported": float64(5)},
			})
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	svc := configuredMemoryService(t, srv.URL)

	summary, err := svc.ImportBrain(context.Background(), "merge", "brain.zip", []byte("zip"))
	if err != nil {
		t.Fatalf("ImportBrain: %v", err)
	}
	if summary.Cleared {
		t.Fatal("merge mode must not clear existing content")
	}
	if len(deletePaths) != 0 {
		t.Fatalf("merge mode issued DELETE calls: %v", deletePaths)
	}
	if summary.Raw["imported"] != float64(5) {
		t.Fatalf("summary.Raw = %+v", summary.Raw)
	}
}

func TestImportBrainReplaceClearsFirst(t *testing.T) {
	var order []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/memories"):
			order = append(order, "clear-memories")
			_ = json.NewEncoder(w).Encode(memory.DeleteResponse{Success: true})
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/observations"):
			order = append(order, "clear-observations")
			_ = json.NewEncoder(w).Encode(memory.DeleteResponse{Success: true})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/document-transfer"):
			order = append(order, "import")
			if got := r.URL.Query().Get("on_conflict"); got != "replace" {
				t.Fatalf("on_conflict = %q, want replace", got)
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(memory.DocumentTransferSubmitResponse{OperationID: "op-import", Status: "pending"})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/operations/"):
			_ = json.NewEncoder(w).Encode(memory.OperationStatus{Status: "completed"})
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	svc := configuredMemoryService(t, srv.URL)

	summary, err := svc.ImportBrain(context.Background(), "replace", "brain.zip", []byte("zip"))
	if err != nil {
		t.Fatalf("ImportBrain: %v", err)
	}
	if !summary.Cleared {
		t.Fatal("replace mode must report Cleared=true")
	}
	wantOrder := []string{"clear-memories", "clear-observations", "import"}
	if !reflect.DeepEqual(order, wantOrder) {
		t.Fatalf("call order = %v, want %v — bank must be wiped before the archive is imported", order, wantOrder)
	}
}

func TestImportBrainRejectsInvalidMode(t *testing.T) {
	svc := configuredMemoryService(t, "http://127.0.0.1:1")
	if _, err := svc.ImportBrain(context.Background(), "overwrite-everything", "brain.zip", []byte("zip")); !errors.Is(err, ErrInvalidImportMode) {
		t.Fatalf("err = %v, want ErrInvalidImportMode", err)
	}
}

func TestExportBrainReturnsErrMemoryNotConfiguredWhenDisabled(t *testing.T) {
	svc := newTestMemoryService(t)
	if _, _, err := svc.ExportBrain(context.Background()); !errors.Is(err, ErrMemoryNotConfigured) {
		t.Fatalf("err = %v, want ErrMemoryNotConfigured", err)
	}
}

// TestLocalContainerStartStopUpdatesConfig drives a REAL container start/stop
// through the service layer (not just internal/memoryhost's own tests),
// proving the config side effects LocalStart/LocalStop document — BaseURL
// derived from the port, Enabled and LocalRunning flipped on a real success,
// LocalRunning cleared on stop.
//
// Opt-in, for the same reason memoryhost's own requireContainerE2E is: the
// container name is one fixed name per machine, and `go test ./...` runs this
// package and internal/memoryhost concurrently. Both used to pass their
// "already exists?" guard and then race on `docker run`, so whichever lost got
// `Conflict. The container name "/devdeck-hindsight" is already in use`.
//
//	DEVDECK_CONTAINER_E2E=1 go test ./internal/service/ -run TestLocalContainer
func TestLocalContainerStartStopUpdatesConfig(t *testing.T) {
	if os.Getenv("DEVDECK_CONTAINER_E2E") == "" {
		t.Skip("set DEVDECK_CONTAINER_E2E=1 to run the real-container lifecycle (exclusive: one devdeck-hindsight per machine)")
	}
	if _, _, err := memoryhost.DetectEngine(); err != nil {
		t.Skip("no docker/podman on this machine")
	}
	if s := memoryhost.GetStatus(context.Background(), memoryhost.ModeContainer, ""); s.Exists {
		t.Skip("devdeck-hindsight already exists on this machine — skipping to avoid disturbing it")
	}

	svc := newTestMemoryService(t)

	hosting := "container"
	localPort := 18889
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{Hosting: &hosting, LocalPort: &localPort}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := svc.LocalStart(ctx); err != nil {
		t.Fatalf("LocalStart: %v", err)
	}
	t.Cleanup(func() { _ = svc.LocalStop(context.Background()) })

	cfg, err := svc.Config()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Enabled || !cfg.LocalRunning {
		t.Fatalf("cfg = %+v, want Enabled+LocalRunning after a successful LocalStart", cfg)
	}
	if want := "http://127.0.0.1:18889"; cfg.BaseURL != want {
		t.Fatalf("BaseURL = %q, want %q", cfg.BaseURL, want)
	}

	status, err := svc.LocalStatus(ctx)
	if err != nil {
		t.Fatalf("LocalStatus: %v", err)
	}
	if !status.Running {
		t.Fatalf("status = %+v, want Running", status)
	}

	if err := svc.LocalStop(ctx); err != nil {
		t.Fatalf("LocalStop: %v", err)
	}
	cfg, err = svc.Config()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalRunning {
		t.Fatal("LocalRunning should be false after LocalStop")
	}
}
