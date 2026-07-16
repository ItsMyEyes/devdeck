# Desktop Remote-Hub Runtime Self-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the desktop app connects to a remote hub, spawn its bundled backend as a background `--role runtime` process that self-registers with that hub over Tailscale, so the operator's own machine becomes a usable runtime there automatically.

**Architecture:** All changes live in `frontend/src-tauri/`. `HubMode::Remote` gains a `key` field; a new `tailscale.rs` module derives this device's tailnet-reachable public URL; `sidecar.rs` gains helpers for a persisted (non-ephemeral) runtime key and runtime-mode launch args; `lib.rs` spawns/monitors the runtime sidecar in the background (mirroring the existing local-hub respawn loop) while the main window navigates to the remote hub exactly as it does today; failures surface via a menu item + bundled warning page, never by blocking navigation. Zero backend/Go changes — every flag and self-registration loop this relies on already ships.

**Tech Stack:** Rust (Tauri v2.11), tokio, reqwest, serde/serde_json — all already dependencies of `frontend/src-tauri`. One Cargo.toml change: enable tokio's `process` feature.

## Global Constraints

- No backend/Go changes. Reuse `--role runtime`, `--hub-url`, `--hub-key`, `--public-url`, `--name`, `--enable-tailscale-serve`, and `machineclient.RunSelfRegisterLoop` exactly as they exist today.
- Public URL format is `https://<tailscale-dnsname>` — no port (the port is only what `--enable-tailscale-serve` fronts *to*, per `docs/superpowers/specs/2026-07-16-runtime-bootstrap-installer-design.md` Decision 7).
- No Tailscale auto-install. If the CLI is missing or the node isn't logged in, skip the runtime spawn, log it, and continue — never block or delay browsing the remote hub.
- No new Tauri plugins (no dialog/notification crate). Reuse the existing bundled-HTML-page + `win.eval(...)` pattern already used by `error.html`.
- The runtime key must be **persisted** (`<appDataDir>/runtime-key`), unlike the ephemeral per-launch key `sidecar::generate_key()` produces for "Host locally" — self-registration needs a stable key across restarts to keep matching the same Machine row by URL.
- Separate database path: `<appDataDir>/loom-runtime.db`, distinct from the "Host locally" hub's `<appDataDir>/loom.db`.
- No live in-app Settings page. Editing the hub URL/key still goes through the existing "Change Hub…" menu → clears saved mode → app restarts → choose-a-mode screen.

---

### Task 1: `HubMode::Remote` carries a hub key, end to end from UI to storage

**Files:**
- Modify: `frontend/src-tauri/src/hubmode.rs:11-16` (enum), `:69-76` (test)
- Modify: `frontend/src-tauri/src/lib.rs:117-130` (`choose_hub_mode`), `:145-150` (`proceed_with_mode`)
- Modify: `frontend/src-tauri/ui/choose.html`

**Interfaces:**
- Produces: `HubMode::Remote { url: String, key: String }`, consumed by `proceed_with_mode` (this task, ignoring `key` for now via `key: _`) and by Task 4 (`run_remote_runtime_loop`, which actually uses it).
- Produces: `choose_hub_mode(app, mode: String, url: Option<String>, key: Option<String>)` command signature, consumed by `choose.html`.

- [ ] **Step 1: Update the `HubMode` round-trip test to include a key field**

In `frontend/src-tauri/src/hubmode.rs`, replace the existing `save_then_load_roundtrips_remote` test:

```rust
    #[test]
    fn save_then_load_roundtrips_remote() {
        let dir = temp_dir("remote");
        let mode = HubMode::Remote {
            url: "https://hub.tail-xxxx.ts.net".into(),
            key: "hubkey123".into(),
        };
        save(&dir, &mode).unwrap();
        assert_eq!(load(&dir), Some(mode));
        std::fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 2: Run the test to confirm it fails to compile**

Run: `cd frontend/src-tauri && cargo test --lib hubmode`
Expected: compile error, `missing field 'key' in initializer of 'HubMode'`

- [ ] **Step 3: Add the `key` field to the enum**

In `frontend/src-tauri/src/hubmode.rs`, change:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum HubMode {
    Local,
    Remote { url: String, key: String },
}
```

