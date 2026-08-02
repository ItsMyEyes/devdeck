// Native child webviews backing the desktop-only, machine-proxied Browser
// tab. Each open "document" (a Browser tile's own internal tab, see the
// design spec's Decision 2) gets its own real Tauri Webview, overlaid at
// the React placeholder div's on-screen rect and routed through a chosen
// machine's SOCKS5/HTTP forward proxy via `proxy_url`. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

/// Live child webviews, keyed by `webview_label(tab_id, doc_id)`.
/// Mutex-guarded — commands can arrive concurrently (e.g. a resize firing
/// mid-navigation).
pub struct BrowserTiles(Mutex<HashMap<String, tauri::Webview>>);

impl BrowserTiles {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

fn webview_label(tab_id: &str, doc_id: &str) -> String {
    format!("browser-{tab_id}-{doc_id}")
}

/// User-Agent for Browser-tile webviews on macOS. A bare WKWebView reports
/// `…AppleWebKit/605.1.15 (KHTML, like Gecko)` and stops there — no `Version/x`,
/// no `Safari/x` — so any site that parses a browser version out of the UA finds
/// none and falls through to its "please update your browser" branch (YouTube's
/// live chat does exactly this, and the page it serves is the only symptom).
///
/// Shaped as current Safari rather than spoofing Chrome: the engine really is
/// WebKit, so claiming Blink invites sites to ship code paths this webview
/// cannot run. Windows is deliberately left on the WebView2 default, which
/// already carries a full `Chrome/… Edg/…` string. Linux/WebKitGTK is untested
/// here — if it turns out to report a stale `Version/`, it needs its own
/// constant with an X11 platform token, not this Mac one.
///
/// Keep this claiming a *current* browser alongside `browser_proxy.go`'s own
/// `browserUserAgent`, which covers the server-side fetch for the web Browser
/// module. That header cannot help here: the "old browser" screen is rendered
/// client-side from `navigator.userAgent`.
#[cfg(target_os = "macos")]
const BROWSER_TILE_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

/// Creates the native child webview for one Browser-tile document, proxied
/// through `proxy_url` (an `http://` or `socks5://` URL) and immediately
/// navigated to `initial_url`. Called once per document, the first time the
/// user actually navigates somewhere (the bookmarks/blank home page never
/// creates a webview at all).
///
/// Idempotent by label: the frontend's `openedDocsRef` tracking a doc as
/// already-open is a component-local ref, so it resets to empty whenever
/// `BrowserTile` remounts (e.g. `showContent: false` on a non-tiled route,
/// then back). Without this check, a remount would call this command again
/// for a doc whose webview is merely hidden (see `browser_tile_hide`), not
/// destroyed — creating a duplicate, leaking the old one, and forcing a full
/// reload of a page that was never actually closed.
#[tauri::command]
pub fn browser_tile_open(
    app: AppHandle,
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    proxy_url: String,
    initial_url: String,
) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    if state.0.lock().unwrap().contains_key(&label) {
        return Ok(());
    }

    // `add_child` lives on `tauri::window::Window`, not `WebviewWindow`
    // (returned by `get_webview_window`) — unlike the design doc's
    // assumption that the latter derefs to the former, this Tauri version
    // (2.11.5) has no such `Deref` impl. `Manager::get_window` returns the
    // plain `Window` directly.
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let proxy: Url = proxy_url.parse().map_err(|e| format!("invalid proxy url: {e}"))?;
    let target: Url = initial_url.parse().map_err(|e| format!("invalid target url: {e}"))?;

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .proxy_url(proxy)
        // Per-webview hook (unlike `on_page_load`, which is global and only
        // carries the URL) — lets the React tab strip follow the loaded
        // page's own <title> instead of guessing one from the URL.
        .on_document_title_changed(|webview, title| {
            let _ = webview.emit(
                "browser-tile-title-changed",
                serde_json::json!({ "label": webview.label(), "title": title }),
            );
        });

    // Shadowed rather than `let mut` + `#[cfg]` block, so non-macOS builds don't
    // trip `unused_mut`. See BROWSER_TILE_USER_AGENT for why only macOS needs it.
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(BROWSER_TILE_USER_AGENT);

    // NOTE: `Window::add_child` is defined on `tauri::window::Window`;
    // `WebviewWindow` (returned by `get_webview_window`) derefs to it. If a
    // future Tauri version changes that relationship, this call site is the
    // one to fix — not independently re-verified against docs.rs during
    // planning, unlike every other API used in this file.
    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| format!("create browser tile webview: {e}"))?;

    state.0.lock().unwrap().insert(label, webview);
    Ok(())
}

#[tauri::command]
pub fn browser_tile_navigate(
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    url: String,
) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    let target: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    webview.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_tile_reload(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.reload().map_err(|e| e.to_string())
}

/// Steps the webview's *own* session history. Tauri exposes no `go_back` on
/// `Webview`, so this drives the page's History API directly — which is what
/// makes back behave like a browser instead of like a fresh request: the
/// engine restores scroll position and form state, serves from the
/// back/forward cache where it can, and does not push a new entry the way
/// `browser_tile_navigate` does.
///
/// A step past either end of the history is a no-op inside the webview, so the
/// frontend's own bounds check is an enable/disable affordance, not a
/// correctness requirement.
fn eval_history_step(
    state: &tauri::State<'_, BrowserTiles>,
    tab_id: &str,
    doc_id: &str,
    js: &str,
) -> Result<(), String> {
    let label = webview_label(tab_id, doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_tile_back(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    eval_history_step(&state, &tab_id, &doc_id, "history.back()")
}

#[tauri::command]
pub fn browser_tile_forward(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    eval_history_step(&state, &tab_id, &doc_id, "history.forward()")
}

/// Keeps the native surface glued to the placeholder div's on-screen rect —
/// called from the frontend's `ResizeObserver` on every resize/drag/
/// fullscreen-toggle of the tile.
#[tauri::command]
pub fn browser_tile_set_bounds(
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

/// Hides a backgrounded internal tab's webview instead of destroying it, so
/// switching between a fullscreen tile's internal tabs — or a DOM overlay
/// needing to appear in front of it, see `nativeOverlayBlockers` — doesn't
/// force a full reload each time. Uses the real `Webview::hide`, not a
/// zero-size resize: sizing to 0x0 forces the loaded page to reflow to that
/// viewport and back on restore, a visible stall on a heavy page.
#[tauri::command]
pub fn browser_tile_hide(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.hide().map_err(|e| e.to_string())
}

/// Reverses `browser_tile_hide`: reasserts the on-screen rect first, then
/// shows the webview — so it never paints for a frame at its last (possibly
/// stale) bounds before snapping to the correct one.
#[tauri::command]
pub fn browser_tile_show(
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    browser_tile_set_bounds(state.clone(), tab_id.clone(), doc_id.clone(), x, y, width, height)?;
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_tile_close(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let webview = state
        .0
        .lock()
        .unwrap()
        .remove(&label)
        .ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.close().map_err(|e| e.to_string())
}
