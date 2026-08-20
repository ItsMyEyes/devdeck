// Package memory gives every agent DevDeck spawns one persistent memory that
// outlives the thread, the project, and the machine the agent ran on.
//
// # Why this layer exists at all
//
// Hindsight (the memory server this package speaks to) ships its own
// per-CLI integrations, and none of them fit DevDeck:
//
//   - They are three different mechanisms — MCP for claude, lifecycle hooks
//     for codex, an npm plugin for opencode — and pi has none at all.
//   - Every one of them installs into a USER-scoped config (~/.hindsight,
//     ~/.codex/config.toml, ~/.claude/settings.json). DevDeck deliberately
//     overrides HOME (claude/pi/opencode) or CODEX_HOME (codex) per provider
//     instance so two instances cannot share credentials — see each adapter's
//     buildEnv — so a user-scoped install lands in a home the agent never
//     reads.
//   - They are per MACHINE, which is the opposite of what a hub with many
//     runtimes needs: one memory, not one per host.
//   - MCP alone is opt-in for the model. An agent that may call recall is an
//     agent that will sometimes forget.
//
// So memory is injected one layer up, where DevDeck already funnels every
// provider: recall runs before Adapter.SendTurn and retain runs when the turn
// completes (see orchestration/workers.go). That is one code path for claude,
// codex, opencode, pi and the SSH DevOps chat at once.
//
// # The wire shapes here were read off the server, not the docs
//
// Every path and field below came from the running server's own
// openapi.json. The published documentation disagrees with it — it advertises
// retain as POST /v1/default/banks/{bank}/memory/retain, which does not
// exist; the real route is POST /v1/default/banks/{bank}/memories. Re-check
// openapi.json before trusting an untested path.
package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Default timeouts. Recall sits in front of a user's turn, so it is the one
// call that must never hang: a memory server that has gone away has to degrade
// into "no memories", not into a chat that never starts.
const (
	RecallTimeout = 12 * time.Second
	RetainTimeout = 30 * time.Second
	ReadTimeout   = 30 * time.Second
)

// Client is a Hindsight HTTP client. Safe for concurrent use.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// NewClient builds a client for one Hindsight deployment. baseURL is the API
// root (e.g. http://127.0.0.1:8888); apiKey may be empty, which is the normal
// case for a self-hosted server on a loopback or private address.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		apiKey:  strings.TrimSpace(apiKey),
		http:    &http.Client{Timeout: ReadTimeout},
	}
}

// BaseURL reports the configured API root, for diagnostics.
func (c *Client) BaseURL() string { return c.baseURL }

// bankPath builds a per-bank API path. The bank id is escaped: it is
// operator-supplied through Settings and travels in the URL.
func bankPath(bank, suffix string) string {
	p := "/v1/default/banks/" + url.PathEscape(bank)
	if suffix != "" {
		p += suffix
	}
	return p
}

// ---------------------------------------------------------------------------
// Retain
// ---------------------------------------------------------------------------

