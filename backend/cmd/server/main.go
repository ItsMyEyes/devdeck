package main

import (
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"loom/backend/internal/handler"
	"loom/backend/internal/port"
	"loom/backend/internal/registry"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
	"loom/backend/internal/terminal"
	"loom/backend/internal/webui"
)

func main() {
	addr := flag.String("addr", envOr("LOOM_ADDR", "127.0.0.1:8989"), "listen address")
	dbPath := flag.String("db", envOr("LOOM_DB", defaultDBPath()), "sqlite database path")
	jadiURL := flag.String("jadi", envOr("LOOM_JADI_URL", ""), "jadi backend URL (empty = static registry)")
	openUI := flag.Bool("open", true, "open the embedded UI in the default browser")
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

	authKey, err := loadOrCreateAuthKey(*dbPath)
	if err != nil {
		log.Fatalf("auth key: %v", err)
	}
	authSvc := service.NewAuthService(st, authKey)
	authH := handler.NewAuthHandler(authSvc)

	if generated, err := st.RunDueRecurringInvoices(); err != nil {
		log.Printf("recurring invoices: startup check failed: %v", err)
	} else if len(generated) > 0 {
		log.Printf("recurring invoices: generated %d draft invoice(s) on startup", len(generated))
	}

	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if generated, err := st.RunDueRecurringInvoices(); err != nil {
				log.Printf("recurring invoices: daily check failed: %v", err)
			} else if len(generated) > 0 {
				log.Printf("recurring invoices: generated %d draft invoice(s)", len(generated))
			}
		}
	}()

	var baseReg port.AgentRegistry
	if *jadiURL != "" {
		baseReg = registry.NewJadiRegistry(*jadiURL)
		log.Printf("agent registry: jadi (%s)", *jadiURL)
	} else {
		baseReg = registry.NewStaticRegistry()
		log.Println("agent registry: static (built-in)")
	}
	agentReg := registry.NewLocalRegistry(baseReg)

	wsSvc := service.NewWorkspaceService(st)
	pSvc := service.NewProjectService(st)
	wtSvc := service.NewWorktreeService(st, terminal.KillSession)
	agentSvc := service.NewAgentService(agentReg)
	seedSvc := service.NewSeedService(st)

	healthH := handler.NewHealthHandler()
	wsH := handler.NewWorkspaceHandler(wsSvc)
	pH := handler.NewProjectHandler(pSvc)
	wtH := handler.NewWorktreeHandler(wtSvc)
	agentH := handler.NewAgentHandler(agentSvc)
	todoH := handler.NewTodoHandler(st)
	invH := handler.NewInvoiceHandler(st)
	companyH := handler.NewCompanyHandler(st)
	bankH := handler.NewBankHandler(st)
	recH := handler.NewRecurringTemplateHandler(st)
	newsH := handler.NewNewsHandler(st)
	issueH := handler.NewIssueHandler(st)
	attH := handler.NewAttachmentHandler(st)
	settingsH := handler.NewSettingsHandler(st)
	seedH := handler.NewSeedHandler(seedSvc)

	termSrv := terminal.NewServer(st)
	fsH := handler.NewFsHandler()

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/auth/register", authH.PostRegister)
	mux.HandleFunc("POST /api/auth/login", authH.PostLogin)
	mux.HandleFunc("POST /api/auth/totp/setup", authH.PostTotpSetup)
	mux.HandleFunc("POST /api/auth/totp/verify-setup", authH.PostTotpVerifySetup)
	mux.HandleFunc("POST /api/auth/totp/verify", authH.PostTotpVerify)
	mux.HandleFunc("POST /api/auth/logout", authH.PostLogout)
	mux.HandleFunc("GET /api/auth/me", authH.GetMe)

	mux.HandleFunc("GET /api/health", healthH.ServeHTTP)
	mux.HandleFunc("GET /api/fs/list", fsH.ListDir)

	mux.HandleFunc("GET /api/settings", settingsH.GetSettings)
	mux.HandleFunc("PUT /api/settings", settingsH.PutSettings)

	mux.HandleFunc("GET /api/workspaces", wsH.GetWorkspaces)
	mux.HandleFunc("POST /api/workspaces", wsH.PostWorkspace)
	mux.HandleFunc("PATCH /api/workspaces/{id}", wsH.PatchWorkspace)
	mux.HandleFunc("DELETE /api/workspaces/{id}", wsH.DeleteWorkspace)

	mux.HandleFunc("POST /api/workspaces/{wsId}/projects", pH.PostProject)
	mux.HandleFunc("PATCH /api/projects/{id}", pH.PatchProject)
	mux.HandleFunc("DELETE /api/projects/{id}", pH.DeleteProject)
	mux.HandleFunc("GET /api/projects/{id}/branches", pH.GetProjectBranches)

	mux.HandleFunc("POST /api/projects/{projectId}/worktrees", wtH.PostWorktree)
	mux.HandleFunc("PATCH /api/worktrees/{id}", wtH.PatchWorktree)
	mux.HandleFunc("DELETE /api/worktrees/{id}", wtH.DeleteWorktree)

	mux.HandleFunc("POST /api/projects/{projectId}/issues", issueH.PostIssue)
	mux.HandleFunc("PATCH /api/issues/{id}", issueH.PatchIssue)
	mux.HandleFunc("DELETE /api/issues/{id}", issueH.DeleteIssue)

	mux.HandleFunc("POST /api/issues/{issueId}/attachments", attH.PostAttachment)
	mux.HandleFunc("GET /api/issues/{issueId}/attachments", attH.ListAttachments)
	mux.HandleFunc("GET /api/attachments/{id}", attH.GetAttachment)
	mux.HandleFunc("DELETE /api/attachments/{id}", attH.DeleteAttachment)

	mux.HandleFunc("GET /api/agents", agentH.ListAgents)
	mux.HandleFunc("GET /api/agents/{agentId}", agentH.GetAgent)
	mux.HandleFunc("GET /api/agents/{agentId}/models", agentH.ListModels)
	mux.HandleFunc("GET /api/agents/{agentId}/skills", agentH.ListSkills)

	mux.HandleFunc("POST /api/workspaces/{wsId}/todos", todoH.PostTodo)
	mux.HandleFunc("POST /api/workspaces/{wsId}/todos/clear-done", todoH.ClearDoneTodos)
	mux.HandleFunc("PATCH /api/todos/{id}", todoH.PatchTodo)
	mux.HandleFunc("DELETE /api/todos/{id}", todoH.DeleteTodo)

	mux.HandleFunc("POST /api/workspaces/{wsId}/invoices", invH.PostInvoice)
	mux.HandleFunc("PATCH /api/invoices/{id}", invH.PatchInvoice)
	mux.HandleFunc("DELETE /api/invoices/{id}", invH.DeleteInvoice)

	mux.HandleFunc("GET /api/companies", companyH.GetCompanies)
	mux.HandleFunc("POST /api/companies", companyH.PostCompany)
	mux.HandleFunc("PATCH /api/companies/{id}", companyH.PatchCompany)
	mux.HandleFunc("DELETE /api/companies/{id}", companyH.DeleteCompany)

	mux.HandleFunc("GET /api/banks", bankH.GetBanks)
	mux.HandleFunc("POST /api/banks", bankH.PostBank)
	mux.HandleFunc("PATCH /api/banks/{id}", bankH.PatchBank)
	mux.HandleFunc("DELETE /api/banks/{id}", bankH.DeleteBank)

	mux.HandleFunc("POST /api/workspaces/{wsId}/recurring-templates", recH.PostRecurringTemplate)
	mux.HandleFunc("PATCH /api/recurring-templates/{id}", recH.PatchRecurringTemplate)
	mux.HandleFunc("DELETE /api/recurring-templates/{id}", recH.DeleteRecurringTemplate)

	mux.HandleFunc("POST /api/workspaces/{wsId}/news", newsH.PostNews)
	mux.HandleFunc("POST /api/workspaces/{wsId}/news/read-all", newsH.ReadAllNews)
	mux.HandleFunc("PATCH /api/news/{id}", newsH.PatchNews)
	mux.HandleFunc("DELETE /api/news/{id}", newsH.DeleteNews)

	mux.HandleFunc("POST /api/seed", seedH.PostSeed)

	mux.HandleFunc("/ws/terminal", termSrv.HandleWS)
	mux.Handle("/", webui.Handler())

	root := handler.CorsMiddleware(handler.JSONErrorMiddleware(handler.RequireAuth(authSvc)(mux)))

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen on %s: %v", *addr, err)
	}
	uiURL, err := browserURL(listener.Addr())
	if err != nil {
		log.Fatalf("resolve UI URL: %v", err)
	}
	log.Printf("loom listening on %s (db: %s)", uiURL, *dbPath)
	if *openUI && webui.Available() {
		openBrowserSoon(uiURL)
	}
	if err := http.Serve(listener, root); err != nil {
		log.Fatalf("server: %v", err)
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

// loadOrCreateAuthKey resolves the AES-256 key used to encrypt TOTP secrets
// at rest. LOOM_AUTH_KEY (base64, 32 bytes) takes precedence; otherwise a
// key is generated once and persisted beside the database, matching the
// app's zero-config local-app model (see defaultDBPath).
func loadOrCreateAuthKey(dbPath string) ([]byte, error) {
	if envKey := os.Getenv("LOOM_AUTH_KEY"); envKey != "" {
		key, err := base64.StdEncoding.DecodeString(envKey)
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("LOOM_AUTH_KEY must be a base64-encoded 32-byte key")
		}
		return key, nil
	}
	keyPath := filepath.Join(filepath.Dir(dbPath), "auth.key")
	if data, err := os.ReadFile(keyPath); err == nil {
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("corrupt auth key file %s", keyPath)
		}
		return key, nil
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(key)), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}
