package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
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
	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/dbdriver/mysqldrv"
	"devdeck/backend/internal/dbdriver/pgdrv"
	"devdeck/backend/internal/dbdriver/sqlitedrv"
	"devdeck/backend/internal/detect"
	"devdeck/backend/internal/handler"
	"devdeck/backend/internal/hoststats"
	"devdeck/backend/internal/lsp"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/netproxy"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/registry"
	"devdeck/backend/internal/selfupdate"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/setupui"
	"devdeck/backend/internal/sshmgr"
	"devdeck/backend/internal/store"
	"devdeck/backend/internal/terminal"
	"devdeck/backend/internal/version"
	"devdeck/backend/internal/webui"

	"github.com/mattn/go-isatty"
)

func main() {
	// `devdeck setup` is a subcommand, not a flag, so it must be recognised and
	// removed before the flag package sees the arguments.
	args, wantSetup := stripSetupArg(os.Args)
	os.Args = args

	// devdeck.yaml supplies the default for almost every flag below, so it has
	// to be resolved first. --config and --managed are therefore read by hand
	// here, ahead of flag.Parse.
	explicitConfig, _ := stringFlagFromArgs(args, "config")
	if explicitConfig == "" {
		explicitConfig = os.Getenv(config.EnvVar)
	}
	cfg, configPath, err := config.Resolve(explicitConfig)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	managed := isManaged(args, os.Getenv("DEVDECK_MANAGED"))

	if wantSetup {
		runSetup(cfg, configPath)
		return
	}
	switch decideBoot(configPath, isTerminal(os.Stdin), isTerminal(os.Stdout), managed) {
	case bootWizard:
		runSetup(cfg, configPath)
		return
	case bootWriteDefaults:
		path := config.DefaultPath()
		if err := config.WriteDefaults(path); err != nil {
			log.Printf("config: could not write %s: %v (continuing with built-in defaults)", path, err)
		} else {
			log.Printf("config: wrote %s (defaults)", path)
		}
	}

	flag.String("config", explicitConfig, "path to devdeck.yaml; also DEVDECK_CONFIG (default: ./devdeck.yaml, then devdeck.yaml beside the binary)")
	showVersion := flag.Bool("version", false, "print the devdeck version and exit")
	// Every flag below resolves flag > env > devdeck.yaml > built-in default.
	// config.Pick / config.PickBool supply the YAML layer; passing them as the
	// flag's default is what makes an explicit flag outrank the file for free.
	updates := flag.Bool("updates", false, "check for and install the latest release, then exit; does not restart the server")
	githubToken := flag.String("github-token", envOr("DEVDECK_GITHUB_TOKEN", config.Pick(cfg.Updates.GitHubToken, "")), "GitHub token for update checks and downloads; only needed if the release repo is private or the unauthenticated API rate limit is a problem (devdeck.yaml: updates.github_token)")
	envFile := flag.String("env", envOr("DEVDECK_ENV_FILE", ".env"), "path to a .env file to load (e.g. LLM API keys for the Tools module); missing file is not an error")
	addr := flag.String("addr", envOr("DEVDECK_ADDR", config.Pick(cfg.Addr, "127.0.0.1:8989")), "listen address (devdeck.yaml: addr)")
	dbPath := flag.String("db", envOr("DEVDECK_DB", config.Pick(cfg.DB, defaultDBPath())), "sqlite database path (devdeck.yaml: db)")
	jadiURL := flag.String("jadi", envOr("DEVDECK_JADI_URL", ""), "jadi backend URL (empty = static registry)")
	openUI := flag.Bool("open", config.PickBool(cfg.Open, true), "open the embedded UI in the default browser (devdeck.yaml: open)")
	onlyFrom := flag.String("only-from", envOr("DEVDECK_ONLY_FROM", config.Pick(config.JoinList(cfg.Network.OnlyFrom), "")), "comma-separated IPs/CIDRs allowed to access the server (empty = no restriction) (devdeck.yaml: network.only_from)")
	trustedProxies := flag.String("trusted-proxies", envOr("DEVDECK_TRUSTED_PROXIES", config.Pick(config.JoinList(cfg.Network.TrustedProxies), "")), "comma-separated proxy IPs/CIDRs whose forwarding headers are trusted when resolving the client IP (devdeck.yaml: network.trusted_proxies)")
	clientIPHeader := flag.String("client-ip-header", envOr("DEVDECK_CLIENT_IP_HEADER", config.Pick(cfg.Network.ClientIPHeader, "")), "trusted header carrying the real client IP, e.g. CF-Connecting-IP behind a Cloudflare Tunnel; only honored when the direct peer is in --trusted-proxies (devdeck.yaml: network.client_ip_header)")
	twoFA := flag.Bool("2fa", envBool("DEVDECK_2FA", config.PickBool(cfg.Auth.TwoFA, true)), "require TOTP two-factor authentication for login (--2fa=false disables it) (devdeck.yaml: auth.two_fa)")
	secureCookiesFlag := flag.Bool("secure-cookies", envBool("DEVDECK_SECURE_COOKIES", config.PickBool(cfg.Auth.SecureCookies, true)), "set the Secure attribute on auth cookies; disable only for loopback desktop deployments (--secure-cookies=false) (devdeck.yaml: auth.secure_cookies)")
	turnstileSiteKey := flag.String("turnstile-site-key", envOr("DEVDECK_TURNSTILE_SITE_KEY", config.Pick(cfg.Auth.Turnstile.SiteKey, "")), "Cloudflare Turnstile site key; with --turnstile-secret-key, login requires passing a Turnstile challenge (devdeck.yaml: auth.turnstile.site_key)")
	turnstileSecretKey := flag.String("turnstile-secret-key", envOr("DEVDECK_TURNSTILE_SECRET_KEY", config.Pick(cfg.Auth.Turnstile.SecretKey, "")), "Cloudflare Turnstile secret key used to verify login challenges server-side (devdeck.yaml: auth.turnstile.secret_key)")
	pythonBin := flag.String("python-bin", envOr("DEVDECK_PYTHON_BIN", config.Pick(cfg.Tools.PythonBin, defaultPythonBin())), "python interpreter used to run the markitdown conversion script (devdeck.yaml: tools.python_bin)")
	pandocBin := flag.String("pandoc-bin", envOr("DEVDECK_PANDOC_BIN", config.Pick(cfg.Tools.PandocBin, "pandoc")), "pandoc binary used for markdown -> docx/pdf export (devdeck.yaml: tools.pandoc_bin)")
	mmdcBin := flag.String("mmdc-bin", envOr("DEVDECK_MMDC_BIN", config.Pick(cfg.Tools.MmdcBin, "mmdc")), "mermaid-cli binary used to render mermaid diagrams for markdown export (devdeck.yaml: tools.mmdc_bin)")
	tailscaleServe := flag.Bool("enable-tailscale-serve", envBool("DEVDECK_TAILSCALE_SERVE", config.PickBool(cfg.Tailscale.Serve, false)), "expose the server on your tailnet by running `tailscale serve <port>` alongside it (requires the tailscale CLI) (devdeck.yaml: tailscale.serve)")
	managedFlag := flag.Bool("managed", managed, "mark this process as supervised by an external respawn loop (set by the Tauri desktop sidecar) — /api/self/restart won't spawn its own replacement, and /api/self/stop will refuse, since the supervisor already owns this process's respawn lifecycle")
	role := flag.String("role", envOr("DEVDECK_ROLE", config.Pick(cfg.Role, "hub")), "server role: hub (organizational data + machine registry + proxy + web UI), runtime (headless execution daemon, key auth only), or both (hub that also self-registers as its own execution machine, for solo self-hosting on a fixed address) (devdeck.yaml: role)")
	apiKey := flag.String("key", envOr("DEVDECK_KEY", config.Pick(cfg.Key, "")), "static API key; required for --role runtime, optional bearer auth for --role hub (desktop clients) (devdeck.yaml: key)")
	signInPIN := flag.String("pin", envOr("DEVDECK_PIN", ""), "6-digit sign-in PIN for this runtime's own web UI (--role runtime only); omit to keep the stored PIN, which is generated and logged on first start")
	hubURL := flag.String("hub-url", envOr("DEVDECK_HUB_URL", config.Pick(cfg.Hub.URL, "")), "hub base URL this runtime should self-register with on startup; empty disables self-registration (devdeck.yaml: hub.url)")
	hubKey := flag.String("hub-key", envOr("DEVDECK_HUB_KEY", config.Pick(cfg.Hub.Key, "")), "hub's bearer key, used to authenticate this runtime's self-registration call; required if --hub-url is set (devdeck.yaml: hub.key)")
	publicURL := flag.String("public-url", envOr("DEVDECK_PUBLIC_URL", config.Pick(cfg.Machine.PublicURL, "")), "this runtime's own reachable URL, advertised to the hub during self-registration (default: http://<--addr>) (devdeck.yaml: machine.public_url)")
	machineName := flag.String("name", envOr("DEVDECK_MACHINE_NAME", config.Pick(cfg.Machine.Name, "")), "display name for this machine in the hub's Machines UI during self-registration (default: OS hostname) (devdeck.yaml: machine.name)")
	socks5Addr := flag.String("socks5-addr", envOr("DEVDECK_SOCKS5_ADDR", config.Pick(cfg.Proxy.Socks5Addr, "")), "listen address for a SOCKS5 forward proxy (empty = disabled); point a browser's SOCKS5 setting here to route its traffic through this app (devdeck.yaml: proxy.socks5_addr)")
	httpProxyAddr := flag.String("http-proxy-addr", envOr("DEVDECK_HTTP_PROXY_ADDR", config.Pick(cfg.Proxy.HTTPAddr, "")), "listen address for an HTTP/HTTPS forward proxy (empty = disabled); point a browser's HTTP proxy setting here (devdeck.yaml: proxy.http_addr)")
	proxyKey := flag.String("proxy-key", envOr("DEVDECK_PROXY_KEY", config.Pick(cfg.Proxy.Key, "")), "credential required by --socks5-addr/--http-proxy-addr (SOCKS5 password or HTTP Proxy-Authorization password, any username); empty = no auth (devdeck.yaml: proxy.key)")
	flag.Parse()
	managed = *managedFlag

	if *showVersion {
		fmt.Println(version.Version)
		return
	}

	if *updates {
		execPath, err := os.Executable()
		if err != nil {
			log.Fatalf("--updates: resolve current executable path: %v", err)
		}
		client := &selfupdate.Client{
			Owner: selfupdate.Owner,
			Repo:  selfupdate.Repo,
			Token: *githubToken,
		}
		res, err := selfupdate.Run(context.Background(), client, selfupdate.Options{
			CurrentVersion: version.Version,
			ExecPath:       execPath,
		})
		if err != nil {
			log.Fatalf("--updates: %v", err)
		}
		if res.Warning != "" {
			log.Printf("warning: %s", res.Warning)
		}
		if !res.Updated {
			log.Printf("already on latest version %s", version.Version)
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
	signingKey, err := loadOrCreateSigningKey(*dbPath)
	if err != nil {
		log.Fatalf("signing key: %v", err)
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

	// The sign-in PIN is a runtime-only credential: it exists so an operator
	// can get into a runtime's own web UI without pasting the runtime key,
	// and a hub authenticates its operators with password + TOTP instead.
	var pinSvc *service.PINService
	if isRuntime {
		pinSvc = service.NewPINService(st)
		if *signInPIN != "" {
			if err := pinSvc.Set(*signInPIN); err != nil {
				log.Fatalf("--pin: %v", err)
			}
			log.Printf("auth: sign-in PIN set from --pin")
		} else if generated, err := pinSvc.EnsureSeeded(); err != nil {
			log.Fatalf("sign-in pin: %v", err)
		} else if generated != "" {
			// Printed once, at the only moment it is recoverable: the stored
			// form is a bcrypt hash. Mirrors how the runtime key is already
			// visible to anyone who can read this process's argv. Deliberately
			// carries no URL — --addr may still be port 0 here, with the real
			// port assigned when the listener binds much further down.
			log.Printf("auth: generated sign-in PIN %s — enter it on this runtime's /runtime-sign-in page; change it from the hub's Runtimes page or this runtime's settings", generated)
		}
	} else if *signInPIN != "" {
		log.Printf("auth: warning: --pin is ignored on --role %s; the sign-in PIN only applies to a runtime's own web UI", *role)
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

	var wsSvc *service.WorkspaceService
	if isRuntime {
		wsSvc = service.NewWorkspaceServiceForRuntime(st)
	} else {
		wsSvc = service.NewWorkspaceService(st)
	}
	var pSvc *service.ProjectService
	if isRuntime {
		pSvc = service.NewProjectServiceForRuntime(st)
	} else {
		pSvc = service.NewProjectService(st)
	}
	lspSrv := lsp.NewServer(st)
	wtSvc := service.NewWorktreeService(st, terminal.KillWorktreeSessions, lspSrv.WarmInstall)
	agentSvc := service.NewAgentService(agentReg)
	seedSvc := service.NewSeedService(st)
	fileSvc := service.NewWorktreeFileService(st)
	gitSvc := service.NewWorktreeGitService(st)

	healthH := handler.NewHealthHandler()
	var whoamiStore port.Store
	if isRuntime {
		whoamiStore = st
	}
	whoamiH := handler.NewWhoamiHandler(*role, *machineName, whoamiStore, *hubURL, "")
	tailscaleStatusH := handler.NewTailscaleStatusHandler(*tailscaleServe)
	lspDepsH := handler.NewLspDepsHandler(lspSrv.Installer())
	updater := &selfupdate.Updater{Client: &selfupdate.Client{
		Owner: selfupdate.Owner,
		Repo:  selfupdate.Repo,
		Token: *githubToken,
	}}
	selfH := handler.NewSelfHandler(managed, version.Version, *githubToken != "", updater)
	hubKeyH := handler.NewHubKeyHandler(*apiKey)
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
	machineH := handler.NewMachineHandler(st, healthCache, authSvc, signingKey)
	bookmarkH := handler.NewBookmarkHandler(st, service.NewFaviconService(st))

	sshSecrets := service.NewSSHSecretService(st, authKey)
	sshH := handler.NewSSHHandler(st, sshSecrets)
	// One dialer backs both the interactive shell and the SFTP file API, so
	// enabling ExecutorMachineID routing here routes both: every file
	// operation rides the same *ssh.Client the shell does.
	sshDialer := sshmgr.NewDialer(st, sshSecrets).
		WithExecutorRouting(st, machineclient.SOCKSProxyStarter{})
	sshSrv := sshmgr.NewServer(sshDialer)
	// One FilePool backs both SFTP file ops and stats polling, so a saved
	// connection's SSH client is cached once instead of dialed twice.
	sshFilePool := sshmgr.NewFilePool(sshDialer)
	sshFileSvc := service.NewSSHFileService(sshFilePool)
	sshFileH := handler.NewSSHFileHandler(sshFileSvc)
	sshStatsSvc := service.NewSSHStatsService(sshFilePool)
	sshStatsH := handler.NewSSHStatsHandler(sshStatsSvc)

	dbSecrets := service.NewDBSecretService(st, authKey)
	dbH := handler.NewDBHandler(st, dbSecrets)

	// Drivers are registered here rather than from an init(), so the set of
	// enabled engines is explicit and the registry is populated before
	// GET /api/db/engines can be served from it.
	dbdriver.Register("sqlite", sqlitedrv.New())
	dbdriver.Register("postgres", pgdrv.New())
	dbdriver.Register("mysql", mysqldrv.New())

	dbExecSvc := service.NewDBExecService(st, dbSecrets)
	dbExecH := handler.NewDBExecHandler(dbExecSvc)

	termSrv := terminal.NewServer(st)
	termH := handler.NewTerminalHandler()
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
	publishedSOCKSSvc := service.NewPublishedSOCKSService(st, advertiseURL.Hostname())
	publishedSOCKSH := handler.NewPublishedSOCKSHandler(publishedSOCKSSvc)
	systemStatsH := handler.NewSystemStatsHandler(hoststats.NewCollector())

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
		// Runtimes have no password/TOTP flow. --key remains the whole
		// machine-to-machine authorization (it is what the hub proxies with),
		// but a human is not expected to paste 64 hex characters into a phone:
		// the browser sign-in page takes a 6-digit PIN instead, exchanged
		// below for the same session cookie the key would have minted.
		authH.SetDesktopKey(*apiKey)
		authH.SetSessionSameSite(http.SameSiteLaxMode)
		authH.SetSessionMaxAge(12 * time.Hour)
		authH.SetClientIPResolution(proxyNets, *clientIPHeader)
		mux.HandleFunc("POST /api/auth/key-session", authH.PostKeySession)
		mux.HandleFunc("POST /api/auth/pin-session", authH.PostPINSession)
		mux.HandleFunc("POST /api/auth/logout", authH.PostLogout)
		mux.HandleFunc("GET /api/auth/me", authH.GetMe)
	}

	// Registered on every role, but backed by a PIN service only on a runtime
	// (SetPINService(nil) elsewhere, which makes both handlers answer a clean
	// 404). A hub operator can point the "Set sign-in PIN" action at any
	// machine in the registry — including a --role both process that is this
	// hub — and an unregistered route would fall through to the SPA handler
	// and answer HTML, which the client cannot parse into an error.
	authH.SetPINService(pinSvc)
	mux.HandleFunc("GET /api/auth/pin", authH.GetPIN)
	mux.HandleFunc("PUT /api/auth/pin", authH.PutPIN)

	mux.HandleFunc("GET /api/health", healthH.ServeHTTP)
	mux.HandleFunc("GET /api/whoami", whoamiH.ServeHTTP)
	mux.HandleFunc("GET /api/tailscale-status", tailscaleStatusH.ServeHTTP)
	// Deliberately in the shared block, not the hub-only one: each machine
	// must report its own toolchain, and the hub reaches a runtime's copy
	// through /api/machines/{id}/proxy/.
	mux.HandleFunc("GET /api/lsp/deps", lspDepsH.GetDeps)
	mux.HandleFunc("POST /api/lsp/deps/install", lspDepsH.PostInstall)
	mux.HandleFunc("GET /api/lsp/trace", lspDepsH.GetTrace)
	mux.HandleFunc("DELETE /api/lsp/trace", lspDepsH.DeleteTrace)
	mux.HandleFunc("POST /api/self/restart", selfH.PostRestart)
	mux.HandleFunc("POST /api/self/stop", selfH.PostStop)
	mux.HandleFunc("GET /api/self/version", selfH.GetVersion)
	mux.HandleFunc("GET /api/self/update-check", selfH.GetUpdateCheck)
	mux.HandleFunc("POST /api/self/update", selfH.PostUpdate)
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
	mux.HandleFunc("POST /api/worktrees/{id}/files/extract", fileH.Extract)
	mux.HandleFunc("GET /api/worktrees/{id}/files/download", fileH.Download)
	mux.HandleFunc("GET /api/worktrees/{id}/files/search", fileH.Search)
	mux.HandleFunc("GET /api/worktrees/{id}/files/grep", fileH.Grep)
	mux.HandleFunc("POST /api/worktrees/{id}/files/grep/install-ripgrep", fileH.InstallRipgrep)
	mux.HandleFunc("GET /api/worktrees/{id}/file", fileH.Read)
	mux.HandleFunc("PUT /api/worktrees/{id}/file", fileH.Write)
	mux.HandleFunc("DELETE /api/worktrees/{id}/file", fileH.Delete)
	mux.HandleFunc("POST /api/worktrees/{id}/files/mkdir", fileH.Mkdir)
	mux.HandleFunc("POST /api/worktrees/{id}/files/move", fileH.Move)
	mux.HandleFunc("POST /api/worktrees/{id}/files/copy", fileH.Copy)

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
		// Hub-only: a runtime has no hub key to hand out. Lives with the
		// machines routes because its only consumer is the Add-runtime
		// dialog. Not in RequireAuth's publicPaths, so it stays behind the
		// session-cookie/bearer-key check.
		mux.HandleFunc("GET /api/self/hub-key", hubKeyH.ServeHTTP)

		mux.HandleFunc("GET /api/machines", machineH.GetMachines)
		mux.HandleFunc("POST /api/machines", machineH.PostMachine)
		mux.HandleFunc("PATCH /api/machines/{id}", machineH.PatchMachine)
		mux.HandleFunc("DELETE /api/machines/{id}", machineH.DeleteMachine)
		mux.HandleFunc("GET /api/machines/{id}/health", machineH.GetMachineHealth)
		mux.HandleFunc("POST /api/machines/{id}/token", machineH.PostToken)
		mux.HandleFunc("POST /api/machines/{id}/restart", machineH.PostMachineRestart)
		mux.HandleFunc("POST /api/machines/{id}/stop", machineH.PostMachineStop)
		mux.HandleFunc("GET /api/machines/{id}/version", machineH.GetMachineVersion)
		mux.HandleFunc("GET /api/machines/{id}/update-check", machineH.GetMachineUpdateCheck)
		mux.HandleFunc("POST /api/machines/{id}/update", machineH.PostMachineUpdate)
		mux.Handle("/api/machines/{id}/proxy/{rest...}", handler.NewMachineProxyHandler(st))

		mux.HandleFunc("GET /api/bookmarks", bookmarkH.GetBookmarks)
		mux.HandleFunc("POST /api/bookmarks", bookmarkH.PostBookmark)
		mux.HandleFunc("PATCH /api/bookmarks/{id}", bookmarkH.PatchBookmark)
		mux.HandleFunc("DELETE /api/bookmarks/{id}", bookmarkH.DeleteBookmark)

		// Catalog: a runtime pulls its own machine-scoped slice here, using
		// its own key (never the hub key). The nested mux is deliberate:
		// RequireMachineKey must wrap only this route, not the whole hub —
		// every other hub route authenticates by session cookie or hub key.
		catalogSvc := service.NewCatalogService(st)
		catalogH := handler.NewCatalogHandler(st, catalogSvc)
		catalogMux := http.NewServeMux()
		catalogMux.HandleFunc("GET /api/runtime/catalog", catalogH.GetCatalog)
		catalogMux.HandleFunc("POST /api/runtime/projects", catalogH.PostProject)
		mux.Handle("GET /api/runtime/catalog", handler.RequireMachineKey(st)(catalogMux))
		mux.Handle("POST /api/runtime/projects", handler.RequireMachineKey(st)(catalogMux))

		// SSH connection registry — hub-scoped like the machine registry.
		mux.HandleFunc("GET /api/ssh/connections", sshH.GetConnections)
		mux.HandleFunc("POST /api/ssh/connections", sshH.PostConnection)
		mux.HandleFunc("PATCH /api/ssh/connections/{id}", sshH.PatchConnection)
		mux.HandleFunc("DELETE /api/ssh/connections/{id}", sshH.DeleteConnection)
		mux.HandleFunc("POST /api/ssh/connections/{id}/accept-hostkey", sshH.PostAcceptHostKey)

		// The socket is served here, but the TCP dial underneath it originates
		// from the connection's ExecutorMachineID when one is set — see
		// sshmgr/executor.go. Terminal-style direct-first client routing is
		// deliberately not used: the hub holds the credentials, so it stays the
		// endpoint and only the outbound dial moves.
		mux.HandleFunc("/ws/ssh", sshSrv.HandleWS)

		// Remote file browser for a saved SSH connection, over SFTP — same
		// route shapes as the worktree file API above.
		mux.HandleFunc("GET /api/ssh/connections/{id}/files", sshFileH.List)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/upload", sshFileH.Upload)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/delete", sshFileH.DeleteMany)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/zip", sshFileH.Archive)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/extract", sshFileH.Extract)
		mux.HandleFunc("GET /api/ssh/connections/{id}/files/download", sshFileH.Download)
		mux.HandleFunc("GET /api/ssh/connections/{id}/files/search", sshFileH.Search)
		mux.HandleFunc("GET /api/ssh/connections/{id}/files/grep", sshFileH.Grep)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/grep/install-ripgrep", sshFileH.InstallRipgrep)
		mux.HandleFunc("GET /api/ssh/connections/{id}/file", sshFileH.Read)
		mux.HandleFunc("PUT /api/ssh/connections/{id}/file", sshFileH.Write)
		mux.HandleFunc("DELETE /api/ssh/connections/{id}/file", sshFileH.Delete)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/mkdir", sshFileH.Mkdir)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/move", sshFileH.Move)
		mux.HandleFunc("POST /api/ssh/connections/{id}/files/copy", sshFileH.Copy)

		// Live CPU/memory/disk for a saved SSH connection, polled the same way
		// the local host stats route is.
		mux.HandleFunc("GET /api/ssh/connections/{id}/stats", sshStatsH.Get)

		// Database connection registry — hub-scoped like the SSH registry.
		mux.HandleFunc("GET /api/db/connections", dbH.GetConnections)
		mux.HandleFunc("POST /api/db/connections", dbH.PostConnection)
		mux.HandleFunc("PATCH /api/db/connections/{id}", dbH.PatchConnection)
		mux.HandleFunc("DELETE /api/db/connections/{id}", dbH.DeleteConnection)
		mux.HandleFunc("POST /api/db/connections/{id}/secret", dbH.PostSecret)

		mux.HandleFunc("GET /api/db/connections/{id}/queries", dbH.GetSavedQueries)
		mux.HandleFunc("POST /api/db/connections/{id}/queries", dbH.PostSavedQuery)
		mux.HandleFunc("PATCH /api/db/queries/{qid}", dbH.PatchSavedQuery)
		mux.HandleFunc("DELETE /api/db/queries/{qid}", dbH.DeleteSavedQuery)

		// SQL editor execution history. Recorded hub-side by PostQuery for
		// both hub-local and runtime-forwarded execution.
		mux.HandleFunc("GET /api/db/connections/{id}/history", dbH.GetQueryHistory)
		mux.HandleFunc("DELETE /api/db/connections/{id}/history", dbH.DeleteQueryHistory)

		// Read path. Each of these executes on the hub, or forwards the
		// connection's descriptor to its executor runtime, transparently.
		mux.HandleFunc("GET /api/db/engines", dbExecH.GetEngines)
		mux.HandleFunc("POST /api/db/connections/{id}/test", dbExecH.PostTest)
		mux.HandleFunc("POST /api/db/connections/{id}/tree", dbExecH.PostTree)
		mux.HandleFunc("POST /api/db/connections/{id}/columns", dbExecH.PostColumns)
		mux.HandleFunc("POST /api/db/connections/{id}/stats", dbExecH.PostStats)
		mux.HandleFunc("POST /api/db/connections/{id}/count", dbExecH.PostCount)
		mux.HandleFunc("POST /api/db/connections/{id}/rows", dbExecH.PostRows)
		mux.HandleFunc("POST /api/db/connections/{id}/lob", dbExecH.PostLOB)
		mux.HandleFunc("POST /api/db/connections/{id}/query", dbExecH.PostQuery)
		mux.HandleFunc("POST /api/db/connections/{id}/indexes", dbExecH.PostIndexes)
		mux.HandleFunc("POST /api/db/connections/{id}/commit", dbExecH.PostCommit)
		mux.HandleFunc("POST /api/db/connections/{id}/ddl/preview", dbExecH.PostDDLPreview)
		mux.HandleFunc("POST /api/db/connections/{id}/ddl/apply", dbExecH.PostDDLApply)
		mux.HandleFunc("POST /api/db/connections/{id}/show-create", dbExecH.PostShowCreate)

		// Bulk export. Streams its body instead of writing one JSON document,
		// so it pages through the same read path the grid uses.
		mux.HandleFunc("POST /api/db/connections/{id}/export", dbExecH.PostExport)
	}

	// Runtime execution endpoints. These accept a descriptor carrying
	// decrypted credentials, so they must never be reachable unauthenticated:
	// on --role runtime the key-auth middleware covers every path but
	// /api/health, and on a hub they sit behind the session cookie or hub key
	// like every other route here.
	mux.HandleFunc("POST /api/db/introspect", dbExecH.RuntimeIntrospect)
	mux.HandleFunc("POST /api/db/exec", dbExecH.RuntimeExec)
	mux.HandleFunc("POST /api/db/close", dbExecH.RuntimeClose)

	mux.HandleFunc("POST /api/tools/markitdown", toolsH.PostMarkitdown)
	mux.HandleFunc("POST /api/tools/markdown-export", toolsH.PostMarkdownExport)
	if !isRuntime {
		browserH := handler.NewBrowserProxyHandler(authSvc)
		mux.HandleFunc("GET /api/browser/session", browserH.GetSession)
		mux.HandleFunc("/api/browser/proxy", browserH.Proxy)
	}

	mux.HandleFunc("POST /api/proxy/start", proxyH.PostStart)

	// Every role: this is how a runtime reports its own load.
	mux.HandleFunc("GET /api/system/stats", systemStatsH.Get)

	// Registered on every role: publishing a proxy from a runtime (to reach
	// that machine's network from elsewhere) is the primary use case.
	mux.HandleFunc("GET /api/proxy/publish", publishedSOCKSH.Get)
	mux.HandleFunc("PUT /api/proxy/publish", publishedSOCKSH.Put)

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

	// Retried rather than bound outright: during a restart this process races
	// the one it replaces for the port. See listenRetryWindow.
	listener, err := listenWithRetry("tcp", *addr, listenRetryWindow)
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
			self, registered := machineclient.RunSelfRegisterLoop(context.Background(), machineclient.SelfRegisterConfig{
				HubURL:    *hubURL,
				HubKey:    *hubKey,
				PublicURL: *publicURL,
				Name:      *machineName,
				Key:       *apiKey,
				IsLocal:   isBoth,
			}, 30*time.Second)
			if registered {
				whoamiH.SetMachineID(self.ID)
				if pub, err := base64.StdEncoding.DecodeString(self.SigningPublicKey); err == nil && len(pub) == ed25519.PublicKeySize {
					handler.SetRuntimeIdentity(self.ID, ed25519.PublicKey(pub))
				} else {
					log.Printf("self-register: hub did not return a usable signing public key; SSO handover tokens will fail verification until this runtime re-registers")
				}
			}

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
	// Replay this machine's stored publication. Never fatal, unlike
	// startForwardProxies: that config is operator-typed at launch, whereas
	// this is replayed automatically, so a since-taken port must not stop
	// the server from booting.
	if err := publishedSOCKSSvc.StartIfEnabled(); err != nil {
		log.Printf("published socks5 proxy: %v", err)
	}
	if err := http.Serve(listener, root); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// startForwardProxies optionally starts the SOCKS5 and/or HTTP forward
