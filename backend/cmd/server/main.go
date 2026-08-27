package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/agentcore/provider/claude"
	"devdeck/backend/internal/agentcore/provider/codex"
	"devdeck/backend/internal/agentcore/provider/opencode"
	"devdeck/backend/internal/agentcore/provider/pi"
	"devdeck/backend/internal/config"
	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/dbdriver/mysqldrv"
	"devdeck/backend/internal/dbdriver/pgdrv"
	"devdeck/backend/internal/dbdriver/sqlitedrv"
	"devdeck/backend/internal/detect"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/handler"
	"devdeck/backend/internal/hoststats"
	"devdeck/backend/internal/issuemcp"
	"devdeck/backend/internal/memorycli"
	"devdeck/backend/internal/lsp"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/memorybackfill"
	"devdeck/backend/internal/netproxy"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/registry"
	"devdeck/backend/internal/selfupdate"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/setupui"
	"devdeck/backend/internal/sshmgr"
	"devdeck/backend/internal/sshthread"
	"devdeck/backend/internal/sshtool"
	"devdeck/backend/internal/sshtoolcli"
	"devdeck/backend/internal/store"
	"devdeck/backend/internal/telegram"
	"devdeck/backend/internal/terminal"
	"devdeck/backend/internal/version"
	"devdeck/backend/internal/webui"

	"github.com/mattn/go-isatty"
)

// shutdownTimeout caps how long a graceful shutdown waits for in-flight HTTP
// requests to finish. Deliberately short: by the time it applies, every PTY,
// forward and pooled SSH client has already been torn down, so what remains
// is only ordinary request draining — and an operator restarting a server
// should not have to wait on one stuck handler.
const shutdownTimeout = 10 * time.Second

