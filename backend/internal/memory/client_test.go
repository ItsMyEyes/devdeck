package memory

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestRetainPostsToMemoriesPath(t *testing.T) {
	var gotPath, gotAuth, gotMethod string
	var gotBody RetainRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(RetainResponse{Success: true, BankID: "bank-1", ItemsCount: 1, Async: true, OperationID: "op-1"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "hsk_test")
	out, err := c.Retain(context.Background(), "bank-1", RetainRequest{
		Items: []MemoryItem{{Content: "hello", DocumentID: "t-1", UpdateMode: "append"}},
		Async: true,
	})
	if err != nil {
		t.Fatalf("Retain: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %s, want POST", gotMethod)
	}
	if gotPath != "/v1/default/banks/bank-1/memories" {
		t.Fatalf("path = %s, want /v1/default/banks/bank-1/memories", gotPath)
	}
	if gotAuth != "Bearer hsk_test" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if len(gotBody.Items) != 1 || gotBody.Items[0].Content != "hello" {
		t.Fatalf("body items = %+v", gotBody.Items)
	}
	if !out.Success || out.OperationID != "op-1" {
		t.Fatalf("out = %+v", out)
	}
}

func TestRecallPostsToRecallPath(t *testing.T) {
	var gotPath string
	var gotBody RecallRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(RecallResponse{Results: []RecallResult{
			{ID: "m-1", Text: "user prefers dark mode", Type: "world"},
		}})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	out, err := c.Recall(context.Background(), "bank-1", RecallRequest{Query: "preferences", Budget: "mid"})
	if err != nil {
		t.Fatalf("Recall: %v", err)
	}
	if gotPath != "/v1/default/banks/bank-1/memories/recall" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotBody.Query != "preferences" {
		t.Fatalf("query = %q", gotBody.Query)
	}
	if len(out.Results) != 1 || out.Results[0].Text != "user prefers dark mode" {
		t.Fatalf("results = %+v", out.Results)
	}
}

func TestOperationsGetsFromOperationsPath(t *testing.T) {
	var gotPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		_ = json.NewEncoder(w).Encode(OperationsResponse{
			BankID: "bank-1", Total: 1, Limit: 20,
			Operations: []Operation{
				{ID: "op-1", TaskType: "batch_retain", Status: "pending", ItemsCount: 1},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	out, err := c.Operations(context.Background(), "bank-1", nil)
	if err != nil {
		t.Fatalf("Operations: %v", err)
	}
	if gotMethod != http.MethodGet {
		t.Fatalf("method = %s, want GET", gotMethod)
	}
	if gotPath != "/v1/default/banks/bank-1/operations" {
		t.Fatalf("path = %s, want /v1/default/banks/bank-1/operations", gotPath)
	}
	if len(out.Operations) != 1 || out.Operations[0].TaskType != "batch_retain" {
		t.Fatalf("operations = %+v", out.Operations)
	}
}

func TestBankIDIsPathEscaped(t *testing.T) {
	var gotEscaped string
	var gotDecoded string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotEscaped = r.URL.EscapedPath()
		gotDecoded = r.URL.Path
		_ = json.NewEncoder(w).Encode(RetainResponse{Success: true})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	if _, err := c.Retain(context.Background(), "my bank/x", RetainRequest{Items: []MemoryItem{{Content: "x"}}}); err != nil {
		t.Fatalf("Retain: %v", err)
	}
	// On the wire the bank id's space and slash must be percent-encoded, even
	// though the server-side Path getter decodes them back for handler
	// convenience — that decoded form is what we check next.
	if !strings.Contains(gotEscaped, "%2F") || !strings.Contains(gotEscaped, "%20") {
		t.Fatalf("bank id not escaped on the wire: %s", gotEscaped)
	}
	if gotDecoded != "/v1/default/banks/my bank/x/memories" {
		t.Fatalf("decoded path = %s", gotDecoded)
	}
}

func TestNonOKStatusReturnsErrWithStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"detail":"bad query"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	_, err := c.Recall(context.Background(), "bank-1", RecallRequest{Query: "x"})
	if err == nil {
		t.Fatal("expected error")
	}
	var herr *Err
	if !asErr(err, &herr) {
		t.Fatalf("error is not *Err: %v", err)
	}
	if herr.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", herr.Status)
	}
	if !strings.Contains(herr.Body, "bad query") {
		t.Fatalf("body = %q", herr.Body)
	}
}

func TestEmptyBaseURLFailsFast(t *testing.T) {
	c := NewClient("", "")
	if err := c.Health(context.Background()); err == nil {
		t.Fatal("expected error for unconfigured client")
	}
}

func TestHealthUsesBanksList(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{"banks": []any{}})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	if err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
	if gotPath != "/v1/default/banks" {
		t.Fatalf("path = %s", gotPath)
	}
}

// TestOperationsDecodesObjectProgress is the regression guard for a real
// decode crash: Operation.Progress was previously declared as a bare
// float64, but the live server sends an OperationProgress OBJECT
// ({stage, at, processed, total, detail}) whenever an operation has reached
// a checkpoint — export/import's own operations are exactly the ones that
// reach one (see client.go's OperationProgress doc comment).
func TestOperationsDecodesObjectProgress(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"bank_id":"bank-1","total":1,"limit":20,"offset":0,"operations":[
			{"id":"op-1","task_type":"document_export","items_count":0,"created_at":"2026-01-01T00:00:00Z",
			 "updated_at":"2026-01-01T00:00:01Z","status":"processing","retry_count":0,
			 "progress":{"stage":"processing_batch","at":"2026-01-01T00:00:01Z","processed":3,"total":10,"detail":{"round":1}}}
		]}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	out, err := c.Operations(context.Background(), "bank-1", nil)
	if err != nil {
		t.Fatalf("Operations: %v (this is the exact decode crash the object-shaped progress field used to cause)", err)
	}
	if len(out.Operations) != 1 {
		t.Fatalf("operations = %+v", out.Operations)
	}
	p := out.Operations[0].Progress
	if p == nil || p.Stage != "processing_batch" || p.Processed == nil || *p.Processed != 3 || p.Detail["round"] != 1 {
		t.Fatalf("progress = %+v", p)
	}
}

