// Native child webviews backing the desktop-only, machine-proxied Browser
// tab. Each open "document" (a Browser tile's own internal tab, see the
// design spec's Decision 2) gets its own real Tauri Webview, overlaid at
// the React placeholder div's on-screen rect and routed through a chosen
// machine's SOCKS5/HTTP forward proxy via `proxy_url`. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

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

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target)).proxy_url(proxy);

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

/// Moves a backgrounded internal tab's webview to zero size instead of
/// destroying it, so switching between a fullscreen tile's internal tabs
/// doesn't force a full reload each time.
#[tauri::command]
pub fn browser_tile_hide(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.set_size(LogicalSize::new(0.0, 0.0)).map_err(|e| e.to_string())
}

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
    browser_tile_set_bounds(state, tab_id, doc_id, x, y, width, height)
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