- [ ] **Step 4: Fix the two call sites this breaks, in `frontend/src-tauri/src/lib.rs`**

Replace the `choose_hub_mode` command (`lib.rs:117-130`):

```rust
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
```

Replace `proceed_with_mode` (`lib.rs:145-150`) — `key` is intentionally ignored here; Task 4 wires it up:

```rust
async fn proceed_with_mode(handle: &AppHandle, mode: hubmode::HubMode) {
    match mode {
        hubmode::HubMode::Remote { url, key: _ } => navigate_remote(handle, &url),
        hubmode::HubMode::Local => run_local_respawn_loop(handle).await,
    }
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd frontend/src-tauri && cargo test --lib hubmode`
Expected: `test result: ok. 4 passed`

- [ ] **Step 6: Confirm the whole crate still builds**

Run: `cd frontend/src-tauri && cargo build --lib`
Expected: builds cleanly (a warning about `key` being unused in the match arm is fine — it's explicitly `_`, so there is no warning at all).

- [ ] **Step 7: Add the Hub Key field to the choose-a-mode screen**

In `frontend/src-tauri/ui/choose.html`, replace the `#remote-form` div:

```html
      <div id="remote-form">
        <input id="url" type="text" placeholder="https://hub.tail-xxxx.ts.net" />
        <input id="hub-key" type="text" placeholder="hub bearer key" />
        <button id="connect-btn">Connect</button>
      </div>
```

Replace the `connect-btn` click handler:

```js
      document.getElementById('connect-btn').addEventListener('click', () => {
        const url = document.getElementById('url').value.trim()
        const key = document.getElementById('hub-key').value.trim()
        if (!url || !key) return
        errorEl.textContent = ''
        invoke('choose_hub_mode', { mode: 'remote', url, key }).catch((e) => {
          errorEl.textContent = String(e)
        })
      })
```

- [ ] **Step 8: Commit**

```bash
git add frontend/src-tauri/src/hubmode.rs frontend/src-tauri/src/lib.rs frontend/src-tauri/ui/choose.html
git commit -m "feat(desktop): collect and persist a hub key for remote-hub mode"
```

---

### Task 2: Tailscale public-URL lookup helper

**Files:**
- Create: `frontend/src-tauri/src/tailscale.rs`
- Modify: `frontend/src-tauri/src/lib.rs:1-4` (add `mod tailscale;`)
- Modify: `frontend/src-tauri/Cargo.toml` (tokio `process` feature)

**Interfaces:**
- Produces: `pub async fn tailscale::public_url() -> Result<String, String>`, consumed by Task 4's `run_remote_runtime_loop`.

- [ ] **Step 1: Enable tokio's `process` feature**

In `frontend/src-tauri/Cargo.toml`, change:

```toml
tokio = { version = "1", features = ["time", "signal", "macros", "process"] }
```

- [ ] **Step 2: Write the module with a stub implementation and its tests**

Create `frontend/src-tauri/src/tailscale.rs`:

```rust
//! Derives this device's Tailscale-reachable public URL for runtime
//! self-registration: `tailscale status --self --json` -> `.Self.DNSName`
//! -> `https://<dnsname>` (trailing dot stripped, no port -- matches
//! `--enable-tailscale-serve`, which fronts the app on the tailnet's
//! implicit port 443). See
//! docs/superpowers/specs/2026-07-16-desktop-remote-runtime-self-registration-design.md.

use serde::Deserialize;

#[derive(Deserialize)]
struct StatusSelf {
    #[serde(rename = "DNSName")]
    dns_name: String,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "Self")]
    self_: StatusSelf,
}

/// Parses `tailscale status --self --json` output into a public URL.
fn parse_dns_name(_json: &[u8]) -> Result<String, String> {
    unimplemented!()
}

