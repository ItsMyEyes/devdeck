mod bindconfig;
mod browser_tiles;
mod hubapi;
mod hubmode;
mod open_with;
mod sidecar;
mod tailscale;

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use browser_tiles::BrowserTiles;
use tauri::menu::{Menu, SubmenuBuilder};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Current sidecar child, so app exit can kill it (kill() consumes the child).
struct ServerProc(Mutex<Option<CommandChild>>);
/// Current background remote-mode runtime child, so app exit can kill it.
struct RuntimeServerProc(Mutex<Option<CommandChild>>);
/// Last runtime-registration failure (reason, hub_url), if any, shown on
/// demand via the "⚠ Runtime not registered" menu item.
struct RuntimeWarning(Mutex<Option<(String, String)>>);
/// Last local-hub sidecar launch failure message, if any, shown on
/// error.html. Read via the get_startup_error command rather than injected
/// with win.eval right after win.navigate — that eval routinely lost the
/// race against the new page finishing its load, leaving error.html's
/// static placeholder text on screen instead of the real message.
struct StartupError(Mutex<Option<String>>);
/// Set on ExitRequested so the monitor loop stops respawning during shutdown.
struct ShuttingDown(AtomicBool);
/// Port the local hub sidecar ACTUALLY bound, recorded once its listen line is
/// parsed. `sidecar::HUB_PORT` is only what the shell asks for — it falls back
/// to an OS-assigned port whenever something already holds 8989 — so anything
/// reporting a reachable URL has to read this, not the preferred port.
struct BoundPort(Mutex<Option<u16>>);

const MAX_RESPAWNS: u32 = 3;
const CHANGE_HUB_MENU_ID: &str = "change-hub";
const RUNTIME_WARNING_MENU_ID: &str = "runtime-warning";

/// Scheme the app's own bundled pages (choose/error/runtime-warning) are
/// served and navigated on, instead of Tauri's generic `tauri://`. Tauri's
/// built-in `tauri` protocol can't be renamed — it stays registered and still
/// resolves — but nothing here navigates to it anymore.
///
/// Registering our own protocol is what makes this safe for the ACL: Tauri
/// treats any user-registered scheme as a *local* origin
/// (`Webview::is_local_url`), so these pages keep the `allow-hub-mode` /
/// `allow-diagnostics` command access that `capabilities/default.json` grants
/// local windows. A plain unregistered scheme would be classified remote and
/// every `invoke` from those pages would be denied.
const APP_SCHEME: &str = "devdeck";

/// URL of a page bundled in `frontendDist`, on the app's own scheme:
/// `devdeck://localhost/<page>` on macOS/Linux. Windows and Android serve
/// custom protocols over `http://<scheme>.localhost/<page>` instead.
fn bundled_page_url(page: &str) -> String {
    if cfg!(windows) {
        format!("http://{APP_SCHEME}.localhost/{page}")
    } else {
        format!("{APP_SCHEME}://localhost/{page}")
    }
}

/// Serves `frontendDist` assets on [`APP_SCHEME`], mirroring what Tauri's
/// built-in `tauri://` handler does: `asset_resolver()` is the same lookup it
/// uses, so path normalisation, the `.html` fallback and the configured CSP
/// header all behave identically.
fn serve_bundled_asset<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};

    match ctx.app_handle().asset_resolver().get(request.uri().path().to_string()) {
        Some(asset) => {
            let mut builder = Response::builder().status(StatusCode::OK).header(CONTENT_TYPE, &asset.mime_type);
            if let Some(csp) = &asset.csp_header {
                builder = builder.header("Content-Security-Policy", csp);
            }
            builder.body(asset.bytes).expect("static asset response")
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .expect("static not-found response"),
    }
}

enum LaunchEnd {
    /// Process exited; respawn unless shutting down or out of attempts.
    Crashed,
    /// Never became ready — navigate to the error page and stop.
    Failed(String),
}

