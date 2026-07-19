package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"devdeck/backend/internal/config"
	"devdeck/backend/internal/handler"
	"devdeck/backend/internal/lsp"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/netproxy"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/registry"
	"devdeck/backend/internal/selfupdate"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/sshmgr"
	"devdeck/backend/internal/store"
	"devdeck/backend/internal/terminal"
	"devdeck/backend/internal/version"
	"devdeck/backend/internal/webui"
)

func main() {
	showVersion := flag.Bool("version", false, "print the devdeck version and exit")
	updates := flag.Bool("updates", false, "check for and install the latest release, then exit; does not restart the server (requires -github-token / DEVDECK_GITHUB_TOKEN)")
	githubToken := flag.String("github-token", envOr("DEVDECK_GITHUB_TOKEN", ""), "GitHub token used to check for and download updates from the private release repo")
	envFile := flag.String("env", envOr("DEVDECK_ENV_FILE", ".env"), "path to a .env file to load (e.g. LLM API keys for the Tools module); missing file is not an error")
	addr := flag.String("addr", envOr("DEVDECK_ADDR", "127.0.0.1:8989"), "listen address")
	dbPath := flag.String("db", envOr("DEVDECK_DB", defaultDBPath()), "sqlite database path")
	jadiURL := flag.String("jadi", envOr("DEVDECK_JADI_URL", ""), "jadi backend URL (empty = static registry)")
	openUI := flag.Bool("open", true, "open the embedded UI in the default browser")
	onlyFrom := flag.String("only-from", envOr("DEVDECK_ONLY_FROM", ""), "comma-separated IPs/CIDRs allowed to access the server (empty = no restriction)")
	trustedProxies := flag.String("trusted-proxies", envOr("DEVDECK_TRUSTED_PROXIES", ""), "comma-separated proxy IPs/CIDRs whose forwarding headers are trusted when resolving the client IP")
	clientIPHeader := flag.String("client-ip-header", envOr("DEVDECK_CLIENT_IP_HEADER", ""), "trusted header carrying the real client IP, e.g. CF-Connecting-IP behind a Cloudflare Tunnel; only honored when the direct peer is in --trusted-proxies")
	twoFA := flag.Bool("2fa", envBool("DEVDECK_2FA", true), "require TOTP two-factor authentication for login (--2fa=false disables it)")
	secureCookiesFlag := flag.Bool("secure-cookies", envBool("DEVDECK_SECURE_COOKIES", true), "set the Secure attribute on auth cookies; disable only for loopback desktop deployments (--secure-cookies=false)")
	turnstileSiteKey := flag.String("turnstile-site-key", envOr("DEVDECK_TURNSTILE_SITE_KEY", ""), "Cloudflare Turnstile site key; with --turnstile-secret-key, login requires passing a Turnstile challenge")
	turnstileSecretKey := flag.String("turnstile-secret-key", envOr("DEVDECK_TURNSTILE_SECRET_KEY", ""), "Cloudflare Turnstile secret key used to verify login challenges server-side")
	pythonBin := flag.String("python-bin", envOr("DEVDECK_PYTHON_BIN", defaultPythonBin()), "python interpreter used to run the markitdown conversion script")
	pandocBin := flag.String("pandoc-bin", envOr("DEVDECK_PANDOC_BIN", "pandoc"), "pandoc binary used for markdown -> docx/pdf export")
	mmdcBin := flag.String("mmdc-bin", envOr("DEVDECK_MMDC_BIN", "mmdc"), "mermaid-cli binary used to render mermaid diagrams for markdown export")
	tailscaleServe := flag.Bool("enable-tailscale-serve", envBool("DEVDECK_TAILSCALE_SERVE", false), "expose the server on your tailnet by running `tailscale serve <port>` alongside it (requires the tailscale CLI)")
	role := flag.String("role", envOr("DEVDECK_ROLE", "hub"), "server role: hub (organizational data + machine registry + proxy + web UI), runtime (headless execution daemon, key auth only), or both (hub that also self-registers as its own execution machine, for solo self-hosting on a fixed address)")
	apiKey := flag.String("key", envOr("DEVDECK_KEY", ""), "static API key; required for --role runtime, optional bearer auth for --role hub (desktop clients)")
	hubURL := flag.String("hub-url", envOr("DEVDECK_HUB_URL", ""), "hub base URL this runtime should self-register with on startup; empty disables self-registration")
	hubKey := flag.String("hub-key", envOr("DEVDECK_HUB_KEY", ""), "hub's bearer key, used to authenticate this runtime's self-registration call; required if --hub-url is set")
	publicURL := flag.String("public-url", envOr("DEVDECK_PUBLIC_URL", ""), "this runtime's own reachable URL, advertised to the hub during self-registration (default: http://<--addr>)")
	machineName := flag.String("name", envOr("DEVDECK_MACHINE_NAME", ""), "display name for this machine in the hub's Machines UI during self-registration (default: OS hostname)")
	socks5Addr := flag.String("socks5-addr", envOr("DEVDECK_SOCKS5_ADDR", ""), "listen address for a SOCKS5 forward proxy (empty = disabled); point a browser's SOCKS5 setting here to route its traffic through this app")
	httpProxyAddr := flag.String("http-proxy-addr", envOr("DEVDECK_HTTP_PROXY_ADDR", ""), "listen address for an HTTP/HTTPS forward proxy (empty = disabled); point a browser's HTTP proxy setting here")
	proxyKey := flag.String("proxy-key", envOr("DEVDECK_PROXY_KEY", ""), "credential required by --socks5-addr/--http-proxy-addr (SOCKS5 password or HTTP Proxy-Authorization password, any username); empty = no auth")
	flag.Parse()

	if *showVersion {
		fmt.Println(version.Version)
		return
	}

	if *updates {
		if *githubToken == "" {
			log.Fatalf("--updates requires --github-token or DEVDECK_GITHUB_TOKEN")
		}
		execPath, err := os.Executable()
		if err != nil {
			log.Fatalf("--updates: resolve current executable path: %v", err)
		}
		client := &selfupdate.Client{
			Owner: selfupdate.Owner,
			Repo:  selfupdate.Repo,
			Token: *githubToken,
		}
		if err := selfupdate.Run(context.Background(), client, selfupdate.Options{
			CurrentVersion: version.Version,
			ExecPath:       execPath,
		}); err != nil {
			log.Fatalf("--updates: %v", err)
		}
		return
	}

	if *role != "hub" && *role != "runtime" && *role != "both" {
		log.Fatalf("--role must be \"hub\", \"runtime\", or \"both\", got %q", *role)
	}
	isRuntime := *role == "runtime"
	isBoth := *role == "both"
	if (isRuntime || isBoth) && *apiKey == "" {
		log.Fatalf("--role %s requires --key (or DEVDECK_KEY)", *role)
	}
	if isBoth {
		// --role both self-registers with itself: default the self-register
		// target to this same process unless the operator overrode it.
		if *hubURL == "" {
			*hubURL = "http://" + *addr
		}
		if *hubKey == "" {
			*hubKey = *apiKey
		}
	}
	if *hubURL != "" && *hubKey == "" {
		log.Fatalf("--hub-url requires --hub-key (or DEVDECK_HUB_KEY) to authenticate self-registration")
	}

	// publicURLWasDefaulted tracks whether the operator left --public-url
	// unset, so it can be recomputed after the listener binds (needed when
	// --addr uses port 0 and the OS assigns the real port — see Step 2).
	publicURLWasDefaulted := *publicURL == ""
	if publicURLWasDefaulted {
		*publicURL = "http://" + *addr
	}
	if *machineName == "" {
		if hostname, err := os.Hostname(); err == nil {
			*machineName = hostname
		} else {
			*machineName = "runtime"
		}
	}

	if applied, err := config.LoadDotEnv(*envFile); err != nil {
		log.Fatalf("--env %s: %v", *envFile, err)
	} else if applied > 0 {
		log.Printf("env: loaded %d variable(s) from %s", applied, *envFile)
	}

	allowNets, err := handler.ParseCIDRList(*onlyFrom)
	if err != nil {
		log.Fatalf("--only-from: %v", err)
	}
	proxyNets, err := handler.ParseCIDRList(*trustedProxies)
	if err != nil {
		log.Fatalf("--trusted-proxies: %v", err)
	}

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
	authSvc.SetTOTPRequired(*twoFA)
	if !*twoFA {
		log.Printf("auth: warning: TOTP two-factor authentication disabled (--2fa=false); logins complete with password only")
	}
	authH := handler.NewAuthHandler(authSvc)
	handler.SetSecureCookies(*secureCookiesFlag)
	if (*turnstileSiteKey == "") != (*turnstileSecretKey == "") {
		log.Fatalf("turnstile: --turnstile-site-key and --turnstile-secret-key must be set together")
	}
	if *turnstileSiteKey != "" {
		authH.SetTurnstile(service.NewTurnstileVerifier(*turnstileSiteKey, *turnstileSecretKey), proxyNets, *clientIPHeader)
		log.Printf("auth: Cloudflare Turnstile enabled for login")
	}

	if !isRuntime {
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
	}

	healthCache := service.NewMachineHealthCache()
	if !isRuntime {
		go healthCache.RunPoller(context.Background(), st, 15*time.Second)
	}

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
	wtSvc := service.NewWorktreeService(st, terminal.KillWorktreeSessions)
	agentSvc := service.NewAgentService(agentReg)
	seedSvc := service.NewSeedService(st)
	fileSvc := service.NewWorktreeFileService(st)
	gitSvc := service.NewWorktreeGitService(st)

	healthH := handler.NewHealthHandler()
	whoamiH := handler.NewWhoamiHandler(*role, *machineName)
	tailscaleStatusH := handler.NewTailscaleStatusHandler(*tailscaleServe)
	wsH := handler.NewWorkspaceHandler(wsSvc)
	pH := handler.NewProjectHandler(pSvc)
	wtH := handler.NewWorktreeHandler(wtSvc)
	agentH := handler.NewAgentHandler(agentSvc)
	fileH := handler.NewWorktreeFileHandler(fileSvc)
	gitH := handler.NewWorktreeGitHandler(gitSvc)
	todoH := handler.NewTodoHandler(st)
	invH := handler.NewInvoiceHandler(st)
	companyH := handler.NewCompanyHandler(st)
	bankH := handler.NewBankHandler(st)
	recH := handler.NewRecurringTemplateHandler(st)
	newsH := handler.NewNewsHandler(st)
	issueH := handler.NewIssueHandler(st)
	attH := handler.NewAttachmentHandler(st)
	commentH := handler.NewCommentHandler(st)
	eventH := handler.NewEventHandler(st)
	settingsH := handler.NewSettingsHandler(st)
	seedH := handler.NewSeedHandler(seedSvc)
	machineH := handler.NewMachineHandler(st, healthCache)

	sshSecrets := service.NewSSHSecretService(st, authKey)
	sshH := handler.NewSSHHandler(st, sshSecrets)
	sshDialer := sshmgr.NewDialer(st, sshSecrets)
	sshSrv := sshmgr.NewServer(sshDialer)
	sshFileSvc := service.NewSSHFileService(sshmgr.NewFilePool(sshDialer))
	sshFileH := handler.NewSSHFileHandler(sshFileSvc)

	dbSecrets := service.NewDBSecretService(st, authKey)
	dbH := handler.NewDBHandler(st, dbSecrets)

	termSrv := terminal.NewServer(st)
	termH := handler.NewTerminalHandler()
	lspSrv := lsp.NewServer(st)
	fsH := handler.NewFsHandler()

	toolsSvc, err := service.NewToolsService(service.ToolsConfig{
		PythonBin: *pythonBin,
		PandocBin: *pandocBin,
		MmdcBin:   *mmdcBin,
	})
	if err != nil {
		log.Fatalf("tools service: %v", err)
	}
	toolsH := handler.NewToolsHandler(toolsSvc)

	advertiseURL, err := url.Parse(*publicURL)
	if err != nil {
		log.Fatalf("--public-url: %v", err)
	}
	proxySvc := service.NewProxyService(advertiseURL.Hostname())
	proxyH := handler.NewProxyHandler(proxySvc)

	mux := http.NewServeMux()

	if !isRuntime {
		mux.HandleFunc("GET /api/auth/config", authH.GetConfig)
		mux.HandleFunc("POST /api/auth/register", authH.PostRegister)
		mux.HandleFunc("POST /api/auth/login", authH.PostLogin)
		mux.HandleFunc("POST /api/auth/totp/setup", authH.PostTotpSetup)
		mux.HandleFunc("POST /api/auth/totp/verify-setup", authH.PostTotpVerifySetup)
		mux.HandleFunc("POST /api/auth/totp/verify", authH.PostTotpVerify)
		mux.HandleFunc("POST /api/auth/logout", authH.PostLogout)
		mux.HandleFunc("GET /api/auth/me", authH.GetMe)
		if *apiKey != "" {
			authH.SetDesktopKey(*apiKey)
			mux.HandleFunc("POST /api/auth/key-session", authH.PostKeySession)
		}
	} else {
		// Runtimes have no password/TOTP flow: possession of --key is the
		// entire authorization, exchanged here for a session cookie so the
		// runtime's own web UI works in a browser.
		authH.SetDesktopKey(*apiKey)
		authH.SetSessionSameSite(http.SameSiteLaxMode)
		authH.SetSessionMaxAge(12 * time.Hour)
		mux.HandleFunc("POST /api/auth/key-session", authH.PostKeySession)
		mux.HandleFunc("POST /api/auth/logout", authH.PostLogout)
		mux.HandleFunc("GET /api/auth/me", authH.GetMe)
	}

	mux.HandleFunc("GET /api/health", healthH.ServeHTTP)
	mux.HandleFunc("GET /api/whoami", whoamiH.ServeHTTP)
	mux.HandleFunc("GET /api/tailscale-status", tailscaleStatusH.ServeHTTP)
	mux.HandleFunc("GET /api/fs/list", fsH.ListDir)
	mux.HandleFunc("POST /api/fs/mkdir", fsH.Mkdir)
	mux.HandleFunc("POST /api/fs/clone", fsH.Clone)

	mux.HandleFunc("GET /api/settings", settingsH.GetSettings)
	mux.HandleFunc("PUT /api/settings", settingsH.PutSettings)

	mux.HandleFunc("GET /api/workspaces", wsH.GetWorkspaces)
	mux.HandleFunc("POST /api/workspaces", wsH.PostWorkspace)
	mux.HandleFunc("PATCH /api/workspaces/{id}", wsH.PatchWorkspace)
	mux.HandleFunc("DELETE /api/workspaces/{id}", wsH.DeleteWorkspace)

	mux.HandleFunc("POST /api/workspaces/{wsId}/projects", pH.PostProject)
	mux.HandleFunc("POST /api/workspaces/{wsId}/projects/clone", pH.PostCloneProject)
	mux.HandleFunc("PATCH /api/projects/{id}", pH.PatchProject)
	mux.HandleFunc("DELETE /api/projects/{id}", pH.DeleteProject)
	mux.HandleFunc("GET /api/projects/{id}/branches", pH.GetProjectBranches)

	mux.HandleFunc("POST /api/projects/{projectId}/worktrees", wtH.PostWorktree)
	mux.HandleFunc("GET /api/projects/{projectId}/worktrees", wtH.ListWorktrees)
	mux.HandleFunc("PATCH /api/worktrees/{id}", wtH.PatchWorktree)
	mux.HandleFunc("DELETE /api/worktrees/{id}", wtH.DeleteWorktree)

	mux.HandleFunc("GET /api/worktrees/{id}/files", fileH.List)
	mux.HandleFunc("POST /api/worktrees/{id}/files/upload", fileH.Upload)
	mux.HandleFunc("POST /api/worktrees/{id}/files/delete", fileH.DeleteMany)
	mux.HandleFunc("POST /api/worktrees/{id}/files/zip", fileH.Archive)
	mux.HandleFunc("GET /api/worktrees/{id}/files/search", fileH.Search)
	mux.HandleFunc("GET /api/worktrees/{id}/file", fileH.Read)
	mux.HandleFunc("PUT /api/worktrees/{id}/file", fileH.Write)
	mux.HandleFunc("DELETE /api/worktrees/{id}/file", fileH.Delete)

	mux.HandleFunc("GET /api/worktrees/{id}/git/status", gitH.Status)
	mux.HandleFunc("GET /api/worktrees/{id}/git/diff", gitH.Diff)
	mux.HandleFunc("GET /api/worktrees/{id}/git/log", gitH.Log)
	mux.HandleFunc("POST /api/worktrees/{id}/git/stage", gitH.Stage)
	mux.HandleFunc("POST /api/worktrees/{id}/git/unstage", gitH.Unstage)
	mux.HandleFunc("POST /api/worktrees/{id}/git/discard", gitH.Discard)
	mux.HandleFunc("POST /api/worktrees/{id}/git/commit", gitH.Commit)
	mux.HandleFunc("POST /api/worktrees/{id}/git/push", gitH.Push)
	mux.HandleFunc("POST /api/worktrees/{id}/git/pull", gitH.Pull)

	mux.HandleFunc("POST /api/projects/{projectId}/issues", issueH.PostIssue)
	mux.HandleFunc("PATCH /api/issues/{id}", issueH.PatchIssue)
	mux.HandleFunc("DELETE /api/issues/{id}", issueH.DeleteIssue)

	mux.HandleFunc("POST /api/issues/{issueId}/attachments", attH.PostAttachment)
	mux.HandleFunc("GET /api/issues/{issueId}/attachments", attH.ListAttachments)
	mux.HandleFunc("GET /api/attachments/{id}", attH.GetAttachment)
	mux.HandleFunc("DELETE /api/attachments/{id}", attH.DeleteAttachment)

	mux.HandleFunc("POST /api/issues/{issueId}/comments", commentH.PostComment)
	mux.HandleFunc("GET /api/issues/{issueId}/comments", commentH.ListComments)
	mux.HandleFunc("PATCH /api/comments/{id}", commentH.PatchComment)
	mux.HandleFunc("DELETE /api/comments/{id}", commentH.DeleteComment)

	mux.HandleFunc("GET /api/issues/{issueId}/events", eventH.ListEvents)

	mux.HandleFunc("GET /api/agents", agentH.ListAgents)
	mux.HandleFunc("GET /api/agents/{agentId}", agentH.GetAgent)
	mux.HandleFunc("GET /api/agents/{agentId}/models", agentH.ListModels)
	mux.HandleFunc("GET /api/agents/{agentId}/skills", agentH.ListSkills)
	mux.HandleFunc("POST /api/agents/{agentId}/skills/{skillName}", agentH.InstallSkill)
	mux.HandleFunc("DELETE /api/agents/{agentId}/skills/{skillName}", agentH.RemoveSkill)
	mux.HandleFunc("GET /api/agents/{agentId}/skills/{skillName}/content", agentH.GetSkillContent)
	mux.HandleFunc("PUT /api/agents/{agentId}/skills/{skillName}/content", agentH.UpdateSkillContent)
	mux.HandleFunc("GET /api/agents/{agentId}/mcp-servers", agentH.ListMCPServers)
	mux.HandleFunc("POST /api/agents/{agentId}/mcp-servers", agentH.AddMCPServer)
	mux.HandleFunc("DELETE /api/agents/{agentId}/mcp-servers/{serverName}", agentH.RemoveMCPServer)

	mux.HandleFunc("GET /api/agents/{agentId}/env-profiles", agentH.ListEnvProfiles)
	mux.HandleFunc("POST /api/agents/{agentId}/env-profiles", agentH.CreateEnvProfile)
	mux.HandleFunc("GET /api/agents/{agentId}/env-profiles/{profileId}", agentH.GetEnvProfile)
	mux.HandleFunc("PATCH /api/agents/{agentId}/env-profiles/{profileId}", agentH.UpdateEnvProfile)
	mux.HandleFunc("DELETE /api/agents/{agentId}/env-profiles/{profileId}", agentH.DeleteEnvProfile)
	mux.HandleFunc("POST /api/agents/{agentId}/env-profiles/{profileId}/activate", agentH.ActivateEnvProfile)
	mux.HandleFunc("POST /api/agents/{agentId}/env-profiles/deactivate", agentH.DeactivateEnvProfile)
	mux.HandleFunc("POST /api/agents/{agentId}/env-profiles/fetch-models", agentH.FetchEnvProfileModels)
	mux.HandleFunc("GET /api/agents/{agentId}/settings-file", agentH.GetSettingsFile)
	mux.HandleFunc("PUT /api/agents/{agentId}/settings-file", agentH.UpdateSettingsFile)

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

	if !isRuntime {
		mux.HandleFunc("POST /api/seed", seedH.PostSeed)
	}

	if !isRuntime {
		mux.HandleFunc("GET /api/machines", machineH.GetMachines)
		mux.HandleFunc("POST /api/machines", machineH.PostMachine)
		mux.HandleFunc("PATCH /api/machines/{id}", machineH.PatchMachine)
		mux.HandleFunc("DELETE /api/machines/{id}", machineH.DeleteMachine)
		mux.HandleFunc("GET /api/machines/{id}/health", machineH.GetMachineHealth)
		mux.Handle("/api/machines/{id}/proxy/{rest...}", handler.NewMachineProxyHandler(st))

		// Catalog: a runtime pulls its own machine-scoped slice here, using
		// its own key (never the hub key). The nested mux is deliberate:
		// RequireMachineKey must wrap only this route, not the whole hub —
		// every other hub route authenticates by session cookie or hub key.
		catalogH := handler.NewCatalogHandler(st)
		catalogMux := http.NewServeMux()
		catalogMux.HandleFunc("GET /api/runtime/catalog", catalogH.GetCatalog)
		mux.Handle("GET /api/runtime/catalog", handler.RequireMachineKey(st)(catalogMux))

		// SSH connection registry — hub-scoped like the machine registry.
		mux.HandleFunc("GET /api/ssh/connections", sshH.GetConnections)
		mux.HandleFunc("POST /api/ssh/connections", sshH.PostConnection)
		mux.HandleFunc("PATCH /api/ssh/connections/{id}", sshH.PatchConnection)
		mux.HandleFunc("DELETE /api/ssh/connections/{id}", sshH.DeleteConnection)
		mux.HandleFunc("POST /api/ssh/connections/{id}/accept-hostkey", sshH.PostAcceptHostKey)

		// Phase 1 executes every SSH session on the hub itself;
		// ExecutorMachineID routing to runtimes is a later phase.
		mux.HandleFunc("/ws/ssh", sshSrv.HandleWS)

		// Remote file browser for a saved SSH connection, over SFTP — same
		// route shapes as the worktree file API above.
		mux.HandleFunc("GET /api/ssh/connections/{id}/files", sshFileH.List)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/upload", sshFileH.Upload)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/delete", sshFileH.DeleteMany)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/zip", sshFileH.Archive)
		mux.HandleFunc("GET /api/ssh/connections/{id}/files/search", sshFileH.Search)
		mux.HandleFunc("GET /api/ssh/connections/{id}/file", sshFileH.Read)
		mux.HandleFunc("PUT /api/ssh/connections/{id}/file", sshFileH.Write)
		mux.HandleFunc("DELETE /api/ssh/connections/{id}/file", sshFileH.Delete)

		// Database connection registry — hub-scoped like the SSH registry.
		// Execution endpoints arrive in phase 2; this phase is registry only.
		mux.HandleFunc("GET /api/db/connections", dbH.GetConnections)
		mux.HandleFunc("POST /api/db/connections", dbH.PostConnection)
		mux.HandleFunc("PATCH /api/db/connections/{id}", dbH.PatchConnection)
		mux.HandleFunc("DELETE /api/db/connections/{id}", dbH.DeleteConnection)
		mux.HandleFunc("POST /api/db/connections/{id}/secret", dbH.PostSecret)

		mux.HandleFunc("GET /api/db/connections/{id}/queries", dbH.GetSavedQueries)
		mux.HandleFunc("POST /api/db/connections/{id}/queries", dbH.PostSavedQuery)
		mux.HandleFunc("PATCH /api/db/queries/{qid}", dbH.PatchSavedQuery)
		mux.HandleFunc("DELETE /api/db/queries/{qid}", dbH.DeleteSavedQuery)
	}

	mux.HandleFunc("POST /api/tools/markitdown", toolsH.PostMarkitdown)
	mux.HandleFunc("POST /api/tools/markdown-export", toolsH.PostMarkdownExport)
	if !isRuntime {
		browserH := handler.NewBrowserProxyHandler(authSvc)
		mux.HandleFunc("GET /api/browser/session", browserH.GetSession)
		mux.HandleFunc("/api/browser/proxy", browserH.Proxy)
	}

	mux.HandleFunc("POST /api/proxy/start", proxyH.PostStart)

	mux.HandleFunc("/ws/terminal", termSrv.HandleWS)
	mux.HandleFunc("DELETE /api/terminal/sessions/{id}", termH.DeleteSession)
	mux.HandleFunc("/ws/lsp", lspSrv.HandleWS)
	mux.Handle("/", webui.Handler())

	var authMW func(http.Handler) http.Handler
	if isRuntime {
		authMW = handler.RequireRuntimeAuth(authSvc, *apiKey)
	} else {
		authMW = handler.RequireAuth(authSvc, *apiKey)
	}
	log.Printf("devdeck role: %s", *role)
	var root http.Handler = handler.CorsMiddleware(handler.JSONErrorMiddleware(authMW(mux)))
	if len(allowNets) > 0 {
		root = handler.OnlyFrom(allowNets, proxyNets, *clientIPHeader)(root)
		log.Printf("access: restricted to %s (--only-from)", *onlyFrom)
		if !handler.LoopbackAllowed(allowNets) {
			log.Printf("access: warning: loopback is not in the allowlist; local requests to this instance will be denied")
		}
	}
	if len(proxyNets) > 0 {
		log.Printf("access: trusting forwarding headers from proxies %s (--trusted-proxies)", *trustedProxies)
	}
	if *clientIPHeader != "" {
		if len(proxyNets) == 0 {
			log.Printf("access: warning: --client-ip-header %s is set but --trusted-proxies is empty, so the header will never be honored", *clientIPHeader)
		} else {
			log.Printf("access: resolving client IPs from %s (--client-ip-header)", *clientIPHeader)
		}
	}
	root = handler.AccessLog(proxyNets, *clientIPHeader)(root)

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen on %s: %v", *addr, err)
	}
	if publicURLWasDefaulted {
		// *addr may have used port 0 (OS-assigned); the flag-parse-time
		// default baked in the literal ":0", so recompute it now that the
		// OS has bound a real port. advertiseURL (used only for its
		// hostname, above) is unaffected by this — hostnames don't change
		// when a port is reassigned.
		*publicURL = "http://" + listener.Addr().String()
	}
	uiURL, err := browserURL(listener.Addr())
	if err != nil {
		log.Fatalf("resolve UI URL: %v", err)
	}
	// NOTE: the desktop shell (frontend/src-tauri/src/sidecar.rs) parses this
	// exact line to discover the bound port when launched with --addr 127.0.0.1:0.
	log.Printf("devdeck listening on %s (db: %s)", uiURL, *dbPath)
	if *tailscaleServe {
		if err := startTailscaleServe(listener.Addr()); err != nil {
			log.Fatalf("--enable-tailscale-serve: %v", err)
		}
	}
	if (isRuntime || isBoth) && *hubURL != "" {
		go func() {
			machineclient.RunSelfRegisterLoop(context.Background(), machineclient.SelfRegisterConfig{
				HubURL:    *hubURL,
				HubKey:    *hubKey,
				PublicURL: *publicURL,
				Name:      *machineName,
				Key:       *apiKey,
				IsLocal:   isBoth,
			}, 30*time.Second)

			// CRITICAL: only a pure runtime syncs. A --role both process is
			// its own hub, so `st` here IS the hub store — running the sync
			// loop against it would make ApplyCatalogSnapshot delete every
			// workspace and every project belonging to *other* machines,
			// then repopulate from a snapshot scoped to itself. That is
			// silent, permanent destruction of the hub's catalog. A both
			// process already has the truth locally and has nothing to pull.
			if !isRuntime {
				return
			}
			// Registration has now succeeded at least once, so the hub can
			// resolve this machine from its key. Only then can the catalog
			// pull authenticate.
			service.RunSyncLoop(context.Background(), st, service.SyncConfig{
				HubURL:     *hubURL,
				MachineKey: *apiKey,
			}, 30*time.Second)
		}()
		log.Printf("self-register: will register with hub %s as %q (%s)", *hubURL, *machineName, *publicURL)
	}
	if !isRuntime && *openUI && webui.Available() {
		openBrowserSoon(uiURL)
	}
	startForwardProxies(*socks5Addr, *httpProxyAddr, *proxyKey)
	if err := http.Serve(listener, root); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// startForwardProxies optionally starts the SOCKS5 and/or HTTP forward