/// Runs `tailscale status --self --json` and derives this device's
/// tailnet-reachable public URL. Fails if the `tailscale` binary is
/// missing, the command errors, or the node isn't logged in (no DNSName).
pub async fn public_url() -> Result<String, String> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dns_name_and_strips_trailing_dot() {
        let json = br#"{"Self":{"DNSName":"my-mac.tail1234.ts.net."}}"#;
        assert_eq!(
            parse_dns_name(json),
            Ok("https://my-mac.tail1234.ts.net".to_string())
        );
    }

    #[test]
    fn rejects_missing_self_field() {
        let json = br#"{"Peer":{}}"#;
        assert!(parse_dns_name(json).is_err());
    }

    #[test]
    fn rejects_empty_dns_name() {
        let json = br#"{"Self":{"DNSName":""}}"#;
        assert!(parse_dns_name(json).is_err());
    }
}
```

Add `mod tailscale;` to `frontend/src-tauri/src/lib.rs:1-4`:

```rust
mod browser_tiles;
mod hubapi;
mod hubmode;
mod sidecar;
mod tailscale;
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `cd frontend/src-tauri && cargo test --lib tailscale`
Expected: FAIL — all three tests panic with `not implemented`

- [ ] **Step 4: Implement `parse_dns_name` and `public_url`**

In `frontend/src-tauri/src/tailscale.rs`, replace both stub functions:

```rust
/// Parses `tailscale status --self --json` output into a public URL.
fn parse_dns_name(json: &[u8]) -> Result<String, String> {
    let status: Status =
        serde_json::from_slice(json).map_err(|e| format!("parse tailscale status: {e}"))?;
    let dns = status.self_.dns_name.trim_end_matches('.');
    if dns.is_empty() {
        return Err("tailscale status: empty DNSName".into());
    }
    Ok(format!("https://{dns}"))
}

/// Runs `tailscale status --self --json` and derives this device's
/// tailnet-reachable public URL. Fails if the `tailscale` binary is
/// missing, the command errors, or the node isn't logged in (no DNSName).
pub async fn public_url() -> Result<String, String> {
    let output = tokio::process::Command::new("tailscale")
        .args(["status", "--self", "--json"])
        .output()
        .await
        .map_err(|e| format!("run tailscale status: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tailscale status exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    parse_dns_name(&output.stdout)
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cd frontend/src-tauri && cargo test --lib tailscale`
Expected: `test result: ok. 3 passed`

- [ ] **Step 6: Commit**

```bash
git add frontend/src-tauri/src/tailscale.rs frontend/src-tauri/src/lib.rs frontend/src-tauri/Cargo.toml frontend/src-tauri/Cargo.lock
git commit -m "feat(desktop): derive this device's Tailscale public URL"
```

---

### Task 3: Sidecar helpers for runtime mode (persisted key, launch args, log file)

**Files:**
- Modify: `frontend/src-tauri/src/sidecar.rs`

**Interfaces:**
- Consumes: `generate_key()`, `LOG_TRUNCATE_BYTES` (both already in this file).
- Produces: `pub fn persisted_runtime_key(data_dir: &Path) -> std::io::Result<String>`, `pub fn runtime_args(data_dir: &Path, key: &str, hub_url: &str, hub_key: &str, public_url: &str, name: &str) -> Vec<String>`, `pub fn open_runtime_log(log_dir: &Path) -> std::io::Result<File>` — all consumed by Task 4's `launch_runtime_once`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src-tauri/src/sidecar.rs`, add to the `tests` module (after the existing `log_open_truncates_oversized_file` test):