/// Builds the app's menu bar: a "DevDeck" submenu holding `items` (id, label
/// pairs), plus a standard Edit submenu (Cut/Copy/Paste). On macOS the menubar
/// may only contain Submenus — a bare top-level `.text()` item (the previous
/// approach) leaves the OS with no native Edit menu, and without it Cmd+C/Cmd+V
/// have nothing to bind to, so copy/paste silently stops working in every
/// WKWebView text input in the app.
///
/// Select All is deliberately NOT in that list, even though it is the obvious
/// fourth item. macOS matches a menu item's key equivalent in
/// `NSApplication.sendEvent:`, *before* the key event reaches the first
/// responder, so a `Select All` item claims Cmd+A app-wide and the webview
/// never sees a `keydown` for it. The menu then sends the native `selectAll:`
/// down the responder chain, and WKWebView runs it against whatever DOM
/// element has focus — which inside Monaco is its small hidden input buffer,
/// not the document. The result is a Cmd+A that appears to do nothing at all
/// in the code editor.
///
/// Cut/Copy/Paste are safe on that same path precisely because Monaco keeps
/// the current selection mirrored in that hidden input for the clipboard to
/// act on; "select all" has no equivalent it can express there.
///
/// Dropping the item costs nothing: WebKit already implements Cmd+A itself for
/// `<input>`, `<textarea>` and `contenteditable` (verified against the WebKit
/// engine with no Edit menu present), and Monaco and Tiptap each bind the
/// chord in JS. All three only need the event to actually reach the page.
fn build_menu<R: tauri::Runtime>(app: &AppHandle<R>, items: &[(&str, &str)]) -> tauri::Result<Menu<R>> {
    let mut app_menu = SubmenuBuilder::new(app, "DevDeck");
    for (id, label) in items {
        app_menu = app_menu.text(*id, *label);
    }
    let app_menu = app_menu.build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit").cut().copy().paste().build()?;

    let menu = Menu::new(app)?;
    menu.append(&app_menu)?;
    menu.append(&edit_menu)?;
    Ok(menu)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol(APP_SCHEME, serve_bundled_asset)
        .manage(BrowserTiles::new())
        .manage(open_with::OpenWithTempFiles::new())
        .on_page_load(|webview, payload| {
            // Global hook (fires for every webview in the app, including
            // the main UI) filtered to just the Browser tab's own child
            // webviews, so the React address bar can react to in-page
            // navigation (the user clicking a link inside the native
            // webview) instead of only explicit typed-URL navigation.
            if !webview.label().starts_with("browser-") {
                return;
            }
            // Previously fired this same event for both Started and
            // Finished, so `loading` flipped back to false almost
            // immediately after every navigation — the toolbar's
            // Reload<->Stop icon swap (chrome-replication design spec
            // §3.3) depends on this actually distinguishing the two.
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let _ = webview.emit(
                "browser-tile-page-load",
                serde_json::json!({
                    "label": webview.label(),
                    "url": payload.url().to_string(),
                    "loading": loading,
                }),
            );
        })
        .invoke_handler(tauri::generate_handler![
            browser_tiles::browser_tile_open,
            browser_tiles::browser_tile_navigate,
            browser_tiles::browser_tile_reload,
            browser_tiles::browser_tile_back,
            browser_tiles::browser_tile_forward,
            browser_tiles::browser_tile_set_bounds,
            browser_tiles::browser_tile_hide,
            browser_tiles::browser_tile_show,
            browser_tiles::browser_tile_close,
            browser_tiles::browser_tile_set_zoom,
            browser_tiles::browser_tile_find,
            browser_tiles::browser_tile_find_clear,
            choose_hub_mode,
            change_hub,
            get_bind_config,
            set_bind_config,
            get_startup_error,
            read_sidecar_log,
            open_log_file,
            open_external_url,
            get_runtime_warning,
            prepare_for_update,
            open_with::open_with_external,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) && std::env::var_os("DEVDECK_TAURI_DEV_FULL").is_none() {
                // `tauri dev`: window already points at the Vite dev server
                // (devUrl); the Go backend comes from `npm run dev`. Set
                // DEVDECK_TAURI_DEV_FULL=1 (see `make dev-tauri-full`) to run
                // this same hub-mode/sidecar/respawn flow in dev instead.
                return Ok(());
            }
            app.manage(ServerProc(Mutex::new(None)));
            app.manage(RuntimeServerProc(Mutex::new(None)));
            app.manage(RuntimeWarning(Mutex::new(None)));
            app.manage(StartupError(Mutex::new(None)));
            app.manage(ShuttingDown(AtomicBool::new(false)));
            app.manage(BoundPort(Mutex::new(None)));
            // Native menu bar is a macOS-only workaround (see `build_menu`'s
            // doc comment: WKWebView loses Cmd+C/Cmd+V without a native Edit
            // submenu). Windows/Linux windows now run `decorations: false`
            // (tauri.windows.conf.json / tauri.linux.conf.json) to match
            // macOS's chrome-free look, and GTK/Win32 render a `set_menu`
            // bar as a real in-window row regardless of decorations — so
            // setting it there would just recreate a shorter version of the
            // native-titlebar-plus-menu double bar this change removes.
            // Ctrl+C/Ctrl+V need no such menu on Windows/Linux; "Change Hub…"
            // stays reachable from Settings (`changeHub()` in
            // desktopBridge.ts) either way.
            if cfg!(target_os = "macos") {
                let menu = build_menu(app.handle(), &[(CHANGE_HUB_MENU_ID, "Change Hub…")])?;
                app.set_menu(menu)?;
                app.on_menu_event(move |app_handle, event| {
                    if event.id() == CHANGE_HUB_MENU_ID {
                        let _ = change_hub(app_handle.clone());
                    } else if event.id() == RUNTIME_WARNING_MENU_ID {
                        show_runtime_warning(app_handle);
                    }
                });
            }
            let handle = app.handle().clone();
            // A raw SIGTERM (killall, forced logout, `pkill`) bypasses AppKit's
            // quit sequence entirely, so RunEvent::ExitRequested/Exit below never
            // fires and the sidecar is orphaned. Handle it explicitly on unix.
            #[cfg(unix)]
            install_signal_handlers(handle.clone());
            tauri::async_runtime::spawn(async move { start(&handle).await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                kill_sidecar(handle);
                open_with::cleanup_all(handle);
            }
            _ => {}
        });
}