// proxy listeners a browser can point its network settings at. Both are
// opt-in (empty addr = disabled) since they're separate TCP listeners
// with their own auth, not routes on the main API mux.
func startForwardProxies(socks5Addr, httpProxyAddr, proxyKey string) {
	if socks5Addr != "" {
		go func() {
			if err := netproxy.NewSOCKS5Server(proxyKey).ListenAndServe(socks5Addr); err != nil {
				log.Fatalf("socks5 proxy on %s: %v", socks5Addr, err)
			}
		}()
		log.Printf("socks5 proxy listening on %s", socks5Addr)
	}
	if httpProxyAddr != "" {
		go func() {
			srv := &http.Server{Addr: httpProxyAddr, Handler: netproxy.NewHTTPProxyHandler(proxyKey)}
			if err := srv.ListenAndServe(); err != nil {
				log.Fatalf("http proxy on %s: %v", httpProxyAddr, err)
			}
		}()
		log.Printf("http proxy listening on %s", httpProxyAddr)
	}
}

// startTailscaleServe runs `tailscale serve <port>` as a foreground child
// process: the serve config exists only while the child runs, so tailscaled
// is left clean when devdeck exits, and ctrl-c reaches both through the shared
// process group. The port comes from the bound listener, not --addr, so it
// is correct even for ":0".
func startTailscaleServe(addr net.Addr) error {
	_, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return fmt.Errorf("resolve listen port from %s: %w", addr, err)
	}
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		return fmt.Errorf("tailscale CLI not found in PATH; install it or drop the flag")
	}
	cmd := exec.Command(bin, "serve", port)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start tailscale serve: %w", err)
	}
	log.Printf("tailscale: serving port %s on your tailnet (pid %d)", port, cmd.Process.Pid)
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("tailscale serve exited: %v (devdeck keeps serving locally)", err)
			return
		}
		log.Printf("tailscale serve exited")
	}()
	return nil
}

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

func envBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		log.Fatalf("%s: invalid boolean %q", key, v)
	}
	return parsed
}

// defaultPythonBin prefers a local venv at ./tools/venv (see COMMANDS.md —
// `python3 -m venv tools/venv && tools/venv/bin/pip install "markitdown[all]" openai pymupdf4llm`),
// since markitdown can't be pip-installed into a system Python on most
// platforms. Falls back to whatever "python3" resolves to on PATH.
func defaultPythonBin() string {
	for _, candidate := range []string{
		filepath.Join("tools", "venv", "bin", "python3"),
		filepath.Join("tools", "venv", "Scripts", "python.exe"),
	} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return "python3"
}

// loadOrCreateAuthKey resolves the AES-256 key used to encrypt TOTP secrets
// at rest. DEVDECK_AUTH_KEY (base64, 32 bytes) takes precedence; otherwise a
// key is generated once and persisted beside the database, matching the
// app's zero-config local-app model (see defaultDBPath).
func loadOrCreateAuthKey(dbPath string) ([]byte, error) {
	if envKey := os.Getenv("DEVDECK_AUTH_KEY"); envKey != "" {
		key, err := base64.StdEncoding.DecodeString(envKey)
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("DEVDECK_AUTH_KEY must be a base64-encoded 32-byte key")
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