// MemoryItem is one unit handed to retain. Content is never stored verbatim —
// Hindsight extracts structured facts from it — so passing a whole turn
// transcript is the intended use, not an abuse.
type MemoryItem struct {
	Content string `json:"content"`
	// Context shapes fact extraction ("devdeck agent turn", "ssh devops
	// session"). It is a hint to the extractor, not a filter.
	Context string `json:"context,omitempty"`
	// Timestamp is RFC3339. Empty lets the server stamp it.
	Timestamp string `json:"timestamp,omitempty"`
	// DocumentID groups items and makes retain idempotent: retaining the same
	// document id again updates instead of duplicating. DevDeck uses the
	// thread id, so one thread is one document however many turns it runs.
	DocumentID string         `json:"document_id,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
	Tags       []string       `json:"tags,omitempty"`
	// UpdateMode is "append" or "replace" and only matters when DocumentID
	// repeats. DevDeck appends: a later turn adds to the thread's document.
	UpdateMode string `json:"update_mode,omitempty"`
}

type RetainRequest struct {
	Items []MemoryItem `json:"items"`
	// Async returns as soon as the work is queued. DevDeck always sets this:
	// fact extraction runs an LLM, and no user should wait on it.
	Async bool `json:"async,omitempty"`
	// OperationID makes a retry safe — the server dedupes on it.
	OperationID string `json:"operation_id,omitempty"`
}

type TokenUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

type RetainResponse struct {
	Success     bool        `json:"success"`
	BankID      string      `json:"bank_id"`
	ItemsCount  int         `json:"items_count"`
	Async       bool        `json:"async"`
	OperationID string      `json:"operation_id,omitempty"`
	Usage       *TokenUsage `json:"usage,omitempty"`
}

// Retain stores memories in a bank. The bank is created on first use.
func (c *Client) Retain(ctx context.Context, bank string, req RetainRequest) (RetainResponse, error) {
	var out RetainResponse
	err := c.do(ctx, http.MethodPost, bankPath(bank, "/memories"), nil, req, &out, RetainTimeout)
	return out, err
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

type RecallRequest struct {
	Query string `json:"query"`
	// Types filters fact categories: "world", "experience", "observation".
	Types     []string `json:"types,omitempty"`
	Budget    string   `json:"budget,omitempty"`     // low | mid | high
	MaxTokens int      `json:"max_tokens,omitempty"` // server default 4096
	Tags      []string `json:"tags,omitempty"`
	TagsMatch string   `json:"tags_match,omitempty"` // any|all|any_strict|all_strict|exact
	// PreferObservations collapses raw facts the server has already folded
	// into a higher-level observation, which keeps an injected block short.
	PreferObservations bool `json:"prefer_observations,omitempty"`
}

type RecallScores struct {
	Final    float64 `json:"final"`
	Reranker float64 `json:"reranker,omitempty"`
	Semantic float64 `json:"semantic,omitempty"`
	Keyword  float64 `json:"keyword,omitempty"`
}

type RecallResult struct {
	ID          string         `json:"id"`
	Text        string         `json:"text"`
	Type        string         `json:"type"`
	Context     string         `json:"context,omitempty"`
	Tags        []string       `json:"tags,omitempty"`
	Entities    []string       `json:"entities,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
	MentionedAt string         `json:"mentioned_at,omitempty"`
	DocumentID  string         `json:"document_id,omitempty"`
	Scores      *RecallScores  `json:"scores,omitempty"`
}

type RecallResponse struct {
	Results []RecallResult `json:"results"`
}

// Recall searches a bank. An empty result set is a normal answer, not an
// error: a fresh bank has nothing to say yet.
func (c *Client) Recall(ctx context.Context, bank string, req RecallRequest) (RecallResponse, error) {
	var out RecallResponse
	err := c.do(ctx, http.MethodPost, bankPath(bank, "/memories/recall"), nil, req, &out, RecallTimeout)
	return out, err
}

// ---------------------------------------------------------------------------
// Reflect
// ---------------------------------------------------------------------------