func main() {
	// `devdeck ssh-tool …` is the SSH chat tool CLI: the same executable
	// entered at a different point, which is how the feature avoids shipping a
	// second binary the operator would have to install (sshtoolcli's package
	// comment). It is dispatched first and returns without touching config, the
	// database, the log prefix or a port — a spawned agent invokes it once per
	// remote command through the shim in its workspace.
	if code, handled := sshtoolcli.Dispatch(os.Args); handled {
		os.Exit(code)
	}
	// Same bargain for the issue-tracker MCP server an agent's own config
	// launches: `devdeck mcp-server` instead of a devdeck-mcp-server binary the
	// operator has to build themselves and rebuild whenever the schema moves.
	if code, handled := issuemcp.Dispatch(os.Args); handled {
		os.Exit(code)
	}
	// `devdeck memory recall|graph` is the same bargain again, for pi: it has
	// no MCP client at all (see internal/memorycli's package comment), so a
	// skill drives this one-shot CLI over bash instead of a protocol
	// handshake every other provider gets automatically.
	if code, handled := memorycli.Dispatch(os.Args); handled {
		os.Exit(code)
	}
	// `devdeck memory-backfill` is a one-shot operator command, same bargain
	// again: no separate tool to build for populating persistent memory from
	// history that predates the feature — see memorybackfill's package
	// comment.
	if code, handled := memorybackfill.Dispatch(os.Args); handled {
		os.Exit(code)
	}

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

	// Agent chat attachments are per-machine, uploaded ahead of the thread
	// that will reference them (store/agentattachment.go's own doc comment).
	// An upload whose thumbnail is removed or whose pane closes before send
	// leaves an orphan row this sweep catches; not gated by !isRuntime since
	// chat — and its attachments — run on runtimes too.
	if n, err := st.DeleteOrphanAgentAttachments(); err != nil {
		log.Printf("agent attachments: startup sweep failed: %v", err)
	} else if n > 0 {
		log.Printf("agent attachments: swept %d orphaned upload(s)", n)
	}

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
	// Advertised so a client can tell an out-of-date runtime from a broken
	// one before it opens a socket — see handler.CapSSHChat. Declared here,
	// next to the handler, so the list stays visibly tied to what this
	// process actually registers below rather than drifting into a constant
	// nobody re-checks.
	whoamiH.SetCapabilities(handler.CapSSHChat, handler.CapAgentChat, handler.CapTelegram)
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
	agentAttachmentH := handler.NewAgentAttachmentHandler(st)
	commentH := handler.NewCommentHandler(st)
	eventH := handler.NewEventHandler(st)
	settingsH := handler.NewSettingsHandler(st)
	completionsHandler := handler.NewCompletionsHandler(service.NewCompletionsService(st))
	seedH := handler.NewSeedHandler(seedSvc)
	machineH := handler.NewMachineHandler(st, healthCache, authSvc, signingKey)
	bookmarkH := handler.NewBookmarkHandler(st, service.NewFaviconService(st))

	sshSecrets := service.NewSSHSecretService(st, authKey)

	// Where the dialer gets its credentials, and where it dials FROM, both
	// depend on the role — and they move together.
	//
	// On the hub: decrypt locally (the ciphertext and the master key are both
	// here) and honour ExecutorMachineID by tunnelling the TCP dial through
	// that runtime's SOCKS5 proxy. That is the split sshmgr/executor.go
	// describes, and it still backs the interactive shell, SFTP and port
	// forwarding unchanged.
	//
	// On a runtime: this process IS the executor, so there is no proxy to
	// route through — a direct dial is the whole point. But its replica has no
	// ssh_secrets rows (ApplyCatalogSnapshot copies connections, never
	// credentials) and no master key to decrypt them with, so credentials come
	// from the hub over a machine-key-gated route, scoped by the hub to
	// exactly the connections this machine executes. See
	// machineclient.HubSecretSource and handler.RuntimeSSHHandler.
	var sshSecretSource sshmgr.SecretSource = sshSecrets
	if isRuntime {
		sshSecretSource = machineclient.NewHubSecretSource(*hubURL, *apiKey)
	}
	// One dialer backs the interactive shell, the SFTP file API and the agent
	// tool calls, so the choice above applies to all of them: every file
	// operation rides the same *ssh.Client the shell does.
	sshDialer := sshmgr.NewDialer(st, sshSecretSource)
	if !isRuntime {
		sshDialer = sshDialer.WithExecutorRouting(st, machineclient.SOCKSProxyStarter{})
	}
	sshSrv := sshmgr.NewServer(sshDialer)
	// One FilePool backs both SFTP file ops and stats polling, so a saved
	// connection's SSH client is cached once instead of dialed twice.
	sshFilePool := sshmgr.NewFilePool(sshDialer)
	sshFileSvc := service.NewSSHFileService(sshFilePool)
	sshFileH := handler.NewSSHFileHandler(sshFileSvc)
	sshStatsSvc := service.NewSSHStatsService(sshFilePool)
	sshStatsH := handler.NewSSHStatsHandler(sshStatsSvc)

	sshForwarder := sshmgr.NewForwarder(sshDialer)
	sshForwardH := handler.NewSSHForwardHandler(st, sshForwarder)
	// sshH needs sshForwarder (stop live forwards on delete) and sshFilePool
	// (evict the cached SSH+SFTP pair on delete/edit/host-key-accept), so it
	// is constructed here rather than up alongside the other handlers.
	sshH := handler.NewSSHHandler(st, sshSecrets, sshForwarder, sshFilePool)

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

	// Agent chat harness. Runs on every role, but only a runtime ever has
	// worktrees to chat about; the hub simply proxies the WebSocket like it
	// does for /ws/terminal and /ws/ssh.
	agentRegistry := provider.NewRegistry(claude.NewDriver(), pi.NewDriver(), codex.NewDriver(), opencode.NewDriver())
	// The engine's State is DERIVED from the event log, never stored — so it
	// has to be rebuilt from that log on every boot. Skipping this was a real
	// bug, not a theoretical one: the events survived the restart, so the
	// WebSocket's replay found them and its auto-create path stayed quiet,
	// while the decider had an empty thread map and answered every turn with
	// "thread <id> does not exist" — permanently, because the auto-create
	// command's receipt is durable and absorbed each retry.
	//
	// A failure here is fatal on purpose. Booting with a partially-replayed
	// log means serving a read model that disagrees with disk, which is worse
	// than not booting.
	agentLog, err := st.AllAgentEvents()
	if err != nil {
		log.Fatalf("replay agent event log: %v", err)
	}
	if len(agentLog) > 0 {
		log.Printf("agent: replayed %d events into the engine", len(agentLog))
	}
	agentEngine := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		Initial:   orchestration.Apply(orchestration.NewState(), agentLog),
		NewID:     func() string { return "ae-" + randomHex(8) },
		QueueSize: 64,
	})
	go agentEngine.Run(context.Background())

	// Built here rather than folded into selfH above, because selfH is
	// constructed before the engine exists and a construction argument cannot
	// reach backwards. Its route lives beside the other /api/self/* ones.
	busyH := handler.NewBusyHandler(agentEngine)

	agentDir := orchestration.NewThreadDirectory()
	agentChatSvc := &provider.Service{Registry: agentRegistry, Dir: agentDir}

	// agentBroker tracks which requestIds (tool approvals + user-input
	// questions) are open per thread, so a cancelled/reconciled thread can
	// deny them instead of leaving ghost prompts the UI can never resolve.
	// Gate, not a plain MemoryBroker: the SSH tool handlers wired below park
	// an HTTP request on a human via a genuinely blocking Await, which
	// MemoryBroker never needed to support (see gate.go's doc comment).
	agentBroker := approval.NewGate()
	agentBroker.OnCancel = func(threadID, requestID string) {
		// A "tool-" request was raised by DevDeck's own SSH tool gate
		// (orchestration.ToolApprovalPrompter below), not by a provider —
		// there is no provider-side request to cancel, and RespondToRequest
		// would either fail outright or answer whatever unrelated request
		// the provider actually has open.
		if strings.HasPrefix(requestID, orchestration.ToolRequestPrefix) {
			return
		}
		// Best-effort — see Gate.OnCancel's doc comment. Errors here are
		// swallowed on purpose: a dead session's write failing is expected, not
		// a bug to surface.
		_ = agentChatSvc.RespondToRequest(context.Background(), threadID, requestID, event.DecisionCancel)
	}

	// Ingestion is the provider -> engine direction; the Reactor below is
	// engine -> provider. Both are required: without Ingestion nothing reads
	// Adapter.Events(), so the agent's replies and tool calls never reach the
	// engine, never get persisted, and never reach the client — the chat
	// echoes the user's own message and then goes quiet.
	agentIngestion := orchestration.NewIngestion(
		agentEngine, agentBroker, func() string { return "ac-" + randomHex(8) },
	)

	// tokenStore mints the per-thread bearer token an SSH chat thread's
	// seeded workspace hands to the devdeck-ssh helper CLI. Declared here,
	// ahead of the Reactor below, because its SSH branch mints from it on
	// every session start, and the /api/agent-tools/ssh/* routes registered
	// later verify against the same store.
	tokenStore := sshtool.NewTokenStore()

	// loopbackHubURL is filled in once the real listener has bound, well
	// below — --addr may use port 0 and get an OS-assigned port. Declared
	// here so the SSH branch of Reactor.InstanceFor, built next, can close
	// over it and read whatever it ends up holding at call time: a session
	// only ever starts after the listener is up, so by the time this is
	// read it is always populated. Loopback rather than *publicURL/
	// --public-url on purpose — the devdeck-ssh helper always runs on this
	// same host (design spec §3.2), so it is both correct and immune to
	// whatever tunnel or TLS terminator sits in front of the public URL.
	var loopbackHubURL string

	// memSvc is the hub-side owner of persistent agent memory (Hindsight) —
	// see domain.MemoryConfig's doc comment for why it is intentionally
	// hub-only, and internal/service/memory.go for the client it builds.
	// Constructed on every role: a --role runtime process never calls it
	// directly (see the isRuntime branch just below), but building it here
	// unconditionally keeps this block the same shape as every service
	// above it, and it does nothing until a handler or hook actually calls
	// it — MemoryService.client() returns ErrMemoryNotConfigured until an
	// operator turns the feature on from Settings.
	memSvc := service.NewMemoryService(st, filepath.Dir(*dbPath))

	// resolveScope turns a bare threadID into the attribution tags a memory
	// gets retained/recalled under — see memory.Scope's doc comment for why
	// this is tags on ONE shared bank rather than a bank per project. Cheap:
	// at most one indexed worktree/project (or SSH connection) lookup on
	// THIS process's own store, plus an in-memory engine-state read for the
	// provider kind (Thread.InstanceID is "<kind>:<instanceId>"). Safe to
	// call from a runtime too — a runtime's own st holds exactly the
	// worktrees it hosts, the same store InstanceFor below already reads.
	resolveScope := func(threadID string) memory.Scope {
		scope := memory.Scope{Machine: *machineName, Thread: threadID}
		if th, ok := agentEngine.State().Thread(threadID); ok {
			if i := strings.IndexByte(string(th.InstanceID), ':'); i >= 0 {
				scope.Provider = string(th.InstanceID)[:i]
			}
		}
		if orchestration.IsSSHThread(threadID) {
			scope.Surface = "ssh"
			if conn, err := st.SSHConnectionByID(orchestration.SSHConnectionIDForThread(threadID)); err == nil {
				scope.Project = conn.Name
			}
			return scope
		}
		scope.Surface = "worktree"
		if wt, err := st.WorktreeByID(orchestration.WorktreeIDForThread(threadID)); err == nil {
			if proj, err := st.ProjectByID(wt.ProjectID); err == nil {
				scope.Project = proj.Name
			}
		}
		return scope
	}

	// memoryHooks is how orchestration reaches persistent memory without
	// importing internal/memory itself — see orchestration.MemoryHooks' doc
	// comment. The two roles diverge here: a plain runtime has no Hindsight
	// credentials of its own and calls back through the hub's machine-key-
	// gated /api/runtime/memory/* routes (machineclient/memory.go); the hub
	// (or a --role both process, which owns its worktrees directly in the
	// same store) calls Hindsight itself through memSvc, no network hop.
	var memoryHooks orchestration.MemoryHooks
	if isRuntime {
		memoryHooks = orchestration.MemoryHooks{
			Recall: func(ctx context.Context, threadID, query string) string {
				return machineclient.RecallMemory(ctx, *hubURL, *apiKey, resolveScope(threadID), query)
			},
			Retain: func(_ context.Context, threadID, role, text string) {
				machineclient.RetainMemory(*hubURL, *apiKey, resolveScope(threadID), role, text)
			},
		}
	} else {
		memoryHooks = orchestration.MemoryHooks{
			Recall: func(ctx context.Context, threadID, query string) string {
				return memSvc.RecallBlock(ctx, resolveScope(threadID), query)
			},
			Retain: func(ctx context.Context, threadID, role, text string) {
				memSvc.RetainAsync(ctx, resolveScope(threadID), role, text)
			},
		}
	}
	agentIngestion.Memory = memoryHooks

	// toolPrompter drives an SSH tool's approval card through the exact same
	// event path a provider's own approval request takes (design spec §4.4),
	// so it is indistinguishable from a provider's, on the wire and in the
	// UI, from the moment it is opened.
	toolPrompter := &orchestration.ToolApprovalPrompter{Ingestion: agentIngestion, Gate: agentBroker}
	sshToolSvc := service.NewSSHToolService(
		&sshShellRunner{pool: sshFilePool},
		sshFileSvc,
		&engineThreadPolicy{engine: agentEngine},
		toolPrompter,
	)
	sshToolH := handler.NewSSHToolHandler(sshToolSvc)

	// A thread the log replay above left "running" or "waiting" belonged to a
	// process that no longer exists (see ReconcileOrphanedThreads's doc
	// comment) — every restart otherwise leaves it stuck that way forever,
	// which is what a chat pane showing "Working for <huge number>s" is.
	// Needs the engine's Run loop already started (just above) to dispatch
	// through it.
	if n, err := orchestration.ReconcileOrphanedThreads(
		context.Background(), agentEngine, agentIngestion.NewID,
	); err != nil {
		log.Printf("agent: reconcile orphaned threads: %v", err)
	} else if n > 0 {
		log.Printf("agent: reconciled %d thread(s) left running/waiting by the previous process", n)
	}

	agentReactor := &orchestration.Reactor{
		Engine: agentEngine, Provider: agentChatSvc, Broker: agentBroker,
		// *store.Store structurally satisfies AttachmentReader (workers.go)
		// with no adapter — resolves a turn's attachment ids into bytes right
		// before the provider call.
		Attachments: st,
		// Recalls persistent-memory context before every turn — see
		// MemoryHooks above.
		Memory: memoryHooks,
		// The Reactor is the only component that learns an adapter was just
		// created, so it is what starts that adapter's Ingestion loop.
		OnInstanceStarted: func(ctx context.Context, a provider.Adapter) {
			go agentIngestion.Consume(ctx, a)
		},
		// InstanceFor resolves a thread to the worktree's configured agent.
		// A threadID is either a bare worktree id or "<worktreeId>::chat-N"
		// for extra split chat panes (see paneTree.ts) — both name the same
		// worktree, so only the prefix before "::" is looked up.
		//
		// An SSH thread (design spec §3.1) is checked FIRST and returns
		// through its own branch entirely: it has no worktree to resolve at
		// all, and everything below this branch — the worktree lookup, its
		// error wrapping, its empty-Agent fallback — stays exactly as it was
		// before this feature existed.
		InstanceFor: func(threadID string) (provider.InstanceID, provider.SessionStartInput, error) {
			// mcpEndpointsFor wires MCP servers into a session: the live
			// Hindsight endpoint (if memory is configured) so the model can
			// call retain/recall/reflect on its own initiative, and
			// DevDeck's own `mcp-server` subcommand (issue tracker +
			// graph_neighbors, see internal/issuemcp) so it can file
			// tickets and look up real memory-graph relationships instead
			// of guessing them from a recall snippet — on top of the
			// deterministic recall/retain every provider already gets from
			// memoryHooks above.
			//
			// claude wires both endpoints unconditionally (ephemeral
			// per-session --mcp-config, nothing persisted). codex and
			// opencode wire them too, but only when the instance's own
			// Config.HomeDir is set — their MCP config lives in a real file
			// (~/.codex/config.toml, ~/.config/opencode/opencode.jsonc)
			// that, with no isolated HomeDir, IS the operator's own
			// hand-maintained one, shared with their interactive CLI use
			// outside DevDeck; adding servers there silently would both
			// surprise them and leak into every codex/opencode session on
			// the machine. See each adapter's configureMCP for the actual
			// write (`codex mcp add` / `opencode mcp add`, not hand-rolled
			// file edits) and its idempotency. pi has no MCP client at all
			// (confirmed against a live `pi --help` — no mcp subcommand or
			// flag exists), so this returns nil for it; there is nothing
			// DevDeck can wire until pi's own CLI gains MCP support.
			// !isRuntime-only: see MemoryService.MCPEndpoint's doc comment
			// for why a remote runtime never gets the Hindsight hop; the
			// same reasoning applies to devdeck mcp-server, which needs
			// direct access to this hub's own SQLite file.
			mcpEndpointsFor := func(kind string) []provider.MCPEndpoint {
				if isRuntime || kind == "pi" {
					return nil
				}
				var eps []provider.MCPEndpoint
				if info, ok := memSvc.MCPEndpoint(); ok {
					eps = append(eps, provider.MCPEndpoint{Name: "hindsight", URL: info.URL, Token: info.Token})
				}
				if exe := hostExecutable(); exe != "" {
					eps = append(eps, provider.MCPEndpoint{
						Name: "devdeck", Command: exe, Args: []string{issuemcp.Subcommand, "--db", *dbPath},
					})
				}
				return eps
			}

			// memoryEnvFor gives pi the same recall/graph capability the MCP
			// hop above gives everyone else, over a route pi actually has:
			// `devdeck memory recall|graph` run through its own bash tool
			// (see internal/memorycli and the devdeck-memory skill that
			// teaches pi when to call it). DEVDECK_DB is this hub's OWN db,
			// the same file mcpEndpointsFor points `devdeck mcp-server` at
			// above — pi never gets a credential the hub doesn't already
			// trust.
			memoryEnvFor := func(kind string) map[string]string {
				if isRuntime || kind != "pi" {
					return nil
				}
				exe := hostExecutable()
				if exe == "" {
					return nil
				}
				return map[string]string{"DEVDECK_BIN": exe, "DEVDECK_DB": *dbPath}
			}
			if orchestration.IsSSHThread(threadID) {
				connectionID := orchestration.SSHConnectionIDForThread(threadID)
				conn, err := st.SSHConnectionByID(connectionID)
				if err != nil {
					return "", provider.SessionStartInput{}, fmt.Errorf("agent thread %s: %w", threadID, err)
				}
				// DevOps chat runs on the connection's executor runtime, not on
				// the hub: the agent process, its tool calls, and the SSH dial
				// all happen on the machine that actually reaches the host.
				//
				// Both halves of this check produce an operator-facing sentence
				// rather than a silent misroute, because both are recoverable
				// configuration mistakes and neither has any other symptom. The
				// client gates the panel on the same two conditions before it
				// ever opens a socket (SSHAgentChatPanel.tsx), so reaching here
				// means something raced or a client is out of step — say so
				// plainly instead of starting an agent on the wrong machine.
				if conn.ExecutorMachineID == nil || *conn.ExecutorMachineID == "" {
					return "", provider.SessionStartInput{}, fmt.Errorf(
						"agent thread %s: SSH connection %q has no executor machine; assign it to a runtime in the connection's settings to use DevOps chat",
						threadID, conn.Name)
				}
				if !isRuntime && !hostsSSHConnection(st, *conn.ExecutorMachineID) {
					return "", provider.SessionStartInput{}, fmt.Errorf(
						"agent thread %s: SSH connection %q runs on a runtime machine; open its chat from that machine",
						threadID, conn.Name)
				}
				// Re-minted on every session start (Task 3's TokenStore.Mint
				// doc comment): a stale token from a previous process, or a
				// previous session on this same thread, must not keep
				// working once a fresh one exists.
				token := tokenStore.Mint(threadID, connectionID)
				dir, err := sshthread.Seed(filepath.Join(filepath.Dir(*dbPath), "ssh-threads"), sshthread.Binding{
					HubURL:       loopbackHubURL,
					ThreadID:     threadID,
					ConnectionID: connectionID,
					Label:        conn.Name,
					Host:         conn.Host,
					User:         conn.Username,
					Token:        token,
				}, hostExecutable())
				if err != nil {
					return "", provider.SessionStartInput{}, fmt.Errorf("agent thread %s: seed workspace: %w", threadID, err)
				}
				// domain.SSHConnection carries no Agent field — an SSH thread
				// has no per-connection choice the way a worktree does — so
				// it always takes the same empty-Agent fallback the worktree
				// branch below logs about.
				log.Printf("agent: SSH thread %s has no configurable agent; defaulting to %q", threadID, orchestration.DefaultAgent)
				// Without PATH the whole feature is inert: the seeded
				// AGENTS.md tells the agent that `devdeck-ssh` is its only
				// route to the host, and a bare invocation of it has to
				// resolve or every tool call comes back "command not found".
				env := agentPathEnv(sshthread.BinDir(dir))
				for k, v := range memoryEnvFor(orchestration.DefaultAgent) {
					env[k] = v
				}
				return orchestration.InstanceIDForAgent(""), provider.SessionStartInput{
					ThreadID:     threadID,
					Cwd:          dir,
					Env:          env,
					MCPEndpoints: mcpEndpointsFor(orchestration.DefaultAgent),
				}, nil
			}

			wt, err := st.WorktreeByID(orchestration.WorktreeIDForThread(threadID))
			if err != nil {
				return "", provider.SessionStartInput{}, fmt.Errorf("agent thread %s: %w", threadID, err)
			}
			// Root worktrees (and any worktree created before the agent field
			// existed) carry an empty Agent. The terminal handles that by
			// opening a plain shell, but chat has no such fallback — it must
			// name an agent or nothing can run. Without this, InstanceID came
			// out as ":default", whose empty Kind matched no driver and left
			// every turn failing with "thread is not bound to an instance".
			if wt.Agent == "" {
				log.Printf("agent: worktree %s has no agent configured; defaulting to %q", wt.ID, orchestration.DefaultAgent)
			}
			agentKind := wt.Agent
			if agentKind == "" {
				agentKind = orchestration.DefaultAgent
			}
			return orchestration.InstanceIDForAgent(wt.Agent), provider.SessionStartInput{
				ThreadID:     threadID,
				Cwd:          wt.Path,
				Env:          memoryEnvFor(agentKind),
				MCPEndpoints: mcpEndpointsFor(agentKind),
			}, nil
		},
	}
	agentReactor.Start(context.Background())

	agentWS := handler.NewAgentWSHandler(agentEngine, st, agentChatSvc)
	agentThreadH := handler.NewAgentThreadHandler(st, agentEngine)

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

	// The Telegram bridge runs on every role for the same reason the published
	// SOCKS proxy does: which threads a process can publish is decided by
	// which threads its own engine holds, not by its role. A hub publishes
	// ssh:* threads; a runtime publishes its own worktree chats. One bot
	// token per process is a hard requirement, not a style choice —
	// Telegram's getUpdates is exclusive per token, so two processes sharing
	// one token evict each other with 409 Conflict. See
	// docs/superpowers/plans/2026-08-18-telegram-remote-chat.md §0.1.
	telegramPairing := &telegram.Pairing{TTL: 5 * time.Minute, Now: time.Now}
	// Shared by pointer with the bridge (which writes it) and the settings
	// handler (which reads it), exactly like telegramPairing. See
	// telegram.Health: without it, a bridge that can never receive a message
	// is indistinguishable in the UI from a working one.
	telegramHealth := &telegram.Health{}
	// The live bridge, so the settings handler can reach it to unpin a
	// confirmation when a thread is unpublished from the UI. Guarded by
	// telegramMu with everything else here, and nil whenever no bridge is
	// running (disabled, or no token).
	var telegramBridge *telegram.Bridge
	var telegramCancel context.CancelFunc
	var telegramDone chan struct{}
	var telegramMu sync.Mutex
	// restartTelegram is the ONE place that starts or stops the bridge. It is
	// concurrency-safe (guarded by telegramMu) and always stops the previous
	// bridge before starting a new one — two long-poll loops on the same bot
	// token evict each other with a 409, breaking the bot until a process
	// restart.
	//
	// Cancelling is not the same as having stopped: Run returns only once both
	// its loops have unwound, and until the old poll loop's in-flight
	// getUpdates is actually torn down, Telegram still counts it as the
	// token's one active poller. So this WAITS for the old bridge — bounded,
	// because a hung shutdown must not wedge the HTTP handler that called it.
	restartTelegram := func() {
		telegramMu.Lock()
		defer telegramMu.Unlock()
		if telegramCancel != nil {
			telegramCancel()
			telegramCancel = nil
			if telegramDone != nil {
				select {
				case <-telegramDone:
				case <-time.After(5 * time.Second):
					log.Printf("telegram: previous bridge did not stop within 5s; starting the new one anyway")
				}
				telegramDone = nil
			}
		}
		telegramBridge = nil
		cfg, err := st.TelegramConfig()
		if err != nil || !cfg.Enabled || !cfg.HasToken {
			// Every early return here leaves NO bridge running, so the state
			// has to say so — otherwise disabling the bridge would leave the
			// last "ok" on screen forever.
			telegramHealth.Set(telegram.HealthOff, "")
			return
		}
		token, err := st.TelegramBotToken()
		if err != nil || token == "" {
			telegramHealth.Set(telegram.HealthOff, "")
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		telegramCancel = cancel
		// DEVDECK_TELEGRAM_API_BASE points the bot client at something other
		// than api.telegram.org. Empty (the normal case) means the real API.
		// This exists so the SHIPPED BINARY can be exercised end-to-end against
		// a local stand-in — booting it, enabling the bridge over its own REST
		// API, and watching it answer a message — which unit tests, exercising
		// the package in-process, cannot prove.
		client := &telegram.Client{Token: token, BaseURL: os.Getenv("DEVDECK_TELEGRAM_API_BASE")}

		// Confirm the token actually works, and record the bot's @username.
		// NOTHING else writes TelegramConfig.BotUsername — handler/telegram.go
		// only carries the stored value through — so without this the Settings
		// panel can never tell an operator whether the token they pasted is
		// valid, and a typo'd token looks identical to a working one until
		// messages mysteriously go nowhere.
		//
		// In its own goroutine, and deliberately not a precondition for
		// starting the bridge below: an unreachable Telegram must not hold up
		// boot, and the poll loop has its own retry/backoff for exactly that.
		go func() {
			me, err := client.GetMe(ctx)
			if err != nil {
				log.Printf("telegram: getMe failed — the bot token may be invalid or Telegram unreachable: %v", err)
				telegramHealth.Set(telegram.HealthError, telegram.PollErrorDetail(err))
				return
			}
			cur, err := st.TelegramConfig()
			if err != nil || cur.BotUsername == me.Username {
				return
			}
			cur.BotUsername = me.Username
			if err := st.SetTelegramConfig(cur); err != nil {
				log.Printf("telegram: store bot username: %v", err)
				return
			}
			log.Printf("telegram: authenticated as @%s", me.Username)
		}()

		b := telegram.New(telegram.Deps{
			Store:   st,
			Engine:  agentEngine,
			Client:  client,
			Pairing: telegramPairing,
			Health:  telegramHealth,
			NewID:   func() string { return "tg-" + randomHex(8) },
			// Backs /agents in a published project: which agent NEW sessions
			// start on. The same catalog the chat header offers, so an agent
			// missing its binary is listed and marked rather than silently
			// dropped.
			ListAgents: agentSvc.ListAgents,
			ListSkills: func() ([]string, error) {
				skills, err := agentSvc.ListSkills(orchestration.DefaultAgent)
				if err != nil {
					return nil, err
				}
				names := make([]string, 0, len(skills))
				for _, s := range skills {
					names = append(names, s.Name)
				}
				return names, nil
			},
			// Keyed by AGENT, not by thread: which agent a destination runs is a
			// question only the bridge can answer (its /agents choice lives on a
			// Telegram binding), so resolving it here would have to guess — and
			// guessing "the thread's creation-time instance" is exactly what
			// made /model offer the previous agent's catalog.
			Models: func(agentID string) ([]string, error) {
				models, err := agentSvc.ListModels(agentID)
				if err != nil {
					return nil, err
				}
				ids := make([]string, 0, len(models))
				for _, m := range models {
					ids = append(ids, m.ID)
				}
				return ids, nil
			},
			Now: time.Now,
		})
		done := make(chan struct{})
		telegramDone = done
		telegramBridge = b
		go func() {
			defer close(done)
			b.Run(ctx)
		}()
		log.Printf("telegram: bridge started")
	}
	restartTelegram()
	// Unpublishing from Settings has to leave the Telegram chat in the same
	// state /unpublish does, which means removing the pinned confirmation.
	// Resolved through telegramMu on each call rather than captured once:
	// every config save replaces the bridge, and a captured pointer would
	// address a cancelled one whose client is no longer polling.
	telegramUnpin := func(r *http.Request, binding domain.TelegramBinding) {
		telegramMu.Lock()
		b := telegramBridge
		telegramMu.Unlock()
		if b == nil {
			return
		}
		b.UnpinBinding(r.Context(), binding)
	}
	telegramH := handler.NewTelegramHandler(st, telegramPairing, telegramHealth, restartTelegram, telegramUnpin)

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
	// What a restart of this process would destroy — PTYs *and* agent runs.
	// Not on selfH: see busyH's construction above.
	mux.HandleFunc("GET /api/self/busy", busyH.GetBusy)
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
	mux.HandleFunc("POST /api/worktrees/{id}/git/init", gitH.Init)
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
		mux.HandleFunc("GET /api/machines/{id}/busy", machineH.GetMachineBusy)
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

		// Persistent agent memory: a runtime calls back through these two
		// routes instead of holding its own Hindsight credentials — see
		// domain.MemoryConfig's doc comment and machineclient/memory.go, the
		// only caller. Same nested-mux-behind-RequireMachineKey shape as the
		// catalog routes just above, for the same reason.
		runtimeMemoryH := handler.NewRuntimeMemoryHandler(memSvc)
		runtimeMemoryMux := http.NewServeMux()
		runtimeMemoryMux.HandleFunc("POST /api/runtime/memory/recall", runtimeMemoryH.PostRecall)
		runtimeMemoryMux.HandleFunc("POST /api/runtime/memory/retain", runtimeMemoryH.PostRetain)
		mux.Handle("POST /api/runtime/memory/recall", handler.RequireMachineKey(st)(runtimeMemoryMux))
		mux.Handle("POST /api/runtime/memory/retain", handler.RequireMachineKey(st)(runtimeMemoryMux))

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

		// Forwarding rule CRUD and lifecycle. All seven routes are hub-only:
		// the listener always opens on the hub, and the SSH client dial
		// (Forwarder.runOnce) already routes through the connection's
		// ExecutorMachineID SOCKS5 proxy when needed — same as shell/SFTP/exec.
		mux.HandleFunc("GET /api/ssh/connections/{id}/forwards", sshForwardH.GetForConnection)
		mux.HandleFunc("POST /api/ssh/connections/{id}/forwards", sshForwardH.Post)
		mux.HandleFunc("PATCH /api/ssh/forwards/{id}", sshForwardH.Patch)
		mux.HandleFunc("DELETE /api/ssh/forwards/{id}", sshForwardH.Delete)
		mux.HandleFunc("POST /api/ssh/forwards/start", sshForwardH.PostStart)
		mux.HandleFunc("POST /api/ssh/forwards/{id}/stop", sshForwardH.PostStop)
		mux.HandleFunc("GET /api/ssh/forwards/states", sshForwardH.GetStates)

		// Hands a runtime the decrypted credentials for the connections IT
		// executes, so it can complete the SSH handshake itself for an SSH
		// chat thread it hosts. Machine-key gated and scoped per connection by
		// the handler — read handler.RuntimeSSHHandler's doc comment before
		// touching this route; it is the one place a plaintext SSH credential
		// crosses a process boundary.
		runtimeSSHH := handler.NewRuntimeSSHHandler(st, sshSecrets)
		runtimeSSHMux := http.NewServeMux()
		runtimeSSHMux.HandleFunc("POST /api/runtime/ssh/secret", runtimeSSHH.PostSecret)
		mux.Handle("POST /api/runtime/ssh/secret", handler.RequireMachineKey(st)(runtimeSSHMux))

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

		// AI inline completions (BYOK). Hub-only and worktree-agnostic: the
		// hub holds the key and everything else (prefix/suffix/grounding
		// symbols) already lives in the browser — see the design doc's "Hub-
		// only, worktree-agnostic" section.
		mux.HandleFunc("GET /api/completions/config", completionsHandler.GetConfig)
		mux.HandleFunc("PUT /api/completions/config", completionsHandler.PutConfig)
		mux.HandleFunc("POST /api/completions/inline", completionsHandler.PostInline)

		// Persistent agent memory (Hindsight-backed). Hub-only for the same
		// reason completions is: the credentials live here, and every other
		// piece of state a request needs is already on this process (the
		// Memory page's browse calls; a runtime's per-turn recall/retain goes
		// through /api/runtime/memory/* above instead, never this block).
		memoryH := handler.NewMemoryHandler(memSvc)
		mux.HandleFunc("GET /api/memory/config", memoryH.GetConfig)
		mux.HandleFunc("PUT /api/memory/config", memoryH.PutConfig)
		mux.HandleFunc("POST /api/memory/test", memoryH.PostTest)
		mux.HandleFunc("GET /api/memory/stats", memoryH.GetStats)
		mux.HandleFunc("GET /api/memory/tags", memoryH.GetTags)
		mux.HandleFunc("GET /api/memory/memories", memoryH.GetMemories)
		mux.HandleFunc("GET /api/memory/operations", memoryH.GetOperations)
		mux.HandleFunc("GET /api/memory/graph", memoryH.GetGraph)
		mux.HandleFunc("GET /api/memory/entities/graph", memoryH.GetEntityGraph)
		mux.HandleFunc("GET /api/memory/entities", memoryH.GetEntities)
		mux.HandleFunc("GET /api/memory/timeseries", memoryH.GetTimeseries)
		mux.HandleFunc("GET /api/memory/documents", memoryH.GetDocuments)
		mux.HandleFunc("GET /api/memory/mental-models", memoryH.GetMentalModels)
		mux.HandleFunc("POST /api/memory/recall", memoryH.PostRecall)
		mux.HandleFunc("POST /api/memory/reflect", memoryH.PostReflect)
		mux.HandleFunc("POST /api/memory/global", memoryH.PostGlobalPreference)
		mux.HandleFunc("GET /api/memory/export", memoryH.GetExport)
		mux.HandleFunc("POST /api/memory/import", memoryH.PostImport)
		mux.HandleFunc("GET /api/memory/local/status", memoryH.GetLocalStatus)
		mux.HandleFunc("POST /api/memory/local/start", memoryH.PostLocalStart)
		mux.HandleFunc("POST /api/memory/local/stop", memoryH.PostLocalStop)
		mux.HandleFunc("GET /api/memory/local/logs", memoryH.GetLocalLogs)
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

	// Registered on every role, like the published-SOCKS routes just above:
	// a runtime publishing its own worktree chats to Telegram is exactly as
	// valid as a hub publishing its SSH chats (see telegramH's construction
	// above for why).
	mux.HandleFunc("GET /api/telegram/config", telegramH.GetConfig)
	mux.HandleFunc("PUT /api/telegram/config", telegramH.PutConfig)
	mux.HandleFunc("POST /api/telegram/pair", telegramH.PostPair)
	mux.HandleFunc("GET /api/telegram/users", telegramH.GetUsers)
	mux.HandleFunc("DELETE /api/telegram/users/{userId}", telegramH.DeleteUser)
	mux.HandleFunc("GET /api/telegram/bindings", telegramH.GetBindings)
	mux.HandleFunc("PUT /api/telegram/bindings/{threadId}", telegramH.PutBinding)
	mux.HandleFunc("DELETE /api/telegram/bindings/{threadId}", telegramH.DeleteBinding)

	mux.HandleFunc("/ws/terminal", termSrv.HandleWS)
	mux.HandleFunc("/ws/agent", agentWS.HandleWS)

	// Tool routes the devdeck-ssh helper CLI calls from inside an SSH chat
	// thread's seeded workspace (sshthread.Seed) — authenticated by a
	// per-thread token (tokenStore), never by a session cookie or hub key.
	// The nested mux is deliberate: RequireThreadToken must wrap only this
	// route group, not the whole server, so it is built on its own mux.
	//
	// Registered on EVERY role, alongside /ws/agent just above and for the
	// same reason: an SSH chat thread now runs wherever its agent runs, and an
	// agent hosted on a runtime calls these on that runtime — the helper shim
	// forwards to this same process's binary (sshthread.Seed's hostExe) and
	// the workspace's hubUrl is this process's own loopback address. Leaving
	// them hub-only is what made a runtime-hosted thread's every tool call
	// 404 against a route its own workspace was pointed at.
	toolMux := http.NewServeMux()
	toolMux.HandleFunc("POST /api/agent-tools/ssh/exec", sshToolH.Exec)
	toolMux.HandleFunc("GET /api/agent-tools/ssh/file", sshToolH.ReadFile)
	toolMux.HandleFunc("PUT /api/agent-tools/ssh/file", sshToolH.WriteFile)
	toolMux.HandleFunc("GET /api/agent-tools/ssh/files", sshToolH.ListFiles)
	toolMux.HandleFunc("GET /api/agent-tools/ssh/grep", sshToolH.Grep)
	mux.Handle("POST /api/agent-tools/ssh/exec", handler.RequireThreadToken(tokenStore)(toolMux))
	mux.Handle("GET /api/agent-tools/ssh/file", handler.RequireThreadToken(tokenStore)(toolMux))
	mux.Handle("PUT /api/agent-tools/ssh/file", handler.RequireThreadToken(tokenStore)(toolMux))
	mux.Handle("GET /api/agent-tools/ssh/files", handler.RequireThreadToken(tokenStore)(toolMux))
	mux.Handle("GET /api/agent-tools/ssh/grep", handler.RequireThreadToken(tokenStore)(toolMux))
	mux.HandleFunc("GET /api/agent/threads", agentThreadH.GetThreads)
	mux.HandleFunc("DELETE /api/agent/threads/{threadId}", agentThreadH.DeleteThread)
	// Composer image attachments (Composer — Context Attachments, C1). Every
	// role: chat, and therefore its attachments, run on runtimes too.
	mux.HandleFunc("POST /api/agent/threads/{threadId}/attachments", agentAttachmentH.PostAttachment)
	mux.HandleFunc("GET /api/agent/attachments/{id}", agentAttachmentH.GetAttachment)
	// Listing exists because PTY sessions are deliberately never reaped (see
	// registry.graceTTL): a session whose id has fallen out of the frontend's
	// persisted pane layout is otherwise invisible and unkillable, and only a
	// restart clears it. DELETE accepts any live id, including a worktree's
	// primary session — the "don't kill the primary" rule belongs to the pane
	// close path in the UI, not to an operator deliberately reaping an orphan.
	mux.HandleFunc("GET /api/terminal/sessions", termH.GetSessions)
	mux.HandleFunc("DELETE /api/terminal/sessions/{id}", termH.DeleteSession)
	mux.HandleFunc("/ws/lsp", lspSrv.HandleWS)

	// Backstop for /api/ paths no route above claimed — most notably the
	// hub-only block, which a --role runtime skips while still serving this
	// web UI. Without it those fall through to the SPA catch-all below and
	// come back as index.html with a 200, which the frontend then tries to
	// parse as JSON. Most specific pattern wins, so registered routes are
	// unaffected.
	mux.Handle("/api/", handler.NewAPINotFoundHandler())
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
	// Now that the real port is known (it may have been OS-assigned from
	// --addr ...:0), loopbackHubURL can be filled in for Reactor.InstanceFor's
	// SSH branch above — see that variable's own doc comment for why it is
	// loopback rather than *publicURL.
	if _, port, err := net.SplitHostPort(listener.Addr().String()); err == nil {
		loopbackHubURL = "http://127.0.0.1:" + port
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
	// exact line to discover the bound port — it asks for a fixed one but falls
	// back to --addr 127.0.0.1:0 when that port is taken, so it never assumes.
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
	// Same replay, for a locally managed Hindsight process/container — see
	// MemoryService.LocalStartIfRunning's doc comment. Backgrounded, unlike
	// the SOCKS5 replay above: a cold image pull or a cold `uvx` package
	// fetch can take minutes, and the hub must start serving HTTP
	// immediately rather than block its own boot on that.
	if !isRuntime {
		go func() {
			if err := memSvc.LocalStartIfRunning(context.Background()); err != nil {
				log.Printf("memory: local hosting: %v", err)
			}
		}()
	}
	// Graceful shutdown, rather than letting the process die where it stands.
	// Three things here exist only in this process's memory and nothing else
	// ever closes them: live PTY children, the pooled SSH/SFTP clients, and
	// the port-forward listeners. Closing the PTY master usually SIGHUPs a
	// child, but an agent that ignores SIGHUP — or that has re-parented
	// children of its own — simply survives as an orphan holding memory, and
	// those accumulate across every restart with no way left to reach them.
	srv := &http.Server{Handler: root}
	shutdownDone := make(chan struct{})
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		defer close(shutdownDone)
		sig := <-stop
		log.Printf("shutdown: %v received, draining", sig)
		// PTYs first, while the WebSockets are still up, so an attached
		// client gets its "[process terminated]" notice before its socket
		// goes away. KillAllSessions kills concurrently on purpose:
		// terminateProcess waits up to 2s per session for SIGTERM before
		// escalating, so doing this serially would put a 20-session host
		// forty seconds into its own shutdown.
		if n := terminal.KillAllSessions(); n > 0 {
			log.Printf("shutdown: terminated %d terminal session(s)", n)
		}
		sshForwarder.StopAll()
		sshFilePool.Close()
		// Hijacked WebSockets are invisible to Shutdown, so this only drains
		// ordinary in-flight HTTP requests; the timeout caps how long one
		// slow request may hold the exit.
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	// Shutdown closes the listeners first, so Serve returns ErrServerClosed
	// while the goroutine above is still draining — wait for it, or the
	// process exits mid-teardown and undoes the point of having one.
	if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server: %v", err)
	}
	<-shutdownDone
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

// tailscaleServeClearArgs removes any existing HTTPS listener on 443 before
// this process claims it.
//
// It exists because `tailscale serve <port>` REFUSES to replace a listener
// rather than overwriting it — it exits 1 with "sending serve config:
// updating config: listener already exists for port 443". A single leftover
// mapping (an older build's `--bg`, or a run that was killed before its
// foreground child could clean up) therefore breaks the flag permanently: not
// just once, but on every launch from then on.
//
// The failure mode that causes is genuinely misleading, because this hub may
// bind an OS-ASSIGNED port (the desktop shell asks for 8989 but falls back to
// --addr 127.0.0.1:0 when something already holds it — see
// frontend/src-tauri/src/sidecar.rs's listen_addr). The stale mapping keeps
// pointing at whatever port a previous run happened to get, so the
// tailnet URL answers 502 while the process itself is perfectly healthy and
// still serving on loopback — and anything that reaches this hub only over
// the tailnet (a remote runtime's self-registration and catalog sync) fails
// with no symptom on this side at all.
//
// Scoped to `--https=443 off`, never `serve reset`: reset drops the whole
// machine's serve configuration — other ports, TCP forwarders, funnel — none
// of which belongs to devdeck. 443's `/` is the one mapping this function
// owns, and it owns it exclusively.
func tailscaleServeClearArgs() []string { return []string{"serve", "--https=443", "off"} }

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
	// Best-effort and deliberately not fatal: "there was nothing to remove" is
	// the normal, healthy case and reports itself as a non-zero exit here, so
	// treating this as an error would fail the common path to fix the rare one.
	// If it genuinely could not clear the listener, the serve below fails with
	// tailscale's own message, which is the one worth showing.
	if err := exec.Command(bin, tailscaleServeClearArgs()...).Run(); err != nil {
		log.Printf("tailscale: no existing 443 listener to clear (%v)", err)
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

// randomHex returns n bytes of crypto/rand as a lowercase hex string, e.g.
// hostExecutable returns the absolute path of the running DevDeck binary, which
// sshthread.Seed bakes into the workspace's devdeck-ssh shim so the agent's tool
// calls re-enter this same executable at its `ssh-tool` subcommand.
//
// Returns "" when the path cannot be resolved or is not a real file, which tells
// Seed to write no shim (see its doc comment) — the tool call then fails as
// "command not found", which is at least an honest report to the agent.
//
// os.Executable is followed by a Stat because it is documented as best-effort on
// some platforms, and a path that does not exist is exactly the input that would
// produce a shim failing with an unrecognisable shell error instead.
// hostsSSHConnection reports whether THIS process is the executor named by
// machineID — i.e. whether it may host that connection's DevOps chat.
//
// Only ever consulted on a hub or a --role both process. A runtime never asks:
// it reaches its InstanceFor branch solely for connections its own catalog
// slice contains, and store.CatalogForMachine builds that slice from
// SSHConnectionsByExecutor, so "this connection is in my replica" already
// means "I am its executor".
//
// True only for a machine flagged IsLocal, which is the desktop's own embedded
// runtime — the same identity sshmgr/executor.go treats as "dial directly
// rather than proxy through myself". Anything else names a separate process,
// and the chat belongs there.
func hostsSSHConnection(st port.Store, machineID string) bool {
	m, err := st.MachineByID(machineID)
	if err != nil {
		return false
	}
	return m.IsLocal
}

func hostExecutable() string {
	exe, err := os.Executable()
	if err != nil {
		log.Printf("agent: cannot resolve executable path; SSH threads will have no devdeck-ssh: %v", err)
		return ""
	}
	if info, err := os.Stat(exe); err != nil || info.IsDir() {
		log.Printf("agent: executable path %q is not usable; SSH threads will have no devdeck-ssh", exe)
		return ""
	}
	return exe
}

// agentPathEnv prepends binDir — an SSH thread workspace's own bin/, holding
// the generated devdeck-ssh shim — to PATH for that thread's agent process, so
// a bare `devdeck-ssh` resolves.
//
// Prepending, not replacing: the agent still needs the rest of its PATH to find
// its own toolchain. Per-workspace rather than one shared directory because the
// shim is written by the same Seed call that writes the thread's binding, so the
// two can never disagree about which executable serves this thread.
func agentPathEnv(binDir string) map[string]string {
	existing := os.Getenv("PATH")
	if existing == "" {
		return map[string]string{"PATH": binDir}
	}
	return map[string]string{"PATH": binDir + string(os.PathListSeparator) + existing}
}

// randomHex(8) -> "1a2b3c4d5e6f7a8b". Mirrors the type-prefixed hex ids used
// throughout the store (internal/store.idGen); agent event/command ids reuse
// the same shape ("ae-"/"ac-" prefixes) rather than inventing a new scheme.
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(b)
}

// sshShellRunner adapts sshmgr.RunShell to service.ShellRunner by closing
// over the same *sshmgr.FilePool every other pooled SSH consumer (SFTP,
// stats polling, RunCommand) already shares — so an SSH chat thread's exec
// tool dials through the exact same cached *ssh.Client per connection as
// the file browser and stats poller, instead of opening a second one.
type sshShellRunner struct {
	pool *sshmgr.FilePool
}

func (r *sshShellRunner) RunShell(ctx context.Context, connectionID, command string) ([]byte, []byte, int, error) {
	return sshmgr.RunShell(ctx, r.pool, connectionID, command)
}

// engineThreadPolicy adapts the orchestration engine's live thread state to
// service.ThreadPolicy: the SSH tool gate reads a thread's RuntimeMode from
// the exact same state the composer's mode pill writes to
// (CmdThreadRuntimeModeSet), so switching a thread's mode mid-session takes
// effect on its very next tool call — there is no separate policy store to
// fall out of sync with it.
type engineThreadPolicy struct {
	engine *orchestration.Engine
}

func (p *engineThreadPolicy) ModeFor(threadID string) (provider.RuntimeMode, bool) {
	t, ok := p.engine.State().Thread(threadID)
	if !ok {
		return "", false
	}
	return t.Mode, true
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
