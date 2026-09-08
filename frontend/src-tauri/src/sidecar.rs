//! Sidecar process helpers: launch args, readiness detection, log capture.

use std::fs::File;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::time::Duration;

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

/// Loopback, the default bind and the address the desktop shell reaches its
/// own hub on for every bind except one pinned to a specific interface.
pub const LOOPBACK: &str = "127.0.0.1";

/// The server normalizes its startup line to loopback whatever it bound
/// (`browserURL` in backend/cmd/server/browser.go), so this marker holds for
/// an all-interfaces or pinned bind too — only the port is read from it.
const LISTEN_MARKER: &str = "devdeck listening on http://127.0.0.1:";
const RUNTIME_KEY_FILE: &str = "runtime-key";

/// Per-launch hub key: 32 random bytes as 64 lowercase hex chars.
pub fn generate_key() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// `--addr` for a desktop sidecar: `<host>:<preferred>` when that port is
/// free on that host right now, `<host>:0` (OS-assigned — the old
/// unconditional behaviour) when it is not.
///
/// `host` is the operator's bind choice (see bindconfig), defaulting to
/// loopback. It was a hard-coded `127.0.0.1` until Settings › Network gained
/// a bind picker, which meant a desktop-hosted hub could not be reached from
/// any other device except through `tailscale serve`.
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
/// Probing is a time-of-check/time-of-use race: the port can be claimed in the
/// gap between this probe and the child's own bind. The window is
/// milliseconds, the Go side already retries a failed bind for a short window
/// (`listenWithRetry`, which exists for the same race during a restart), and
/// the shell reads the port the child ACTUALLY got from its listen line.
///
/// What the shell CANNOT infer from that listen line is whether the port it
/// got is shared with a stranger — see `port_has_a_server` for why two hubs
/// can hold one port — so `verify_own_hub` checks that separately.
pub fn listen_addr(host: &str, preferred: u16) -> String {
    if port_has_a_server(host, preferred) || TcpListener::bind((host, preferred)).is_err() {
        return format!("{host}:0");
    }
    format!("{host}:{preferred}")
}

/// How long a probe connect may take before the port counts as free. Loopback
/// refuses instantly when nothing is listening, so this only bounds the
/// pathological case (a filtered port, a wedged listener).
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);

/// True when something is already *serving* `preferred`, which is a stricter
/// question than "can I bind it" and the one that actually matters here.
///
/// A bind probe is not enough, because the probe and the real server do not
/// bind the same thing. Rust binds IPv4 `0.0.0.0`; Go's `net.Listen("tcp",
/// "0.0.0.0:P")` opens a DUAL-STACK IPv6 wildcard (`*:P`), and macOS lets that
/// coexist with an unrelated process holding IPv4 `127.0.0.1:P` — different
/// address families, no conflict. So a second DevDeck really can bind "the
/// same" port, and then this shell's own `http://127.0.0.1:P` health check and
/// machine registration resolve to IPv4 and land on the OTHER hub, which
/// rejects our key with a 401 that reads as a permissions bug.
///
/// Connecting catches that regardless of which family the incumbent chose.
/// Checked on loopback because loopback is the address this shell dials, plus
/// the bind host itself when it is a concrete address that loopback would miss.
fn port_has_a_server(host: &str, preferred: u16) -> bool {
    let mut targets: Vec<IpAddr> = vec![IpAddr::from([127, 0, 0, 1])];
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !ip.is_loopback() && !ip.is_unspecified() {
            targets.push(ip);
        }
    }
    targets
        .into_iter()
        .any(|ip| TcpStream::connect_timeout(&SocketAddr::new(ip, preferred), PROBE_TIMEOUT).is_ok())
}