type ReflectRequest struct {
	Query     string   `json:"query"`
	Budget    string   `json:"budget,omitempty"`
	Context   string   `json:"context,omitempty"`
	MaxTokens int      `json:"max_tokens,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	TagsMatch string   `json:"tags_match,omitempty"`
}

type ReflectResponse struct {
	Text  string      `json:"text"`
	Usage *TokenUsage `json:"usage,omitempty"`
}

// Reflect asks the bank a question its raw facts do not answer directly; the
// server runs an agent loop over them. Slower and LLM-priced, so it is an
// explicit operator/agent action, never part of a turn's hot path.
func (c *Client) Reflect(ctx context.Context, bank string, req ReflectRequest) (ReflectResponse, error) {
	var out ReflectResponse
	err := c.do(ctx, http.MethodPost, bankPath(bank, "/reflect"), nil, req, &out, ReadTimeout)
	return out, err
}

// ---------------------------------------------------------------------------
// Read-only views (the Memory page)
// ---------------------------------------------------------------------------

// BankStats is the bank's headline numbers.
type BankStats struct {
	BankID             string         `json:"bank_id"`
	TotalNodes         int            `json:"total_nodes"`
	TotalLinks         int            `json:"total_links"`
	TotalDocuments     int            `json:"total_documents"`
	TotalObservations  int            `json:"total_observations"`
	NodesByFactType    map[string]int `json:"nodes_by_fact_type"`
	LinksByLinkType    map[string]int `json:"links_by_link_type"`
	PendingOperations  int            `json:"pending_operations"`
	FailedOperations   int            `json:"failed_operations"`
	LastConsolidatedAt string         `json:"last_consolidated_at,omitempty"`
	LastMemoryWriteAt  string         `json:"last_memory_write_at,omitempty"`
}

func (c *Client) Stats(ctx context.Context, bank string) (BankStats, error) {
	var out BankStats
	err := c.do(ctx, http.MethodGet, bankPath(bank, "/stats"), nil, nil, &out, ReadTimeout)
	return out, err
}

type TagItem struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

type TagsResponse struct {
	Items  []TagItem `json:"items"`
	Total  int       `json:"total"`
	Limit  int       `json:"limit"`
	Offset int       `json:"offset"`
}

func (c *Client) Tags(ctx context.Context, bank string, q url.Values) (TagsResponse, error) {
	var out TagsResponse
	err := c.do(ctx, http.MethodGet, bankPath(bank, "/tags"), q, nil, &out, ReadTimeout)
	return out, err
}

// ListResponse keeps its items as raw JSON on purpose. The server describes a
// memory unit as an untyped object in its own schema, and this package has no
// reason to invent a Go struct the server never promised: the Memory page
// renders what it is given.
type ListResponse struct {
	Items  []json.RawMessage `json:"items"`
	Total  int               `json:"total"`
	Limit  int               `json:"limit"`
	Offset int               `json:"offset"`
}

func (c *Client) ListMemories(ctx context.Context, bank string, q url.Values) (ListResponse, error) {
	var out ListResponse
	err := c.do(ctx, http.MethodGet, bankPath(bank, "/memories/list"), q, nil, &out, ReadTimeout)
	return out, err
}

// Operation is one background job Hindsight is running or has run against a
// bank — a batch retain, a single retain (the fact-extraction pass a batch
// retain fans out into), a consolidation sweep, a mental-model refresh.
// Fields verified against a live server's response, not guessed: this is a
// concrete shape (unlike ListResponse's items), so it is worth a real struct.
type Operation struct {
	ID          string             `json:"id"`
	TaskType    string             `json:"task_type"`
	ItemsCount  int                `json:"items_count"`
	DocumentID  string             `json:"document_id,omitempty"`
	Filename    string             `json:"filename,omitempty"`
	CreatedAt   string             `json:"created_at"`
	UpdatedAt   string             `json:"updated_at"`
	Status      string             `json:"status"` // pending | running | done | failed (observed values; treat unknowns as "pending"-like)
	ErrorMsg    string             `json:"error_message,omitempty"`
	RetryCount  int                `json:"retry_count"`
	NextRetryAt string             `json:"next_retry_at,omitempty"`
	Progress    *OperationProgress `json:"progress,omitempty"`
}

// OperationProgress is a running operation's last-known checkpoint — written
// at coarse phase/batch boundaries, so a poller can distinguish a healthy
// long-running job (Processed advancing across polls) from a frozen one.
// Absent (nil) on operations that never reached a checkpoint (completed
// instantly, or predate this field). This was previously (wrongly) declared
// as a bare float64 on Operation, which crashed decoding the very first real
// object the live server sent — export/import's own operations are what
// finally exercises this path, since a batch retain rarely lives long enough
// to reach a progress checkpoint.
type OperationProgress struct {
	Stage     string         `json:"stage"`
	At        string         `json:"at"`
	Processed *int           `json:"processed,omitempty"`
	Total     *int           `json:"total,omitempty"`
	Detail    map[string]int `json:"detail,omitempty"`
}

type OperationsResponse struct {
	BankID     string      `json:"bank_id"`
	Total      int         `json:"total"`
	Limit      int         `json:"limit"`
	Offset     int         `json:"offset"`
	Operations []Operation `json:"operations"`
}

// Operations is what the Memory page's Overview tab polls to answer "what is
// Hindsight doing right now" — extracting facts from a just-retained turn,
// consolidating, refreshing a mental model — the background work an operator
// otherwise has no visibility into.
func (c *Client) Operations(ctx context.Context, bank string, q url.Values) (OperationsResponse, error) {
	var out OperationsResponse
	err := c.do(ctx, http.MethodGet, bankPath(bank, "/operations"), q, nil, &out, ReadTimeout)
	return out, err
}

// ---------------------------------------------------------------------------
// Document transfer — the whole-bank backup/restore Settings' Export/Import
// Brain buttons use. Facts, entity names, causal links, chunks, and
// (optionally) consolidated observations, packaged as a ZIP. Both directions
// are async: submit returns an operation id, MemoryService polls Operation
// for it via GetOperation.
// ---------------------------------------------------------------------------

// DocumentTransferSubmitResponse is returned by both ExportDocuments (a
// pending export job) and ImportDocuments (a pending import job) — same
// shape on the wire for both.
type DocumentTransferSubmitResponse struct {
	OperationID string `json:"operation_id"`
	Status      string `json:"status"`
}

// ExportDocuments starts an async export of every document in bank as a
// transfer ZIP. includeObservations also bundles consolidated observations —
// only meaningful for a whole-bank export, which this always is (DevDeck
// never exports a document subset).
func (c *Client) ExportDocuments(ctx context.Context, bank string, includeObservations bool) (DocumentTransferSubmitResponse, error) {
	q := url.Values{}
	if includeObservations {
		q.Set("include_observations", "true")
	}
	var out DocumentTransferSubmitResponse
	err := c.do(ctx, http.MethodPost, bankPath(bank, "/document-transfer/export"), q, nil, &out, ReadTimeout)
	return out, err
}

// ImportDocuments submits a transfer ZIP (produced by ExportDocuments) for
// import into bank. onConflict is "skip" (Merge: keep existing documents
// untouched, add anything new) or "replace" (overwrite documents whose id
// collides — MemoryService additionally wipes the bank before calling this
// with "replace", see ImportBrain).
func (c *Client) ImportDocuments(ctx context.Context, bank, onConflict, filename string, data []byte) (DocumentTransferSubmitResponse, error) {
	var out DocumentTransferSubmitResponse
	q := url.Values{"on_conflict": {onConflict}}
	err := c.doMultipart(ctx, bankPath(bank, "/document-transfer"), q, "file", filename, data, &out, RetainTimeout)
	return out, err
}

// OperationStatus is one export/import job's current state, polled while an
// Export/Import Brain request is in flight. ResultMetadata's shape is
// operation-specific and the server's own schema warns it "may change
// without notice" — callers pull known keys out defensively rather than
// typing it.
type OperationStatus struct {
	OperationID    string         `json:"operation_id"`
	Status         string         `json:"status"` // pending | processing | completed | failed | cancelled | not_found
	ErrorMessage   string         `json:"error_message,omitempty"`
	ResultMetadata map[string]any `json:"result_metadata,omitempty"`
}

// GetOperation fetches a single operation's status — unlike Operations (a
// paged list), this is what a poll loop calls once per tick for one known id.
func (c *Client) GetOperation(ctx context.Context, bank, operationID string) (OperationStatus, error) {
	var out OperationStatus
	err := c.do(ctx, http.MethodGet, bankPath(bank, "/operations/"+url.PathEscape(operationID)), nil, nil, &out, ReadTimeout)
	return out, err
}

// DeleteResponse is the server's answer to any of the bank-content DELETE
// endpoints (ClearMemories, ClearObservations).
type DeleteResponse struct {
	Success      bool   `json:"success"`
	Message      string `json:"message,omitempty"`
	DeletedCount int    `json:"deleted_count,omitempty"`
}

// ClearMemories deletes every memory unit in bank (all fact types), keeping
// the bank's own profile (disposition/mission) intact. Used by Replace-mode
// import to wipe existing content before importing the incoming archive.
func (c *Client) ClearMemories(ctx context.Context, bank string) (DeleteResponse, error) {
	var out DeleteResponse
	err := c.do(ctx, http.MethodDelete, bankPath(bank, "/memories"), nil, nil, &out, RetainTimeout)
	return out, err
}

// ClearObservations deletes bank's consolidated observations — a separate
// store from memory units, so a full content wipe needs both this and
// ClearMemories.
func (c *Client) ClearObservations(ctx context.Context, bank string) (DeleteResponse, error) {
	var out DeleteResponse
	err := c.do(ctx, http.MethodDelete, bankPath(bank, "/observations"), nil, nil, &out, RetainTimeout)
	return out, err
}

// DownloadFile fetches a file previously written to Hindsight's file
// storage — currently only the transfer ZIP an export operation produces.
// key comes from that operation's ResultMetadata["storage_key"]. Unlike
// every other call in this file, the path is NOT bank-scoped: access is
// authorized against the bank the key belongs to server-side.
func (c *Client) DownloadFile(ctx context.Context, key string) ([]byte, error) {
	return c.doDownload(ctx, "/v1/default/files/download/"+url.PathEscape(key))
}

// Graph and EntityGraph return the server's payload untouched, for the same
// reason ListResponse does: openapi.json types their nodes and edges as bare
// objects, so anything this package declared would be a guess. The Memory
// page's graph reads them defensively.
func (c *Client) Graph(ctx context.Context, bank string, q url.Values) (json.RawMessage, error) {
	return c.raw(ctx, bankPath(bank, "/graph"), q)
}

func (c *Client) EntityGraph(ctx context.Context, bank string, q url.Values) (json.RawMessage, error) {
	return c.raw(ctx, bankPath(bank, "/entities/graph"), q)
}

func (c *Client) Timeseries(ctx context.Context, bank string, q url.Values) (json.RawMessage, error) {
	return c.raw(ctx, bankPath(bank, "/stats/memories-timeseries"), q)
}

func (c *Client) Entities(ctx context.Context, bank string, q url.Values) (json.RawMessage, error) {
	return c.raw(ctx, bankPath(bank, "/entities"), q)
}

func (c *Client) Documents(ctx context.Context, bank string, q url.Values) (json.RawMessage, error) {
	return c.raw(ctx, bankPath(bank, "/documents"), q)
}

func (c *Client) MentalModels(ctx context.Context, bank string, q url.Values) (json.RawMessage, error) {
	return c.raw(ctx, bankPath(bank, "/mental-models"), q)
}

// Banks lists every bank on the server. Used by Settings to show what exists
// before an operator commits to a bank id.
func (c *Client) Banks(ctx context.Context) (json.RawMessage, error) {
	return c.raw(ctx, "/v1/default/banks", nil)
}

// Health reports whether the server answers at all. It deliberately uses the
// bank list rather than a bank-scoped route: this must work before any bank
// exists, and it is what Settings' "Test connection" button calls.
func (c *Client) Health(ctx context.Context) error {
	_, err := c.Banks(ctx)
	return err
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

func (c *Client) raw(ctx context.Context, path string, q url.Values) (json.RawMessage, error) {
	var out json.RawMessage
	if err := c.do(ctx, http.MethodGet, path, q, nil, &out, ReadTimeout); err != nil {
		return nil, err
	}
	return out, nil
}

// Err is a failed Hindsight call. Status is the HTTP status when the server
// answered at all (0 when it did not), which is what lets a caller tell a
// misconfigured bank from an unreachable server.
type Err struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *Err) Error() string {
	if e.Status == 0 {
		return fmt.Sprintf("hindsight: %s %s: %s", e.Method, e.Path, e.Body)
	}
	return fmt.Sprintf("hindsight: %s %s: status %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func (c *Client) do(ctx context.Context, method, path string, q url.Values, in, out any, timeout time.Duration) error {
	if c.baseURL == "" {
		return &Err{Method: method, Path: path, Body: "no memory server configured"}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	full := c.baseURL + path
	if len(q) > 0 {
		full += "?" + q.Encode()
	}

	var body io.Reader
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, full, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return &Err{Method: method, Path: path, Body: err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		// Cap the echoed body: a FastAPI validation error is small, but an
		// HTML error page from something else in front of the server is not,
		// and this string ends up in a log line and an API error envelope.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return &Err{Method: method, Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(snippet))}
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return &Err{Method: method, Path: path, Status: resp.StatusCode, Body: "decode response: " + err.Error()}
	}
	return nil
}

// doMultipart posts one file as multipart/form-data — the shape
// ImportDocuments needs and the only place this client sends a non-JSON
// body.
func (c *Client) doMultipart(ctx context.Context, path string, q url.Values, fieldName, filename string, data []byte, out any, timeout time.Duration) error {
	if c.baseURL == "" {
		return &Err{Method: http.MethodPost, Path: path, Body: "no memory server configured"}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile(fieldName, filename)
	if err != nil {
		return err
	}
	if _, err := part.Write(data); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}

	full := c.baseURL + path
	if len(q) > 0 {
		full += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, full, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return &Err{Method: http.MethodPost, Path: path, Body: err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return &Err{Method: http.MethodPost, Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(snippet))}
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return &Err{Method: http.MethodPost, Path: path, Status: resp.StatusCode, Body: "decode response: " + err.Error()}
	}
	return nil
}

// doDownload GETs path and returns the raw response body — the shape
// DownloadFile needs for a binary (ZIP) response, which json.Decode cannot
// handle.
func (c *Client) doDownload(ctx context.Context, path string) ([]byte, error) {
	if c.baseURL == "" {
		return nil, &Err{Method: http.MethodGet, Path: path, Body: "no memory server configured"}
	}
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Err{Method: http.MethodGet, Path: path, Body: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, &Err{Method: http.MethodGet, Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(snippet))}
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &Err{Method: http.MethodGet, Path: path, Status: resp.StatusCode, Body: "read body: " + err.Error()}
	}
	return data, nil
}
