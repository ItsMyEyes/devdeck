//! Sidecar process helpers: launch args, readiness detection, log capture.

use std::fs::File;
use std::net::TcpListener;
use std::path::Path;

/// Seconds the shell waits for the listen line + health check.
pub const READY_TIMEOUT_SECS: u64 = 15;
/// Truncate sidecar.log at startup once it exceeds 5 MB (spec: no rotation in v1).
pub const LOG_TRUNCATE_BYTES: u64 = 5 * 1024 * 1024;

/// The desktop hub sidecar's preferred loopback port — the same 8989 the Go
/// binary itself defaults `--addr` to (backend/cmd/server/main.go).
pub const HUB_PORT: u16 = 8989;
/// The desktop's background remote-mode runtime's preferred loopback port —
/// the 9199 every doc, install script and Makefile target already uses for a
/// runtime.
pub const RUNTIME_PORT: u16 = 9199;

const LISTEN_MARKER: &str = "devdeck listening on http://127.0.0.1:";
const RUNTIME_KEY_FILE: &str = "runtime-key";

/// Per-launch hub key: 32 random bytes as 64 lowercase hex chars.
pub fn generate_key() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// `--addr` for a desktop sidecar: `127.0.0.1:<preferred>` when that port is
/// free right now, `127.0.0.1:0` (OS-assigned — the old unconditional
/// behaviour) when it is not.
///
/// The fixed port is what makes the local URL stable across restarts, and it
/// is what `tailscale serve` ends up fronting: `startTailscaleServe` in
/// backend/cmd/server/main.go takes its port from the BOUND LISTENER rather
/// than from `--addr`, so pinning the bind pins the tailnet mapping too.
///
/// The fallback is what keeps a *second* DevDeck on this machine — the
/// installed app alongside a `tauri dev` build, or a `make dev` hub already
/// holding 8989 — from crash-looping: a failed bind is fatal on the Go side
/// (`log.Fatalf("listen on %s")`) and this shell's respawn loop would retry it
/// forever.
///
/// Probing by binding is a time-of-check/time-of-use race: the port can be
/// claimed in the gap between this probe and the child's own bind. The window
/// is milliseconds, the Go side already retries a failed bind for a short
/// window (`listenWithRetry`, which exists for the same race during a
/// restart), and either way the shell reads the port the child ACTUALLY got
/// from its listen line — so nothing downstream depends on this guess being
/// right.
pub fn listen_addr(preferred: u16) -> String {
    match TcpListener::bind(("127.0.0.1", preferred)) {
        Ok(probe) => {
            drop(probe);
            format!("127.0.0.1:{preferred}")
        }
        Err(_) => "127.0.0.1:0".into(),
    }
}

/// devdeck-server args for desktop-sidecar mode. `--addr` prefers HUB_PORT and
/// falls back to an OS-assigned port (see `listen_addr`); parse_listen_port
/// recovers whichever one was bound from the startup log line (the contract is
/// marked with a NOTE next to the log.Printf in backend/cmd/server/main.go).
/// `enable_tailscale_serve` is true only when a preflight
/// `tailscale::public_url()` check already succeeded — passing
/// `--enable-tailscale-serve` when the tailscale binary is missing is fatal
/// on the Go side (see docs/superpowers/specs/2026-07-04-enable-tailscale-serve-design.md).
pub fn sidecar_args(data_dir: &Path, key: &str, enable_tailscale_serve: bool) -> Vec<String> {
    let mut args = vec![
        "--role".into(), "hub".into(),
        "--addr".into(), listen_addr(HUB_PORT),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("devdeck.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--open=false".into(),
        "--2fa=false".into(),
        "--secure-cookies=false".into(),
        // Tells the Go process an external supervisor (this Tauri app's own
        // respawn loop) already owns its respawn lifecycle — see
        // docs/superpowers/specs/2026-07-21-runtime-restart-stop-design.md.
        "--managed".into(),
    ];
    if enable_tailscale_serve {
        args.push("--enable-tailscale-serve".into());
    }
    args
}

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

/// devdeck-server args for the desktop's background remote-mode runtime: binds
/// RUNTIME_PORT (falling back to an ephemeral one — see `listen_addr`) fronted
/// on the tailnet by `--enable-tailscale-serve`, and self-registers with the
/// operator-supplied hub using the persisted runtime key.
///
/// The bound port is a local detail either way: the hub reaches this runtime at
/// `--public-url`, the tailnet name, which `tailscale serve` maps onto whatever
/// loopback port was actually taken.
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
        "--addr".into(), listen_addr(RUNTIME_PORT),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("devdeck-runtime.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--hub-url".into(), hub_url.into(),
        "--hub-key".into(), hub_key.into(),
        "--public-url".into(), public_url.into(),
        "--name".into(), name.into(),
        "--enable-tailscale-serve".into(),
        // See sidecar_args's --managed comment — same reasoning applies to
        // this desktop's background remote-mode runtime.
        "--managed".into(),
    ]
}

