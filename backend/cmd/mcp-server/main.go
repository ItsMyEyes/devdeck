// mcp-server exposes Loom's issue tracker to coding agents over the Model
// Context Protocol (stdio transport). It opens the same SQLite database as
// the main backend (WAL mode supports the two processes sharing the file)
// and goes through the same port.Store used by the HTTP handlers — no
// duplicated business logic.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

func main() {
	dbPath := flag.String("db", envOr("LOOM_DB", defaultDBPath()), "sqlite database path (same file the Loom backend uses)")
	flag.Parse()

	if err := os.MkdirAll(filepath.Dir(*dbPath), 0o700); err != nil {
		log.Fatalf("create database directory: %v", err)
	}
	db, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	st := store.New(db)
	srv := newIssueMCPServer(st)

	if err := server.ServeStdio(srv); err != nil {
		log.Fatalf("mcp server: %v", err)
	}
}

func newIssueMCPServer(st *store.Store) *server.MCPServer {
	s := server.NewMCPServer("loom-issues", "1.0.0")
	h := &issueTools{st: st}

	s.AddTool(mcp.NewTool("list_projects",
		mcp.WithDescription("List every project across all workspaces, with its id (needed by create_issue) and open issue count."),
	), h.listProjects)

	s.AddTool(mcp.NewTool("create_issue",
		mcp.WithDescription(
			"Create an issue on a project's board. `assignee` is required — if the caller "+
				"hasn't been told which agent or person should own this ticket, ask before calling "+
				"this tool rather than guessing.",
		),
		mcp.WithString("project_id", mcp.Required(), mcp.Description("Project id from list_projects.")),
		mcp.WithString("title", mcp.Required(), mcp.Description("Short issue title.")),
		mcp.WithString("description", mcp.Description("Markdown body — implementation notes, spec/plan, acceptance criteria.")),
		mcp.WithString("assignee", mcp.Required(), mcp.Description("Who is picking this up (agent name or person).")),
		mcp.WithString("priority", mcp.Description("high | normal | low (default normal)."), mcp.Enum("high", "normal", "low")),
		mcp.WithString("status", mcp.Description("todo | in_progress | in_review | done (default todo)."),
			mcp.Enum("todo", "in_progress", "in_review", "done")),
	), h.createIssue)

	s.AddTool(mcp.NewTool("upload_attachment",
		mcp.WithDescription(
			"Attach a local file (e.g. a spec/plan document, screenshot) to an issue. By default the "+
				"returned link is appended to the issue's description so it's visible immediately.",
		),
		mcp.WithString("issue_id", mcp.Required(), mcp.Description("Issue id returned by create_issue.")),
		mcp.WithString("file_path", mcp.Required(), mcp.Description("Absolute path to the file to upload, readable by this process.")),
		mcp.WithBoolean("append_to_description", mcp.Description("Append a markdown link/image to the issue description (default true).")),
	), h.uploadAttachment)

	s.AddTool(mcp.NewTool("mark_issue_done",
		mcp.WithDescription("Move an issue to In Review once the assigned work is finished."),
		mcp.WithString("issue_id", mcp.Required(), mcp.Description("Issue id to move to in_review.")),
		mcp.WithString("note", mcp.Description("Optional note appended to the description summarizing what was done.")),
	), h.markIssueDone)

	return s
}

type issueTools struct {
	st *store.Store
}

func (h *issueTools) listProjects(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	workspaces, err := h.st.Workspaces()
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}

	type projectSummary struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		Path          string `json:"path"`
		WorkspaceID   string `json:"workspaceId"`
		WorkspaceName string `json:"workspaceName"`
		OpenIssues    int    `json:"openIssues"`
	}

	out := []projectSummary{}
	for _, ws := range workspaces {
		for _, p := range ws.Projects {
			open := 0
			for _, iss := range p.Issues {
				if iss.Status != "done" {
					open++
				}
			}
			out = append(out, projectSummary{
				ID: p.ID, Name: p.Name, Path: p.Path,
				WorkspaceID: ws.ID, WorkspaceName: ws.Name, OpenIssues: open,
			})
		}
	}
	return jsonResult(out)
}