// proxy listeners a browser can point its network settings at. Both are
// opt-in (empty addr = disabled) since they're separate TCP listeners
// with their own auth, not routes on the main API mux.
func startForwardProxies(socks5Addr, httpProxyAddr, proxyKey string) {
	// Both bind through listenWithRetry for the same reason the main listener
	// does: a restart overlaps the process being replaced, and these ports are
	// held just as long as the main one. Losing that race here is fatal to the
	// whole server, not just the proxy, so a configured proxy would otherwise
	// re-break every restart. Binding happens here rather than inside the
	// goroutine so a real conflict is reported before startup continues.
	if socks5Addr != "" {
		ln, err := listenWithRetry("tcp", socks5Addr, listenRetryWindow)
		if err != nil {
			log.Fatalf("socks5 proxy on %s: %v", socks5Addr, err)
		}
		go func() {
			if err := netproxy.NewSOCKS5Server(proxyKey).Serve(ln); err != nil {
				log.Fatalf("socks5 proxy on %s: %v", socks5Addr, err)
			}
		}()
		log.Printf("socks5 proxy listening on %s", ln.Addr())
	}
	if httpProxyAddr != "" {
		ln, err := listenWithRetry("tcp", httpProxyAddr, listenRetryWindow)
		if err != nil {
			log.Fatalf("http proxy on %s: %v", httpProxyAddr, err)
		}
		go func() {
			srv := &http.Server{Handler: netproxy.NewHTTPProxyHandler(proxyKey)}
			if err := srv.Serve(ln); err != nil {
				log.Fatalf("http proxy on %s: %v", httpProxyAddr, err)
			}
		}()
		log.Printf("http proxy listening on %s", ln.Addr())
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
	bin, err := detect.ResolveTailscale()
	if err != nil {
		return fmt.Errorf("tailscale CLI not found in PATH or common install locations; install it or drop the flag")
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

// setupSubcommand is the one subcommand devdeck accepts. Everything else on
// the command line is a flag.
const setupSubcommand = "setup"

// stripSetupArg removes a leading `setup` subcommand, returning the argument
// list the flag package should see and whether the subcommand was present.
// Flags start with '-', so no existing invocation is ambiguous, and `setup`
// only counts in first position — `--role hub setup` is not a setup run.
//
// The input slice is never modified: main passes os.Args straight in and both
// flag.Parse and the wizard read it afterwards.
func stripSetupArg(args []string) ([]string, bool) {
	if len(args) < 2 || args[1] != setupSubcommand {
		return args, false
	}
	stripped := make([]string, 0, len(args)-1)
	stripped = append(stripped, args[0])
	stripped = append(stripped, args[2:]...)
	return stripped, true
}

// managedFromArgs scans for --managed before flag.Parse runs, because the
// decision to launch the wizard has to be made while the flags' defaults are
// still being assembled from devdeck.yaml. It understands every form the flag
// package accepts for a bool, stops at the `--` terminator, and reports
// whether the flag appeared at all. The last occurrence wins, matching the
// flag package.
func managedFromArgs(args []string) (value bool, ok bool) {
	if len(args) < 2 {
		return false, false
	}
	for _, arg := range args[1:] {
		if arg == "--" {
			break
		}
		name, val, hasVal := strings.Cut(arg, "=")
		if name != "--managed" && name != "-managed" {
			continue
		}
		if !hasVal {
			value, ok = true, true // a bare bool flag means true
			continue
		}
		parsed, err := strconv.ParseBool(val)
		if err != nil {
			// flag.Parse would reject this outright; leaving it unset lets the
			// real parse report the error properly a moment later.
			continue
		}
		value, ok = parsed, true
	}
	return value, ok
}

// stringFlagFromArgs is managedFromArgs for a string flag, handling both
// --name=value and --name value. It exists for --config, which has to be read
// before the flags that depend on the file it names.
func stringFlagFromArgs(args []string, name string) (string, bool) {
	if len(args) < 2 {
		return "", false
	}
	long, short := "--"+name, "-"+name
	rest := args[1:]
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		if arg == "--" {
			break
		}
		key, val, hasVal := strings.Cut(arg, "=")
		if key != long && key != short {
			continue
		}
		if hasVal {
			return val, true
		}
		if i+1 < len(rest) {
			return rest[i+1], true
		}
		return "", true
	}
	return "", false
}

// isManaged combines the pre-parsed flag with DEVDECK_MANAGED, flag winning.
func isManaged(args []string, env string) bool {
	if v, ok := managedFromArgs(args); ok {
		return v
	}
	v, err := strconv.ParseBool(env)
	return err == nil && v
}

// bootAction is what to do about a missing devdeck.yaml.
type bootAction int

const (
	// bootServer — a config file was found; start normally.
	bootServer bootAction = iota
	// bootWizard — no config and a human is watching; ask them.
	bootWizard
	// bootWriteDefaults — no config and nobody to ask; write one and carry on.
	bootWriteDefaults
)

func (a bootAction) String() string {
	switch a {
	case bootServer:
		return "server"
	case bootWizard:
		return "wizard"
	case bootWriteDefaults:
		return "write-defaults"
	}
	return "bootAction(" + strconv.Itoa(int(a)) + ")"
}

// decideBoot chooses what a start with no config file should do.
//
// The rule that matters: a headless process must never block on a prompt. A
// service started by systemd, launchd, or the Tauri sidecar has no terminal
// and no operator, so it writes a defaults file and keeps booting rather than
// hanging forever on step 1 of a wizard nobody can see. --managed is part of
// the test because the desktop sidecar always sets it.
func decideBoot(configPath string, stdinTTY, stdoutTTY, managed bool) bootAction {
	if configPath != "" {
		return bootServer
	}
	if managed || !stdinTTY || !stdoutTTY {
		return bootWriteDefaults
	}
	return bootWizard
}

// isTerminal reports whether f is a real terminal. This deliberately uses
// go-isatty rather than checking os.ModeCharDevice, because /dev/null is also
// a character device — `devdeck setup < /dev/null` must be treated as
// non-interactive, not as a terminal.
func isTerminal(f *os.File) bool {
	return isatty.IsTerminal(f.Fd()) || isatty.IsCygwinTerminal(f.Fd())
}

// runSetup shows the wizard and prints its summary. It always returns to a
// caller that exits: the wizard never chains into starting the server, whether
// it was reached by `devdeck setup` or auto-launched by a missing config.
func runSetup(existing *config.Config, configPath string) {
	if !isTerminal(os.Stdin) || !isTerminal(os.Stdout) {
		fmt.Fprintln(os.Stderr, "devdeck setup needs an interactive terminal; edit devdeck.yaml directly")
		os.Exit(1)
	}

	dir := filepath.Dir(config.DefaultPath())
	if configPath != "" {
		dir = filepath.Dir(configPath)
	} else {
		// Nothing on disk yet, so nothing was pre-filled either.
		existing = nil
	}

	res, err := setupui.Run(context.Background(), setupui.Options{Dir: dir, Existing: existing})
	if err != nil {
		if errors.Is(err, setupui.ErrAborted) {
			fmt.Fprintln(os.Stderr, "setup cancelled; nothing was written")
			os.Exit(1)
		}
		log.Fatalf("setup: %v", err)
	}
	// Printed after the Bubble Tea program has exited so it survives the
	// alternate screen and stays pipeable.
	fmt.Print(res.Summary())
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

// loadOrCreateSigningKey returns the hub's Ed25519 keypair, used to sign
// short-lived handover tokens (see internal/handovertoken). Persisted the
// same way as loadOrCreateAuthKey: an env var override, then a file next to
// the database, then generated fresh on first run. The private key format
// (ed25519.PrivateKey) is 64 bytes and already contains the public key in
// its second half.
func loadOrCreateSigningKey(dbPath string) (ed25519.PrivateKey, error) {
	if envKey := os.Getenv("DEVDECK_SIGNING_KEY"); envKey != "" {
		key, err := base64.StdEncoding.DecodeString(envKey)
		if err != nil || len(key) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("DEVDECK_SIGNING_KEY must be a base64-encoded %d-byte Ed25519 private key", ed25519.PrivateKeySize)
		}
		return ed25519.PrivateKey(key), nil
	}
	keyPath := filepath.Join(filepath.Dir(dbPath), "signing.key")
	if data, err := os.ReadFile(keyPath); err == nil {
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(key) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("corrupt signing key file %s", keyPath)
		}
		return ed25519.PrivateKey(key), nil
	}
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(priv)), 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}
