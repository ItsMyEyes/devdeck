//! Sidecar process helpers: launch args, readiness detection, log capture.

use std::fs::File;
use std::path::Path;

/// Seconds the shell waits for the listen line + health check.
pub const READY_TIMEOUT_SECS: u64 = 15;
/// Truncate sidecar.log at startup once it exceeds 5 MB (spec: no rotation in v1).
pub const LOG_TRUNCATE_BYTES: u64 = 5 * 1024 * 1024;

const LISTEN_MARKER: &str = "loom listening on http://127.0.0.1:";

/// Per-launch hub key: 32 random bytes as 64 lowercase hex chars.
pub fn generate_key() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// loom-server args for desktop-sidecar mode. `--addr 127.0.0.1:0` makes the
/// OS pick the port; parse_listen_port recovers it from the startup log line
/// (the contract is marked with a NOTE next to the log.Printf in
/// backend/cmd/server/main.go).
pub fn sidecar_args(data_dir: &Path, key: &str) -> Vec<String> {
    vec![
        "--role".into(), "hub".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("loom.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--open=false".into(),
        "--2fa=false".into(),
        "--secure-cookies=false".into(),
    ]
}

/// Extracts the bound port from the server's "loom listening on" line.
pub fn parse_listen_port(line: &str) -> Option<u16> {
    let idx = line.find(LISTEN_MARKER)?;
    let digits: String = line[idx + LISTEN_MARKER.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Opens <log_dir>/sidecar.log for appending, truncating it first when it
/// has grown past LOG_TRUNCATE_BYTES.
pub fn open_sidecar_log(log_dir: &Path) -> std::io::Result<File> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join("sidecar.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_TRUNCATE_BYTES).unwrap_or(false) {
        std::fs::remove_file(&path)?;
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path)
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
        let line = "2026/07/13 10:00:00 loom listening on http://127.0.0.1:52341 (db: /x/loom.db)";
        assert_eq!(parse_listen_port(line), Some(52341));
        assert_eq!(parse_listen_port("unrelated log noise"), None);
        assert_eq!(parse_listen_port("loom listening on http://127.0.0.1: (db)"), None);
    }

    #[test]
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0");
        let joined = args.join(" ");
        assert!(joined.contains("--role hub"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--open=false"));
        assert!(joined.contains("--2fa=false"));
        assert!(joined.contains("--secure-cookies=false"));
        assert!(joined.contains("loom.db"));
    }

    #[test]
    fn log_open_truncates_oversized_file() {
        let dir = std::env::temp_dir().join(format!("loom-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sidecar.log");
        std::fs::write(&path, vec![b'x'; (LOG_TRUNCATE_BYTES + 1) as usize]).unwrap();
        drop(open_sidecar_log(&dir).unwrap());
        assert!(std::fs::metadata(&path).unwrap().len() <= LOG_TRUNCATE_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }
}