/// devdeck-server args for desktop-sidecar mode. `--addr` prefers HUB_PORT and
/// falls back to an OS-assigned port (see `listen_addr`); parse_listen_port
/// recovers whichever one was bound from the startup log line (the contract is
/// marked with a NOTE next to the log.Printf in backend/cmd/server/main.go).
/// `enable_tailscale_serve` is true only when a preflight
/// `tailscale::public_url()` check already succeeded — passing
/// `--enable-tailscale-serve` when the tailscale binary is missing is fatal
/// on the Go side (see docs/superpowers/specs/2026-07-04-enable-tailscale-serve-design.md).
pub fn sidecar_args(
    data_dir: &Path,
    key: &str,
    enable_tailscale_serve: bool,
    bind_host: &str,
) -> Vec<String> {
    let mut args = vec![
        "--role".into(), "hub".into(),
        "--addr".into(), listen_addr(bind_host, HUB_PORT),
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
/// RUNTIME_PORT (falling back to an ephemeral one — see `listen_addr`) and
/// self-registers with the operator-supplied hub using the persisted runtime
/// key.
///
/// `public_url` selects how the hub reaches this runtime:
///
///   - `Some(tailnet_url)` — tailnet mode. `--enable-tailscale-serve` fronts
///     the process on the tailnet, and the bound port is a local detail:
///     `tailscale serve` maps the tailnet name onto whatever port was taken.
///   - `None` — LAN mode, for a `bind_host` the operator has exposed on the
///     local network. Both flags are omitted so the Go side derives the
///     advertised URL from the address it actually bound (`advertiseURLFor`
///     in backend/cmd/server/advertise.go, which swaps an unspecified host
///     for a routable one). Passing `--enable-tailscale-serve` here would be
///     fatal on the Go side whenever the tailscale CLI is missing, which is
///     precisely the case LAN mode exists to serve.
pub fn runtime_args(
    data_dir: &Path,
    key: &str,
    hub_url: &str,
    hub_key: &str,
    public_url: Option<&str>,
    name: &str,
    bind_host: &str,
) -> Vec<String> {
    let mut args = vec![
        "--role".into(), "runtime".into(),
        "--addr".into(), listen_addr(bind_host, RUNTIME_PORT),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("devdeck-runtime.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--hub-url".into(), hub_url.into(),
        "--hub-key".into(), hub_key.into(),
        "--name".into(), name.into(),
        // See sidecar_args's --managed comment — same reasoning applies to
        // this desktop's background remote-mode runtime.
        "--managed".into(),
    ];
    if let Some(url) = public_url {
        args.push("--public-url".into());
        args.push(url.into());
        args.push("--enable-tailscale-serve".into());
    }
    args
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
        assert_eq!(listen_addr("127.0.0.1", port), format!("127.0.0.1:{port}"));
    }

    #[test]
    fn listen_addr_falls_back_to_ephemeral_when_the_port_is_taken() {
        // Held for the whole test: SO_REUSEADDR (which Rust sets on unix) lets
        // a TIME_WAIT port be rebound, but never one with a live listener, so
        // this really does model "another DevDeck already has 8989".
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert_eq!(listen_addr("127.0.0.1", port), "127.0.0.1:0");
        drop(held);
    }

    /// The bind host reaches `--addr` verbatim on BOTH branches — this is the
    /// whole point of the Settings › Network picker, and what would have
    /// failed against the hard-coded loopback this replaced.
    ///
    /// Asserted on the host rather than the port because a wildcard bind
    /// conflicts with a specific-address bind on the same port, and the
    /// sibling test above holds one on a port this thread cannot predict — so
    /// which branch is taken here is genuinely racy, while the host is not.
    #[test]
    fn listen_addr_honors_a_non_loopback_host() {
        let probe = TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let free = probe.local_addr().unwrap().port();
        drop(probe);
        let addr = listen_addr("0.0.0.0", free);
        assert!(addr.starts_with("0.0.0.0:"), "loopback leaked back in: {addr}");

        // The taken branch is deterministic: this listener is held across the
        // assertion, so the probe inside listen_addr cannot succeed.
        let held = TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let taken = held.local_addr().unwrap().port();
        assert_eq!(listen_addr("0.0.0.0", taken), "0.0.0.0:0");
        drop(held);
    }

    /// The regression, reproduced exactly: an incumbent holding IPv4
    /// `127.0.0.1:P` does not stop a dual-stack wildcard from taking "the
    /// same" port, so the bind probe alone said free and two hubs ended up on
    /// 8989 — the shell then dialed 127.0.0.1 and hit the wrong one (401).
    /// A LISTENING socket is what makes this detectable, so hold one.
    #[test]
    fn listen_addr_falls_back_when_a_stranger_serves_the_port_on_loopback() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(port_has_a_server("0.0.0.0", port), "a live loopback listener must be seen");
        assert_eq!(
            listen_addr("0.0.0.0", port),
            "0.0.0.0:0",
            "an all-interfaces bind must not share a port with an IPv4 loopback server"
        );
        drop(held);
    }

    #[test]
    fn port_has_a_server_is_false_for_an_unused_port() {
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        assert!(!port_has_a_server("127.0.0.1", port));
    }

    #[test]
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0", false, "127.0.0.1");
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
    fn hub_args_bind_the_chosen_host() {
        let args = sidecar_args(Path::new("/data"), "k0", false, "0.0.0.0");
        let joined = args.join(" ");
        assert!(
            joined.contains("--addr 0.0.0.0:8989") || joined.contains("--addr 0.0.0.0:0"),
            "expected an all-interfaces bind, got: {joined}"
        );
        assert!(!joined.contains("--addr 127.0.0.1"), "loopback must not leak back in: {joined}");
    }

    #[test]
    fn args_include_tailscale_serve_flag_when_enabled() {
        let args = sidecar_args(Path::new("/data"), "k0", true, "127.0.0.1");
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
            Some("https://me.ts.net"),
            "my-mac",
            "127.0.0.1",
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

    /// LAN mode: no tailnet URL, so neither --public-url nor
    /// --enable-tailscale-serve may appear. The latter is the sharp edge —
    /// it is fatal on the Go side when the tailscale CLI is missing, which is
    /// exactly the machine this mode is for.
    #[test]
    fn runtime_args_omit_tailscale_flags_in_lan_mode() {
        let args = runtime_args(
            Path::new("/data"),
            "k0",
            "https://hub.example",
            "hk0",
            None,
            "my-mac",
            "0.0.0.0",
        );
        let joined = args.join(" ");
        assert!(
            joined.contains("--addr 0.0.0.0:9199") || joined.contains("--addr 0.0.0.0:0"),
            "expected an all-interfaces bind, got: {joined}"
        );
        assert!(!joined.contains("--enable-tailscale-serve"), "fatal without the CLI: {joined}");
        assert!(!joined.contains("--public-url"), "the Go side derives it: {joined}");
        assert!(joined.contains("--hub-url https://hub.example"));
        assert!(joined.contains("--managed"));
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