/// Resolves which hub mode this install is in (or shows the first-run
/// choice screen if none is saved yet) and proceeds accordingly.
async fn start(handle: &AppHandle) {
    let data_dir = match handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            show_error(handle, &format!("resolve app data dir: {e}"));
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        show_error(handle, &format!("create app data dir: {e}"));
        return;
    }
    match hubmode::load(&data_dir) {
        Some(mode) => proceed_with_mode(handle, mode).await,
        None => show_choose_screen(handle),
    }
}

/// Tauri command invoked from choose.html once the operator picks a mode.
/// Persists the choice, then proceeds the same way a saved-mode launch
/// would (spawn the local sidecar, or navigate to the remote hub).
#[tauri::command]
async fn choose_hub_mode(
    app: AppHandle,
    mode: String,
    url: Option<String>,
    key: Option<String>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let hub_mode = match mode.as_str() {
        "local" => hubmode::HubMode::Local,
        "remote" => hubmode::HubMode::Remote {
            url: url.ok_or("url is required for remote mode")?,
            key: key.ok_or("key is required for remote mode")?,
        },
        other => return Err(format!("unknown hub mode {other}")),
    };
    hubmode::save(&data_dir, &hub_mode).map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { proceed_with_mode(&handle, hub_mode).await });
    Ok(())
}

/// Clears the saved hub mode and restarts the app. On restart, `start`
/// (see Step 3 of Task 6) finds no saved mode and shows the first-run
/// choice screen again. Using a full app restart (rather than hand-rolled
/// cross-task cancellation of the running respawn loop) means the normal
/// RunEvent::Exit handler kills any local sidecar exactly as it would on a
/// real quit — no separate teardown path to get right.
#[tauri::command]
fn change_hub(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    hubmode::clear(&data_dir).map_err(|e| e.to_string())?;
    app.restart();
}

/// What Settings › Network renders: the saved bind host, this device's
/// dialable interfaces, and the address to actually show for the current
/// choice (None while bound to loopback, since there is nothing to hand out).
#[derive(serde::Serialize)]
struct BindConfigInfo {
    host: String,
    interfaces: Vec<bindconfig::Interface>,
    #[serde(rename = "displayHost")]
    display_host: Option<String>,
    /// The port the hub is listening on RIGHT NOW, not the one the shell
    /// prefers — those differ whenever 8989 was already taken.
    #[serde(rename = "hubPort")]
    hub_port: u16,
    /// False when the hub had to take an OS-assigned port, so the UI can say
    /// the address is not stable across restarts.
    #[serde(rename = "portIsPreferred")]
    port_is_preferred: bool,
}

#[tauri::command]
fn get_bind_config(app: AppHandle) -> Result<BindConfigInfo, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let host = bindconfig::load(&data_dir);
    // Falls back to the preferred port only before the first listen line has
    // been parsed, which the settings UI cannot reach — it is served by the
    // very hub whose port this is.
    let bound = (*app.state::<BoundPort>().0.lock().unwrap()).unwrap_or(sidecar::HUB_PORT);
    Ok(BindConfigInfo {
        display_host: bindconfig::display_host(&host),
        host,
        interfaces: bindconfig::interfaces(),
        hub_port: bound,
        port_is_preferred: bound == sidecar::HUB_PORT,
    })
}

/// Persists a new bind host and restarts the app so the sidecars are respawned
/// against it.
///
/// A full app restart rather than hand-rolled cancellation of the running
/// respawn loop, for the same reason `change_hub` does it: the normal
/// RunEvent::Exit handler already kills both sidecar children exactly as a
/// real quit would, so there is no second teardown path to keep correct. The
/// host is validated before anything is written — an unbindable `--addr` is
/// fatal on the Go side and would take the respawn loop down with it, which
/// from the operator's seat looks like the app simply failing to come back.
#[tauri::command]
fn set_bind_config(app: AppHandle, host: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    bindconfig::save(&data_dir, host.trim())?;
    app.restart();
}