/// Extracts the bound port from the server's "devdeck listening on" line.
pub fn parse_listen_port(line: &str) -> Option<u16> {
    let idx = line.find(LISTEN_MARKER)?;
    let digits: String = line[idx + LISTEN_MARKER.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn key_is_64_lowercase_hex_chars() {
        let k = generate_key();
        assert_eq!(k.len(), 64);
        assert!(k.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(generate_key(), k, "keys must be random");
    }

    #[test]
    fn parses_port_from_listen_line() {
        let line = "2026/07/13 10:00:00 devdeck listening on http://127.0.0.1:52341 (db: /x/devdeck.db)";
        assert_eq!(parse_listen_port(line), Some(52341));
        assert_eq!(parse_listen_port("unrelated log noise"), None);
        assert_eq!(parse_listen_port("devdeck listening on http://127.0.0.1: (db)"), None);
    }

    #[test]
    fn listen_addr_takes_the_preferred_port_when_it_is_free() {
        // Borrow a port from the OS, then hand it back — nothing is listening
        // on it for the length of this assertion.
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        assert_eq!(listen_addr(port), format!("127.0.0.1:{port}"));
    }

    #[test]
    fn listen_addr_falls_back_to_ephemeral_when_the_port_is_taken() {
        // Held for the whole test: SO_REUSEADDR (which Rust sets on unix) lets
        // a TIME_WAIT port be rebound, but never one with a live listener, so
        // this really does model "another DevDeck already has 8989".
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert_eq!(listen_addr(port), "127.0.0.1:0");
        drop(held);
    }

    #[test]
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0", false);
        let joined = args.join(" ");
        assert!(joined.contains("--role hub"));
        // Either the fixed port or the fallback — which one depends on whether
        // 8989 is free on the machine running the test. `listen_addr`'s own
        // tests pin the choice itself.
        assert!(
            joined.contains("--addr 127.0.0.1:8989") || joined.contains("--addr 127.0.0.1:0"),
            "expected the hub port or the ephemeral fallback, got: {joined}"
        );
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--open=false"));
        assert!(joined.contains("--2fa=false"));
        assert!(joined.contains("--secure-cookies=false"));
        assert!(joined.contains("devdeck.db"));
        assert!(joined.contains("--managed"));
        assert!(!joined.contains("--enable-tailscale-serve"));
    }

    #[test]
    fn args_include_tailscale_serve_flag_when_enabled() {
        let args = sidecar_args(Path::new("/data"), "k0", true);
        assert!(args.join(" ").contains("--enable-tailscale-serve"));
    }

    #[test]
    fn log_open_truncates_oversized_file() {
        let dir = std::env::temp_dir().join(format!("devdeck-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sidecar.log");
        std::fs::write(&path, vec![b'x'; (LOG_TRUNCATE_BYTES + 1) as usize]).unwrap();
        drop(open_sidecar_log(&dir).unwrap());
        assert!(std::fs::metadata(&path).unwrap().len() <= LOG_TRUNCATE_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persisted_runtime_key_is_stable_across_calls() {
        let dir = std::env::temp_dir().join(format!("devdeck-test-runtime-key-{}", std::process::id()));
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
        assert!(
            joined.contains("--addr 127.0.0.1:9199") || joined.contains("--addr 127.0.0.1:0"),
            "expected the runtime port or the ephemeral fallback, got: {joined}"
        );
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--hub-url https://hub.example"));
        assert!(joined.contains("--hub-key hk0"));
        assert!(joined.contains("--public-url https://me.ts.net"));
        assert!(joined.contains("--name my-mac"));
        assert!(joined.contains("--enable-tailscale-serve"));
        assert!(joined.contains("--managed"));
        assert!(joined.contains("devdeck-runtime.db"));
    }

    #[test]
    fn runtime_log_truncates_oversized_file() {
        let dir = std::env::temp_dir().join(format!("devdeck-test-runtime-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runtime-sidecar.log");
        std::fs::write(&path, vec![b'x'; (LOG_TRUNCATE_BYTES + 1) as usize]).unwrap();
        drop(open_runtime_log(&dir).unwrap());
        assert!(std::fs::metadata(&path).unwrap().len() <= LOG_TRUNCATE_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }
}