```rust
    #[test]
    fn persisted_runtime_key_is_stable_across_calls() {
        let dir = std::env::temp_dir().join(format!("loom-test-runtime-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = persisted_runtime_key(&dir).unwrap();
        let second = persisted_runtime_key(&dir).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn runtime_args_carry_the_remote_contract() {
        let args = runtime_args(
            Path::new("/data"),
            "k0",
            "https://hub.example",
            "hk0",
            "https://me.ts.net",
            "my-mac",
        );
        let joined = args.join(" ");
        assert!(joined.contains("--role runtime"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--hub-url https://hub.example"));
        assert!(joined.contains("--hub-key hk0"));
        assert!(joined.contains("--public-url https://me.ts.net"));
        assert!(joined.contains("--name my-mac"));
        assert!(joined.contains("--enable-tailscale-serve"));
        assert!(joined.contains("loom-runtime.db"));
    }

    #[test]
    fn runtime_log_truncates_oversized_file() {
        let dir = std::env::temp_dir().join(format!("loom-test-runtime-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runtime-sidecar.log");
        std::fs::write(&path, vec![b'x'; (LOG_TRUNCATE_BYTES + 1) as usize]).unwrap();
        drop(open_runtime_log(&dir).unwrap());
        assert!(std::fs::metadata(&path).unwrap().len() <= LOG_TRUNCATE_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 2: Run the tests to confirm they fail to compile**

Run: `cd frontend/src-tauri && cargo test --lib sidecar`
Expected: compile errors — `persisted_runtime_key`, `runtime_args`, `open_runtime_log` not found

- [ ] **Step 3: Implement the three helpers**

In `frontend/src-tauri/src/sidecar.rs`, add near the top (after the existing consts):

```rust
const RUNTIME_KEY_FILE: &str = "runtime-key";
```

Add after `generate_key`:

```rust
/// Reads this device's persisted runtime key, generating and saving one on
/// first use. Unlike `generate_key` (a fresh ephemeral key every "Host
/// locally" launch), this key must stay stable across restarts so runtime
/// self-registration keeps matching the same Machine row by URL.
pub fn persisted_runtime_key(data_dir: &Path) -> std::io::Result<String> {
    let path = data_dir.join(RUNTIME_KEY_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let key = generate_key();
    std::fs::write(&path, &key)?;
    Ok(key)
}

/// loom-server args for the desktop's background remote-mode runtime: binds
/// an ephemeral loopback port fronted on the tailnet by
/// `--enable-tailscale-serve`, and self-registers with the operator-supplied
/// hub using the persisted runtime key.
pub fn runtime_args(
    data_dir: &Path,
    key: &str,
    hub_url: &str,
    hub_key: &str,
    public_url: &str,
    name: &str,
) -> Vec<String> {
    vec![
        "--role".into(), "runtime".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("loom-runtime.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--hub-url".into(), hub_url.into(),
        "--hub-key".into(), hub_key.into(),
        "--public-url".into(), public_url.into(),
        "--name".into(), name.into(),
        "--enable-tailscale-serve".into(),
    ]
}
```

Replace `open_sidecar_log` with a shared helper plus two thin wrappers:

```rust
fn open_log_file(log_dir: &Path, filename: &str) -> std::io::Result<File> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join(filename);
    if std::fs::metadata(&path).map(|m| m.len() > LOG_TRUNCATE_BYTES).unwrap_or(false) {
        std::fs::remove_file(&path)?;
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path)
}

/// Opens <log_dir>/sidecar.log for appending, truncating it first when it
/// has grown past LOG_TRUNCATE_BYTES.
pub fn open_sidecar_log(log_dir: &Path) -> std::io::Result<File> {
    open_log_file(log_dir, "sidecar.log")
}

/// Opens <log_dir>/runtime-sidecar.log for the desktop's background
/// remote-mode runtime, same truncate-at-5MB behavior as `open_sidecar_log`.
pub fn open_runtime_log(log_dir: &Path) -> std::io::Result<File> {
    open_log_file(log_dir, "runtime-sidecar.log")
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd frontend/src-tauri && cargo test --lib sidecar`
Expected: `test result: ok. 7 passed`

- [ ] **Step 5: Commit**

```bash
git add frontend/src-tauri/src/sidecar.rs
git commit -m "feat(desktop): add persisted runtime key and runtime-mode launch args"
```

---

### Task 4: Spawn and monitor the background runtime sidecar in remote mode

**Files:**
- Modify: `frontend/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `tailscale::public_url()` (Task 2), `sidecar::persisted_runtime_key`, `sidecar::runtime_args`, `sidecar::open_runtime_log`, `sidecar::parse_listen_port` (Task 3), `hubapi::device_name`, `hubapi::wait_healthy` (existing).
- Produces: `struct RuntimeServerProc(Mutex<Option<CommandChild>>)`, `async fn run_remote_runtime_loop(handle: &AppHandle, hub_url: &str, hub_key: &str)` — the failure branches call `set_runtime_warning_menu`, implemented in Task 5. For this task, stub `set_runtime_warning_menu` as a bare log line so the crate compiles standalone; Task 5 replaces it with the real menu-swap behavior.

- [ ] **Step 1: Add the `RuntimeServerProc` state struct and manage it**

In `frontend/src-tauri/src/lib.rs`, near the existing `struct ServerProc` (around line 17-18), add:

```rust
/// Current background remote-mode runtime child, so app exit can kill it.
struct RuntimeServerProc(Mutex<Option<CommandChild>>);
```

In `setup()`, right after `app.manage(ServerProc(Mutex::new(None)));` (line 68), add:

```rust
            app.manage(RuntimeServerProc(Mutex::new(None)));
```

- [ ] **Step 2: Add a temporary stub for the menu-warning hook**

Add this function anywhere in `lib.rs` (Task 5 replaces the body):

```rust
/// Records a runtime-registration failure and surfaces it to the operator.
/// Stub for now (logs only) -- Task 5 replaces this with a menu-item swap
/// and a bundled warning page the operator can open on demand.
fn set_runtime_warning_menu(handle: &AppHandle, reason: &str, _hub_url: &str) {
    log_runtime_line(handle, reason);
}
```

- [ ] **Step 3: Add the runtime spawn/respawn loop**

Add these functions to `lib.rs` (near `run_local_respawn_loop` / `launch_once`):

```rust
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
```

- [ ] **Step 4: Wire the loop into `proceed_with_mode` and extend `kill_sidecar`**

Replace `proceed_with_mode`:

```rust
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
```

Replace `kill_sidecar`:

```rust
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
```

- [ ] **Step 5: Confirm the crate builds**

Run: `cd frontend/src-tauri && cargo build --lib`
Expected: builds cleanly, no errors

- [ ] **Step 6: Run the full test suite**

Run: `cd frontend/src-tauri && cargo test --lib`
Expected: `test result: ok.` — all tests from Tasks 1-3 plus any prior ones still pass

- [ ] **Step 7: Commit**

```bash
git add frontend/src-tauri/src/lib.rs
git commit -m "feat(desktop): spawn and monitor a background runtime sidecar in remote mode"
```

---

### Task 5: Failure surface — warning menu item and bundled warning page

**Files:**
- Create: `frontend/src-tauri/ui/runtime-warning.html`
- Modify: `frontend/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `RUNTIME_WARNING_MENU_ID` and `CHANGE_HUB_MENU_ID` consts, `MenuBuilder` (already imported).
- Replaces the Task 4 stub `set_runtime_warning_menu` with the real implementation; produces `struct RuntimeWarning(Mutex<Option<(String, String)>>)` and `fn show_runtime_warning(handle: &AppHandle, reason: &str, hub_url: &str)`.

- [ ] **Step 1: Create the bundled warning page**

Create `frontend/src-tauri/ui/runtime-warning.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Loom — runtime not registered</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0d1017; color: #c0c6d4;
        font: 13px/1.6 -apple-system, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { max-width: 480px; padding: 0 24px; }
      h1 { font-size: 15px; color: #d9a441; }
      code { color: #8b93a7; word-break: break-all; }
      button { display: block; margin-top: 16px; padding: 10px 12px;
        background: #1a1f2b; color: #c0c6d4; border: 1px solid #2a3040;
        border-radius: 6px; cursor: pointer; font: inherit; }
      button:hover { background: #232936; }
    </style>
  </head>
  <body>
    <main>
      <h1>This device couldn't register as a runtime</h1>
      <p id="reason">Unknown reason.</p>
      <p>Details are in the log:<br /><code id="logpath">app log directory / runtime-sidecar.log</code></p>
      <p>Browsing the hub is unaffected — this only means the hub can't run terminals/git on this device.</p>
      <button id="back-btn">Back to hub</button>
    </main>
    <script>
      document.getElementById('back-btn').addEventListener('click', () => {
        const url = document.body.dataset.hubUrl
        if (url) window.location.href = url
      })
    </script>
  </body>
</html>
```

- [ ] **Step 2: Add the `RuntimeWarning` state and menu id**

In `frontend/src-tauri/src/lib.rs`, near `const CHANGE_HUB_MENU_ID` (line 23), add:

```rust
const RUNTIME_WARNING_MENU_ID: &str = "runtime-warning";
```

Near `struct RuntimeServerProc`, add:

```rust
/// Last runtime-registration failure (reason, hub_url), if any, shown on
/// demand via the "⚠ Runtime not registered" menu item.
struct RuntimeWarning(Mutex<Option<(String, String)>>);
```

In `setup()`, after `app.manage(RuntimeServerProc(Mutex::new(None)));`, add:

```rust
            app.manage(RuntimeWarning(Mutex::new(None)));
```

- [ ] **Step 3: Extend the menu-event handler**

Replace the `app.on_menu_event(...)` block in `setup()`:

```rust
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
```

- [ ] **Step 4: Replace the Task 4 stub with the real menu-swap + warning page**

Replace `set_runtime_warning_menu` from Task 4:

```rust
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
```

- [ ] **Step 5: Confirm the crate builds and tests still pass**

Run: `cd frontend/src-tauri && cargo build --lib && cargo test --lib`
Expected: builds cleanly; `test result: ok.` for all tests

- [ ] **Step 6: Commit**

```bash
git add frontend/src-tauri/ui/runtime-warning.html frontend/src-tauri/src/lib.rs
git commit -m "feat(desktop): surface runtime-registration failures via menu + warning page"
```

---

### Task 6: End-to-end smoke verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Rebuild the sidecar binaries and run the full Rust test suite**

Run: `make sidecar-host && cd frontend/src-tauri && cargo test --lib`
Expected: `test result: ok.` — all unit tests from Tasks 1-5 pass

- [ ] **Step 2: Build the desktop app in release mode (spawns the real sidecar path)**

Run: `cd frontend && npm run tauri:build`
Expected: produces a `.app`/`.dmg` (macOS), `.exe`/NSIS (Windows), or `.deb`/`.AppImage` (Linux) artifact under `frontend/src-tauri/target/release/bundle/`

- [ ] **Step 3: Manual runbook — happy path (requires a machine with Tailscale installed and joined, and a real reachable test hub)**

1. Launch the built app fresh (or clear its saved mode first via "Change Hub…" if reusing an existing install).
2. Choose "Connect to a hub I already host," enter the test hub's URL and its bearer key, click Connect.
3. Confirm the window navigates to and shows the remote hub's login/SPA immediately (no waiting on the runtime spawn).
4. Within a few seconds, open the test hub's Machines page from another client and confirm this device appears as a new machine, with its Tailscale-derived `https://<dnsname>` URL.
5. Quit the desktop app; confirm no `loom-server` process remains running (`ps aux | grep loom-server` shows nothing).

- [ ] **Step 4: Manual runbook — graceful degradation (a machine without Tailscale, or an unreachable hub)**

1. On a machine without the `tailscale` CLI on `PATH` (or not logged in), repeat steps 1-2 above.
2. Confirm the window still navigates to and shows the remote hub's UI, unaffected.
3. Confirm the menu bar now shows "⚠ Runtime not registered" instead of "Change Hub…".
4. Click it; confirm the bundled warning page shows a clear reason and the `runtime-sidecar.log` path.
5. Click "Back to hub"; confirm the window returns to the remote hub URL.
6. Inspect `<app log dir>/runtime-sidecar.log` and confirm the failure reason was written there too.

- [ ] **Step 5: Confirm no regressions in "Host locally" mode**

1. Use "Change Hub…" to reset, then choose "Host locally on this device."
2. Confirm the bundled hub sidecar still starts, the SPA loads, and a project/terminal works as before.
3. Quit; confirm no `loom-server` process remains running.