async fn proceed_with_mode(handle: &AppHandle, mode: hubmode::HubMode) {
    match mode {
        hubmode::HubMode::Remote { url, key } => {
            navigate_remote(handle, &url);
            let handle2 = handle.clone();
            tauri::async_runtime::spawn(async move { run_remote_runtime_loop(&handle2, &url, &key).await });
        }
        hubmode::HubMode::Local => run_local_respawn_loop(handle).await,
    }
}

/// Records a runtime-registration failure and logs it. On macOS, swaps the
/// menu bar to surface a "⚠ Runtime not registered" item the operator can
/// click for details — without ever blocking or interrupting whatever
/// they're doing in the remote hub's UI. Windows/Linux never have a native
/// menu to click (see the `cfg!(target_os = "macos")` guard in `setup`
/// above), so there is no non-interrupting affordance to offer there; this
/// navigates straight to the same warning page instead of leaving the
/// failure undiscoverable.
fn set_runtime_warning_menu(handle: &AppHandle, reason: &str, hub_url: &str) {
    log_runtime_line(handle, reason);
    *handle.state::<RuntimeWarning>().0.lock().unwrap() = Some((reason.to_string(), hub_url.to_string()));
    if cfg!(target_os = "macos") {
        if let Ok(menu) = build_menu(
            handle,
            &[(CHANGE_HUB_MENU_ID, "Change Hub…"), (RUNTIME_WARNING_MENU_ID, "⚠ Runtime not registered")],
        ) {
            let _ = handle.set_menu(menu);
        }
    } else {
        show_runtime_warning(handle);
    }
}

/// Navigates the main window to the bundled runtime-warning page. The page
/// itself pulls the failure reason, log path, and remote hub URL via the
/// get_runtime_warning command once it has actually loaded, rather than
/// having them injected with win.eval right after win.navigate — that eval
/// routinely lost the race against the new page's load, leaving the page's
/// static placeholder text on screen instead of the real values.
fn show_runtime_warning(handle: &AppHandle) {
    let warning_url = bundled_page_url("runtime-warning.html");
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(warning_url.parse().expect("static runtime warning url"));
        let _ = win.show();
    }
}

enum RuntimeLaunchEnd {
    /// Process exited; respawn unless shutting down or out of attempts.
    Crashed,
    /// Never became ready — stop trying and surface the failure.
    Failed(String),
}

/// Background loop for the desktop's remote-mode local runtime: derives a
/// Tailscale public URL, then spawns/respawns the sidecar as `--role
/// runtime` so it self-registers with the operator-supplied hub. Runs
/// fully in the background — the main window has already navigated to the
/// remote hub via `navigate_remote` and is never blocked by this.
async fn run_remote_runtime_loop(handle: &AppHandle, hub_url: &str, hub_key: &str) {
    let bind_host = match handle.path().app_data_dir() {
        Ok(dir) => bindconfig::load(&dir),
        Err(_) => bindconfig::LOOPBACK.to_string(),
    };
    // Tailnet when Tailscale can front this runtime, LAN when it can't but the
    // operator has bound something reachable anyway. Only a loopback bind with
    // no tailnet leaves the hub genuinely no route to this runtime, and that is
    // the one case still worth warning about — this used to be the ONLY
    // outcome of a failed Tailscale lookup, which made a perfectly reachable
    // LAN runtime refuse to start.
    let public_url = match tailscale::public_url().await {
        Ok(u) => Some(u),
        Err(e) if bindconfig::is_loopback(&bind_host) => {
            let msg = format!(
                "Tailscale lookup failed: {e}. This runtime is bound to {bind_host}, so the hub has no way to reach it — set a bind address in Settings › Network, or sign in to Tailscale."
            );
            set_runtime_warning_menu(handle, &msg, hub_url);
            return;
        }
        Err(e) => {
            log_runtime_line(
                handle,
                &format!("tailscale unavailable ({e}); registering over the local network from {bind_host}"),
            );
            None
        }
    };
    let mut respawns = 0;
    loop {
        match launch_runtime_once(handle, hub_url, hub_key, public_url.as_deref(), &bind_host).await {
            RuntimeLaunchEnd::Failed(msg) => {
                set_runtime_warning_menu(handle, &msg, hub_url);
                break;
            }
            RuntimeLaunchEnd::Crashed => {
                if handle.state::<ShuttingDown>().0.load(Ordering::SeqCst) {
                    break;
                }
                respawns += 1;
                if respawns > MAX_RESPAWNS {
                    set_runtime_warning_menu(handle, "runtime sidecar crashed repeatedly", hub_url);
                    break;
                }
            }
        }
    }
}