func TestExportDocumentsPostsToDocumentTransferExportPath(t *testing.T) {
	var gotPath, gotMethod, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(DocumentTransferSubmitResponse{OperationID: "op-1", Status: "pending"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	out, err := c.ExportDocuments(context.Background(), "bank-1", true)
	if err != nil {
		t.Fatalf("ExportDocuments: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %s, want POST", gotMethod)
	}
	if gotPath != "/v1/default/banks/bank-1/document-transfer/export" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotQuery != "include_observations=true" {
		t.Fatalf("query = %s", gotQuery)
	}
	if out.OperationID != "op-1" {
		t.Fatalf("out = %+v", out)
	}
}

func TestImportDocumentsPostsMultipartWithOnConflict(t *testing.T) {
	var gotPath, gotQuery, gotContentType string
	var gotFileBytes []byte
	var gotFilename string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotContentType = r.Header.Get("Content-Type")
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			t.Fatalf("ParseMultipartForm: %v", err)
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("FormFile: %v", err)
		}
		defer file.Close()
		gotFilename = header.Filename
		gotFileBytes, _ = io.ReadAll(file)
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(DocumentTransferSubmitResponse{OperationID: "op-2", Status: "pending"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	out, err := c.ImportDocuments(context.Background(), "bank-1", "skip", "brain.zip", []byte("zip-bytes"))
	if err != nil {
		t.Fatalf("ImportDocuments: %v", err)
	}
	if gotPath != "/v1/default/banks/bank-1/document-transfer" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotQuery != "on_conflict=skip" {
		t.Fatalf("query = %s", gotQuery)
	}
	if !strings.HasPrefix(gotContentType, "multipart/form-data") {
		t.Fatalf("content-type = %s", gotContentType)
	}
	if gotFilename != "brain.zip" || string(gotFileBytes) != "zip-bytes" {
		t.Fatalf("filename=%q bytes=%q", gotFilename, gotFileBytes)
	}
	if out.OperationID != "op-2" {
		t.Fatalf("out = %+v", out)
	}
}

func TestGetOperationGetsSingleOperationPath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(OperationStatus{
			OperationID: "op-1", Status: "completed",
			ResultMetadata: map[string]any{"storage_key": "k-1", "filename": "export.zip"},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	out, err := c.GetOperation(context.Background(), "bank-1", "op-1")
	if err != nil {
		t.Fatalf("GetOperation: %v", err)
	}
	if gotPath != "/v1/default/banks/bank-1/operations/op-1" {
		t.Fatalf("path = %s", gotPath)
	}
	if out.Status != "completed" || out.ResultMetadata["storage_key"] != "k-1" {
		t.Fatalf("out = %+v", out)
	}
}

func TestClearMemoriesAndObservationsSendDelete(t *testing.T) {
	var gotPaths []string
	var gotMethods []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		gotMethods = append(gotMethods, r.Method)
		_ = json.NewEncoder(w).Encode(DeleteResponse{Success: true, DeletedCount: 3})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	if _, err := c.ClearMemories(context.Background(), "bank-1"); err != nil {
		t.Fatalf("ClearMemories: %v", err)
	}
	if _, err := c.ClearObservations(context.Background(), "bank-1"); err != nil {
		t.Fatalf("ClearObservations: %v", err)
	}
	wantPaths := []string{"/v1/default/banks/bank-1/memories", "/v1/default/banks/bank-1/observations"}
	if !reflect.DeepEqual(gotPaths, wantPaths) {
		t.Fatalf("paths = %v, want %v", gotPaths, wantPaths)
	}
	for _, m := range gotMethods {
		if m != http.MethodDelete {
			t.Fatalf("methods = %v, want all DELETE", gotMethods)
		}
	}
}

func TestDownloadFileFetchesRawBytes(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/zip")
		_, _ = w.Write([]byte("zip-content"))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "")
	data, err := c.DownloadFile(context.Background(), "storage-key-1")
	if err != nil {
		t.Fatalf("DownloadFile: %v", err)
	}
	if gotPath != "/v1/default/files/download/storage-key-1" {
		t.Fatalf("path = %s", gotPath)
	}
	if string(data) != "zip-content" {
		t.Fatalf("data = %q", data)
	}
}

func asErr(err error, target **Err) bool {
	e, ok := err.(*Err)
	if ok {
		*target = e
	}
	return ok
}