func (h *issueTools) createIssue(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectID, err := req.RequireString("project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	title, err := req.RequireString("title")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	assignee, err := req.RequireString("assignee")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	description := req.GetString("description", "")
	status := req.GetString("status", "todo")
	priority := req.GetString("priority", "")

	createdAt := time.Now().UTC().Format(time.RFC3339)
	iss, err := h.st.CreateIssue(projectID, title, status, createdAt)
	if err != nil {
		return storeErrResult(err)
	}

	patch := port.IssuePatch{Assignee: &assignee, HasAssignee: true}
	if description != "" {
		patch.Description = &description
	}
	if priority != "" {
		patch.Priority = &priority
	}
	iss, err = h.st.UpdateIssue(iss.ID, createdAt, patch)
	if err != nil {
		return storeErrResult(err)
	}
	return jsonResult(iss)
}

func (h *issueTools) uploadAttachment(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	issueID, err := req.RequireString("issue_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	filePath, err := req.RequireString("file_path")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	appendToDescription := req.GetBool("append_to_description", true)

	data, err := os.ReadFile(filePath)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("read file: %v", err)), nil
	}
	mimeType := mimeFromExt(filePath)
	filename := filepath.Base(filePath)
	createdAt := time.Now().UTC().Format(time.RFC3339)

	att, err := h.st.CreateAttachment(issueID, filename, mimeType, data, createdAt)
	if err != nil {
		return storeErrResult(err)
	}

	result := struct {
		Attachment  any    `json:"attachment"`
		URL         string `json:"url"`
		Description string `json:"description,omitempty"`
	}{Attachment: att, URL: "/api/attachments/" + att.ID}

	if appendToDescription {
		iss, err := h.st.UpdateIssue(issueID, createdAt, port.IssuePatch{})
		if err != nil {
			return storeErrResult(err)
		}
		link := fmt.Sprintf("[📎 %s](%s)", filename, result.URL)
		if mimeType != "" && len(mimeType) >= 6 && mimeType[:6] == "image/" {
			link = fmt.Sprintf("![%s](%s)", filename, result.URL)
		}
		newDescription := iss.Description
		if newDescription != "" {
			newDescription += "\n\n"
		}
		newDescription += link
		iss, err = h.st.UpdateIssue(issueID, createdAt, port.IssuePatch{Description: &newDescription})
		if err != nil {
			return storeErrResult(err)
		}
		result.Description = iss.Description
	}

	return jsonResult(result)
}

func (h *issueTools) markIssueDone(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	issueID, err := req.RequireString("issue_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	note := req.GetString("note", "")

	status := "in_review"
	updatedAt := time.Now().UTC().Format(time.RFC3339)
	patch := port.IssuePatch{Status: &status}

	if note != "" {
		iss, err := h.st.UpdateIssue(issueID, updatedAt, port.IssuePatch{})
		if err != nil {
			return storeErrResult(err)
		}
		desc := iss.Description
		if desc != "" {
			desc += "\n\n"
		}
		desc += "**Done:** " + note
		patch.Description = &desc
	}

	iss, err := h.st.UpdateIssue(issueID, updatedAt, patch)
	if err != nil {
		return storeErrResult(err)
	}
	return jsonResult(iss)
}

func jsonResult(v any) (*mcp.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal result: %w", err)
	}
	return mcp.NewToolResultText(string(b)), nil
}

func storeErrResult(err error) (*mcp.CallToolResult, error) {
	if errors.Is(err, store.ErrNotFound) {
		return mcp.NewToolResultError("not found"), nil
	}
	return mcp.NewToolResultError(err.Error()), nil
}

func mimeFromExt(path string) string {
	switch filepath.Ext(path) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	case ".md":
		return "text/markdown"
	case ".txt":
		return "text/plain"
	default:
		return "application/octet-stream"
	}
}

func defaultDBPath() string {
	executable, err := os.Executable()
	if err != nil {
		return filepath.Join("data", "loom.db")
	}
	return filepath.Join(filepath.Dir(executable), "data", "loom.db")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