/// Appends one line to the runtime log without an active child process
/// (e.g. a pre-spawn Tailscale failure). Best-effort: logging failures are
/// swallowed, matching this file's existing style for non-critical I/O.
fn log_runtime_line(handle: &AppHandle, msg: &str) {
    if let Ok(log_dir) = handle.path().app_log_dir() {
        if let Ok(mut log) = sidecar::open_runtime_log(&log_dir) {
            let _ = writeln!(log, "{msg}");
        }
    }
}

/// One full runtime sidecar lifetime: spawn, wait ready, then pump events
/// until the process terminates. Unlike `launch_once`, there is no window
/// navigation here — the main window is already showing the remote hub.
async fn launch_runtime_once(
    handle: &AppHandle,
    hub_url: &str,
    hub_key: &str,
    public_url: Option<&str>,
    bind_host: &str,
) -> RuntimeLaunchEnd {
    let data_dir = match handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => return RuntimeLaunchEnd::Failed(format!("resolve app data dir: {e}")),
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        return RuntimeLaunchEnd::Failed(format!("create app data dir: {e}"));
    }
    let log_dir = match handle.path().app_log_dir() {
        Ok(d) => d,
        Err(e) => return RuntimeLaunchEnd::Failed(format!("resolve app log dir: {e}")),
    };
    let mut log = match sidecar::open_runtime_log(&log_dir) {
        Ok(f) => f,
        Err(e) => return RuntimeLaunchEnd::Failed(format!("open runtime log: {e}")),
    };

    let key = match sidecar::persisted_runtime_key(&data_dir) {
        Ok(k) => k,
        Err(e) => return RuntimeLaunchEnd::Failed(format!("persist runtime key: {e}")),
    };
    let name = hubapi::device_name();
    let cmd = match handle.shell().sidecar("devdeck-server") {
        Ok(c) => c.args(sidecar::runtime_args(
            &data_dir, &key, hub_url, hub_key, public_url, &name, bind_host,
        )),
        Err(e) => return RuntimeLaunchEnd::Failed(format!("resolve sidecar binary: {e}")),
    };
    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => return RuntimeLaunchEnd::Failed(format!("spawn devdeck-server (runtime): {e}")),
    };
    *handle.state::<RuntimeServerProc>().0.lock().unwrap() = Some(child);

    // Phase 1: wait for the listen line (or early termination / timeout).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(sidecar::READY_TIMEOUT_SECS);
    let mut port: Option<u16> = None;
    while port.is_none() {
        let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => {
                return RuntimeLaunchEnd::Failed(
                    "devdeck-server (runtime) produced no listen line in time".into(),
                )
            }
            Ok(None) => return RuntimeLaunchEnd::Crashed,
            Ok(Some(ev)) => ev,
        };
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let _ = writeln!(log, "{}", line.trim_end());
                port = sidecar::parse_listen_port(&line);
            }
            CommandEvent::Terminated(_) => return RuntimeLaunchEnd::Crashed,
            _ => {}
        }
    }
    let port = port.unwrap();

    // Phase 2: readiness. No navigation here — the window is already
    // showing the remote hub via navigate_remote.
    // Same reasoning as launch_once: a runtime pinned to one interface has
    // nothing listening on loopback, so the readiness poll has to follow it.
    if let Err(msg) = hubapi::wait_healthy(
        &reachable_host(bind_host),
        port,
        Duration::from_secs(sidecar::READY_TIMEOUT_SECS),
    )
    .await
    {
        return RuntimeLaunchEnd::Failed(msg);
    }

    // Phase 3: pump output to the log until the process dies.
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let _ = writeln!(log, "{}", String::from_utf8_lossy(&bytes).trim_end());
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    RuntimeLaunchEnd::Crashed
}

/// Navigates the main window straight at an operator-hosted hub URL and
/// shows it. No sidecar is spawned — the window behaves like a plain
/// browser tab against that hub's existing web SPA/session-cookie login.
fn navigate_remote(handle: &AppHandle, url: &str) {
    let Ok(parsed) = url.parse() else {
        show_error(handle, &format!("invalid hub URL: {url}"));
        return;
    };
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(parsed);
        let _ = win.show();
    }
}

/// The sidecar spawn/respawn loop, reachable from both a first-run choice
/// and a saved "local" mode from a previous launch.
async fn run_local_respawn_loop(handle: &AppHandle) {
    let mut respawns = 0;
    loop {
        match launch_once(handle).await {
            LaunchEnd::Failed(msg) => {
                show_error(handle, &msg);
                break;
            }
            LaunchEnd::Crashed => {
                if handle.state::<ShuttingDown>().0.load(Ordering::SeqCst) {
                    break;
                }
                respawns += 1;
                if respawns > MAX_RESPAWNS {
                    show_error(handle, "devdeck-server crashed repeatedly");
                    break;
                }
            }
        }
    }
}

