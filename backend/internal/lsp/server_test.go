package lsp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"loom/backend/internal/store"

	"nhooyr.io/websocket"
)

func TestFrameRoundTrip(t *testing.T) {
	want := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	var framed bytes.Buffer
	if err := writeFrame(&framed, want); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	got, err := readFrame(bufio.NewReader(&framed))
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("payload = %q, want %q", got, want)
	}
}

func TestReadFrameRejectsMissingLength(t *testing.T) {
	_, err := readFrame(bufio.NewReader(bytes.NewBufferString("Content-Type: application/json\r\n\r\n{}")))
	if err == nil {
		t.Fatal("readFrame accepted a frame without Content-Length")
	}
}

func TestLanguageServerAliases(t *testing.T) {
	for _, language := range []string{"go", "typescript", "typescriptreact", "javascript", "javascriptreact", "python", "rust"} {
		if _, ok := languageServers[language]; !ok {
			t.Errorf("language %q has no server", language)
		}
	}
}

func TestResolveWorktreeRoot(t *testing.T) {
	project := t.TempDir()
	worktree := filepath.Join(project, ".wt", "w-test")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}

	gotRoot, err := resolveWorktreeRoot(project, "w-test", true, "")
	if err != nil {
		t.Fatalf("root worktree: %v", err)
	}
	wantRoot, _ := filepath.EvalSymlinks(project)
	if gotRoot != wantRoot {
		t.Fatalf("root = %q, want %q", gotRoot, wantRoot)
	}

	gotBranch, err := resolveWorktreeRoot(project, "w-test", false, "feat/test")
	if err != nil {
		t.Fatalf("branch worktree: %v", err)
	}
	wantBranch, _ := filepath.EvalSymlinks(worktree)
	if gotBranch != wantBranch {
		t.Fatalf("branch root = %q, want %q", gotBranch, wantBranch)
	}
}

func TestWebsocketGatewayProxiesJSONRPC(t *testing.T) {
	t.Setenv("LOOM_LSP_HELPER", "1")
	original := languageServers["go"]
	languageServers["go"] = serverSpec{
		binary: os.Args[0],
		args:   []string{"-test.run=^TestLSPHelperProcess$"},
	}
	t.Cleanup(func() { languageServers["go"] = original })

	projectPath := t.TempDir()
	db, err := store.Open(filepath.Join(t.TempDir(), "lsp-test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := store.New(db)
	workspace, err := st.CreateWorkspace("test")
	if err != nil {
		t.Fatal(err)
	}
	project, err := st.CreateProject(workspace.ID, "project", projectPath, "", "")
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := st.CreateWorktree(project.ID, "root", "", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}

	httpServer := httptest.NewServer(http.HandlerFunc(NewServer(st).HandleWS))
	t.Cleanup(httpServer.Close)
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") +
		"?worktree=" + worktree.ID + "&language=go"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	_, readyPayload, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read ready control message: %v", err)
	}
	var ready struct {
		LoomLSP controlMessage `json:"loomLsp"`
	}
	if err := json.Unmarshal(readyPayload, &ready); err != nil {
		t.Fatalf("decode ready control message: %v", err)
	}
	if ready.LoomLSP.Type != "ready" || ready.LoomLSP.RootURI == "" {
		t.Fatalf("ready control message = %+v", ready.LoomLSP)
	}

	request := []byte(`{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, request); err != nil {
		t.Fatalf("write JSON-RPC request: %v", err)
	}
	_, response, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read JSON-RPC response: %v", err)
	}
	var rpc struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(response, &rpc); err != nil {
		t.Fatalf("decode JSON-RPC response: %v", err)
	}
	if rpc.ID != 7 || len(rpc.Result) == 0 {
		t.Fatalf("response = %s", response)
	}
}

func TestLSPHelperProcess(t *testing.T) {
	if os.Getenv("LOOM_LSP_HELPER") != "1" {
		return
	}
	payload, err := readFrame(bufio.NewReader(os.Stdin))
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		t.Fatal(err)
	}
	response := []byte(`{"jsonrpc":"2.0","id":` + strconv.Itoa(request.ID) + `,"result":{"capabilities":{}}}`)
	if err := writeFrame(os.Stdout, response); err != nil {
		t.Fatal(err)
	}
}
