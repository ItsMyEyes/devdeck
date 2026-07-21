//! Sidecar process helpers: launch args, readiness detection, log capture.

use std::fs::File;
use std::path::Path;

/// Seconds the shell waits for the listen line + health check.
pub const READY_TIMEOUT_SECS: u64 = 15;
/// Truncate sidecar.log at startup once it exceeds 5 MB (spec: no rotation in v1).
pub const LOG_TRUNCATE_BYTES: u64 = 5 * 1024 * 1024;

const LISTEN_MARKER: &str = "devdeck listening on http://127.0.0.1:";
const RUNTIME_KEY_FILE: &str = "runtime-key";

/// Per-launch hub key: 32 random bytes as 64 lowercase hex chars.
pub fn generate_key() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// devdeck-server args for desktop-sidecar mode. `--addr 127.0.0.1:0` makes the
/// OS pick the port; parse_listen_port recovers it from the startup log line
/// (the contract is marked with a NOTE next to the log.Printf in
/// backend/cmd/server/main.go). `enable_tailscale_serve` is true only when a
/// preflight `tailscale::public_url()` check already succeeded — passing
/// `--enable-tailscale-serve` when the tailscale binary is missing is fatal
/// on the Go side (see docs/superpowers/specs/2026-07-04-enable-tailscale-serve-design.md).
pub fn sidecar_args(data_dir: &Path, key: &str, enable_tailscale_serve: bool) -> Vec<String> {
    let mut args = vec![
        "--role".into(), "hub".into(),
        "--addr".into(), "127.0.0.1:0".into(),
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
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0", false);
        let joined = args.join(" ");
        assert!(joined.contains("--role hub"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
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
        assert!(joined.contains("--addr 127.0.0.1:0"));
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