/// Navigates the main window to the bundled first-run choice screen.
fn show_choose_screen(handle: &AppHandle) {
    let url = bundled_page_url("choose.html");
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(url.parse().expect("static choose url"));
        let _ = win.show();
    }
}

/// Marks shutdown (stops the respawn loop) and kills both the local-hub and
/// background remote-mode runtime sidecar children, if either was spawned.
/// Idempotent: each child is taken out of its state slot, so a second call
/// (e.g. RunEvent::Exit firing after a signal handler already ran this) is
/// a no-op.
fn kill_sidecar(handle: &AppHandle) {
    handle.state::<ShuttingDown>().0.store(true, Ordering::SeqCst);
    if let Some(child) = handle.state::<ServerProc>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
    if let Some(child) = handle.state::<RuntimeServerProc>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Kills the sidecar on a raw SIGTERM/SIGINT, then asks Tauri to exit
/// normally (which will also run kill_sidecar via RunEvent::Exit, safely a
/// no-op the second time).
#[cfg(unix)]
fn install_signal_handlers(handle: AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};
    tauri::async_runtime::spawn(async move {
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(_) => return,
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        kill_sidecar(&handle);
        handle.exit(0);
    });
}

/// The address this app uses to reach its OWN hub, given the operator's bind
/// choice.
///
/// Loopback for a loopback bind (obviously) and for an all-interfaces bind,
/// where 0.0.0.0 covers 127.0.0.1 too — keeping the desktop on loopback there
/// preserves the origin the static capability is written against. A bind
/// pinned to one specific interface is the only case that has to change: it
/// leaves nothing listening on loopback at all.
fn reachable_host(bind_host: &str) -> String {
    if bindconfig::is_loopback(bind_host) || bind_host == bindconfig::ALL_INTERFACES {
        return sidecar::LOOPBACK.to_string();
    }
    bind_host.to_string()
}

/// Grants the main window the same command set at `http://<host>:*` that
/// capabilities/default.json grants at loopback.
///
/// Built as JSON at runtime because the static manifest cannot name an
/// address the operator has not chosen yet. Kept deliberately in lockstep
/// with capabilities/default.json — a permission added there and missed here
/// silently stops working the moment a hub is pinned to one interface.
fn grant_origin_capability(handle: &AppHandle, host: &str) -> tauri::Result<()> {
    let capability = serde_json::json!({
        "identifier": format!("bound-origin-{host}"),
        "description": "Same commands as the default capability, for a hub pinned to a specific interface.",
        "windows": ["main"],
        "remote": { "urls": [format!("http://{host}:*")] },
        "permissions": [
            "core:default",
            "core:window:allow-start-dragging",
            "allow-browser-tiles",
            "allow-hub-mode",
            "allow-bind-config",
            "allow-diagnostics",
            "allow-prepare-for-update",
            "allow-open-with",
            "process:allow-restart",
            "dialog:allow-save",
            "fs:allow-write-file",
            "updater:default",
            { "identifier": "opener:allow-open-path", "allow": [{ "path": "$APPLOG/*" }] }
        ]
    })
    .to_string();
    handle.add_capability(capability)
}

