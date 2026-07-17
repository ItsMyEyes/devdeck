mod browser_tiles;
mod hubapi;
mod hubmode;
mod sidecar;
mod tailscale;

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use browser_tiles::BrowserTiles;
use tauri::menu::MenuBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Current sidecar child, so app exit can kill it (kill() consumes the child).
struct ServerProc(Mutex<Option<CommandChild>>);
/// Current background remote-mode runtime child, so app exit can kill it.
struct RuntimeServerProc(Mutex<Option<CommandChild>>);
/// Last runtime-registration failure (reason, hub_url), if any, shown on
/// demand via the "⚠ Runtime not registered" menu item.
struct RuntimeWarning(Mutex<Option<(String, String)>>);
/// Set on ExitRequested so the monitor loop stops respawning during shutdown.
struct ShuttingDown(AtomicBool);

const MAX_RESPAWNS: u32 = 3;
const CHANGE_HUB_MENU_ID: &str = "change-hub";
const RUNTIME_WARNING_MENU_ID: &str = "runtime-warning";

enum LaunchEnd {
    /// Process exited; respawn unless shutting down or out of attempts.
    Crashed,
    /// Never became ready — navigate to the error page and stop.
    Failed(String),
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(BrowserTiles::new())
        .on_page_load(|webview, payload| {
            // Global hook (fires for every webview in the app, including
            // the main UI) filtered to just the Browser tab's own child
            // webviews, so the React address bar can react to in-page
            // navigation (the user clicking a link inside the native
            // webview) instead of only explicit typed-URL navigation.
            if !webview.label().starts_with("browser-") {
                return;
            }
            let _ = webview.emit(
                "browser-tile-page-load",
                serde_json::json!({ "label": webview.label(), "url": payload.url().to_string() }),
            );
        })
        .invoke_handler(tauri::generate_handler![
            browser_tiles::browser_tile_open,
            browser_tiles::browser_tile_navigate,
            browser_tiles::browser_tile_reload,
            browser_tiles::browser_tile_set_bounds,
            browser_tiles::browser_tile_hide,
            browser_tiles::browser_tile_show,
            browser_tiles::browser_tile_close,
            choose_hub_mode,
            change_hub,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                // `tauri dev`: window already points at the Vite dev server
                // (devUrl); the Go backend comes from `npm run dev`.
                return Ok(());
            }
            app.manage(ServerProc(Mutex::new(None)));
            app.manage(RuntimeServerProc(Mutex::new(None)));
            app.manage(RuntimeWarning(Mutex::new(None)));
            app.manage(ShuttingDown(AtomicBool::new(false)));
            let menu = MenuBuilder::new(app).text(CHANGE_HUB_MENU_ID, "Change Hub…").build()?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app_handle, event| {
                if event.id() == CHANGE_HUB_MENU_ID {
                    let _ = change_hub(app_handle.clone());
                } else if event.id() == RUNTIME_WARNING_MENU_ID {
                    let saved = app_handle.state::<RuntimeWarning>().0.lock().unwrap().clone();
                    if let Some((reason, hub_url)) = saved {
                        show_runtime_warning(app_handle, &reason, &hub_url);
                    }
                }
            });
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
            RunEvent::ExitRequested { .. } | RunEvent::Exit => kill_sidecar(handle),
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

/// Records a runtime-registration failure, logs it, and swaps the menu bar
/// to surface a "⚠ Runtime not registered" item the operator can click for
/// details — without ever blocking or interrupting whatever they're doing
/// in the remote hub's UI.
fn set_runtime_warning_menu(handle: &AppHandle, reason: &str, hub_url: &str) {
    log_runtime_line(handle, reason);
    *handle.state::<RuntimeWarning>().0.lock().unwrap() = Some((reason.to_string(), hub_url.to_string()));
    if let Ok(menu) = MenuBuilder::new(handle)
        .text(CHANGE_HUB_MENU_ID, "Change Hub…")
        .text(RUNTIME_WARNING_MENU_ID, "⚠ Runtime not registered")
        .build()
    {
        let _ = handle.set_menu(menu);
    }
}

/// Navigates the main window to the bundled runtime-warning page, injecting
/// the failure reason, log path, and the remote hub URL (for the page's own
/// "Back to hub" button) via `win.eval` — same pattern as `show_error`.
fn show_runtime_warning(handle: &AppHandle, reason: &str, hub_url: &str) {
    let log_path = handle
        .path()
        .app_log_dir()
        .map(|d| d.join("runtime-sidecar.log").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "app log directory / runtime-sidecar.log".into());
    #[cfg(not(windows))]
    let warning_url = "tauri://localhost/runtime-warning.html";
    #[cfg(windows)]
    let warning_url = "http://tauri.localhost/runtime-warning.html";
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(warning_url.parse().expect("static runtime warning url"));
        let _ = win.eval(format!(
            "document.getElementById('reason').textContent = {}; document.getElementById('logpath').textContent = {}; document.body.dataset.hubUrl = {};",
            serde_json::to_string(reason).unwrap_or_default(),
            serde_json::to_string(&log_path).unwrap_or_default(),
            serde_json::to_string(hub_url).unwrap_or_default(),
        ));
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
    let public_url = match tailscale::public_url().await {
        Ok(u) => u,
        Err(e) => {
            let msg = format!("Tailscale lookup failed: {e}");
            set_runtime_warning_menu(handle, &msg, hub_url);
            return;
        }
    };
    let mut respawns = 0;
    loop {
        match launch_runtime_once(handle, hub_url, hub_key, &public_url).await {
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
    public_url: &str,
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
    let cmd = match handle.shell().sidecar("loom-server") {
        Ok(c) => c.args(sidecar::runtime_args(&data_dir, &key, hub_url, hub_key, public_url, &name)),
        Err(e) => return RuntimeLaunchEnd::Failed(format!("resolve sidecar binary: {e}")),
    };
    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => return RuntimeLaunchEnd::Failed(format!("spawn loom-server (runtime): {e}")),
    };
    *handle.state::<RuntimeServerProc>().0.lock().unwrap() = Some(child);

    // Phase 1: wait for the listen line (or early termination / timeout).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(sidecar::READY_TIMEOUT_SECS);
    let mut port: Option<u16> = None;
    while port.is_none() {
        let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => {
                return RuntimeLaunchEnd::Failed(
                    "loom-server (runtime) produced no listen line in time".into(),
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
    if let Err(msg) = hubapi::wait_healthy(port, Duration::from_secs(sidecar::READY_TIMEOUT_SECS)).await {
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
                    show_error(handle, "loom-server crashed repeatedly");
                    break;
                }
            }
        }
    }
}

/// Navigates the main window to the bundled first-run choice screen.
fn show_choose_screen(handle: &AppHandle) {
    #[cfg(not(windows))]
    let url = "tauri://localhost/choose.html";
    #[cfg(windows)]
    let url = "http://tauri.localhost/choose.html";
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
    let enable_tailscale_serve = tailscale::public_url().await.is_ok();
    let cmd = match handle.shell().sidecar("loom-server") {
        Ok(c) => c.args(sidecar::sidecar_args(&data_dir, &key, enable_tailscale_serve)),
        Err(e) => return LaunchEnd::Failed(format!("resolve sidecar binary: {e}")),
    };
    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => return LaunchEnd::Failed(format!("spawn loom-server: {e}")),
    };
    *handle.state::<ServerProc>().0.lock().unwrap() = Some(child);

    // Phase 1: wait for the listen line (or early termination / timeout).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(sidecar::READY_TIMEOUT_SECS);
    let mut port: Option<u16> = None;
    while port.is_none() {
        let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => return LaunchEnd::Failed("loom-server produced no listen line in time".into()),
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

    // Phase 2: readiness + local machine registration + navigation.
    if let Err(msg) = hubapi::wait_healthy(port, Duration::from_secs(sidecar::READY_TIMEOUT_SECS)).await {
        return LaunchEnd::Failed(msg);
    }
    if let Err(msg) = hubapi::upsert_local_machine(port, &key, &data_dir).await {
        return LaunchEnd::Failed(msg);
    }
    if let Some(win) = handle.get_webview_window("main") {
        let url = format!("http://127.0.0.1:{port}/?key={key}");
        if let Err(e) = win.navigate(url.parse().expect("static loopback url")) {
            return LaunchEnd::Failed(format!("navigate to loom ui: {e}"));
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

/// Sends the main window to the bundled error page with the failure message.
fn show_error(handle: &AppHandle, msg: &str) {
    let log_path = handle
        .path()
        .app_log_dir()
        .map(|d| d.join("sidecar.log").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "app log directory / sidecar.log".into());
    // Bundled frontendDist pages are served on the app's custom protocol:
    // tauri://localhost on macOS/Linux, http://tauri.localhost on Windows.
    #[cfg(not(windows))]
    let error_url = "tauri://localhost/error.html";
    #[cfg(windows)]
    let error_url = "http://tauri.localhost/error.html";
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(error_url.parse().expect("static error url"));
        let _ = win.eval(format!(
            "document.getElementById('msg').textContent = {}; document.getElementById('logpath').textContent = {};",
            serde_json::to_string(msg).unwrap_or_default(),
            serde_json::to_string(&log_path).unwrap_or_default(),
        ));
        let _ = win.show();
    }
}