/// One full sidecar lifetime: spawn, wait ready, register machine, navigate,
/// then pump events until the process terminates.
async fn launch_once(handle: &AppHandle) -> LaunchEnd {
    let data_dir = match handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => return LaunchEnd::Failed(format!("resolve app data dir: {e}")),
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        return LaunchEnd::Failed(format!("create app data dir: {e}"));
    }
    let log_dir = match handle.path().app_log_dir() {
        Ok(d) => d,
        Err(e) => return LaunchEnd::Failed(format!("resolve app log dir: {e}")),
    };
    let mut log = match sidecar::open_sidecar_log(&log_dir) {
        Ok(f) => f,
        Err(e) => return LaunchEnd::Failed(format!("open sidecar log: {e}")),
    };

    let key = sidecar::generate_key();
    // Non-blocking preflight: if Tailscale isn't installed/logged in, the
    // local hub still starts (local-only) — see
    // docs/superpowers/specs/2026-07-17-local-hub-tailscale-reachability-design.md.
    let tailscale_probe = tailscale::public_url().await;
    let enable_tailscale_serve = tailscale_probe.is_ok();
    // Logged either way: when this comes back Err the hub is started without
    // --enable-tailscale-serve, and /api/tailscale-status can only report
    // that fact, not the reason behind it. Without this line the operator saw
    // an exposure failure with no record anywhere of what the preflight hit.
    if let Err(e) = &tailscale_probe {
        let _ = writeln!(log, "devdeck: tailscale preflight failed, hub will not be exposed on the tailnet: {e}");
    }
    let bind_host = bindconfig::load(&data_dir);
    let _ = writeln!(log, "devdeck: binding hub to {bind_host}");
    let cmd = match handle.shell().sidecar("devdeck-server") {
        Ok(c) => c.args(sidecar::sidecar_args(&data_dir, &key, enable_tailscale_serve, &bind_host)),
        Err(e) => return LaunchEnd::Failed(format!("resolve sidecar binary: {e}")),
    };
    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => return LaunchEnd::Failed(format!("spawn devdeck-server: {e}")),
    };
    *handle.state::<ServerProc>().0.lock().unwrap() = Some(child);

    // Phase 1: wait for the listen line (or early termination / timeout).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(sidecar::READY_TIMEOUT_SECS);
    let mut port: Option<u16> = None;
    while port.is_none() {
        let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => return LaunchEnd::Failed("devdeck-server produced no listen line in time".into()),
            Ok(None) => return LaunchEnd::Crashed,
            Ok(Some(ev)) => ev,
        };
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let _ = writeln!(log, "{}", line.trim_end());
                port = sidecar::parse_listen_port(&line);
            }
            CommandEvent::Terminated(_) => return LaunchEnd::Crashed,
            _ => {}
        }
    }
    let port = port.unwrap();
    *handle.state::<BoundPort>().0.lock().unwrap() = Some(port);

    // Phase 2: readiness + local machine registration + navigation.
    let host = reachable_host(&bind_host);
    if host != sidecar::LOOPBACK {
        // A hub pinned to one interface has NOTHING listening on loopback, so
        // this window's origin stops being the loopback URL the static
        // capability (capabilities/default.json `remote.urls`) grants command
        // access to — and Settings › Network is itself a Tauri command, so
        // without this the operator would be locked out of the one panel that
        // could undo the change. Granted to exactly the bound origin rather
        // than a LAN wildcard: a remote-mode hub on someone else's LAN must
        // not inherit command access it does not have today.
        if let Err(e) = grant_origin_capability(handle, &host) {
            let _ = writeln!(log, "devdeck: could not grant ACL for {host}: {e}");
        }
    }
    if let Err(msg) =
        hubapi::wait_healthy(&host, port, Duration::from_secs(sidecar::READY_TIMEOUT_SECS)).await
    {
        return LaunchEnd::Failed(msg);
    }
    // Between health and registration: prove this is OUR child. Two hubs can
    // legitimately hold one port (see sidecar::port_has_a_server), and without
    // this the collision surfaced as an opaque 401 from the line below.
    if let Err(msg) = hubapi::verify_own_hub(&host, port, &key).await {
        let _ = writeln!(log, "devdeck: {msg}");
        return LaunchEnd::Failed(msg);
    }
    if let Err(msg) = hubapi::upsert_local_machine(&host, port, &key, &data_dir).await {
        return LaunchEnd::Failed(msg);
    }
    if let Some(win) = handle.get_webview_window("main") {
        let url = format!("http://{host}:{port}/?key={key}");
        let Ok(parsed) = url.parse() else {
            return LaunchEnd::Failed(format!("build devdeck ui url from bind host {host:?}"));
        };
        if let Err(e) = win.navigate(parsed) {
            return LaunchEnd::Failed(format!("navigate to devdeck ui: {e}"));
        }
        let _ = win.show();
    }

    // Phase 3: pump output to the log until the process dies.
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let _ = writeln!(log, "{}", String::from_utf8_lossy(&bytes).trim_end());
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    LaunchEnd::Crashed
}

/// Sends the main window to the bundled error page with the failure
/// message. The page itself pulls the message (and the sidecar log) via the
/// get_startup_error/read_sidecar_log commands once it has actually loaded,
/// rather than having them injected with win.eval right after win.navigate
/// — that eval routinely lost the race against the new page's load, leaving
/// error.html's static placeholder text on screen instead of the real
/// message (what "app log directory / sidecar.log" verbatim on screen
/// means: the substitution never ran).
fn show_error(handle: &AppHandle, msg: &str) {
    *handle.state::<StartupError>().0.lock().unwrap() = Some(msg.to_string());
    let error_url = bundled_page_url("error.html");
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(error_url.parse().expect("static error url"));
        let _ = win.show();
    }
}

/// Absolute path to a log file this app writes under its log directory
/// (sidecar.log, runtime-sidecar.log), resolved fresh on each call rather
/// than cached — used by both the read/open commands below and kept in one
/// place so they can never disagree on the path.
fn app_log_path(app: &AppHandle, filename: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| format!("resolve app log dir: {e}"))?;
    Ok(dir.join(filename))
}

/// Returns the last local-hub sidecar launch failure message, if any, for
/// error.html to render on load.
#[tauri::command]
fn get_startup_error(app: AppHandle) -> Option<String> {
    app.state::<StartupError>().0.lock().unwrap().clone()
}

/// Returns the last runtime-registration failure (reason, log path, hub
/// URL), if any, for runtime-warning.html to render on load.
#[derive(serde::Serialize)]
struct RuntimeWarningInfo {
    reason: String,
    #[serde(rename = "logPath")]
    log_path: String,
    #[serde(rename = "hubUrl")]
    hub_url: String,
}

/// Kills the sidecar before the updater replaces the app bundle.
///
/// The frontend calls this immediately before `update.install()`. It cannot be
/// left to `RunEvent::Exit`, for the same reason the unix signal handler above
/// cannot: on Windows, tauri-plugin-updater's `install_inner` runs its
/// `on_before_exit` hook, `ShellExecuteW`s the NSIS installer, and then calls
/// `std::process::exit(0)` outright (updater.rs:865 in 2.10.1). A hard
/// `process::exit` bypasses Tauri's event loop, so the `RunEvent::Exit` arm in
/// `run()` never executes. The plugin's own `Builder` exposes no
/// `on_before_exit`, so an explicit command is the only hook available.
///
/// Left un-killed, `devdeck-server.exe` outlives the app (tauri-plugin-shell
/// does not put sidecars in a job object), keeps the SQLite file and the
/// loopback port open, and blocks the installer from overwriting its own
/// binary inside the install directory.
///
/// It matters on macOS and Linux too: the sidecar executes from inside the
/// bundle the updater is about to replace wholesale.
///
/// Safe to call more than once — `kill_sidecar` `take()`s each child, so a
/// second call is a no-op, exactly as it already is for signal-then-Exit.
#[tauri::command]
fn prepare_for_update(app: AppHandle) {
    kill_sidecar(&app);
}

#[tauri::command]
fn get_runtime_warning(app: AppHandle) -> Option<RuntimeWarningInfo> {
    let saved = app.state::<RuntimeWarning>().0.lock().unwrap().clone();
    saved.map(|(reason, hub_url)| RuntimeWarningInfo {
        reason,
        log_path: app_log_path(&app, "runtime-sidecar.log")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|e| e),
        hub_url,
    })
}

/// Sidecar log content shipped to error.html — bounded to the last
/// SIDECAR_LOG_TAIL_BYTES so a multi-run, multi-MB log (see
/// sidecar::LOG_TRUNCATE_BYTES) doesn't get sent across IPC whole.
const SIDECAR_LOG_TAIL_BYTES: usize = 64 * 1024;

#[derive(serde::Serialize)]
struct SidecarLog {
    path: String,
    content: String,
    truncated: bool,
}

/// Reads the tail of the local-hub sidecar's log file, so error.html can
/// show it in-page instead of sending the operator hunting for the file
/// themselves.
#[tauri::command]
fn read_sidecar_log(app: AppHandle) -> Result<SidecarLog, String> {
    let path = app_log_path(&app, "sidecar.log")?;
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let truncated = bytes.len() > SIDECAR_LOG_TAIL_BYTES;
    let tail = if truncated { &bytes[bytes.len() - SIDECAR_LOG_TAIL_BYTES..] } else { &bytes[..] };
    Ok(SidecarLog {
        path: path.to_string_lossy().into_owned(),
        content: String::from_utf8_lossy(tail).into_owned(),
        truncated,
    })
}

/// Opens the sidecar log file with the OS's default handler, so the
/// operator can inspect it (or attach it to a bug report) without
/// navigating Finder/Explorer to the app's log directory by hand.
#[tauri::command]
fn open_log_file(app: AppHandle) -> Result<(), String> {
    let path = app_log_path(&app, "sidecar.log")?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Opens a terminal URL in the operating system's default browser.
#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = external_url(&url)?;
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

fn external_url(value: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| "invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http and https URLs can be opened".to_string());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{external_url, reachable_host};

    /// An all-interfaces bind covers loopback, so the desktop keeps the
    /// origin the STATIC capability is written against — no runtime ACL grant
    /// needed, and none should be triggered.
    #[test]
    fn reachable_host_stays_on_loopback_for_loopback_and_all_interfaces() {
        assert_eq!(reachable_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(reachable_host("0.0.0.0"), "127.0.0.1");
        assert_eq!(reachable_host("::1"), "127.0.0.1");
    }

    /// A pinned bind is the one case with nothing on loopback — the shell has
    /// to follow it or its own health poll, machine row and navigation all
    /// hit a closed port.
    #[test]
    fn reachable_host_follows_a_pinned_interface() {
        assert_eq!(reachable_host("192.168.1.24"), "192.168.1.24");
        assert_eq!(reachable_host("10.0.0.5"), "10.0.0.5");
    }

    #[test]
    fn external_url_allows_only_web_urls() {
        assert!(external_url("http://localhost:3000").is_ok());
        assert!(external_url("https://example.com").is_ok());
        assert!(external_url("file:///tmp/nope").is_err());
    }
}
